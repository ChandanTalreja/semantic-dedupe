import { findPendingVideos, markProcessed, parseQuestions } from "@/lib/sync";
import { processSources } from "@/lib/dedupe";
import { ensureTaxonomy } from "@/lib/taxonomy";
import { config } from "@/lib/config";

// POST /api/sync — process ONE chunk of pending TUBEBOX videos
// (config.syncBatchSize) in a combined pass (see lib/dedupe.processSources):
// one bank load, one set of embedding batches, one judge call for every
// gray-zone pair, bulk inserts. Returns { processed, remaining }; the UI
// loops until remaining is 0. Chunking commits each batch, so the daily
// embedding cap (or any mid-run failure) never wipes work already saved.
// Sections come from the fixed taxonomy at export time — no per-video AI
// section call. Never mutate on GET.

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
    // Embed any new/changed taxonomy labels once (cached in qb_taxonomy).
    // Runs even with nothing pending, so a plain Preview re-files the
    // existing bank under the current taxonomy.
    await ensureTaxonomy();

    if (pending.length === 0) {
      return Response.json({ processed: [], remaining: 0 });
    }

    // One chunk this request; the UI calls again for the rest.
    const batch = pending.slice(0, config.syncBatchSize);
    const items = batch.map((v) => ({
      source: {
        type: "tubebox_video" as const,
        ref: v.ytVideoId,
        key: v.ytVideoId,
      },
      questions: parseQuestions(v.answer).map((q) => q.text),
    }));

    const results = await processSources(items);

    // Mark this chunk's videos processed only after their rows are committed.
    const titleByRef = new Map(batch.map((v) => [v.ytVideoId, v.title]));
    for (const r of results) {
      await markProcessed({ type: "tubebox_video", key: r.ref, ref: r.ref });
    }

    return Response.json({
      processed: results.map((r) => ({
        ytVideoId: r.ref,
        title: titleByRef.get(r.ref) ?? r.ref,
        questionCount: r.total,
        created: r.created,
        attached: r.attached,
        skipped: r.skipped,
        undecided: r.undecided,
      })),
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
