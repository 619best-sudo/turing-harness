/**
 * Internal tool: inspiration_generator.
 *
 * Looks up reusable section blueprints from a keyword-indexed store (the
 * `turing-machine/inspiration` backend) and adapts them to the current
 * project's theme. Use it ONLY when you are about to build UI without a
 * reference image of your own: it hands you previously-extracted section
 * blueprints (layout, elements, animation) keyed by the tags that describe what
 * you are building.
 *
 * Two important behaviours:
 *
 * 1. **Section-scoped requests.** `sections` requests specific section kinds
 *    (`navigation` | `hero` | `section` | `footer` | `background`). The backend
 *    returns one blueprint per requested section — these can come from
 *    DIFFERENT stored designs (the best match per section, not one cohesive
 *    page). Only the requested sections are returned.
 *
 * 2. **Theme adaptation (NOT copying).** The blueprint is a STRUCTURAL
 *    reference. You must recolour it to the current project's palette, swap
 *    icons for the project's icon set, and regenerate/replace images per the
 *    project's theme. Never paste a borrowed design's hex colors, icons, or
 *    imagery verbatim — borrow the LAYOUT and RHYTHM, then re-skin it.
 *
 * The tool owns NO HTTP client. The host injects an {@link InspirationBackend}
 * (resolving credentials/base URL is the host's job, exactly like
 * `assets_generator`'s pluggable backends). When no backend is configured, or
 * the backend returns nothing, the tool returns a short "no match" note and
 * `isError: false` — the run continues without a reference, as requested.
 *
 * The structured `details` (the blueprint bundle) is meant for the host/tool
 * consumer, NOT for on-screen display: this is an internal tool and the host
 * decides whether to surface anything.
 */
import type { AgentTool, JSONSchema, ToolContext } from "../../types.js";

/**
 * High-level design kind. Parallax is NOT a kind — an animated/parallax site is
 * `web-ui` (or `mobile-ui`) carrying the `"parallax"` keyword tag plus an
 * `animation` block on the relevant section(s).
 */
export type InspirationKind = "web-ui" | "mobile-ui" | "poster";

export type InspirationCategory =
  | "navigation"
  | "hero"
  | "section"
  | "footer"
  | "background";

/** One keyframe in a scroll- or time-driven animation (see InspirationAnimation). */
export interface InspirationKeyframe {
  /** Unitless progress: 0..1 scroll progress, or seconds into a loop. */
  at: number;
  styles: Record<string, string>;
  easing?: string;
}

/** A single animated layer/element (parallax depth layer, floating element, ...). */
export interface InspirationAnimationLayer {
  id: string;
  trigger: "scroll" | "loop" | "hover" | "load";
  property?: string;
  keyframes?: InspirationKeyframe[];
  depth?: number;
  translateZ?: string;
  duration?: number;
  iterations?: number | "infinite";
  direction?: "normal" | "reverse" | "alternate";
  easing?: string;
}

/**
 * How a section animates. Mirrors the backend's `InspirationAnimation`. Lets the
 * consumer reproduce scroll-driven parallax / reveal or autonomous loops via CSS
 * scroll-timeline, IntersectionObserver + rAF, or a lib (Framer Motion/GSAP).
 */
export interface InspirationAnimation {
  type: "scroll-parallax" | "scroll-reveal" | "loop" | "hover" | "mixed";
  layers?: InspirationAnimationLayer[];
  scrollTrigger?: "window" | (string & {});
  scrollStart?: string;
  scrollEnd?: string;
  perspective?: string;
  easing?: string;
  duration?: number;
  /** True when the reference was a VIDEO and this was reverse-engineered from it. */
  fromVideo?: boolean;
  notes?: string;
}

/**
 * A stored section blueprint. Mirrors the `InspirationJson` shape on the
 * backend (`backend/src/database/entities/inspiration.entity.ts`) and the
 * contract the image-extraction prompt must emit. Kept loose here (records)
 * because the harness does not own the schema — the backend does.
 *
 * Note: `"parallax"` is a retrieval TAG (a member of `keywords`), not a kind.
 */
