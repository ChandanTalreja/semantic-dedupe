import { GoogleGenAI } from "@google/genai";
import { count, gte } from "drizzle-orm";
import { getDb } from "./db";
import { qbAiUsage } from "./schema";
import { config } from "./config";

// All Gemini API access lives here: embeddings now, Gemma judge/extract
// later. Every call is recorded in the qb_ai_usage ledger and gated by the
// app-level daily cap (Google's API exposes no remaining-quota signal).

let client: GoogleGenAI | undefined;

function genai(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set — get a free key at aistudio.google.com and put it in .env.local"
    );
  }
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

// Google's docs: embeddings truncated below the native 3072 dims are no
// longer unit-length, so they MUST be re-normalized for cosine math to be
// correct.
function l2Normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  if (!(norm > 0)) {
    throw new Error("embedding has zero magnitude — API returned bad data");
  }
  return values.map((x) => x / norm);
}

async function assertUnderDailyCap(upcomingCalls: number): Promise<void> {
  const db = await getDb();
  const utcMidnight = new Date();
  utcMidnight.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({ used: count() })
    .from(qbAiUsage)
    .where(gte(qbAiUsage.usedAt, utcMidnight));
  if (row.used + upcomingCalls > config.aiDailyLimit) {
    throw new Error(
      `AI daily cap reached (${row.used}/${config.aiDailyLimit} calls today) — raise AI_DAILY_LIMIT or try tomorrow`
    );
  }
}

// The batch endpoint accepts up to 100 texts per request — but the free
// tier's 100 requests/min quota counts each TEXT, so large sources can trip
// it mid-sync regardless of batching.
const EMBED_BATCH_SIZE = 90;

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return (
    e?.status === 429 ||
    /RESOURCE_EXHAUSTED|"code"\s*:\s*429/.test(String(e?.message ?? ""))
  );
}

// Google's 429 payload includes RetryInfo, e.g. "retryDelay":"30s".
function retryDelaySeconds(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/retryDelay[^\d]*(\d+)/);
  return m ? Number(m[1]) : 30;
}

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// Embed question texts, batched, L2-normalized, ledger-recorded.
// Returns one vector per input text, in the same order.
export async function embedQuestions(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiCalls = Math.ceil(texts.length / EMBED_BATCH_SIZE);
  await assertUnderDailyCap(apiCalls);

  const db = await getDb();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const call = () =>
      genai().models.embedContent({
        model: config.embeddingModel,
        contents: batch,
        config: {
          taskType: "SEMANTIC_SIMILARITY",
          outputDimensionality: config.embeddingDims,
        },
      });
    let res;
    try {
      res = await call();
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      // Wait out the per-minute window once, then retry. (Local-first
      // behavior — a hosted function timeout would kill a wait this long;
      // revisit if this app ever deploys.)
      const wait = Math.min(retryDelaySeconds(err) + 2, 70);
      console.warn(`embedding rate limit — waiting ${wait}s and retrying`);
      await sleep(wait);
      try {
        res = await call();
      } catch (err2) {
        if (isRateLimit(err2)) {
          throw new Error(
            "Gemini embedding rate limit (100 texts/min on the free tier) — wait a minute and press Preview again; everything processed so far is saved."
          );
        }
        throw err2;
      }
    }
    const embeddings = res.embeddings ?? [];
    if (embeddings.length !== batch.length) {
      throw new Error(
        `embedding API returned ${embeddings.length} vectors for ${batch.length} inputs`
      );
    }
    await db
      .insert(qbAiUsage)
      .values({ model: config.embeddingModel, kind: "embed", tokens: null });
    for (const e of embeddings) {
      vectors.push(l2Normalize(e.values ?? []));
    }
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// Gray-zone judging (REVIEW <= cosine < MATCH), layered so accuracy comes
// from the strongest available signal and failures degrade, never crash:
//   1. Gemma judge chain — ONE batched call per source for all its pairs
//      (stays far under Gemma's 15 RPM; fewer calls, fewer free-tier 500s).
//      Retry once per model, then the next model in the chain.
//   2. Second opinion — an independent embedding space scores the pair
//      deterministically.
//   3. Caller keeps the pair separate — visible and mergeable, never
//      silently merged or lost.
// Gemma models take no systemInstruction; everything goes in the user turn.
// ---------------------------------------------------------------------------

// Run a prompt through the judge chain, expecting JSON back. Records one
// ledger row per successful API call (even if its JSON later fails to
// parse — the tokens were spent).
async function generateJson(prompt: string, kind: string): Promise<unknown> {
  await assertUnderDailyCap(1);
  const db = await getDb();
  let lastErr: unknown;
  for (const model of config.judgeModels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await genai().models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0 },
        });
        await db.insert(qbAiUsage).values({
          model,
          kind,
          tokens: res.usageMetadata?.totalTokenCount ?? null,
        });
        const text = (res.text ?? "").replace(/```(json)?/gi, "").trim();
        return JSON.parse(text);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${kind} via ${model} attempt ${attempt} failed: ${msg.slice(0, 160)}`
        );
        await sleep(2);
      }
    }
  }
  throw lastErr;
}

