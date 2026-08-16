/**
 * Shared per-image attachment triage.
 *
 * Runs the `media_analysis` tool at most twice over one image: a `describe` lens
 * to learn its ROLE (informational reference / a mockup to replicate / a defect
 * to fix), and — only when the image bears text the task should KNOW verbatim
 * (`informational` / `ui-bug`) — a second `ocr` lens to lift that text out.
 *
 * This is the exact logic the orchestrator runs as a pre-pass over the
 * attachments that arrived with the prompt. It lives here, extracted, so the
 * work loop can run the SAME triage on images a user hands over MID-RUN (in
 * answer to `ask_user_question`), which would otherwise reach the authoring pass
 * as undifferentiated pixels with no extracted text — a regression next to an
 * attachment supplied up front, which the user has understood by the time the
 * first write runs.
 *
 * Resilient by design: the OCR call is allowed to fail without consequence (it
 * is an enrichment, not a requirement). A describe failure leaves the image
 * un-enriched — the caller proceeds with a raw reference image, exactly as if
 * triage had never run.
 */
import type { AgentTool, LLMBridge, LogEntry, Usage } from "../types.js";
import type { LogStore } from "../logging/logger.js";
import type { Registry } from "../registry/registry.js";
import * as path from "node:path";

export interface TriageableImage {
  path: string;
  mimeType: string;
}

export interface TriagedImage extends TriageableImage {
  category?: string;
  ocr?: string;
  note?: string;
}

export interface TriageContext {
  tool: AgentTool;
  cwd: string;
  llm: LLMBridge;
  registry: Registry;
  logStore: LogStore;
  signal?: AbortSignal;
}

export interface TriageResult {
  result: TriagedImage;
  /**
   * Verbatim OCR text when the image bears any; for an `informational` image
   * whose OCR failed, the describe paraphrase so an OCR failure still seeds
   * SOMETHING. `ui-replicate`/`ui-bug` pixels travel via `images`, not text, so
   * they contribute a `fact` only when OCR actually returned text.
   */
  fact?: string;
  usage?: Usage;
}

/**
 * Render an enriched image entry's triaged role as a short human-readable note
 * for the loop-opening and step messages, so the model knows each image's
 * purpose (informational / ui-replicate / ui-bug) without re-running analysis.
 * Returns undefined for an un-triaged image so the AVAILABLE IMAGES line keeps
 * its original form.
 */
export function describeImageRole(img: {
  path?: string;
  mimeType?: string;
  category?: string;
  ocr?: string;
  note?: string;
}): string | undefined {
  if (img.note) return img.note;
  switch (img.category) {
    case "informational":
      return "informational — text/data the task should know (do NOT replicate as UI)";
    case "ui-replicate":
      return "UI to replicate (pass to write/edit images for vision authoring)";
    case "ui-bug":
      return "UI defect to fix (pointing at a bug)";
    case "other":
      return "reference image";
    default:
      return undefined;
  }
}

/**
 * Triage a single image: describe its role, then OCR it when it carries text
 * the task should know verbatim. Returns the enriched image (with `category`,
 * any `ocr`, and a `note`), the extractable `fact`, and accumulated `usage`.
 */
export async function triageImageAttachment(
  img: TriageableImage,
  task: string,
  ctx: TriageContext,
): Promise<TriageResult> {
  const { tool, cwd, llm, registry, logStore, signal } = ctx;
  const toolCtx = {
    cwd,
    llm,
    registry,
    ...(signal ? { signal } : {}),
    log: (e: LogEntry) => logStore.append(e),
  };

  let category: string | undefined;
  let ocr: string | undefined;
  let analysis: string | undefined;
  let usage: Usage | undefined;
  const onUsage = (u: Usage) => {
    usage = usage ? addUsage(usage, u) : u;
  };

  try {
    const res = await tool.execute(
      `triage-${img.path}`,
      {
        files: [img.path],
        lens: "describe",
        prompt: `For this attachment in the context of the task "${task}": what is its role?`,
      },
      toolCtx,
    );
    if (res.usage) onUsage(res.usage);
    const details = res.details as {
      category?: string;
      ocr?: { text?: string };
      analysis?: string;
    } | undefined;
    category = details?.category;
    analysis = details?.analysis;

    // Only text-bearing roles earn the second call. A `ui-replicate` mockup is
    // read off the pixels at authoring time, so OCR here would pay twice for
    // something the authoring pass already sees.
    if (category === "informational" || category === "ui-bug") {
      ocr = await extractOcrText(tool, img.path, toolCtx, onUsage);
    }
  } catch {
    // A describe/ocr failure leaves the image un-enriched; the caller treats it
    // as a raw reference image, exactly as if triage had never run.
  }

  const note = describeImageRole({ category, ocr });
  // The verbatim text is the better fact when we have it; the describe analysis
  // is the fallback for an informational image so an OCR failure still seeds
  // SOMETHING. A `ui-bug`/`ui-replicate` image contributes a fact only when OCR
  // actually returned text.
  const fact = ocr?.trim() || (category === "informational" ? analysis?.trim() : undefined);

  const result: TriagedImage = {
    path: img.path,
    mimeType: img.mimeType,
    ...(category ? { category } : {}),
    ...(ocr ? { ocr } : {}),
    ...(note ? { note } : {}),
  };
  return { result, ...(fact ? { fact } : {}), ...(usage ? { usage } : {}) };
}

