/**
 * Internal tool: ui_screen_auditor (req #6).
 *
 * Takes one or more images (or a video, by reference) plus a QA system prompt and
 * runs a vision model to perform visual QA — returning a pass/fail verdict and a
 * structured list of issues. Used primarily by the Perfect phase to verify UI work.
 *
 * Images are read from disk on demand (req #7: process the file only when needed).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, Context, ToolContext, UserContent } from "../../types.js";

export interface AuditFinding {
  severity: "critical" | "major" | "minor" | "nit";
  area: string;
  issue: string;
  suggestion?: string;
}

export interface AuditResult {
  pass: boolean;
  score: number;
  findings: AuditFinding[];
  summary: string;
}

const DEFAULT_AUDIT_MODEL = "google/gemini-2.5-flash";

const AUDIT_SYSTEM = `You are a meticulous UI/visual QA auditor. You are given screenshots (or video frames) and acceptance criteria.
Inspect the visuals for: layout/alignment issues, overflow/clipping, contrast/readability, spacing, broken images, inconsistent styling, and whether the stated criteria are met.
Respond with STRICT JSON only, matching:
{"pass": boolean, "score": number (0..1), "summary": string, "findings": [{"severity":"critical|major|minor|nit","area":string,"issue":string,"suggestion":string}]}
"pass" must be false if any "critical" or "major" finding exists or a criterion is unmet.`;

function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    }[ext] ?? "image/png"
  );
}

export interface UiScreenAuditorConfig {
  /** Model slug used for the vision pass (default gemini flash). */
  model?: string;
}

export function createUiScreenAuditorTool(config: UiScreenAuditorConfig = {}): AgentTool<any, AuditResult> {
  return {
    name: "ui_screen_auditor",
    description:
      "Visual QA of screenshots/video against acceptance criteria using a vision model. Returns pass/fail + structured findings.",
    mutates: false,
    phases: ["perfect"],
    complexityHint: 0.5,
    parameters: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string" },
          description: "Paths to screenshot image files to audit.",
        },
        video: { type: "string", description: "Optional path to a video file (audited by reference)." },
        systemPrompt: { type: "string", description: "The QA acceptance criteria / what to check for." },
        model: { type: "string", description: "Override the vision model slug." },
      },
      required: ["systemPrompt"],
    },
    async execute(_id, args, ctx): Promise<{ output: string; details: AuditResult; isError?: boolean }> {
      if (!ctx.llm) {
        return {
          output: "ui_screen_auditor requires an LLM bridge in the tool context.",
          isError: true,
          details: { pass: false, score: 0, findings: [], summary: "no llm bridge" },
        };
      }
      const criteria = String(args.systemPrompt);
      const imagePaths = (args.images as string[] | undefined) ?? [];
      const videoPath = args.video ? String(args.video) : undefined;

      ctx.log({
        timestamp: Date.now(),
        level: "info",
        tags: ["tool:ui_screen_auditor", "verify"],
        message: `audit ${imagePaths.length} image(s)${videoPath ? " + video" : ""}`,
      });

      const content: UserContent[] = [
        { type: "text", text: `Acceptance criteria:\n${criteria}` },
      ];

      for (const p of imagePaths) {
        const abs = path.isAbsolute(p) ? p : path.join(ctx.cwd, p);
        try {
          const bytes = await fs.readFile(abs);
          content.push({ type: "image", data: bytes.toString("base64"), mimeType: guessMime(abs) });
        } catch (err) {
          content.push({ type: "text", text: `[could not read image ${abs}: ${(err as Error).message}]` });
        }
      }
      if (videoPath) {
        // Carried by reference; a video-capable model can be pointed at it, otherwise
        // we surface the address so the auditor knows it exists.
        const abs = path.isAbsolute(videoPath) ? videoPath : path.join(ctx.cwd, videoPath);
        content.push({ type: "video", uri: abs, mimeType: "video/mp4" });
      }

      const slug = args.model ? String(args.model) : ctx.model?.openRouterSlug ?? config.model ?? DEFAULT_AUDIT_MODEL;
      const model = ctx.llm.resolveModel(slug);
      const context: Context = { systemPrompt: AUDIT_SYSTEM, messages: [{ role: "user", content, timestamp: Date.now() }] };

      const msg = await ctx.llm.complete(model, context, { temperature: 0, signal: ctx.signal });
      const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
      const result = parseAudit(text);
      return {
        output: `Audit ${result.pass ? "PASSED" : "FAILED"} (score ${result.score.toFixed(2)}). ${result.summary}\n${result.findings
          .map((f) => `- [${f.severity}] ${f.area}: ${f.issue}`)
          .join("\n")}`,
        details: result,
      };
    },
  };
}

function parseAudit(text: string): AuditResult {
  const json = extractJson(text);
  if (json) {
    try {
      const parsed = JSON.parse(json) as Partial<AuditResult>;
      return {
        pass: parsed.pass ?? false,
        score: typeof parsed.score === "number" ? parsed.score : parsed.pass ? 1 : 0,
        findings: parsed.findings ?? [],
        summary: parsed.summary ?? "",
      };
    } catch {
      /* fall through */
    }
  }
  return { pass: false, score: 0, findings: [], summary: `Could not parse audit output: ${text.slice(0, 200)}` };
}

function extractJson(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return undefined;
}
