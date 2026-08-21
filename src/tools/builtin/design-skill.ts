/**
 * Design skill — the final structural reference when nothing else matched.
 *
 * The reference-sourcing ladder for a UI write/edit is:
 *
 *   1. an explicit reference IMAGE the model attached — replicated directly via
 *      `REPLICATE_FROM_IMAGE` in `authoring.ts`;
 *   2. `inspiration_generator` — a structured blueprint from the store, or one
 *      the harness auto-invokes on a no-image UI write (see `loop.ts`);
 *   3. THIS — when the store had no match (or `inspiration_generator` is not
 *      registered at all), and there is no image either.
 *
 * Without this rung the third case authors blind: the task text is all the
 * authoring model has, and "build a pricing page" produces an unstructured
 * guess at what a pricing page is. This module asks the model to FIRST design
 * the layout — emit the same `InspirationJson[]` shape `inspiration_generator`
 * returns — so the existing threading carries it into the authoring prompt
 * behind the SAME `DESIGN_REUSE_BOUNDARY`. The author then writes against a
 * coherent skeleton instead of inventing one while writing.
 *
 * Mirrors `design-reference-synthesis.ts`'s contract and shape, with two
 * differences: it takes no image (the no-image case is its whole reason to
 * exist), and it designs a COHERENT page rather than extracting one — so the
 * prompt stresses "design for THIS brief" rather than "extract from THIS
 * screen". Same role-not-literal discipline: it emits ROLE for text and color,
 * never invented copy or hex, so the boundary and the skill cannot disagree.
 *
 * Why an internal helper and not a model-invoked tool: the gap is precisely
 * that the model did not source a reference on its own. A tool the model must
 * remember to call re-creates the gap (model forgets → no reference). The
 * loop-driven trigger guarantees the authoring model always has a reference
 * when one is achievable. The pattern mirrors `comprehension.ts` /
 * `authoring.ts`: an internal LLM call inside the tool layer, so the runner
 * still reasons over no file content.
 *
 * Never throws. On any failure (network, parse, empty) it returns `undefined`,
 * and the caller proceeds with no designReference — exactly today's no-match
 * behavior. This matches `comprehension.ts`'s degrade-to-`low` philosophy, not
 * `authoring.ts`'s throw-on-empty: a skill failure forgoes a reference, it does
 * not corrupt a write.
 */
import type { Context, LLMBridge, Model, Usage } from "../../types.js";
import { emptyUsage } from "../../types.js";
import { parseJsonArrayLoose } from "../../robust-json.js";

/**
 * What the skill must emit, one per section of the designed page.
 *
 * Mirrors `InspirationJson` (`inspiration-generator.ts:100-130`) and
 * `SynthesizedSection` (`design-reference-synthesis.ts:49-60`) at the level the
 * consumer validates: `kind` must be a string (the harvester's single gate,
 * `loop.ts:designReferenceFromToolResult`). The inner geometry is intentionally
 * loose — the harness treats the whole thing as `unknown[]` and stringifies it,
 * so anything structurally useful the model emits survives verbatim into the
 * authoring prompt.
 */
export interface DesignedSection {
  kind: string;
  category?: string;
  name: string;
  description?: string;
  keywords?: string[];
  layout?: Record<string, unknown>;
  elements?: Array<Record<string, unknown>>;
  styles?: Record<string, unknown>;
  animation?: Record<string, unknown>;
  rationale?: Record<string, unknown>;
  /**
   * Typography ROLES per slot — e.g. `{ "heading": "display", "body": "text" }`.
   * Roles only, never font family names: agrees with DESIGN_REUSE_BOUNDARY
   * (authoring.ts), which maps roles to the project's own type system.
   */
  fonts?: Record<string, unknown>;
}

/**
 * Design instructions.
 *
 * Agrees with `DESIGN_REUSE_BOUNDARY` (`authoring.ts`) on what gets emitted:
 * role, not literal values. The skill's output is rendered into the SAME
 * authoring prompt the boundary governs, so if the skill invented copy or hex
 * the boundary would then have to forbid what the skill just handed it. The
 * skill emits ROLE — "primary CTA", "muted background", "trust signal" — so the
 * author maps roles to this project's content and tokens.
 *
 * The output shape is stated as a TypeScript-ish sketch rather than a JSON
 * Schema because models follow a concrete shape description more reliably than
 * a formal schema, and the consumer's validation is minimal anyway.
 */
