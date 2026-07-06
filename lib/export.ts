import { asc } from "drizzle-orm";
import { getDb } from "./db";
import { qbQuestions, qbQuestionSources, qbSectionMap } from "./schema";

// Assemble the master list: every canonical question, grouped under
// reconciled section headings, with "asked in N sources" counts. Pure read
// — section-name reconciliation is computed (and cached) during sync, and
// any heading not yet in the cache falls back to its raw name.

export type ExportQuestion = { id: number; text: string; count: number };
export type ExportSection = { name: string; questions: ExportQuestion[] };
export type ExportData = {
  sections: ExportSection[];
  totalUnique: number;
  totalAsked: number;
  generatedAt: string;
};

const FALLBACK_SECTION = "Other";

export async function assembleExport(): Promise<ExportData> {
  const db = await getDb();
  const questions = await db
    .select({ id: qbQuestions.id, text: qbQuestions.text })
    .from(qbQuestions)
    .orderBy(asc(qbQuestions.id));
  const sources = await db
    .select({
      questionId: qbQuestionSources.questionId,
      section: qbQuestionSources.section,
    })
    .from(qbQuestionSources)
    .orderBy(asc(qbQuestionSources.id));
  const mapRows = await db.select().from(qbSectionMap);
  const canonicalName = new Map(mapRows.map((r) => [r.raw, r.canonical]));

  // Per question: variant count + the most common section among its
  // variants (earliest seen wins ties).
  const counts = new Map<number, number>();
  const sectionVotes = new Map<number, Map<string, number>>();
  for (const s of sources) {
    counts.set(s.questionId, (counts.get(s.questionId) ?? 0) + 1);
    if (s.section) {
      const mapped = canonicalName.get(s.section) ?? s.section;
      const votes = sectionVotes.get(s.questionId) ?? new Map();
      votes.set(mapped, (votes.get(mapped) ?? 0) + 1);
      sectionVotes.set(s.questionId, votes);
    }
  }

  const bySection = new Map<string, ExportQuestion[]>();
  for (const q of questions) {
    let best = FALLBACK_SECTION;
    let bestVotes = 0;
    for (const [name, votes] of sectionVotes.get(q.id) ?? []) {
      if (votes > bestVotes) {
        best = name;
        bestVotes = votes;
      }
    }
    const list = bySection.get(best) ?? [];
    list.push({ id: q.id, text: q.text, count: counts.get(q.id) ?? 0 });
    bySection.set(best, list);
  }

  const sections = [...bySection.entries()]
    .map(([name, qs]) => ({
      name,
      questions: qs.sort((a, b) => b.count - a.count || a.id - b.id),
    }))
    // biggest sections first; "Other" always last
    .sort((a, b) => {
      if (a.name === FALLBACK_SECTION) return 1;
      if (b.name === FALLBACK_SECTION) return -1;
      return b.questions.length - a.questions.length;
    });

  return {
    sections,
    totalUnique: questions.length,
    totalAsked: sources.length,
    generatedAt: new Date().toISOString().slice(0, 10),
  };
}

export function toMarkdown(data: ExportData): string {
  const lines: string[] = [
    "# Interview Questions — Master List",
    "",
    `> ${data.totalUnique} unique questions from ${data.totalAsked} appearances across sources · generated ${data.generatedAt}`,
    "",
  ];
  for (const section of data.sections) {
    lines.push(`## ${section.name}`, "");
    let n = 1;
    for (const q of section.questions) {
      const marker = q.count > 1 ? ` *(asked in ${q.count} sources)*` : "";
      lines.push(`${n}. ${q.text}${marker}`);
      n++;
    }
    lines.push("");
  }
  return lines.join("\n");
}
