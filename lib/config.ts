// All tunables live here, env-driven with defaults (config over code).
// Getters read process.env lazily so import order never matters.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // ---------------------------------------------------------------------------
  // Embedding providers — tiered fallback: Jina (primary) → OpenAI → Gemini.
  // Jina's free tier is 2,000 RPM / 10M tokens with no card required.
  // OpenAI requires a payment method on file for any API access.
  // Gemini remains as the emergency fallback and powers judge/second-opinion.
  // ---------------------------------------------------------------------------

  get jinaApiKey() {
    return process.env.JINA_API_KEY;
  },
  get jinaBaseUrl() {
    return process.env.JINA_BASE_URL ?? "https://api.jina.ai/v1";
  },
  get jinaEmbeddingModel() {
    return process.env.JINA_EMBEDDING_MODEL ?? "jina-embeddings-v3";
  },

  get openaiApiKey() {
    return process.env.OPENAI_API_KEY;
  },
  get openaiEmbeddingModel() {
    return process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  },

  // Legacy Gemini embedding model — still used for emergency fallback and
  // second-opinion embeddings (independent space from the bank).
  get embeddingModel() {
    return process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
  },

  // Baked into the qb_questions DDL on first init — changing it later
  // requires dropping/recreating the table (embeddings are not comparable
  // across dimensionalities anyway).
  // Both Jina (jina-embeddings-v3) and OpenAI (with truncation) output 768
  // dims, so the bank stays compatible across the fallback chain.
  get embeddingDims() {
    return num("EMBEDDING_DIMS", 768);
  },

  // Judge model — Gemini 3.1 Flash Lite. Proven reliable in TUBEBOX
  // (same API key, 15 RPM / 250K TPM / 500 RPD on free tier).
  // Gemma models were deprecated due to chronic 500s and timeouts.
  // Override via JUDGE_MODELS env (comma-separated for chaining).
  get judgeModels(): string[] {
    return (process.env.JUDGE_MODELS ?? "gemini-3.1-flash-lite")
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

  // Judge fail-fast: cap each attempt so a congested model can't stall a
  // run — on timeout we drop to the deterministic second-opinion tiebreak.
  get judgeTimeoutMs() {
    return num("JUDGE_TIMEOUT_MS", 25000);
  },

  // cosine >= match → duplicate (variant); < review → new canonical;
  // in between → judge decides.
  get matchThreshold() {
    return num("MATCH_THRESHOLD", 0.92);
  },
  get reviewThreshold() {
    return num("REVIEW_THRESHOLD", 0.8);
  },

  get maxUploadFiles() {
    return num("MAX_UPLOAD_FILES", 5);
  },

  // Videos per /api/sync request. Each chunk COMMITS before the next, so a
  // mid-run failure or the daily embedding cap can't wipe the whole run.
  // Raised from 3 → 25 now that the embedding bottleneck (Google's 100
  // texts/min) is removed. Jina/OpenAI both comfortably handle 25 videos
  // worth of questions in a single batch (up to 1,024 texts per request).
  get syncBatchSize() {
    return num("SYNC_BATCH_SIZE", 25);
  },

  // App-level safety net across ALL AI calls (embed/judge/extract) per UTC day.
  get aiDailyLimit() {
    return num("AI_DAILY_LIMIT", 1000);
  },

  // Fixed section taxonomy (option c): the ONLY headings the master list can
  // use. Each canonical question is filed under the label whose description
  // its embedding is closest to — deterministic, no LLM, always consistent.
  // Order here is the display order. Override via TAXONOMY env (JSON array of
  // {name, description}); editing it re-files everything on the next sync.
  get taxonomy(): { name: string; description: string }[] {
    const raw = process.env.TAXONOMY;
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // fall through to default
      }
    }
    return DEFAULT_TAXONOMY;
  },
};

// Descriptions are keyword-rich on purpose — they are embedded and compared
// against question embeddings, so more surface area = better routing.
const DEFAULT_TAXONOMY: { name: string; description: string }[] = [
  {
    name: "Project",
    description:
      "The candidate's own current project: its architecture, tech stack, request flow, responsibilities, optimizations, and real work experience.",
  },
  {
    name: "Coding Questions",
    description:
      "Hands-on Java coding problems and the Stream API: streams, map, flatMap, filter, intermediate and terminal operations, lambdas, functional programming, predict the output.",
  },
  {
    name: "Java Core",
    description:
      "Core Java language concepts: OOP, classes, objects, interfaces, records, sealed classes, constructors, static, final, exceptions, keywords, Optional, enums, functional interfaces.",
  },
  {
    name: "Collections",
    description:
      "Java Collections Framework: List, Set, Map, ArrayList, LinkedList, HashMap, ConcurrentHashMap, HashSet, Comparable, Comparator, and their internal working.",
  },
  {
    name: "Concurrency & Multithreading",
    description:
      "Threads and concurrency: multithreading, synchronization, race conditions, ExecutorService, thread pools, atomic classes, locks, volatile, deadlocks.",
  },
  {
    name: "JVM & Memory",
    description:
      "JVM internals and memory: heap, stack, JVM memory structure, garbage collection, memory leaks, OutOfMemoryError, class loading.",
  },
  {
    name: "Spring & Spring Boot",
    description:
      "Spring and Spring Boot framework: dependency injection, auto-configuration, beans, profiles, annotations, filters, interceptors, request validation, exception handling.",
  },
  {
    name: "Microservices & Architecture",
    description:
      "Microservices architecture: service-to-service communication, monolith vs microservices, API gateway, resilience, saga pattern, distributed systems.",
  },
  {
    name: "Databases & JPA",
    description:
      "Databases and persistence: SQL queries, indexes, joins, JPA, Hibernate, ORM, transactions, cascade types, database design and query optimization.",
  },
  {
    name: "Kafka & Messaging",
    description:
      "Kafka and messaging: topics, partitions, consumer groups, producers, offsets, duplicate message handling, event streaming, message queues.",
  },
  {
    name: "DevOps & Cloud",
    description:
      "DevOps and cloud: Kubernetes, pods, Docker, containers, CI/CD, blue-green deployment, canary deployment, Maven build lifecycle, cloud infrastructure.",
  },
  {
    name: "Patterns & System Design (LLD, HLD)",
    description:
      "Design patterns and system design: singleton, factory, builder, SOLID principles, low-level design (LLD), high-level design (HLD), design a parking lot, scalable system design.",
  },
  {
    name: "Scenario",
    description:
      "Scenario and situational questions: 'what would you do if', troubleshooting a production issue, debugging a described situation, handling a specific given edge case.",
  },
  {
    name: "Security & Authentication",
    description:
      "Security: authentication, authorization, JWT, OAuth, encryption, hashing, secure APIs, common vulnerabilities.",
  },
  {
    name: "GraphQL",
    description:
      "GraphQL APIs: schema, queries, mutations, resolvers, and how it compares to REST.",
  },
];
