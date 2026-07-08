import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { getDb } from "./db";
import { qbProcessedSources } from "./schema";
import { channels, genres, videoNotes, videos } from "./tubebox";

// The TUBEBOX source: find Interview-genre videos with a saved
// "list the questions" note that haven't been processed yet.
// Everything is discovered at query time — no hardcoded channels or counts.

// Matches the Interview genre's "list the questions" ask leniently: the
// prompt just has to mention "questions" and "asked" in any order. Real
// wordings vary — "List the interview questions asked" and "what all
// interview questions are asked" must both match (the earlier
// "%questions asked%" substring missed the second: "questions ARE asked").

export type PendingVideo = {
  ytVideoId: string;
  title: string;
  publishedAt: Date;
  answer: string;
};

// Parse a saved note answer into questions with their section headings.
// Observed format: a preamble sentence, **section headers**, and one `* `
// bullet per question (some questions are imperatives without a trailing
// "?"). Rules:
//   - a bulleted line is a question, filed under the current section;
//   - a non-bulleted **bold** line (or markdown # heading) is a section
//     header — it becomes the current section;
//   - a non-bulleted line ending in "?" is a question too;
//   - anything else (preamble) is ignored and does NOT reset the section.
const BULLET_PREFIX = /^([*\-•]|\d+[.)])\s+/;
const BOLD_HEADER = /^\*\*(.+?)\*\*:?$/;
const MD_HEADER = /^#{1,6}\s+(.+?):?$/;

export type ParsedQuestion = { text: string; section: string | null };

export function parseQuestions(answer: string): ParsedQuestion[] {
  const questions: ParsedQuestion[] = [];
  let section: string | null = null;
  for (const line of answer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bulleted = BULLET_PREFIX.test(trimmed);
    if (!bulleted) {
      const header = trimmed.match(BOLD_HEADER) ?? trimmed.match(MD_HEADER);
      if (header && !header[1].endsWith("?")) {
        section = header[1].replace(/\*\*/g, "").trim();
        continue;
      }
    }
    const text = trimmed
      .replace(BULLET_PREFIX, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!text) continue;
    if (bulleted || text.endsWith("?")) {
      questions.push({ text, section });
    }
  }
  return questions;
}

// In PGlite demo mode TUBEBOX's tables don't exist — that's expected,
// not an error; the sync feature just has nothing to offer.
// PGlite/Drizzle wraps the underlying Postgres error in `err.cause`, so we
// must check both the top-level error and the nested cause for the code.
function isMissingTableError(err: unknown): boolean {
  const topCode = (err as { code?: string }).code;
  const causeCode = (err as { cause?: { code?: string } }).cause?.code;
  const message = err instanceof Error ? err.message : String(err);
  const causeMessage = (err as { cause?: { message?: string } }).cause
    ?.message;
  return (
    topCode === "42P01" ||
    causeCode === "42P01" ||
    /does not exist/i.test(message) ||
    /does not exist/i.test(causeMessage ?? "")
  );
}

export async function findPendingVideos(): Promise<{
  pending: PendingVideo[];
  tubeboxAvailable: boolean;
}> {
  const db = await getDb();
  try {
    const rows = await db
      .select({
        ytVideoId: videos.ytVideoId,
        title: videos.title,
        publishedAt: videos.publishedAt,
        answer: videoNotes.answer,
      })
      .from(videos)
      .innerJoin(channels, eq(videos.channelId, channels.id))
      .innerJoin(genres, eq(channels.genreId, genres.id))
      .innerJoin(videoNotes, eq(videoNotes.videoId, videos.id))
      .where(
        and(
          eq(genres.name, "Interview"),
          ilike(videoNotes.prompt, "%questions%"),
          ilike(videoNotes.prompt, "%asked%"),
          sql`NOT EXISTS (
            SELECT 1 FROM qb_processed_sources ps
            WHERE ps.source_key = ${videos.ytVideoId}
          )`
        )
      )
      // oldest video first; newest note first within a video
      .orderBy(videos.publishedAt, desc(videoNotes.createdAt));

    // A video can have several matching notes (re-asks); keep the newest.
    const byVideo = new Map<string, PendingVideo>();
    for (const row of rows) {
      if (!byVideo.has(row.ytVideoId)) byVideo.set(row.ytVideoId, row);
    }
    return { pending: [...byVideo.values()], tubeboxAvailable: true };
  } catch (err) {
    if (isMissingTableError(err)) {
      return { pending: [], tubeboxAvailable: false };
    }
    throw err;
  }
}

// Idempotency log — a source_key in qb_processed_sources is done forever.
export async function markProcessed(source: {
  type: string;
  key: string;
  ref: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .insert(qbProcessedSources)
    .values({ sourceType: source.type, sourceKey: source.key, sourceRef: source.ref })
    .onConflictDoNothing();
}