const DESIGN_SKILL_SYSTEM = [
  "You are the design skill: the fallback when no reference image and no inspiration blueprint are",
  "available. A UI build is about to happen and the authoring model needs a structural skeleton; you design",
  "a COHERENT page for the brief, in the shape below. Design it for THIS product — do not reproduce some",
  "named site you remember.",
  "",
  "Emit a JSON ARRAY of section objects, one per region of the page in reading order (a top nav, a hero,",
  "each content section, a footer). The sections must COHERE — they are one page, not independent parts —",
  "so the hero introduces what the sections deliver and the footer closes it. Do not wrap the array in an",
  "object, do not fence it, do not add prose before or after — the raw JSON array only.",
  "",
  "Each section object has this shape:",
  "  {",
  "    \"kind\": \"web-ui\" | \"mobile-ui\" | \"poster\",            // REQUIRED, always a string",
  "    \"category\": \"navigation\" | \"hero\" | \"section\" | \"footer\" | \"background\",",
  "    \"name\": \"<a short structural name, e.g. 'split hero with product preview'>\",",
  "    \"description\": \"<one line on what the section IS structurally and why it is here>\",",
  "    \"keywords\": [\"<style tag>\", \"<component tag>\", ...],     // e.g. \"split\", \"hero\", \"pricing-tier\"",
  "    \"layout\": { \"type\": \"flex\"|\"grid\"|\"columns\", \"direction\": \"row\"|\"column\", \"gap\": \"<relative, e.g. '24px'>\", \"align\": \"...\" },",
  "    \"elements\": [",
  "      { \"role\": \"heading\"|\"subheading\"|\"paragraph\"|\"label\"|\"button\"|\"nav-link\"|\"image\"|\"icon\"|\"input\"|\"card\"|\"list\",",
  "        \"styles\": { ... relative metric hints ... } }",
  "    ],",
  "    \"styles\": { \"background\": \"<role, e.g. 'surface'>\", \"surface\": \"<role>\", \"radius\": \"<relative>\" },",
  "    \"fonts\": { \"heading\": \"<role: display|text|mono>\", \"body\": \"<role: text|mono>\", \"ui\": \"<role: text|mono>\" }",
  "  }",
  "",
  "ROLE, NOT LITERAL VALUES — this is the whole point, so do not skip it:",
  "  - For every piece of text, emit the ROLE (\"headline\", \"primary-cta\", \"trust-badge\") and NEVER invent",
  "    copy. The authoring model fills roles with the project's real content. Do not write headlines, labels,",
  "    or button text, even as a placeholder.",
  "  - For every color, emit the ROLE it plays (\"primary accent\", \"surface\", \"muted text\", \"primary",
  "    gradient\") and NEVER a hex value. The authoring model maps roles to THIS project's theme tokens.",
  "  - For TYPOGRAPHY, emit the ROLE each slot plays (\"display\", \"text\", \"mono\") and the relative size/",
  "    weight HIERARCHY — NEVER a font family name. The authoring model maps roles to THIS project's fonts.",
  "  - For images and icons, emit the ROLE (\"product photo\", \"decorative illustration\", \"checkmark\") with",
  "    its aspect ratio — never a filename, never a brand mark.",
  "  What you DO design: the layout grid, the spacing rhythm and RELATIVE sizes, the component anatomy and",
  "  the section order, the alignment, the rationale for why each section is here, and (if the brief asks for",
  "  motion) a per-region \"animation\" block with the trigger and the per-layer motion. Those are structure.",
  "",
  "Design toward the BRIEF. If the task names a domain (ecommerce, saas, health), choose sections that",
  "domain needs (a pricing tier, a dosage table, a trust strip). If it names a style (minimal, glassmorphism,",
  "brutalist), let it shape the layout and the keywords. If it implies motion (parallax, scroll-tied), add",
  "the animation block. Where the brief is silent, pick the boring competent default over the clever one.",
  "Output the JSON array only.",
].join("\n");

/**
 * Reasoning effort for the design call.
 *
 * `high`, for the same reason `AUTHORING_EFFORT` is `high` on a hard write
 * (`authoring.ts:390-426`): this call exists to do work the authoring pass
 * cannot do while also writing bytes, so it must think at the hardest effort
 * the provider offers. Effort, not a token ceiling, for the reason documented in
 * `comprehension.ts:89-109` — a reasoning token ceiling is near-meaningless on
 * OpenAI-family models and silently drops to the provider default.
 */
const DESIGN_SKILL_EFFORT = "high" as const;

export interface DesignSkillInput {
  llm: LLMBridge;
  /** The model that designs the page. Vision is not required (no image input). */
  model: Model;
  /** The originating task the chain is working on. */
  task?: string;
  /**
   * The path being authored, so the skill can infer `kind`
   * (`.tsx`/`.html` → web-ui, `.vue`/`.svelte` → mobile-ui is a weak signal but
   * better than nothing) and name the file in the framing.
   */
  path?: string;
  /** Current contents of the target file, when it already exists — for context. */
  currentContent?: string;
  signal?: AbortSignal;
}

