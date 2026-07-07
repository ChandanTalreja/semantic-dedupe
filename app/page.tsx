"use client";

import { useCallback, useEffect, useState } from "react";

// The master-list page. On load it shows the current bank immediately.
// Preview runs one combined sync pass over all pending TUBEBOX videos, then
// re-renders the merged master list. Download saves the same document as
// .md — only when clicked.

type ExportQuestion = { id: number; text: string; count: number };
type ExportSection = { name: string; questions: ExportQuestion[] };
type ExportData = {
  sections: ExportSection[];
  totalUnique: number;
  totalAsked: number;
  generatedAt: string;
  markdown: string;
};

type Processed = {
  title: string;
  questionCount: number;
  created: number;
  attached: number;
  skipped: number;
  undecided: number;
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

  const loadDocument = useCallback(async () => {
    const res = await fetch("/api/export");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setDoc(data);
  }, []);

  useEffect(() => {
    // show the existing master list immediately on load
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDocument().catch((e) =>
      setError(e instanceof Error ? e.message : "failed to load")
    );
  }, [loadDocument]);

  async function preview() {
    setBusy(true);
    setError(null);
    setStatus("Checking TUBEBOX for new videos…");
    // Accumulate across chunks — each /api/sync call handles a few videos
    // and commits; we loop until none remain, refreshing the document as we
    // go so progress is visible and durable.
    let videos = 0;
    let created = 0;
    let attached = 0;
    let undecided = 0;
    try {
      for (;;) {
        const res = await fetch("/api/sync", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const processed: Processed[] = data.processed;
        if (processed.length === 0 && videos === 0) {
          setStatus("No new videos — this is the current master list.");
          break;
        }
        for (const v of processed) {
          videos++;
          created += v.created;
          attached += v.attached;
          undecided += v.undecided;
        }
        await loadDocument(); // durable, visible progress after each chunk
        setStatus(
          `Merged ${videos} video(s): ${created} new questions, ${attached} matched` +
            (undecided > 0 ? ` · ${undecided} kept separate` : "") +
            (data.remaining > 0 ? ` — ${data.remaining} video(s) left…` : " — done.")
        );
        if (data.remaining === 0) break;
      }
    } catch (err) {
      setError(
        (err instanceof Error ? err.message : "something went wrong") +
          (videos > 0 ? ` (${videos} video(s) already saved)` : "")
      );
      await loadDocument().catch(() => {}); // partial progress is saved
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

  const hasContent = (doc?.totalUnique ?? 0) > 0;

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
        {hasContent && (
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

      {doc && !hasContent && !busy && (
        <p className="mt-10 text-zinc-500">
          The bank is empty — ask “List the interview questions” on your TUBEBOX
          videos, then hit <span className="font-bold uppercase">Preview</span>.
        </p>
      )}

      {hasContent && (
        <article className="mt-6 border-2 border-black bg-white p-8 shadow-[6px_6px_0_0_#000]">
          <h2 className="text-2xl font-black">
            Interview Questions — Master List
          </h2>
          <p className="mt-2 border-l-4 border-violet-300 pl-3 text-sm text-zinc-600">
            {doc!.totalUnique} unique questions from {doc!.totalAsked}{" "}
            appearances across sources · generated {doc!.generatedAt}
          </p>
          {doc!.sections.map((section) => (
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
    </main>
  );
}