/**
 * Run the `ocr` lens over one attachment and return the verbatim text.
 *
 * The one call in triage that is allowed to fail without consequence: OCR is an
 * enrichment, so a provider error, an image with no text in it, or an abort all
 * resolve to `undefined` and the triage falls back to the describe analysis.
 */
async function extractOcrText(
  tool: AgentTool,
  file: string,
  toolCtx: {
    cwd: string;
    llm: LLMBridge;
    registry: Registry;
    signal?: AbortSignal;
    log: (e: LogEntry) => void;
  },
  onUsage: (u: Usage) => void,
): Promise<string | undefined> {
  if (toolCtx.signal?.aborted) return undefined;
  try {
    const res = await tool.execute(
      `triage-ocr-${file}`,
      {
        files: [file],
        lens: "ocr",
        prompt:
          "Extract every piece of text in this attachment verbatim, preserving the reading order and " +
          "any structure (headings, labels, table rows, code, error codes). Do not interpret or summarise.",
      },
      toolCtx,
    );
    if (res.usage) onUsage(res.usage);
    const details = res.details as { ocr?: { text?: string }; analysis?: string } | undefined;
    const text = details?.ocr?.text ?? details?.analysis;
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cap on how much extracted document text is folded into `mediaFact`. A spec can
 * be dozens of pages; inlining all of it would dominate the authoring context.
 * The model still has the path (AVAILABLE FILES) and can `read` the whole thing
 * when it needs the part beyond the cap.
 */
const DOC_FACT_MAX = 6000;

const DOC_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".txt", ".md",
  ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".rtf", ".log",
]);
const DOC_MIME_PREFIXES = [
  "text/",
  "application/pdf",
  "application/json",
  "application/yaml",
  "application/vnd.openxmlformats",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/x-yaml",
];

/**
 * Whether a non-image attachment is a text-bearing DOCUMENT worth auto-extracting
 * (so its content reaches authoring via `mediaFact`, exactly as an image's OCR
 * does). Audio and video are deliberately excluded — they are surfaced by path
 * only, and the model transcribes/analyzes them on demand.
 */
export function isDocumentRef(file: { path: string; mimeType: string }): boolean {
  const ext = path.extname(file.path).toLowerCase();
  if (DOC_EXTENSIONS.has(ext)) return true;
  const mime = (file.mimeType || "").toLowerCase();
  return DOC_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

/**
 * Triage a document attachment: extract its content verbatim and return it as
 * the `fact` (capped at {@link DOC_FACT_MAX}), so a spec/data/reference doc the
 * user attached reaches the authoring pass automatically — the document analogue
 * of an image's OCR. Resilient like the image path: any failure leaves the file
 * path-only (still visible via AVAILABLE FILES); triage never blocks the run.
 */
export async function triageDocumentAttachment(
  file: { path: string; mimeType: string },
  task: string,
  ctx: TriageContext,
): Promise<TriageResult> {
  const { tool, cwd, llm, registry, logStore, signal } = ctx;
  const toolCtx = {
    cwd,
    llm,
    registry,
    ...(signal ? { signal } : {}),
    log: (e: LogEntry) => logStore.append(e),
  };
  let usage: Usage | undefined;
  const onUsage = (u: Usage) => {
    usage = usage ? addUsage(usage, u) : u;
  };
  let fact: string | undefined;
  try {
    const res = await tool.execute(
      `triage-doc-${file.path}`,
      {
        files: [file.path],
        lens: "describe",
        prompt:
          `Extract the content of this document verbatim, preserving its structure ` +
          `(headings, lists, tables, code, key values, error strings). This is reference ` +
          `material for the task: "${task}". Do not summarise — reproduce the actual text.`,
      },
      toolCtx,
    );
    if (res.usage) onUsage(res.usage);
    const details = res.details as { ocr?: { text?: string }; analysis?: string } | undefined;
    const text = details?.ocr?.text ?? details?.analysis;
    if (typeof text === "string" && text.trim()) {
      const trimmed = text.trim();
      fact =
        trimmed.length > DOC_FACT_MAX
          ? `${trimmed.slice(0, DOC_FACT_MAX)}\n…[truncated: ${trimmed.length} chars total — read the file for the rest]`
          : trimmed;
    }
  } catch {
    // enrichment only; failure leaves the document path-only (still surfaced).
  }
  const result: TriagedImage = { path: file.path, mimeType: file.mimeType };
  return { result, ...(fact ? { fact } : {}), ...(usage ? { usage } : {}) };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
