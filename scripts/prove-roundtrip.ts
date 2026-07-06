/**
 * Step-2 proof: the riskiest unknown, end to end.
 *
 *   embed via gemini-embedding-001 (768 dims, re-normalized)
 *     → store in pgvector → cosine nearest-neighbor → sane similarity numbers
 *
 * Seeds a paraphrase pair + an unrelated control, probes with one side of
 * the pair, and checks the paraphrase ranks clearly above the control.
 * Test rows are deleted afterwards (they are fixtures, not bank data).
 *
 * Run: npm run prove   (needs GEMINI_API_KEY in .env.local; uses Neon if
 * DATABASE_URL is set there, embedded PGlite otherwise — run it both ways.)
 * Cost: 1 embedding API call. Re-runs are idempotent by cleanup.
 */
import { desc, inArray, sql } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { getDb } from "../lib/db";
import { qbQuestions } from "../lib/schema";
import { embedQuestions } from "../lib/ai";
import { config } from "../lib/config";

const PROBE = "What happens during Spring Boot startup?";
const PARAPHRASE = "Spring Boot auto-configuration — what does it do?";
const CONTROL = "How does a HashMap handle collisions in Java?";

async function main() {
  console.log(
    `driver: ${process.env.DATABASE_URL ? "Neon" : "PGlite (.data/pglite)"}`
  );
  console.log(
    `model: ${config.embeddingModel} @ ${config.embeddingDims} dims\n`
  );

  const db = await getDb();
  const [probeVec, paraphraseVec, controlVec] = await embedQuestions([
    PROBE,
    PARAPHRASE,
    CONTROL,
  ]);

  const inserted = await db
    .insert(qbQuestions)
    .values([
      { text: PARAPHRASE, embedding: paraphraseVec },
      { text: CONTROL, embedding: controlVec },
    ])
    .returning({ id: qbQuestions.id });
  const ids = inserted.map((r) => r.id);

  try {
    const similarity = sql<number>`1 - (${cosineDistance(qbQuestions.embedding, probeVec)})`;
    const neighbors = await db
      .select({ text: qbQuestions.text, similarity })
      .from(qbQuestions)
      .where(inArray(qbQuestions.id, ids)) // only our fixtures, even against a live bank
      .orderBy(desc(similarity));

    console.log(`probe: "${PROBE}"`);
    for (const n of neighbors) {
      console.log(`  ${Number(n.similarity).toFixed(4)}  "${n.text}"`);
    }

    const paraphraseSim = Number(
      neighbors.find((n) => n.text === PARAPHRASE)?.similarity
    );
    const controlSim = Number(
      neighbors.find((n) => n.text === CONTROL)?.similarity
    );

    console.log(
      `\nthresholds: MATCH=${config.matchThreshold} REVIEW=${config.reviewThreshold}`
    );
    const band =
      paraphraseSim >= config.matchThreshold
        ? "MATCH (auto-variant)"
        : paraphraseSim >= config.reviewThreshold
          ? "REVIEW (judge decides)"
          : "below REVIEW (would be a new canonical!)";
    console.log(`paraphrase pair lands in: ${band}`);

    if (paraphraseSim > controlSim + 0.1) {
      console.log("\nPASS — paraphrase ranks clearly above the control.");
    } else {
      console.error(
        `\nFAIL — no clear separation (paraphrase ${paraphraseSim.toFixed(4)} vs control ${controlSim.toFixed(4)}).`
      );
      process.exitCode = 1;
    }
  } finally {
    await db.delete(qbQuestions).where(inArray(qbQuestions.id, ids));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
