/**
 * Internal tool: assets_generator (req #6).
 *
 * Generates image / video / audio / 3d assets. Generation backends are pluggable:
 * pass your own {@link AssetBackend} functions (calling whatever provider you use).
 * When a modality has no backend configured, a deterministic local placeholder is
 * written so the 4P pipeline still runs end-to-end (and Perfect can audit it).
 *
 * The tool returns the asset by reference (address + summary), never inlining the
 * bytes into the tool result, per req #7.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { AgentTool, MediaRef, ToolContext } from "../../types.js";

export type AssetKind = "image" | "video" | "audio" | "3d";

export interface AssetRequest {
  kind: AssetKind;
  prompt: string;
  /** Output directory (absolute or relative to cwd). Defaults to `<cwd>/assets`. */
  outDir?: string;
  /** Optional filename (without extension). */
  name?: string;
  /** Modality-specific options (size, duration, voice, format...). */
  options?: Record<string, unknown>;
}

export interface AssetResult {
  uri: string;
  mimeType: string;
  size: number;
  summary: string;
}

/** A backend produces the bytes for one asset kind. */
export type AssetBackend = (req: AssetRequest, ctx: ToolContext) => Promise<{ bytes: Uint8Array; mimeType: string; ext: string; summary?: string }>;

export interface AssetBackends {
  image?: AssetBackend;
  video?: AssetBackend;
  audio?: AssetBackend;
  "3d"?: AssetBackend;
}

// ---------------------------------------------------------------------------
// Deterministic placeholders (used when no backend is configured)
// ---------------------------------------------------------------------------

function hashColor(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `#${h.slice(0, 6)}`;
}

const placeholderBackends: Required<AssetBackends> = {
  async image(req) {
    const color = hashColor(req.prompt);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${color}"/><text x="256" y="256" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle" dominant-baseline="middle">${escapeXml(req.prompt).slice(0, 60)}</text></svg>`;
    return { bytes: new TextEncoder().encode(svg), mimeType: "image/svg+xml", ext: "svg", summary: `Placeholder image for: ${req.prompt}` };
  },
  async audio(req) {
    // Minimal valid silent WAV (44-byte header + tiny data chunk).
    return { bytes: silentWav(), mimeType: "audio/wav", ext: "wav", summary: `Placeholder silent audio for: ${req.prompt}` };
  },
  async video(req) {
    // No trivially-valid tiny mp4; emit a manifest describing the intended video.
    const manifest = JSON.stringify({ kind: "video-placeholder", prompt: req.prompt, options: req.options }, null, 2);
    return { bytes: new TextEncoder().encode(manifest), mimeType: "application/json", ext: "video.json", summary: `Placeholder video manifest for: ${req.prompt}` };
  },
  "3d": async (req) => {
    // A tiny valid OBJ (unit triangle) as a stand-in 3d asset.
    const obj = "o placeholder\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    return { bytes: new TextEncoder().encode(obj), mimeType: "model/obj", ext: "obj", summary: `Placeholder 3d object for: ${req.prompt}` };
  },
};

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
}

function silentWav(): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true); writeStr(36, "data"); view.setUint32(40, 0, true);
  return header;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface AssetsGeneratorConfig {
  backends?: AssetBackends;
  /** Default output directory relative to cwd. */
  defaultOutDir?: string;
}

export function createAssetsGeneratorTool(config: AssetsGeneratorConfig = {}): AgentTool<any, AssetResult> {
  return {
    name: "assets_generator",
    description:
      "Generate an image, video, audio, or 3d object from a text prompt. Returns the asset by reference (path + summary), not inline bytes.",
    mutates: true,
    phases: ["perform"],
    complexityHint: 0.6,
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "video", "audio", "3d"], description: "Asset type to generate." },
        prompt: { type: "string", description: "What to generate." },
        name: { type: "string", description: "Optional output filename (no extension)." },
        outDir: { type: "string", description: "Output directory (default <cwd>/assets)." },
        options: { type: "object", description: "Backend-specific options (size, duration, voice...)." },
      },
      required: ["kind", "prompt"],
    },
    async execute(_id, args, ctx): Promise<{ output: string; details: AssetResult; content: any[] }> {
      const kind = args.kind as AssetKind;
      const req: AssetRequest = {
        kind,
        prompt: String(args.prompt),
        outDir: args.outDir ? String(args.outDir) : undefined,
        name: args.name ? String(args.name) : undefined,
        options: (args.options as Record<string, unknown>) ?? {},
      };
      const backend = config.backends?.[kind] ?? placeholderBackends[kind];
      const usingPlaceholder = !config.backends?.[kind];

      ctx.log({
        timestamp: Date.now(),
        level: "info",
        tags: ["tool:assets_generator", "mutation", `asset:${kind}`],
        message: `generate ${kind}: ${req.prompt}${usingPlaceholder ? " (placeholder backend)" : ""}`,
      });

      const { bytes, mimeType, ext, summary } = await backend(req, ctx);
      const outDir = path.isAbsolute(req.outDir ?? "")
        ? (req.outDir as string)
        : path.join(ctx.cwd, req.outDir ?? config.defaultOutDir ?? "assets");
      await fs.mkdir(outDir, { recursive: true });
      const base = (req.name ?? slug(req.prompt)) || "asset";
      const file = path.join(outDir, `${base}.${ext}`);
      await fs.writeFile(file, bytes);

      const result: AssetResult = {
        uri: file,
        mimeType,
        size: bytes.byteLength,
        summary: summary ?? `Generated ${kind} for: ${req.prompt}`,
      };
      return {
        output: `Generated ${kind} → ${file} (${bytes.byteLength} bytes). ${result.summary}`,
        details: result,
        // Surface the asset by reference (address, not bytes) for downstream phases (req #7).
        content: [{ type: "file", uri: file, mimeType }],
      };
    },
  };
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
