import { asc, desc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { qbQuestions, qbQuestionSources } from "@/lib/schema";
import { videos } from "@/lib/tubebox";

// GET /api/bank — the whole bank: canonicals with their variants, sorted by
// variant count desc ("asked in N sources" = prep priority). Read-only.

export async function GET() {
  try {
    const db = await getDb();
    // embedding column deliberately not selected — 768 floats per row of
    // dead weight for the UI.
    const questions = await db
      .select({
        id: qbQuestions.id,
        text: qbQuestions.text,
        createdAt: qbQuestions.createdAt,
      })
      .from(qbQuestions)
      .orderBy(asc(qbQuestions.id));
    const sources = await db
      .select({
        id: qbQuestionSources.id,
        questionId: qbQuestionSources.questionId,
        sourceType: qbQuestionSources.sourceType,
        sourceRef: qbQuestionSources.sourceRef,
        rawText: qbQuestionSources.rawText,
        createdAt: qbQuestionSources.createdAt,
      })
      .from(qbQuestionSources)
      .orderBy(desc(qbQuestionSources.createdAt));

    // Best-effort display names: video titles from TUBEBOX where available
    // (absent in PGlite demo mode — the raw yt_video_id still shows).
    const videoIds = [
      ...new Set(
        sources
          .filter((s) => s.sourceType === "tubebox_video")
          .map((s) => s.sourceRef)
      ),
    ];
    let titles = new Map<string, string>();
    if (videoIds.length > 0) {
      try {
        const rows = await db
          .select({ ytVideoId: videos.ytVideoId, title: videos.title })
          .from(videos)
          .where(inArray(videos.ytVideoId, videoIds));
        titles = new Map(rows.map((r) => [r.ytVideoId, r.title]));
      } catch {
        // demo mode: no TUBEBOX tables
      }
    }

    const byQuestion = new Map<number, typeof sources>();
    for (const s of sources) {
      const list = byQuestion.get(s.questionId) ?? [];
      list.push(s);
      byQuestion.set(s.questionId, list);
    }

    const bank = questions
      .map((q) => {
        const qSources = byQuestion.get(q.id) ?? [];
        return {
          ...q,
          count: qSources.length,
          sources: qSources.map((s) => ({
            id: s.id,
            sourceType: s.sourceType,
            sourceRef: s.sourceRef,
            sourceLabel:
              s.sourceType === "tubebox_video"
                ? (titles.get(s.sourceRef) ?? s.sourceRef)
                : s.sourceRef,
            rawText: s.rawText,
            createdAt: s.createdAt,
          })),
        };
      })
      .sort((a, b) => b.count - a.count || a.id - b.id);

    return Response.json({
      questions: bank,
      totalSources: sources.length,
    });
  } catch (err) {
    console.error("bank fetch failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "bank fetch failed" },
      { status: 500 }
    );
  }
}