export interface DesignSkillResult {
  /** The designed sections, each guaranteed to carry a string `kind`. */
  sections: DesignedSection[];
  usage: Usage;
}

/**
 * Design a structural page reference from the brief alone.
 *
 * Returns `undefined` on any failure — the caller then keeps `designReference`
 * unset, which is exactly today's no-match behaviour. This is the never-throws
 * contract: a skill failure only forgoes the reference, it never breaks the
 * write.
 */
export async function designReferenceFromBrief(
  input: DesignSkillInput,
): Promise<DesignSkillResult | undefined> {
  const context: Context = {
    systemPrompt: DESIGN_SKILL_SYSTEM,
    messages: [
      { role: "user", content: buildDesignMessage(input), timestamp: Date.now() },
    ],
  };

  let designText: string;
  let usage: Usage;
  try {
    const msg = await input.llm.complete(input.model, context, {
      temperature: 0,
      reasoning: DESIGN_SKILL_EFFORT,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    designText = extractText(msg.content).trim();
    usage = msg.usage ?? emptyUsage();
  } catch {
    return undefined;
  }
  if (!designText) return undefined;

  const sections = parseSections(designText);
  if (!sections.length) return undefined;
  return { sections, usage };
}

/** Build the user turn: the brief, plus whatever context the file provides. */
function buildDesignMessage(input: DesignSkillInput): string {
  const parts: string[] = [];
  if (input.path) {
    parts.push(
      `FILE TO AUTHOR: ${input.path} (kind hint: ${inferKindFromPath(input.path)})`,
    );
  }
  if (input.task) {
    parts.push(`BRIEF (design a coherent page for THIS):\n${input.task}`);
  } else {
    // A skill call with no task is malformed, but the never-throws contract
    // means we still produce something rather than fail. The model will design
    // a generic page for the inferred kind.
    parts.push("BRIEF: design a coherent page for the file above.");
  }
  if (input.currentContent) {
    parts.push(
      "EXISTING FILE (design toward what is already here, especially its theme tokens and component",
      "patterns; do not contradict them):\n```\n" +
        truncateForFraming(input.currentContent) +
        "\n```",
    );
  }
  parts.push("Output the JSON array of section objects now.");
  return parts.join("\n\n");
}

/**
 * Best-effort `kind` from the path, to seed the design. The model decides the
 * real value; this only frames it.
 */
function inferKindFromPath(file: string): string {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (ext === ".svg") return "poster";
  // `.vue`/`.svelte` skew toward mobile-style component layouts in practice,
  // but this is a weak signal — left as web-ui with the comment so a future
  // caller can refine it without changing the contract.
  return "web-ui";
}

/** Cap the existing-file framing so a huge file does not drown the brief. */
function truncateForFraming(text: string): string {
  const MAX = 6000;
  return text.length <= MAX ? text : `${text.slice(0, MAX)}\n…(truncated)`;
}

/**
 * Tolerant extraction of the JSON array the model emitted.
 *
 * Models wrap JSON in fences, prefix it with a sentence, or trail a closing
 * remark despite the instruction not to. A strict `JSON.parse` on the whole
 * text fails on any of those and silently disables the skill. We find the first
 * `[` ... last `]` and parse that, then keep only objects whose `kind` is a
 * string — the single field the harvester validates. Anything else the model
 * emitted that parses is kept, since the consumer stringifies verbatim.
 *
 * Returns an empty array (the caller treats empty as "no design") on any
 * failure — never throws. Shared shape with `design-reference-synthesis.ts`'s
 * parser; kept here rather than imported so the skill has no dependency on the
 * module it conceptually replaced.
 */
export function parseSections(text: string): DesignedSection[] {
  // `parseJsonArrayLoose` replaces what used to be a first-`[`-to-last-`]` slice:
  // that slice cannot tell a bracket inside a string from structure, and it threw
  // away a truncated array wholesale instead of keeping the sections that did
  // arrive.
  const parsed = parseJsonArrayLoose(text);
  if (!Array.isArray(parsed)) return [];
  const sections: DesignedSection[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    // `kind` is the ONLY field the harvester validates; without a string kind
    // the section is silently dropped by `designReferenceFromToolResult`, so it
    // is worthless to emit.
    if (typeof obj.kind !== "string") continue;
    if (!obj.kind.trim()) continue;
    const section = { ...obj } as unknown as DesignedSection;
    // `name` is required by the type; default it so the authoring prompt never
    // shows an unnamed section even on a terse model.
    if (typeof section.name !== "string" || !section.name.trim()) {
      section.name = `${section.kind} section`;
    }
    sections.push(section);
  }
  return sections;
}

/** Concatenate the text blocks out of an assistant message's content. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text)
    .join("");
}
