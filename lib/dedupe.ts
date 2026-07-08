import { inArray } from "drizzle-orm";
import { getDb } from "./db";
import { qbQuestions, qbQuestionSources } from "./schema";
import { embedQuestions, judgePairs, secondOpinionSame } from "./ai";
import { config } from "./config";

// The engine core — ONE combined pass over every pending source at once
// (all of tonight's videos together, matched against the existing bank and
// against each other). This is the performance design: many videos cost one
// bank load, one set of embedding batches, ONE judge call for all gray-zone
// pairs, and a couple of bulk inserts — instead of repeating that per video.
//
// Pipeline per distinct question text:
//   exact-text match to an existing/just-created canonical → attach (no
//     embedding, no judge: identical text is unambiguously the same)
//   else embed, then:
//     cosine >= MATCH_THRESHOLD  → duplicate: attach as variant
//     cosine <  REVIEW_THRESHOLD → new canonical question
//     in between                 → one batched judge call (judge →
//       second-opinion → keep-separate; see lib/ai.ts)
//
// Sections are NOT decided here — a canonical's section is derived at export
// time from its embedding against the fixed taxonomy (lib/taxonomy.ts).
// Nothing is ever deleted or skipped: every appearance becomes a
// qb_question_sources row with provenance; undecidable pairs stay separate,
// visible and mergeable, never buried.

export type SourceInfo = {
  type: "tubebox_video" | "file";
  ref: string; // display: yt_video_id | filename
  key: string; // identity: yt_video_id | sha256(content)
};

export type SourceResult = {
  ref: string;
  created: number; // new canonical questions this source introduced
  attached: number; // appearances that matched an existing/shared question
  skipped: number; // already recorded on a previous run
  undecided: number; // all judge layers unavailable — kept separate to be safe
  total: number;
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

// In-memory canonical pool entry. Existing canonicals carry their real DB
// id; canonicals created during this run carry a temp index into
// `newCanonicals`, resolved to a real id at flush time.
type Ref = { existingId?: number; newIdx?: number };
type PoolEntry = { vec: number[]; text: string } & Ref;

function refOf(e: PoolEntry): Ref {
  return { existingId: e.existingId, newIdx: e.newIdx };
}

function nearest(pool: PoolEntry[], vec: number[]) {
  let best: PoolEntry | undefined;
  let bestSim = -Infinity;
  for (const entry of pool) {
    const sim = cosine(entry.vec, vec);
    if (sim > bestSim) {
      bestSim = sim;
      best = entry;
    }
  }
  return best ? { entry: best, sim: bestSim } : undefined;
}

// Chunk size for bulk inserts. Each qb_questions row carries a 768-dim
// embedding vector (~6 KB of SQL), so the chunk must stay small enough
// that the total INSERT statement fits within Neon's HTTP query limit.
// 50 rows × 768 floats ≈ 30 KB per query — comfortably under the limit.
const QUESTION_CHUNK = 50;
const SOURCE_CHUNK = 200;

async function chunkedInsert<T extends Record<string, unknown>>(
  insert: (rows: T[]) => Promise<{ id: number }[]>,
  rows: T[]
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < rows.length; i += QUESTION_CHUNK) {
    const chunk = rows.slice(i, i + QUESTION_CHUNK);
    const inserted = await insert(chunk);
    for (const row of inserted) ids.push(row.id);
  }
  return ids;
}

async function bulkInsert<T extends Record<string, unknown>>(
  insert: (rows: T[]) => Promise<unknown>,
  rows: T[],
  chunkSize: number
) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insert(rows.slice(i, i + chunkSize));
  }
}

