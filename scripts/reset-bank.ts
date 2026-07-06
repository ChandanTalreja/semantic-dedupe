/**
 * Wipe the question bank for a clean rebuild: qb_questions,
 * qb_question_sources, qb_processed_sources, qb_section_map.
 * The qb_ai_usage ledger is kept (it tracks real quota spend).
 * TUBEBOX's tables are untouched, as always.
 *
 * Run: npm run reset:bank  — then hit Preview in the app to rebuild.
 * Cost note: rebuilding re-embeds every question (~1 embedding per
 * question; well inside the free daily allowance, gone from the cache).
 */
import { getDb } from "../lib/db";
import {
  qbProcessedSources,
  qbQuestions,
  qbQuestionSources,
  qbSectionMap,
} from "../lib/schema";

async function main() {
  const db = await getDb();
  console.log(
    `database: ${process.env.DATABASE_URL ? "Neon" : "PGlite (.data/pglite)"}`
  );
  await db.delete(qbQuestionSources);
  await db.delete(qbQuestions);
  await db.delete(qbProcessedSources);
  await db.delete(qbSectionMap);
  console.log(
    "question bank reset — the next Preview rebuilds everything from scratch."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