export type JudgePair = { a: string; b: string };

// One batched call for ALL of a source's gray-zone pairs. Returns one
// verdict per pair; null = every judge model failed (or answered
// unparseably) for that pair — callers move to the next layer.
export async function judgePairs(
  pairs: JudgePair[]
): Promise<(boolean | null)[]> {
  if (pairs.length === 0) return [];
  const prompt = [
    "You are deduplicating a list of interview questions.",
    "For each numbered pair below, decide whether the two questions ask the",
    "same thing — such that one good answer would fully answer both.",
    "Different wordings of one question are the same; questions about",
    "different specific topics are NOT the same, even when closely related.",
    'Reply with ONLY a JSON array like [{"pair":1,"same":true},…],',
    "one entry per pair, in order.",
    "",
    ...pairs.map((p, i) => `Pair ${i + 1}:\nA: ${p.a}\nB: ${p.b}`),
  ].join("\n");
  const verdicts: (boolean | null)[] = pairs.map(() => null);
  try {
    const parsed = await generateJson(prompt, "judge");
    if (!Array.isArray(parsed)) throw new Error("judge returned non-array JSON");
    for (const item of parsed as { pair?: unknown; same?: unknown }[]) {
      const idx = typeof item?.pair === "number" ? item.pair - 1 : -1;
      if (idx >= 0 && idx < pairs.length && typeof item?.same === "boolean") {
        verdicts[idx] = item.same;
      }
    }
  } catch (err) {
    console.error(
      "all judge models failed:",
      err instanceof Error ? err.message.slice(0, 160) : err
    );
  }
  return verdicts;
}

// Layer 2: score one pair in an independent embedding space. Deterministic;
// null only on API failure. Nothing is stored — the bank stays in the
// primary model's space (the two spaces are incompatible).
export async function secondOpinionSame(
  a: string,
  b: string
): Promise<boolean | null> {
  try {
    await assertUnderDailyCap(2);
    const db = await getDb();
    const embedOne = async (text: string) => {
      const res = await genai().models.embedContent({
        model: config.embedding2Model,
        contents: text,
      });
      return res.embeddings?.[0]?.values ?? [];
    };
    const va = await embedOne(a);
    const vb = await embedOne(b);
    await db.insert(qbAiUsage).values([
      { model: config.embedding2Model, kind: "second-opinion", tokens: null },
      { model: config.embedding2Model, kind: "second-opinion", tokens: null },
    ]);
    if (va.length === 0 || va.length !== vb.length) return null;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < va.length; i++) {
      dot += va[i] * vb[i];
      na += va[i] * va[i];
      nb += vb[i] * vb[i];
    }
    if (!(na > 0 && nb > 0)) return null;
    return dot / Math.sqrt(na * nb) >= config.secondOpinionThreshold;
  } catch (err) {
    console.error(
      "second opinion failed:",
      err instanceof Error ? err.message.slice(0, 160) : err
    );
    return null;
  }
}

// Map raw section headings from different sources onto canonical names
// ("Java Core" vs "Core Java Concepts" → one heading). One call for the
// whole batch through the judge chain; results are cached forever in
// qb_section_map by the caller. Fail-open: on any error each name maps to
// itself — the export is then less tidy, never wrong or blocked.
export async function reconcileSections(
  rawNames: string[]
): Promise<Record<string, string>> {
  const identity = Object.fromEntries(rawNames.map((n) => [n, n]));
  if (rawNames.length === 0) return identity;
  try {
    const prompt = [
      "These section headings come from several interview-question lists.",
      "Group headings that cover the same topic under one short canonical",
      "heading (e.g. 'Java Core', 'Spring Boot', 'Kafka'). Reply with ONLY",
      "a JSON object mapping every input heading to its canonical heading.",
      "Every input heading must appear as a key exactly as written.",
      "",
      JSON.stringify(rawNames),
    ].join("\n");
    const mapping = (await generateJson(prompt, "sections")) as Record<
      string,
      unknown
    >;
    const result: Record<string, string> = {};
    for (const name of rawNames) {
      const mapped = mapping?.[name];
      result[name] =
        typeof mapped === "string" && mapped.trim() ? mapped.trim() : name;
    }
    return result;
  } catch (err) {
    console.error("section reconciliation failed (using raw names):", err);
    return identity;
  }
}
