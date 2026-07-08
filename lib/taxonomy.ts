import { inArray } from "drizzle-orm";
import { getDb } from "./db";
import { qbQuestions, qbTaxonomy } from "./schema";
import { embedQuestions } from "./ai";
import { config } from "./config";

// Fixed-taxonomy section assignment (option c). The config.taxonomy labels
// are embedded once and cached in qb_taxonomy; every canonical question is
// then filed under the label its embedding is closest to. Deterministic,
// no LLM, always the same clean headings — see config.taxonomy.

export type Label = { name: string; vec: number[] };

// Detect whether cached taxonomy embeddings are from a different embedding
// provider than the current question bank. When the provider changes
// (e.g., Gemini → Jina), the vector spaces are incompatible — cosine
// similarities between old taxonomy vectors and new question vectors are
// meaningless, causing random misclassification (e.g., multithreading →
// coding). We detect this by sampling one bank question against the cached
// labels: if ALL similarities are very low (< 0.2), the spaces don't match.
async function spacesMismatched(): Promise<boolean> {
  const db = await getDb();
  const [sample] = await db
    .select({ embedding: qbQuestions.embedding })
    .from(qbQuestions)
    .limit(1);
  if (!sample) return false; // no questions yet — nothing to compare

  const labels = await db.select().from(qbTaxonomy).limit(3);
  if (labels.length === 0) return false;

  const qVec = toVec(sample.embedding);
  let allVeryLow = true;
  for (const label of labels) {
    const sim = cosine(qVec, toVec(label.embedding));
    if (sim >= 0.2) {
      allVeryLow = false;
      break;
    }
  }
  return allVeryLow;
}

// Ensure every current taxonomy label has a cached embedding, re-embedding
// only labels whose description changed, and dropping labels removed from
// config. Called during sync (so /api/export stays a pure read). Returns
// the labels with their vectors, in config (display) order.
export async function ensureTaxonomy(): Promise<Label[]> {
  const db = await getDb();
  const desired = config.taxonomy;
  const existing = await db.select().from(qbTaxonomy);
  const byName = new Map(existing.map((r) => [r.name, r]));

  // If the embedding provider changed (Gemini → Jina), all cached vectors
  // are in the wrong space. Clear them so everything gets re-embedded.
  if (await spacesMismatched()) {
    console.warn(
      "Taxonomy embeddings are from a different provider than the question bank — clearing and re-embedding all labels"
    );
    await db.delete(qbTaxonomy);
    byName.clear();
    existing.length = 0;
  }

  // Labels to (re)embed: new, or description edited.
  const stale = desired.filter(
    (d) => byName.get(d.name)?.description !== d.description
  );
  if (stale.length > 0) {
    const vecs = await embedQuestions(stale.map((d) => d.description));
    for (let i = 0; i < stale.length; i++) {
      await db
        .insert(qbTaxonomy)
        .values({
          name: stale[i].name,
          description: stale[i].description,
          embedding: vecs[i],
        })
        .onConflictDoUpdate({
          target: qbTaxonomy.name,
          set: {
            description: stale[i].description,
            embedding: vecs[i],
            updatedAt: new Date(),
          },
        });
    }
  }

  // Drop labels no longer in config.
  const wanted = new Set(desired.map((d) => d.name));
  const orphans = existing.filter((r) => !wanted.has(r.name)).map((r) => r.name);
  if (orphans.length > 0) {
    await db.delete(qbTaxonomy).where(inArray(qbTaxonomy.name, orphans));
  }

  return loadLabels();
}

function toVec(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") return JSON.parse(v);
  return [];
}

// Load cached label vectors in config (display) order. Labels missing an
// embedding (config edited but no sync yet) are simply absent — questions
// then fall back to config order's first match or "Other".
export async function loadLabels(): Promise<Label[]> {
  const db = await getDb();
  const rows = await db.select().from(qbTaxonomy);
  const byName = new Map(rows.map((r) => [r.name, toVec(r.embedding)]));
  return config.taxonomy
    .filter((d) => byName.has(d.name))
    .map((d) => ({ name: d.name, vec: byName.get(d.name)! }));
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

// File one question embedding under the nearest label. "Other" only when no
// labels are available yet.
export function assignSection(vec: number[], labels: Label[]): string {
  let best = "Other";
  let bestSim = -Infinity;
  for (const label of labels) {
    const sim = cosine(vec, label.vec);
    if (sim > bestSim) {
      bestSim = sim;
      best = label.name;
    }
  }
  return best;
}
