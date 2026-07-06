import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// ============================================================================
// TUBEBOX's tables — READ-ONLY. THE CONTRACT:
//
//   - This app NEVER writes, alters, or creates anything declared here.
//     No DDL for these tables exists in this repo (see lib/db.ts — its DDL
//     list is qb_ tables only).
//   - Cross-references into TUBEBOX data use the natural key yt_video_id,
//     never these serial ids: TUBEBOX cascade-deletes videos when a channel
//     is removed, and that must never damage the question bank.
//   - Only the columns this app reads are declared (the real tables have
//     more; Drizzle only selects what is declared).
//
// In owner mode (DATABASE_URL set) these tables exist because TUBEBOX
// created them in the same Neon database. In PGlite demo mode they do not
// exist — the sync feature reports "no TUBEBOX data" instead of querying.
// ============================================================================

export const genres = pgTable("genres", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // we look for name = 'Interview'
  askPrompt: text("ask_prompt"),
});

export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  ytChannelId: text("yt_channel_id").notNull(),
  title: text("title").notNull(),
  genreId: integer("genre_id"),
});

export const videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  ytVideoId: text("yt_video_id").notNull(), // the natural key we reference
  channelId: integer("channel_id").notNull(),
  title: text("title").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  transcript: text("transcript"),
});

export const videoNotes = pgTable("video_notes", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),
  prompt: text("prompt").notNull(),
  answer: text("answer").notNull(), // the saved question list we parse
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
