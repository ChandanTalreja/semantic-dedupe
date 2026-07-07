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
  // Judge fail-fast: cap each attempt so a congested Gemma can't stall a
  // run — on timeout we drop to the deterministic second-opinion tiebreak.
  get judgeTimeoutMs() {
    return num("JUDGE_TIMEOUT_MS", 25000);
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
  // Videos per /api/sync request. Each chunk COMMITS before the next, so a
  // mid-run failure or the daily embedding cap can't wipe the whole run —
  // you keep every chunk that finished. Small keeps the loss window small.
  get syncBatchSize() {
    return num("SYNC_BATCH_SIZE", 3);
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
