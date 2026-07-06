"use client";

import { useState } from "react";

// One button. Preview checks the database for videos not yet processed
// (everything already processed is cached and never redone), runs only the
// new ones through the dedupe engine, then opens the merged master list
// right here. Download saves the same document as .md — only when clicked.
// Nothing is fetched on page load.

type ExportQuestion = { id: number; text: string; count: number };
type ExportSection = { name: string; questions: ExportQuestion[] };
type ExportData = {
  sections: ExportSection[];
  totalUnique: number;
  totalAsked: number;
  generatedAt: string;
  markdown: string;
};

type Decision = {
  action: "attached" | "created" | "skipped";
  decidedBy?: string;
};
type ProcessedVideo = {
  title: string;
  questionCount: number;
  decisions: Decision[];
};

const btn =
  "border-2 border-black bg-white px-5 py-2.5 font-bold uppercase tracking-wide " +
  "shadow-[3px_3px_0_0_#000] active:translate-x-[3px] active:translate-y-[3px] " +
  "active:shadow-none disabled:pointer-events-none disabled:opacity-40";

export default function Home() {
  const [doc, setDoc] = useState<ExportData | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadDocument() {
    const res = await fetch("/api/export");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setDoc(data);
  }

  async function preview() {
    setBusy(true);
    setError(null);
    setStatus("Checking the database for new videos…");
    let videos = 0;
    let created = 0;
    let matched = 0;
    try {
      for (;;) {
        const res = await fetch("/api/sync", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const processed: ProcessedVideo[] = data.processed;
        if (processed.length === 0) break;
        let undecided = 0;
        for (const v of processed) {
          videos++;
          created += v.decisions.filter((d) => d.action === "created").length;
          matched += v.decisions.filter((d) => d.action === "attached").length;
          undecided += v.decisions.filter((d) => d.decidedBy === "fallback").length;
          setStatus(
            `Processed “${v.title}” — ${data.remaining} video(s) remaining…` +
              (undecided > 0
                ? ` (${undecided} kept separate: judges unavailable)`
                : "")
          );
        }
        if (data.remaining === 0) break;
      }
      setStatus(
        videos > 0
          ? `Merged ${videos} new video(s): ${created} new questions, ${matched} matched existing ones.`
          : "No new videos — this is the current master list."
      );
      await loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
      setStatus(null);
      // show whatever already exists — partial progress is saved progress
      try {
        await loadDocument();
      } catch {
        /* nothing to show yet */
      }
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!doc) return;
    const blob = new Blob([doc.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "interview-questions-master-list.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-black uppercase tracking-tight">
        semantic&#8209;dedupe
      </h1>
      <p className="text-sm text-zinc-600">
        One master list — duplicates matched by meaning, nothing ever lost.
      </p>

      <div className="mt-6 flex gap-3">
        <button className={`${btn} bg-violet-300`} disabled={busy} onClick={preview}>
          {busy ? "Working…" : "Preview"}
        </button>
        {doc && doc.totalUnique > 0 && (
          <button className={btn} disabled={busy} onClick={download}>
            Download .md
          </button>
        )}
      </div>

      {status && <p className="mt-4 text-sm font-semibold">{status}</p>}
      {error && (
        <p className="mt-4 border-2 border-black bg-red-100 px-3 py-2 text-sm font-semibold">
          {error}
        </p>
      )}

      {!doc && !busy && !error && (
        <p className="mt-10 text-zinc-500">
          Hit <span className="font-bold uppercase">Preview</span> to check for
          newly asked videos, merge them into the bank, and read the master
          list here.
        </p>
      )}

      {doc && doc.totalUnique > 0 && (
        <article className="mt-6 border-2 border-black bg-white p-8 shadow-[6px_6px_0_0_#000]">
          <h2 className="text-2xl font-black">
            Interview Questions — Master List
          </h2>
          <p className="mt-2 border-l-4 border-violet-300 pl-3 text-sm text-zinc-600">
            {doc.totalUnique} unique questions from {doc.totalAsked}{" "}
            appearances across sources · generated {doc.generatedAt}
          </p>
          {doc.sections.map((section) => (
            <section key={section.name} className="mt-6">
              <h3 className="border-b-2 border-black pb-1 text-lg font-black">
                {section.name}
              </h3>
              <ol className="mt-2 list-decimal space-y-1 pl-8">
                {section.questions.map((q) => (
                  <li key={q.id}>
                    {q.text}
                    {q.count > 1 && (
                      <em className="text-sm text-zinc-500">
                        {" "}
                        (asked in {q.count} sources)
                      </em>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </article>
      )}

      {doc && doc.totalUnique === 0 && (
        <p className="mt-10 text-zinc-500">
          The bank is empty — ask “List the interview questions” on your
          TUBEBOX videos first, then Preview again.
        </p>
      )}
    </main>
  );
}
