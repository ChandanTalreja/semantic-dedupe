import { assembleExport, toMarkdown } from "@/lib/export";

// GET /api/export — the master list as structured data + ready-to-download
// markdown. Pure read; safe on GET.

export async function GET() {
  try {
    const data = await assembleExport();
    return Response.json({ ...data, markdown: toMarkdown(data) });
  } catch (err) {
    console.error("export failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 }
    );
  }
}
