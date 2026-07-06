// All tunables live here, env-driven with defaults (config over code).
// Getters read process.env lazily so import order never matters.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  get embeddingModel() {
    return process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
  },
  // Baked into the qb_questions DDL on first init — changing it later
  // requires dropping/recreating the table (embeddings are not comparable
  // across dimensionalities anyway).
  get embeddingDims() {
    return num("EMBEDDING_DIMS", 768);
  },
  // Judge chain, tried in order (retry once per model). Gemma free tier
  // throws intermittent 500s — two models give two independent chances.
  // Ids verified against ListModels 2026-07.
  get judgeModels(): string[] {
    return (process.env.JUDGE_MODELS ?? "gemma-4-31b-it,gemma-4-26b-a4b-it")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  // Second-opinion embedding space (independent from the bank's model) used
  // when every judge model is down: deterministic tiebreak for gray-zone
  // pairs. Never stored — the bank stays in embeddingModel's space.
  get embedding2Model() {
    return process.env.EMBEDDING2_MODEL ?? "gemini-embedding-2";
  },
  get secondOpinionThreshold() {
    return num("SECOND_OPINION_THRESHOLD", 0.9);
  },
  // cosine >= match → duplicate (variant); < review → new canonical;
  // in between → Gemma judge decides.
  get matchThreshold() {
    return num("MATCH_THRESHOLD", 0.92);
  },
  get reviewThreshold() {
    return num("REVIEW_THRESHOLD", 0.8);
  },
  get maxUploadFiles() {
    return num("MAX_UPLOAD_FILES", 5);
  },
  // Videos per /api/sync request — keeps each request's work bounded
  // (~10s Netlify free-tier timeout) AND under the embedding free tier's
  // 100 requests/min, which counts each embedded text, not each API call.
  get syncBatchSize() {
    return num("SYNC_BATCH_SIZE", 1);
  },
  // App-level safety net across ALL AI calls (embed/judge/extract) per UTC day.
  get aiDailyLimit() {
    return num("AI_DAILY_LIMIT", 1000);
  },
};