export interface InspirationJson {
  kind: InspirationKind;
  category: InspirationCategory;
  /** Groups the sections extracted from one reference (see the store's docs). */
  designId?: string;
  /**
   * WHY this section is shaped this way — the decision behind the focal element
   * and what its motion argues. Unlike the geometry, this is what survives a
   * change of brand, palette and copy, so it is the part a consumer should
   * actually reason from rather than reproduce.
   */
  rationale?: {
    heroElement?: string;
    whyThisElement?: string;
    businessGoal?: string;
    audience?: string;
    animationIntent?: string;
    journeyStage?: string;
  };
  name: string;
  description?: string;
  keywords?: string[];
  layout?: Record<string, unknown>;
  elements?: Array<Record<string, unknown>>;
  styles?: Record<string, unknown>;
  /**
   * Typography roles per slot (e.g. `{ "heading": "display", "body": "text" }).
   * Populated by the design skill; the inspiration backend does not own this
   * field (see the schema note above), so blueprints from the store will lack
   * it. Roles only — never font family names.
   */
  fonts?: Record<string, unknown>;
  /**
   * Parallax/scroll-animation spec; present only when `keywords` has an
   * animation tag (e.g. "parallax"). Often reverse-engineered from a video.
   */
  animation?: InspirationAnimation;
}

export interface InspirationBackendInput {
  /**
   * Free-form tags. Always includes `style` and `category` when they were given,
   * so a backend that only indexes keywords keeps working unchanged.
   */
  keywords: string[];
  /** Restrict to a design kind. */
  kind?: InspirationKind;
  /** Requested section kinds; one blueprint is returned per requested section. */
  sections?: InspirationCategory[];
  /**
   * The visual language asked for — `neumorphism`, `glassmorphism`, `brutalist`,
   * `flat`… Separate from `category` because they are orthogonal axes and a
   * single keyword bag conflates them: "health" and "glassmorphism" in one list
   * ranks a glassy fintech page and a flat clinic page identically, when the
   * caller wanted the intersection. A backend that scores them separately can.
   */
  style?: string;
  /**
   * The product domain — `ecommerce`, `health`, `saas`, `fintech`, `education`…
   * Domain drives which SECTIONS a design has at all (a checkout flow, a
   * dosage table, a pricing tier), which is what makes it worth its own axis
   * rather than another tag.
   *
   * Called `domain`, not `category`, on purpose: the store has meant SECTION
   * KIND by "category" since its first migration (navigation/hero/section/
   * footer/background, the same values as `sections` here). Two meanings for
   * one word across a network boundary is a bug waiting to happen, so the
   * model-facing argument accepts `category` as a synonym and it is normalized
   * to this field before it leaves the tool.
   */
  domain?: string;
  /**
   * `page` for a fresh screen — every section of ONE design, in reading order,
   * so the result is coherent. `section` (default) for isolated parts: best
   * match per section, possibly from different designs.
   */
  scope?: "page" | "section";
  ctx: ToolContext;
}

export interface InspirationBackendResult {
  /** Matched blueprints (at most one per requested section, possibly from different designs). */
  sections: InspirationJson[];
}

/**
 * Host-supplied lookup. Returns matched blueprints, or `null` when nothing
 * matches (or the backend/auth is unavailable) — the tool treats `null` as
 * "no inspiration found; proceed without a reference".
 */
export type InspirationBackend = (
  input: InspirationBackendInput,
) => Promise<InspirationBackendResult | null>;

export interface InspirationGeneratorConfig {
  /** Host's keyword→blueprint lookup. Absent ⇒ tool always reports "no match". */
  backend?: InspirationBackend;
  /** Hard ceiling for a single lookup (default 8s). Honors ctx.signal too. */
  timeoutMs?: number;
}

/** What the tool hands back in `details`. */
export interface InspirationToolResult {
  matched: boolean;
  /** The blueprints when matched; absent otherwise. */
  sections?: InspirationJson[];
  /** Keywords actually queried (normalized, including style/category). */
  keywords: string[];
  /** The visual language axis, as queried. */
  style?: string;
  /** The product-domain axis, as queried. */
  domain?: string;
  kind?: InspirationKind;
  /** Sections actually requested (normalized). */
  sectionsRequested?: InspirationCategory[];
}

const DEFAULT_TIMEOUT_MS = 8000;

const KIND_VALUES: readonly InspirationKind[] = ["web-ui", "mobile-ui", "poster"];
const CATEGORY_VALUES: readonly InspirationCategory[] = [
  "navigation",
  "hero",
  "section",
  "footer",
  "background",
];

/** Lowercase a single free-text tag; empty/blank becomes undefined. */
function normalizeTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim().toLowerCase();
  return t.length > 0 ? t : undefined;
}

/**
 * Normalize the keyword list, folding in `style`/`category` so they are always
 * queryable as plain tags too. Deduped, so naming glassmorphism in both places
 * does not weight it twice.
 */
