import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./db";
import type { Db } from "./db";
import { qbQuestions, qbQuestionSources } from "./schema";
import { embedQuestions, judgePairs, secondOpinionSame } from "./ai";
import { config } from "./config";

// The engine core. Every question from every source flows through here.
//
// Performance design: the bank's canonical vectors are loaded into memory
// ONCE per source, and all nearest-neighbor matching runs in-memory (plain
// cosine). Writes are batched into two bulk inserts at the end. This
// replaces ~3 sequential Neon round-trips PER QUESTION (which made a single
// 60-question video take minutes) with a handful of round-trips total —
// identical logic and results, without the per-question network latency.
//
// Two phases, same as before:
//   Phase 1 — embed everything in one batched call, then resolve each
//     question against the in-memory pool:
//       cosine >= MATCH_THRESHOLD  → duplicate: attach as variant
//       cosine <  REVIEW_THRESHOLD → new canonical question
//       in between                 → deferred to phase 2
//   Phase 2 — ALL gray-zone pairs go to the judge in one batched call
//     (judge → second-opinion → keep-separate; see lib/ai.ts), verdicts
//     applied in order.
// Nothing is ever deleted or skipped: every appearance becomes a
// qb_question_sources row with its original wording, section, and
// provenance; when no layer can decide, the question stays its own entry —
// visible and mergeable, never buried.

export type SourceInfo = {
  type: "tubebox_video" | "file";
  ref: string; // display: yt_video_id | filename
  key: string; // identity: yt_video_id | sha256(content)
};

export type Decision = {
  question: string;
  action: "attached" | "created" | "skipped";
  canonicalText?: string; // set when attached to an existing canonical
  similarity?: number; // vs the nearest canonical at decision time
  // which layer settled it: threshold (clear case), judge (Gemma chain),
  // second-opinion (independent embedding space), fallback (all layers
  // down — kept separate to be safe)
  decidedBy?: "threshold" | "judge" | "second-opinion" | "fallback";
};

