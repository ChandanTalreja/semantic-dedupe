import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { count, gte } from "drizzle-orm";
import { getDb } from "./db";
import { qbAiUsage } from "./schema";
import { config } from "./config";

// ============================================================================
// Three-tier embedding provider stack:
//   1. Jina AI   — primary (free 2,000 RPM, 10M tokens, no card needed)
//   2. OpenAI    — fallback (requires payment method, 100-3,000 RPM)
//   3. Gemini    — emergency fallback + judge/second-opinion (existing)
//
// The fallback chain is tried once per provider: if the primary fails for
// any reason (rate limit, auth error, network), we move to the next.
// Everything processed so far is saved, so a mid-run failure is recoverable.
// ============================================================================

// ---------------------------------------------------------------------------
// Provider 1: Jina AI (HTTP, no SDK needed)
// ---------------------------------------------------------------------------

async function jinaEmbed(texts: string[]): Promise<number[][]> {
  const apiKey = config.jinaApiKey;
  if (!apiKey) {
    throw new Error("JINA_API_KEY not set");
  }
  const res = await fetch(`${config.jinaBaseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.jinaEmbeddingModel,
      input: texts,
      task: "text-matching", // optimal for semantic similarity / dedup
      dimensions: config.embeddingDims, // match pgvector column (768)
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jina ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: { embedding: number[] }[];
  };
  const embeddings = json.data ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Jina returned ${embeddings.length} vectors for ${texts.length} inputs`
    );
  }
  return embeddings.map((e) => e.embedding);
}

// ---------------------------------------------------------------------------
// Provider 2: OpenAI
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | undefined;

function getOpenAI(): OpenAI {
  const apiKey = config.openaiApiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }
  openaiClient ??= new OpenAI({ apiKey });
  return openaiClient;
}

async function openaiEmbed(texts: string[]): Promise<number[][]> {
  const res = await getOpenAI().embeddings.create({
    model: config.openaiEmbeddingModel,
    input: texts,
    dimensions: config.embeddingDims, // truncate to match bank (768)
  });
  if (res.data.length !== texts.length) {
    throw new Error(
      `OpenAI returned ${res.data.length} vectors for ${texts.length} inputs`
    );
  }
  // Return in the same order as input (OpenAI preserves order)
  return res.data.map((d) => d.embedding);
}

// ---------------------------------------------------------------------------
// Provider 3: Gemini (existing — judge, second-opinion, emergency embed)
// ---------------------------------------------------------------------------

let geminiClient: GoogleGenAI | undefined;

function genai(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set — get a free key at aistudio.google.com and put it in .env.local"
    );
  }
  geminiClient ??= new GoogleGenAI({ apiKey });
  return geminiClient;
}

// Google's docs: embeddings truncated below the native dims are no longer
// unit-length, so they MUST be re-normalized for cosine math to be correct.
function l2Normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  if (!(norm > 0)) {
    throw new Error("embedding has zero magnitude — API returned bad data");
  }
  return values.map((x) => x / norm);
}

async function geminiEmbed(texts: string[]): Promise<number[][]> {
  const res = await genai().models.embedContent({
    model: config.embeddingModel,
    contents: texts,
    config: {
      taskType: "SEMANTIC_SIMILARITY",
      outputDimensionality: config.embeddingDims,
    },
  });
  const embeddings = res.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Gemini returned ${embeddings.length} vectors for ${texts.length} inputs`
    );
  }
  return embeddings.map((e) => l2Normalize(e.values ?? []));
}

// ---------------------------------------------------------------------------
// Provider-agnostic embedding with tiered fallback
// ---------------------------------------------------------------------------

// Jina and OpenAI both accept up to 2,048 texts per request. 1,024 keeps
// memory comfortable while fitting 25 videos worth of questions in one go.
const EMBED_BATCH_SIZE = 1024;

// One retry per provider for transient failures (network blips).
const PROVIDER_RETRIES = 1;

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function tryProvider<T>(
  label: string,
  fn: () => Promise<T>,
  retries: number
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        console.warn(`${label} attempt ${attempt + 1} failed, retrying: ${msg.slice(0, 160)}`);
        await sleep(1);
      } else {
        console.warn(`${label} failed after ${retries + 1} attempts: ${msg.slice(0, 160)}`);
      }
    }
  }
  throw lastErr;
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

// Embed question texts, batched, L2-normalized, ledger-recorded.
// Tiered fallback: Jina → OpenAI → Gemini.
// Returns one vector per input text, in the same order.
export async function embedQuestions(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiCalls = Math.ceil(texts.length / EMBED_BATCH_SIZE);
  await assertUnderDailyCap(apiCalls);

  const db = await getDb();
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    let batchVectors: number[][] | undefined;
    let providerUsed = "";

    // --- Tier 1: Jina AI (primary) ---
    if (config.jinaApiKey) {
      try {
        batchVectors = await tryProvider(
          "Jina embed",
          () => jinaEmbed(batch),
          PROVIDER_RETRIES
        );
        providerUsed = config.jinaEmbeddingModel;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Jina embed failed, trying OpenAI: ${msg.slice(0, 160)}`);
      }
    }

    // --- Tier 2: OpenAI (fallback) ---
    if (!batchVectors && config.openaiApiKey) {
      try {
        batchVectors = await tryProvider(
          "OpenAI embed",
          () => openaiEmbed(batch),
          PROVIDER_RETRIES
        );
        providerUsed = config.openaiEmbeddingModel;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`OpenAI embed failed, trying Gemini: ${msg.slice(0, 160)}`);
      }
    }

    // --- Tier 3: Gemini (emergency fallback) ---
    if (!batchVectors) {
      try {
        batchVectors = await tryProvider(
          "Gemini embed",
          () => geminiEmbed(batch),
          PROVIDER_RETRIES
        );
        providerUsed = config.embeddingModel;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `All embedding providers failed for batch: ${msg.slice(0, 200)}`
        );
      }
    }

    // Ledger entry — one row per API batch (not per text).
    if (providerUsed) {
      await db
        .insert(qbAiUsage)
        .values({ model: providerUsed, kind: "embed", tokens: null });
    }

    // All providers return normalized vectors, but re-normalizing is
    // idempotent — safe to always call for consistency.
    for (const vec of batchVectors!) {
      vectors.push(l2Normalize(vec));
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

// Reject if a promise doesn't settle within ms — so one congested Gemma
// attempt can't stall the whole run.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Run a prompt through the judge chain, expecting JSON back. One attempt per
// model (the chain itself is the retry), each bounded by judgeTimeoutMs.
// Records one ledger row per successful API call (even if its JSON later
// fails to parse — the tokens were spent).
async function generateJson(prompt: string, kind: string): Promise<unknown> {
  await assertUnderDailyCap(1);
  const db = await getDb();
  let lastErr: unknown;
  for (const model of config.judgeModels) {
    try {
      const res = await withTimeout(
        genai().models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0 },
        }),
        config.judgeTimeoutMs,
        `${kind} via ${model}`
      );
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
      console.warn(`${kind} via ${model} failed: ${msg.slice(0, 160)}`);
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
// Uses Gemini embedding-2 as the independent space (low volume, stays
// within free tier limits since it's only called when judge fails).
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
