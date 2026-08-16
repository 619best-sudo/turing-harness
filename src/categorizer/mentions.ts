/**
 * `/` and `#` mention parsing.
 *
 * The client sends MCP servers and skills by mentioning them in the prompt
 * (`/skill-name`, `#mcp-name`, and `#path/to/file` for file mentions). v2 makes
 * those mentions first-class: every mention-resolved provider's tools are added
 * to EVERY categorizer's toolset, so wherever required they can be called — the
 * categorizer never has to "own" a tool someone attached by name.
 *
 * Resolution is pragmatic, not strict:
 *   - `/x` counts only when a skill/MCP provider matches x (a leading-slash path
 *     in prose stays prose);
 *   - `#x` matches providers first, then falls back to a real file path relative
 *     to the cwd (a file mention becomes an attachment-like input);
 *   - unknown tokens are surfaced to the model so it can say "no such skill"
 *     instead of silently ignoring the user's mention.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Registry } from "../registry/registry.js";
import type { AgentTool } from "../types.js";

export interface MentionResolution {
  /** Provider ids the mentions resolved to (skills + MCP servers). */
  providers: string[];
  /** Tools from those providers, to be added to every categorizer's toolset. */
  tools: AgentTool[];
  /** File paths the mentions resolved to (relative-or-absolute, cwd-resolved). */
  files: string[];
  /** Tokens that looked like mentions but resolved to nothing. */
  unknown: string[];
}

/** Tokens starting with `/` or `#` in running text (not inside URLs/paths). */
export function extractMentionTokens(text: string): string[] {
  const out: string[] = [];
  const re = /(^|\s)([/#])([A-Za-z0-9_][A-Za-z0-9_.\-/]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[2] + m[3]);
  }
  return [...new Set(out)];
}

/**
 * Resolve mention tokens against the registry (by provider id, name, and
 * `builtin:`-stripped id) and the filesystem. Pure-ish: filesystem probes are
 * existence checks only.
 */
export async function resolveMentions(
  tokens: string[],
  registry: Registry,
  cwd: string,
): Promise<MentionResolution> {
  const providers = new Set<string>();
  const tools: AgentTool[] = [];
  const files: string[] = [];
  const unknown: string[] = [];
  const items = registry.list();

  const matchProvider = (token: string) => {
    const bare = token.slice(1); // strip the leading / or #
    const lower = bare.toLowerCase();
    const item = items.find(
      (p) =>
        p.id.toLowerCase() === lower ||
        p.name.toLowerCase() === lower ||
        p.id.replace(/^.*:/, "").toLowerCase() === lower,
    );
    return item;
  };

  for (const token of tokens) {
    const slash = token.startsWith("/");
    const item = matchProvider(token);
    if (item && (item.kind === "skill" || item.kind === "mcp")) {
      providers.add(item.id);
      continue;
    }
    if (!slash) {
      // `#token` may be a file mention.
      const rel = token.slice(1);
      const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile()) {
          files.push(abs);
          continue;
        }
      } catch {
        // not a file either
      }
    }
    unknown.push(token);
  }

  // Resolve the executable tools for matched providers in one pass.
  if (providers.size) {
    for (const item of items) {
      if (!providers.has(item.id)) continue;
      for (const t of registry.allTools()) {
        // A tool belongs to a provider when its name is in the provider's list.
        if (item.tools.some((d) => d.name === t.name) && !tools.some((x) => x.name === t.name)) {
          tools.push(t);
        }
      }
    }
  }

  return { providers: [...providers], tools, files, unknown };
}

/**
 * Build the mention block for a categorizer's opening message: what the user
 * mentioned, what resolved, and what to do with unresolved tokens.
 */
export function renderMentionNote(res: MentionResolution): string | undefined {
  if (!res.providers.length && !res.files.length && !res.unknown.length) return undefined;
  const lines: string[] = [];
  if (res.providers.length) {
    lines.push(
      `USER-MENTIONED CAPABILITIES (their tools are attached to you regardless of category): ${res.providers.join(", ")}.`,
    );
  }
  if (res.files.length) {
    lines.push(`USER-MENTIONED FILES: ${res.files.join(", ")}.`);
  }
  if (res.unknown.length) {
    lines.push(
      `UNRECOGNIZED MENTIONS: ${res.unknown.join(", ")} — no such skill/MCP/file is registered; ` +
        `say so if the user expected one, then carry on.`,
    );
  }
  return lines.join("\n");
}
