import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon, NeonHttpDatabase } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import * as tubebox from "./tubebox";
import { config } from "./config";

// Dual driver, same pattern as TUBEBOX: Neon when DATABASE_URL is set
// (owner mode — the same database TUBEBOX writes to), embedded PGlite
// otherwise (zero-setup demo mode). One CREATE TABLE IF NOT EXISTS pass
// per process, qb_ tables ONLY — TUBEBOX's tables are never touched.

const fullSchema = { ...schema, ...tubebox };
export type Db = NeonHttpDatabase<typeof fullSchema>;

function ddl(): string[] {
  return [
    // pgvector — available on Neon free tier; loaded as a module in PGlite.
    `CREATE EXTENSION IF NOT EXISTS vector`,
    `CREATE TABLE IF NOT EXISTS qb_questions (
      id serial PRIMARY KEY,
      text text NOT NULL,
      embedding vector(${config.embeddingDims}) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS qb_question_sources (
      id serial PRIMARY KEY,
      question_id integer NOT NULL REFERENCES qb_questions(id) ON DELETE CASCADE,
      source_type text NOT NULL,
      source_ref text NOT NULL,
      source_key text NOT NULL,
      raw_text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS qb_question_sources_question_idx
      ON qb_question_sources (question_id)`,
    `CREATE TABLE IF NOT EXISTS qb_processed_sources (
      id serial PRIMARY KEY,
      source_type text NOT NULL,
      source_key text NOT NULL UNIQUE,
      source_ref text,
      processed_at timestamptz NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE qb_question_sources ADD COLUMN IF NOT EXISTS section text`,
    `CREATE TABLE IF NOT EXISTS qb_section_map (
      id serial PRIMARY KEY,
      raw text NOT NULL UNIQUE,
      canonical text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS qb_ai_usage (
      id serial PRIMARY KEY,
      model text NOT NULL,
      kind text NOT NULL,
      tokens integer,
      used_at timestamptz NOT NULL DEFAULT now()
    )`,
    // No vector index on purpose: at bank scale (thousands of rows) an exact
    // sequential scan is milliseconds and more accurate than HNSW/IVFFlat.
    // If the bank ever grows to 100K+, append a CREATE INDEX here.
  ];
}

async function init(): Promise<Db> {
  let db: Db;
  if (process.env.DATABASE_URL) {
    db = drizzleNeon(neon(process.env.DATABASE_URL), { schema: fullSchema });
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    // pgvector ships as a separate package since PGlite 0.3 (pinned to the
    // exact PGlite version via peerDependencies).
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    const { mkdir } = await import("fs/promises");
    const dir = process.env.PGLITE_DIR ?? ".data/pglite";
    await mkdir(dir, { recursive: true });
    const client = new PGlite(dir, { extensions: { vector } });
    db = drizzlePglite(client, { schema: fullSchema }) as unknown as Db;
  }
  for (const stmt of ddl()) {
    await db.execute(sql.raw(stmt));
  }
  return db;
}

const g = globalThis as unknown as { __qbDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  g.__qbDb ??= init().catch((err) => {
    // Don't cache a failed init; let the next request retry.
    g.__qbDb = undefined;
    throw err;
  });
  return g.__qbDb;
}