// Process many sources in one pass. Returns a per-source summary (for
// progress reporting); the deduplicated bank is the durable result.
export async function processSources(
  items: { source: SourceInfo; questions: string[] }[]
): Promise<SourceResult[]> {
  const db = await getDb();
  const results = new Map<string, SourceResult>();
  for (const it of items) {
    results.set(it.source.key, {
      ref: it.source.ref,
      created: 0,
      attached: 0,
      skipped: 0,
      undecided: 0,
      total: 0,
    });
  }

  // Rerun safety: skip any (source, text) already recorded on a prior run.
  const keys = items.map((i) => i.source.key);
  const recorded =
    keys.length > 0
      ? await db
          .select({
            sourceKey: qbQuestionSources.sourceKey,
            rawText: qbQuestionSources.rawText,
          })
          .from(qbQuestionSources)
          .where(inArray(qbQuestionSources.sourceKey, keys))
      : [];
  const recordedByKey = new Map<string, Set<string>>();
  for (const r of recorded) {
    const set = recordedByKey.get(r.sourceKey) ?? new Set<string>();
    set.add(r.rawText);
    recordedByKey.set(r.sourceKey, set);
  }

  // Build the occurrence list (each source's questions, de-duplicated within
  // that source and against what it already recorded).
  type Occ = { source: SourceInfo; text: string };
  const occurrences: Occ[] = [];
  for (const { source, questions } of items) {
    const summary = results.get(source.key)!;
    const seen = new Set(recordedByKey.get(source.key) ?? []);
    for (const raw of questions) {
      const text = normalizeQuestion(raw);
      if (!text) continue;
      summary.total++;
      if (seen.has(text)) {
        summary.skipped++;
        continue;
      }
      seen.add(text);
      occurrences.push({ source, text });
    }
  }

  // Load the bank ONCE; build an exact-text index for the short-circuit.
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
  const exactMap = new Map<string, PoolEntry>();
  for (const e of pool) exactMap.set(e.text, e);

  // Distinct texts, first-seen order; remember each text's first source
  // (that source "owns" the creation, for created-vs-attached accounting).
  const uniqueTexts: string[] = [];
  const firstSource = new Map<string, string>();
  const textSeen = new Set<string>();
  for (const occ of occurrences) {
    if (!textSeen.has(occ.text)) {
      textSeen.add(occ.text);
      uniqueTexts.push(occ.text);
      firstSource.set(occ.text, occ.source.key);
    }
  }

  // Embed only texts that aren't an exact match to an existing canonical.
  const needEmbed = uniqueTexts.filter((t) => !exactMap.has(t));
  const embedded = await embedQuestions(needEmbed);
  const textVec = new Map<string, number[]>();
  needEmbed.forEach((t, i) => textVec.set(t, embedded[i]));

  const newCanonicals: { text: string; vec: number[] }[] = [];
  const textRef = new Map<string, Ref>();
  const createdText = new Set<string>();

  const createCanonical = (text: string, vec: number[]): Ref => {
    const newIdx = newCanonicals.length;
    newCanonicals.push({ text, vec });
    const entry: PoolEntry = { vec, text, newIdx };
    pool.push(entry);
    exactMap.set(text, entry);
    createdText.add(text);
    return { newIdx };
  };

  // Resolve each distinct text to a canonical; defer the gray zone.
  type Gray = { text: string; vec: number[]; nearestRef: Ref; nearestText: string };
  const gray: Gray[] = [];
  for (const text of uniqueTexts) {
    const exact = exactMap.get(text);
    if (exact) {
      textRef.set(text, refOf(exact)); // exact repeat → attach, no AI
      continue;
    }
    const vec = textVec.get(text)!;
    const hit = nearest(pool, vec);
    if (hit && hit.sim >= config.matchThreshold) {
      textRef.set(text, refOf(hit.entry));
    } else if (!hit || hit.sim < config.reviewThreshold) {
      textRef.set(text, createCanonical(text, vec));
    } else {
      gray.push({
        text,
        vec,
        nearestRef: refOf(hit.entry),
        nearestText: hit.entry.text,
      });
    }
  }

  // ONE batched judge call for every gray-zone pair across all sources.
  const verdicts = await judgePairs(
    gray.map((g) => ({ a: g.text, b: g.nearestText }))
  );
  const undecidedText = new Set<string>();
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i];
    let same = verdicts[i];
    if (same === null) same = await secondOpinionSame(g.text, g.nearestText);
    if (same === null) {
      same = false; // keep separate: visible and mergeable, never buried
      undecidedText.add(g.text);
    }
    if (same) {
      textRef.set(g.text, g.nearestRef);
      continue;
    }
    // Pool may have grown during this run — re-check before creating.
    const hit = nearest(pool, g.vec);
    if (hit && hit.sim >= config.matchThreshold) {
      textRef.set(g.text, refOf(hit.entry));
    } else {
      textRef.set(g.text, createCanonical(g.text, g.vec));
    }
  }

  // Flush: chunk-insert new canonicals (ids return in VALUES order within
  // each chunk, so we concatenate them in order), then resolve every
  // occurrence's ref and bulk-insert the source rows.
  let newIds: number[] = [];
  if (newCanonicals.length > 0) {
    newIds = await chunkedInsert(
      (rows) =>
        db
          .insert(qbQuestions)
          .values(rows)
          .returning({ id: qbQuestions.id }),
      newCanonicals.map((c) => ({ text: c.text, embedding: c.vec }))
    );
  }
  const resolve = (ref: Ref): number => ref.existingId ?? newIds[ref.newIdx!];

  await bulkInsert(
    (rows: (typeof qbQuestionSources.$inferInsert)[]) =>
      db.insert(qbQuestionSources).values(rows),
    occurrences.map((occ) => ({
      questionId: resolve(textRef.get(occ.text)!),
      sourceType: occ.source.type,
      sourceRef: occ.source.ref,
      sourceKey: occ.source.key,
      rawText: occ.text,
    })),
    SOURCE_CHUNK
  );

  // Per-source created/attached accounting.
  for (const occ of occurrences) {
    const s = results.get(occ.source.key)!;
    const isCreator =
      createdText.has(occ.text) && firstSource.get(occ.text) === occ.source.key;
    if (isCreator) s.created++;
    else s.attached++;
    if (undecidedText.has(occ.text)) s.undecided++;
  }

  return items.map((i) => results.get(i.source.key)!);
}