export function normalizeQuestion(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// pgvector columns come back as number[] on PGlite and as a JSON string on
// the Neon HTTP driver — normalize both.
function toVec(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") return JSON.parse(v);
  return [];
}

// An entry in the in-memory canonical pool. Existing canonicals carry their
// real DB id; canonicals created during this run carry a temp index into
// `newCanonicals`, resolved to a real id at flush time.
type PoolEntry = {
  vec: number[];
  text: string;
  existingId?: number;
  newIdx?: number;
};

type SourceRow = {
  ref: { existingId?: number; newIdx?: number };
  rawText: string;
  section: string | null;
};

function nearest(pool: PoolEntry[], vec: number[]) {
  let best: PoolEntry | undefined;
  let bestSim = -1;
  for (const entry of pool) {
    const sim = cosine(entry.vec, vec);
    if (sim > bestSim) {
      bestSim = sim;
      best = entry;
    }
  }
  return best ? { entry: best, sim: bestSim } : undefined;
}

const INSERT_CHUNK = 200;

async function bulkInsertSources(db: Db, rows: (typeof qbQuestionSources.$inferInsert)[]) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(qbQuestionSources).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

export async function processQuestions(
  parsed: { text: string; section: string | null }[],
  source: SourceInfo
): Promise<Decision[]> {
  const db = await getDb();
  const decisions: Decision[] = [];

  // Rerun safety without transactions: a crash mid-source leaves the source
  // unmarked in qb_processed_sources, so it reruns — and here we skip any
  // question this source already recorded, so nothing duplicates.
  const existingSources = await db
    .select({
      rawText: qbQuestionSources.rawText,
      section: qbQuestionSources.section,
    })
    .from(qbQuestionSources)
    .where(eq(qbQuestionSources.sourceKey, source.key));
  const seen = new Set(existingSources.map((r) => r.rawText));

  const todo: { text: string; section: string | null }[] = [];
  const backfill: { text: string; section: string }[] = [];
  for (const item of parsed) {
    const question = normalizeQuestion(item.text);
    if (!question) continue;
    if (seen.has(question)) {
      if (item.section) backfill.push({ text: question, section: item.section });
      decisions.push({ question, action: "skipped" });
      continue;
    }
    seen.add(question); // also collapses exact repeats within the source
    todo.push({ text: question, section: item.section });
  }

  // Backfill sections for rows recorded by a run that predated section
  // tracking (rare — only on reruns). One statement each; there are few.
  for (const b of backfill) {
    await db
      .update(qbQuestionSources)
      .set({ section: b.section })
      .where(
        and(
          eq(qbQuestionSources.sourceKey, source.key),
          eq(qbQuestionSources.rawText, b.text),
          isNull(qbQuestionSources.section)
        )
      );
  }

  if (todo.length === 0) return decisions;

  const vectors = await embedQuestions(todo.map((t) => t.text));

  // Load the whole bank ONCE into memory. (At bank scale — thousands of
  // 768-float rows — this is a few MB and a single query; matching is then
  // pure CPU.)
  const bankRows = await db
    .select({
      id: qbQuestions.id,
      text: qbQuestions.text,
      embedding: qbQuestions.embedding,
    })
    .from(qbQuestions);
  const pool: PoolEntry[] = bankRows.map((r) => ({
    vec: toVec(r.embedding),
    text: r.text,
    existingId: r.id,
  }));

  const newCanonicals: { text: string; vec: number[] }[] = [];
  const sourceRows: SourceRow[] = [];

  const createCanonical = (text: string, vec: number[]) => {
    const newIdx = newCanonicals.length;
    newCanonicals.push({ text, vec });
    pool.push({ vec, text, newIdx }); // matchable by later questions this run
    return newIdx;
  };

  // Phase 1 — resolve clear cases in-memory; defer the gray zone.
  type Gray = {
    text: string;
    section: string | null;
    vec: number[];
    nearestRef: { existingId?: number; newIdx?: number };
    nearestText: string;
    sim: number;
  };
  const gray: Gray[] = [];
  for (let i = 0; i < todo.length; i++) {
    const { text, section } = todo[i];
    const vec = vectors[i];
    const hit = nearest(pool, vec);
    if (hit && hit.sim >= config.matchThreshold) {
      sourceRows.push({
        ref: { existingId: hit.entry.existingId, newIdx: hit.entry.newIdx },
        rawText: text,
        section,
      });
      decisions.push({
        question: text,
        action: "attached",
        canonicalText: hit.entry.text,
        similarity: hit.sim,
        decidedBy: "threshold",
      });
    } else if (!hit || hit.sim < config.reviewThreshold) {
      const newIdx = createCanonical(text, vec);
      sourceRows.push({ ref: { newIdx }, rawText: text, section });
      decisions.push({
        question: text,
        action: "created",
        similarity: hit?.sim,
        decidedBy: "threshold",
      });
    } else {
      gray.push({
        text,
        section,
        vec,
        nearestRef: { existingId: hit.entry.existingId, newIdx: hit.entry.newIdx },
        nearestText: hit.entry.text,
        sim: hit.sim,
      });
    }
  }

  // Phase 2 — one batched judge call for the whole source, applied in order.
  const verdicts = await judgePairs(
    gray.map((g) => ({ a: g.text, b: g.nearestText }))
  );
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i];
    let same = verdicts[i];
    let decidedBy: Decision["decidedBy"] = "judge";
    if (same === null) {
      same = await secondOpinionSame(g.text, g.nearestText);
      decidedBy = "second-opinion";
    }
    if (same === null) {
      same = false; // keep separate: visible and mergeable, never buried
      decidedBy = "fallback";
    }

    if (same) {
      sourceRows.push({ ref: g.nearestRef, rawText: g.text, section: g.section });
      decisions.push({
        question: g.text,
        action: "attached",
        canonicalText: g.nearestText,
        similarity: g.sim,
        decidedBy,
      });
      continue;
    }

    // Distinct from its judged pair — but the pool grew during this run, so
    // re-check before creating: a near-identical twin from this same source
    // may now match outright (settled by threshold alone; no second AI
    // round for a rare within-source edge).
    const hit = nearest(pool, g.vec);
    if (hit && hit.sim >= config.matchThreshold) {
      sourceRows.push({
        ref: { existingId: hit.entry.existingId, newIdx: hit.entry.newIdx },
        rawText: g.text,
        section: g.section,
      });
      decisions.push({
        question: g.text,
        action: "attached",
        canonicalText: hit.entry.text,
        similarity: hit.sim,
        decidedBy: "threshold",
      });
    } else {
      const newIdx = createCanonical(g.text, g.vec);
      sourceRows.push({ ref: { newIdx }, rawText: g.text, section: g.section });
      decisions.push({
        question: g.text,
        action: "created",
        similarity: g.sim,
        decidedBy,
      });
    }
  }

  // Flush — bulk insert new canonicals (ids come back in VALUES order),
  // then resolve every source row's ref to a real question id and bulk
  // insert them.
  let newIds: number[] = [];
  if (newCanonicals.length > 0) {
    const inserted = await db
      .insert(qbQuestions)
      .values(newCanonicals.map((c) => ({ text: c.text, embedding: c.vec })))
      .returning({ id: qbQuestions.id });
    newIds = inserted.map((r) => r.id);
  }
  await bulkInsertSources(
    db,
    sourceRows.map((r) => ({
      questionId: r.ref.existingId ?? newIds[r.ref.newIdx!],
      sourceType: source.type,
      sourceRef: source.ref,
      sourceKey: source.key,
      rawText: r.rawText,
      section: r.section,
    }))
  );

  return decisions;
}