function normalizeKeywords(value: unknown, ...extra: Array<string | undefined>): string[] {
  const source = [...(Array.isArray(value) ? value : []), ...extra.filter(Boolean)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    const k = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function asKind(value: unknown): InspirationKind | undefined {
  return typeof value === "string" && (KIND_VALUES as readonly string[]).includes(value)
    ? (value as InspirationKind)
    : undefined;
}

function normalizeSections(value: unknown): InspirationCategory[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<InspirationCategory>();
  const out: InspirationCategory[] = [];
  for (const raw of value) {
    const s = String(raw ?? "")
      .trim()
      .toLowerCase();
    if ((CATEGORY_VALUES as readonly string[]).includes(s)) {
      const cat = s as InspirationCategory;
      if (!seen.has(cat)) {
        seen.add(cat);
        out.push(cat);
      }
    }
  }
  return out;
}

/** Render a layer's keyframes as an at→styles summary the agent can reproduce. */
function describeKeyframes(layer: InspirationAnimationLayer): string {
  const frames = layer.keyframes ?? [];
  if (frames.length === 0) return "";
  const parts = frames.map((f) => {
    const styles = Object.entries(f.styles)
      .map(([k, v]) => `${k}:${v}`)
      .join("; ");
    return `at ${f.at}${f.easing ? ` (~${f.easing})` : ""} { ${styles} }`;
  });
  return `    keyframes: ${parts.join("  ->  ")}\n`;
}

/**
 * Render an animation spec in plain terms so the consuming agent understands
 * HOW the section moves and can reproduce it (CSS scroll-timeline /
 * IntersectionObserver + rAF / Framer Motion / GSAP). Without this, the
 * `animation` JSON in `details` is opaque; with it, the agent gets the intent.
 */
function describeAnimation(anim: InspirationAnimation): string {
  const lines: string[] = [];
  const trigger =
    anim.scrollTrigger === "window" || anim.scrollTrigger
      ? ` over ${anim.scrollTrigger}`
      : "";
  const range =
    anim.scrollStart || anim.scrollEnd
      ? ` (scroll ${anim.scrollStart ?? "start"} -> ${anim.scrollEnd ?? "end"})`
      : "";
  const perspective = anim.perspective ? ` perspective=${anim.perspective}` : "";
  lines.push(
    `    animation: ${anim.type}${trigger}${range}${perspective}${anim.fromVideo ? " [from video]" : ""}` +
      (anim.easing ? ` easing=${anim.easing}` : "") +
      (anim.duration ? ` duration=${anim.duration}s` : ""),
  );
  if (anim.notes) lines.push(`    notes: ${anim.notes}`);
  for (const layer of anim.layers ?? []) {
    const depth = layer.depth !== undefined ? ` depth=${layer.depth}` : "";
    const tz = layer.translateZ ? ` translateZ=${layer.translateZ}` : "";
    const dur = layer.duration ? ` duration=${layer.duration}s` : "";
    const prop = layer.property ? ` [${layer.property}]` : "";
    lines.push(
      `    layer "${layer.id}": ${layer.trigger}${prop}${depth}${tz}${dur}` +
        (layer.easing ? ` easing=${layer.easing}` : ""),
    );
    lines.push(describeKeyframes(layer));
  }
  return lines.filter(Boolean).join("");
}

function summarizeSections(sections: InspirationJson[]): string {
  return sections
    .map((s) => {
      const tags = (s.keywords ?? []).slice(0, 6).join(", ");
      const animated = (s.keywords ?? []).includes("parallax") ? " [parallax]" : "";
      const elems = s.elements?.length ?? 0;
      const head = `  • ${s.kind}/${s.category}: ${s.name}${animated}${tags ? ` (${tags})` : ""}${elems ? ` [${elems} elements]` : ""}`;
      const anim = s.animation ? "\n" + describeAnimation(s.animation) : "";
      const fonts =
        s.fonts && typeof s.fonts === "object" && Object.keys(s.fonts).length
          ? "\n    typography roles: " +
            Object.entries(s.fonts)
              .map(([slot, role]) => `${slot}=${typeof role === "string" ? role : JSON.stringify(role)}`)
              .join(", ")
          : "";
      return head + anim + fonts;
    })
    .join("\n");
}

const THEME_NOTE =
  "These blueprints were extracted from OTHER designs, so they carry that source's text, colors, images, " +
  "and logos — NONE of which are yours to ship. Borrow the STRUCTURE ONLY (layout, spacing, element roles, " +
  "visual rhythm, animation timing) and rebuild around THIS project's content:\n" +
  "  • CONTENT: replace every heading/link/label/button text with the user's real copy — never echo the source's wording, brand, or lorem.\n" +
  "  • COLORS: do NOT paste the source's hex values. Map each color's ROLE (primary accent, surface, muted text) to the project's theme tokens/palette.\n" +
  "  • IMAGES & LOGOS: never reuse the source's sample photo/stock image/brand mark. Regenerate fresh imagery (assets_generator) or use the project's own assets. A logo is the project's wordmark/icon, never the extracted one.\n" +
  "  • ICONS: use the project's icon set, keeping only the ROLE (checkmark, chevron...) so the layout holds.\n" +
  "  • TYPOGRAPHY: adopt the project's fonts; borrow the size HIERARCHY, not the literal font.\n" +
  "  • ANIMATION: reproduce the MOTION (keyframes, depth, easing) faithfully, but apply it to the project's own layers/colors.\n" +
  "The result must feel native to THIS project and never be mistaken for the source.";

const ANIMATION_NOTE =
  "Some sections are animated (parallax/scroll). The `animation` block describes the motion per layer " +
  "(trigger, depth, keyframes: at→styles). Reproduce it faithfully with CSS scroll-timeline / " +
  "IntersectionObserver + requestAnimationFrame, or a lib like Framer Motion / GSAP — interpolate the " +
  "layer styles between the keyframes as the user scrolls (or loops, for trigger=loop). Keep the motion " +
  "and timing; re-skin the visuals to the project theme.";

export function createInspirationGeneratorTool(
  config: InspirationGeneratorConfig = {},
): AgentTool<JSONSchema, InspirationToolResult> {
  const backend = config.backend;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "inspiration_generator",
    // Kept to what a description is for: when to call it, what comes back, and the
    // one constraint that must travel WITH the result. The full reuse policy (how to
    // re-skin content, colors, imagery, icons, type, motion) lives in the
    // INSPIRATION_REUSE guidance block in the system prompt — repeating all of it
    // here meant the model read the same 2KB twice on every call.
    description:
      "Look up reusable UI section blueprints from the inspiration store. Call it ONCE when you are about to " +
      "build a screen, page or poster and have NO reference of your own (no mockup, screenshot or URL to " +
      "copy) — if you do have one, read that with `media_analysis` lens:\"ui\" instead. Pass `keywords` " +
      "describing the design (e.g. ['saas','dark','parallax'] — include 'parallax' when the brief asks for " +
      "scroll animation), `kind` (web-ui | mobile-ui | poster), and the `sections` you need. At most ONE " +
      "blueprint comes back per requested section and they may come from DIFFERENT stored designs, so they " +
      "are independent parts, not a cohesive page — making them cohere is your job. A 'parallax' blueprint " +
      "carries an `animation` block of per-layer keyframes (at→styles as the user scrolls); reproduce that " +
      "MOTION faithfully via CSS scroll-timeline, IntersectionObserver + rAF, or the project's animation " +
      "library. CRITICAL: a blueprint describes SOMEONE ELSE'S design and carries their copy, hex values, " +
      "images, logos and icons — none of it yours to ship. Borrow the structure; rebuild it with this " +
      "project's content and theme tokens. On 'no match', proceed without a reference — do not retry with " +
      "reworded keywords.",
    mutates: false,
    phases: ["perform", "perfect"],
    parameters: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description:
            "Tags describing the desired design (e.g. ['saas','dark','gradient','parallax']). At least one required.",
        },
        kind: {
          type: "string",
          enum: ["web-ui", "mobile-ui", "poster"],
          description: "Design kind to narrow the match.",
        },
        sections: {
          type: "array",
          items: {
            type: "string",
            enum: ["navigation", "hero", "section", "footer", "background"],
          },
          description:
            "Section kinds to fetch. One blueprint is returned per requested section, possibly from " +
            "different stored designs. Omit to let the backend pick.",
        },
        style: {
          type: "string",
          description:
            "The visual language to match — e.g. 'neumorphism', 'glassmorphism', 'brutalist', 'flat', " +
            "'material', 'skeuomorphic', 'minimal'. Name it whenever the brief implies a look, even loosely; " +
            "it is ranked separately from `category`, so style+domain finds their intersection instead of " +
            "whichever tag happened to match first.",
        },
        domain: {
          type: "string",
          description:
            "The product domain (a.k.a. category) — e.g. 'ecommerce', 'health', 'saas', 'fintech', " +
            "'education', 'portfolio', 'travel'. Domain decides which sections a design even has (a checkout " +
            "step, a dosage table, a pricing tier), so it changes what comes back as much as the style does. " +
            "`category` is accepted as a synonym here, but note it means SECTION KIND everywhere else in this " +
            "tool — use `sections` for those.",
        },
        scope: {
          type: "string",
          enum: ["page", "section"],
          description:
            "What you are building. `page` — a FRESH screen: returns every section of ONE design in reading " +
            "order, so navigation, hero and footer belong together instead of being three unrelated designs " +
            "stapled into one page. `section` (default) — you are designing one part of an existing screen: " +
            "returns the best match per requested section. Use `page` only when the whole screen is yours to " +
            "design; a redesign of just the hero is `section`.",
        },
        intent: {
          type: "string",
          description: "Short note on what you intend to build (for logging only).",
        },
      },
      required: ["keywords"],
    },
    async execute(_id, args, ctx): Promise<{
      output: string;
      details: InspirationToolResult;
    }> {
      const style = normalizeTag(args.style);
      // `category` is accepted as a synonym for `domain` because it is the word
      // a model reaches for; `domain` wins when both are present.
      const domain = normalizeTag(args.domain) ?? normalizeTag(args.category);
      // Fold both axes into `keywords` as well as passing them separately. A
      // keyword-only backend then behaves exactly as it did before this existed,
      // while a backend that scores the axes independently gets the structure.
      const keywords = normalizeKeywords(args.keywords, style, domain);
      const kind = asKind(typeof args.kind === "string" ? args.kind.toLowerCase() : args.kind);
      const sections = normalizeSections(args.sections);
      const scope = args.scope === "page" ? ("page" as const) : ("section" as const);

      // A non-UI (backend) project has no screens to design blueprints for, so a
      // reference lookup is wasted work. Decline with the same `matched:false`
      // shape the no-backend path returns, so the loop falls straight through to
      // authoring without retrying. Not an error: the model should read this as
      // guidance ("nothing to look up here"), not a tool failure to escalate.
      if (ctx.projectCategory === "backend") {
        const result: InspirationToolResult = { matched: false, keywords, ...(style ? { style } : {}), ...(domain ? { domain } : {}), kind, sectionsRequested: sections };
        return {
          output:
            "inspiration_generator is for UI projects; this project is categorized as backend (no UI). Author the file directly without a design reference.",
          details: result,
        };
      }

      if (keywords.length === 0) {
        const result: InspirationToolResult = { matched: false, keywords, ...(style ? { style } : {}), ...(domain ? { domain } : {}), kind, sectionsRequested: sections };
        return {
          output:
            "inspiration_generator needs at least one keyword. Proceed without a reference.",
          details: result,
        };
      }

      if (!backend) {
        const result: InspirationToolResult = { matched: false, keywords, ...(style ? { style } : {}), ...(domain ? { domain } : {}), kind, sectionsRequested: sections };
        return {
          output:
            "No inspiration backend configured. Proceed without a reference.",
          details: result,
        };
      }

      // Honor caller abort and a hard timeout: whichever fires first. If the
      // caller already aborted, resolve as "no match" instead of throwing, so a
      // race at the end of a run never surfaces a tool error for this lookup.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (ctx.signal?.aborted) {
        controller.abort();
      } else {
        ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const childCtx: ToolContext = { ...ctx, signal: controller.signal };

      let backendResult: InspirationBackendResult | null = null;
      try {
        backendResult = await backend({
          keywords,
          kind,
          sections,
          ...(style ? { style } : {}),
          ...(domain ? { domain } : {}),
          scope,
          ctx: childCtx,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log?.({
          timestamp: Date.now(),
          level: "warn",
          tags: ["inspiration_generator"],
          message: `inspiration_generator backend error: ${message}`,
        });
      } finally {
        clearTimeout(timer);
      }

      const matchedSections = backendResult?.sections ?? [];
      if (matchedSections.length === 0) {
        const result: InspirationToolResult = {
          matched: false,
          keywords,
          kind,
          sectionsRequested: sections,
        };
        return {
          output:
            `No stored inspiration matched [${keywords.join(", ")}]` +
            (sections.length ? ` for sections [${sections.join(", ")}]` : "") +
            ". Proceed without a reference.",
          details: result,
        };
      }

      const hasAnimation = matchedSections.some(
        (s) => s.animation && (s.keywords ?? []).some((k) => k === "parallax" || k === "scroll"),
      );
      const result: InspirationToolResult = {
        matched: true,
        sections: matchedSections,
        keywords,
        kind,
        sectionsRequested: sections,
      };
      return {
        output:
          `Inspiration found (${matchedSections.length} section${matchedSections.length === 1 ? "" : "s"}):\n` +
          summarizeSections(matchedSections) +
          (hasAnimation ? `\n\n${ANIMATION_NOTE}` : "") +
          `\n\n${THEME_NOTE}`,
        details: result,
      };
    },
  };
}
