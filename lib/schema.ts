import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";
import { config } from "./config";

// Tables THIS app owns and writes — all prefixed qb_ (question bank).
// TUBEBOX's tables live in lib/tubebox.ts and are strictly read-only.
// DDL runs in lib/db.ts (CREATE TABLE IF NOT EXISTS on first use).

// One row per canonical (deduplicated) question.
export const qbQuestions = pgTable("qb_questions", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(), // canonical wording
  embedding: vector("embedding", { dimensions: config.embeddingDims }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Every appearance of a question in any source, with the original wording —
// nothing is ever discarded. Variant count per question = "asked in N sources".
export const qbQuestionSources = pgTable("qb_question_sources", {
  id: serial("id").primaryKey(),
  questionId: integer("question_id")
    .notNull()
    .references(() => qbQuestions.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(), // 'tubebox_video' | 'file'
  sourceRef: text("source_ref").notNull(), // yt_video_id | filename (display)
  sourceKey: text("source_key").notNull(), // yt_video_id | sha256(content) (identity)
  rawText: text("raw_text").notNull(), // wording as originally asked
  section: text("section"), // the source's own section heading, if any
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Section-name reconciliation cache: different sources name the same topic
// differently ("Java Core" vs "Core Java Concepts"); Gemma maps each raw
// name to a canonical one exactly once (compute once, cache forever).
export const qbSectionMap = pgTable("qb_section_map", {
  id: serial("id").primaryKey(),
  raw: text("raw").notNull().unique(),
  canonical: text("canonical").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Idempotency log: a source_key in here is done and never reprocessed.
export const qbProcessedSources = pgTable("qb_processed_sources", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceKey: text("source_key").notNull().unique(),
  sourceRef: text("source_ref"),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Own quota ledger — one row per AI API call (Google exposes no live quota).
export const qbAiUsage = pgTable("qb_ai_usage", {
  id: serial("id").primaryKey(),
  model: text("model").notNull(),
  kind: text("kind").notNull(), // 'embed' | 'judge' | 'extract'
  tokens: integer("tokens"), // null when the API reports no usage (embeddings)
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
});
