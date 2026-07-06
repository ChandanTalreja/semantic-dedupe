import { isNotNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { qbQuestionSources, qbSectionMap } from "@/lib/schema";
import { findPendingVideos, markProcessed, parseQuestions } from "@/lib/sync";
import { processQuestions } from "@/lib/dedupe";
import { reconcileSections } from "@/lib/ai";
import { config } from "@/lib/config";

// POST /api/sync — process up to SYNC_BATCH_SIZE pending videos through the
// dedupe engine (bounded work per request; the UI loops until remaining is
// 0), then reconcile any new section headings. Never mutate on GET.

async function reconcileNewSections(): Promise<void> {
  const db = await getDb();
  const known = (await db.select({ raw: qbSectionMap.raw }).from(qbSectionMap)).map(
    (r) => r.raw
  );
  const unmappedRows = await db
    .selectDistinct({ section: qbQuestionSources.section })
    .from(qbQuestionSources)
    .where(
      known.length > 0
        ? sql`${isNotNull(qbQuestionSources.section)} AND ${notInArray(qbQuestionSources.section, known)}`
        : isNotNull(qbQuestionSources.section)
    );
  const unmapped = unmappedRows
    .map((r) => r.section)
    .filter((s): s is string => s !== null);
  if (unmapped.length === 0) return;
  // Include known canonical names as context so new sources converge on the
  // same headings instead of inventing parallel ones.
  const canonicals = [
    ...new Set((await db.select().from(qbSectionMap)).map((r) => r.canonical)),
  ];
  const mapping = await reconcileSections([...unmapped, ...canonicals]);
  await db
    .insert(qbSectionMap)
    .values(unmapped.map((raw) => ({ raw, canonical: mapping[raw] ?? raw })))
    .onConflictDoNothing();
}

export async function POST() {
  try {
    const { pending, tubeboxAvailable } = await findPendingVideos();
    if (!tubeboxAvailable) {
      return Response.json(
        {
          error:
            "No TUBEBOX tables in this database (demo mode) — use file upload instead.",
        },
        { status: 409 }
      );
    }

    const batch = pending.slice(0, config.syncBatchSize);
    const processed = [];
    for (const video of batch) {
      const questions = parseQuestions(video.answer);
      const decisions = await processQuestions(questions, {
        type: "tubebox_video",
        ref: video.ytVideoId,
        key: video.ytVideoId,
      });
      // Even a zero-question parse is marked done — otherwise it would
      // block the queue forever; the response flags it for a human look.
      await markProcessed({
        type: "tubebox_video",
        key: video.ytVideoId,
        ref: video.ytVideoId,
      });
      processed.push({
        ytVideoId: video.ytVideoId,
        title: video.title,
        questionCount: questions.length,
        decisions,
      });
    }

    // Best-effort: a failure here never fails the sync — the export falls
    // back to raw section names until the next run retries.
    try {
      if (processed.length > 0) await reconcileNewSections();
    } catch (err) {
      console.error("section reconciliation pass failed:", err);
    }

    return Response.json({
      processed,
      remaining: pending.length - batch.length,
    });
  } catch (err) {
    console.error("sync failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}
