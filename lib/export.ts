import { asc } from "drizzle-orm";
import { getDb } from "./db";
import { qbQuestions, qbQuestionSources } from "./schema";
import { assignSection, loadLabels } from "./taxonomy";
import { config } from "./config";

// Assemble the master list: every canonical question, filed under the fixed
// taxonomy (each question's section = nearest label to its embedding, done
// in-memory here so it always reflects the current taxonomy), with "asked
// in N sources" counts. Pure read — no AI calls (labels are embedded during
// sync). Sections appear in the taxonomy's configured order.

export type ExportQuestion = { id: number; text: string; count: number };
export type ExportSection = { name: string; questions: ExportQuestion[] };
export type ExportData = {
  sections: ExportSection[];
  totalUnique: number;
  totalAsked: number;
  generatedAt: string;
};

const FALLBACK_SECTION = "Other";

function toVec(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") return JSON.parse(v);
  return [];
}

export async function assembleExport(): Promise<ExportData> {
  const db = await getDb();
  const questions = await db
    .select({
      id: qbQuestions.id,
      text: qbQuestions.text,
      embedding: qbQuestions.embedding,
    })
    .from(qbQuestions)
    .orderBy(asc(qbQuestions.id));
  const sources = await db
    .select({ questionId: qbQuestionSources.questionId })
    .from(qbQuestionSources);
  const labels = await loadLabels();

  const counts = new Map<number, number>();
  for (const s of sources) {
    counts.set(s.questionId, (counts.get(s.questionId) ?? 0) + 1);
  }

  const bySection = new Map<string, ExportQuestion[]>();
  for (const q of questions) {
    const section = assignSection(toVec(q.embedding), labels);
    const list = bySection.get(section) ?? [];
    list.push({ id: q.id, text: q.text, count: counts.get(q.id) ?? 0 });
    bySection.set(section, list);
  }

  // Emit sections in the taxonomy's configured order; "Other" (unmatched)
  // last. Within a section, most-asked first.
  const order = config.taxonomy.map((t) => t.name);
  order.push(FALLBACK_SECTION);
  const sections: ExportSection[] = [];
  for (const name of order) {
    const qs = bySection.get(name);
    if (qs && qs.length > 0) {
      sections.push({
        name,
        questions: qs.sort((a, b) => b.count - a.count || a.id - b.id),
      });
    }
  }

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
