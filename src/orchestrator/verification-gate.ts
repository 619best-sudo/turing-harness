/**
 * The verify-what-you-wrote gate — the post-development mirror of
 * {@link ReproductionGate}.
 *
 * `VERIFY_WHAT_YOU_WROTE` (in phases/prompts.ts) has said for a long time that
 * every file a run created or modified needs a check behind it before the
 * summary is written. It is stated unambiguously and it is routinely skipped —
 * a model that wrote a React component, ran `tsc`, and called it done shipped a
 * visual change nobody looked at. The lesson is the same one the reproduce gate
 * already encoded: prose does not bind. A rule the model can silently skip is a
 * suggestion; this makes the end of the run refuse to write its summary until
 * every written RUNTIME file has evidence behind it (or an auditable bypass).
 *
 * This is a pure state machine — no I/O, no model calls. The loop feeds it
 * writes and tool results via {@link observeWritten} / {@link observeCheck}; the
 * orchestrator feeds it the model's per-file classification via {@link declare}
 * and reads {@link isSatisfied} / {@link gaps} / {@link toReport} to drive the
 * verification sub-loops. Enforcement (the rounds, the summary hold, the
 * non-fatal fallback) lives in the orchestrator, not here.
 *
 * What counts as evidence is deliberately broad — any of the ways the toolkit
 * lets you observe a running system, plus a passing build/test through `bash`.
 * What does NOT count is re-reading the file: the write result already proved
 * the bytes landed, and reading them back proves nothing about whether they run.
 */

/**
 * Tools whose successful result means the run has produced verification
 * evidence. Matched under any MCP prefix a server adds (`some-server__…`); see
 * {@link VerificationGate.classifyTool} for which method each satisfies.
 *
 * - `activity_inspect` — drove a surface (browser/device) and captured it. A
 *   visual change verified by LOOKING AT IT.
 * - `activity_collect` / `activity_study` — instrumented a flow and read back /
 *   reasoned over what it recorded. An internal-behaviour change verified by
 *   the trace loop.
 * - `activity_tail_file` — read a log the project itself writes. Used both for
 *   bug reproduction (the pre-fix gate) and for the user-driven handoff, where
 *   the host drops a log at the per-run evidence dir.
 * - `media_analysis` — only counts when its verdict was PASS (see
 *   {@link VERDICT_PASS}). A FAIL is the most useful thing that can happen in a
 *   verify loop, but it is not evidence the change is correct.
 */

/** `media_analysis` — evidence only on a PASS verdict (matched case-insensitively). */
const MEDIA_ANALYSIS = "media_analysis";
const VERDICT_PASS = /VERDICT:\s*PASS/i;

/**
 * `activity_inspect`'s own words when it captured a screen but could not judge it
 * because `media_analysis` is not in this run's registry. On such a run a capture
 * is the best evidence obtainable, so it is accepted — see `classifyTool`. Kept as
 * a literal match on the tool's message (activity-monitor.ts) so the two cannot
 * drift into a gate that silently never closes.
 */
const INSPECT_UNANALYSABLE = /Screenshot captured but not analysed/i;

/** `bash` — evidence when the project's test/build/typecheck reported success. */
const BASH = "bash";
/** Bash success signals, matched case-insensitively in the output text. */
const BASH_PASS = [
  /\bpass(?:ed|ing)?\b/i,
  /\b0 failures?\b/i,
  /\b✓\b/,
  /\ball tests? pass/i,
  /--noEmit\b[^\n]*\n?\s*(?:$|[^e])/i, // tsc --noEmit with no error
];

/**
 * HTTP success signals, matched case-insensitively. A `curl` (or any `bash`
 * HTTP call) returning a 2xx status or a JSON body that reads as success is
 * endpoint evidence — the verify message tells the model to verify endpoints
 * with `bash (curl)`, so without this, `curl localhost:3000/health → 200 OK`
 * registers nothing and the file stays unverified.
 */
const HTTP_PASS = [
  /\bHTTP\/[\d.]+\s+2\d\d\b/i, // `HTTP/1.1 200 OK`
  /^2\d\d\b/m, // bare `200` status line (curl -w '%{http_code}')
  /"status"\s*:\s*"(?:ok|success|healthy|active|ready)"/i, // {"status":"ok"}
  /^\s*<\?xml[^>]*>\s*<[^>]*\b(ok|healthy|up|ready)\b/im, // XML health bodies
  /\b(response|result|state|outcome)"?\s*[:=]\s*"?ok\b/i, // {"response":"ok"}
];

/** True for a tool name under any MCP prefix. */
function matchesTool(name: string, target: string): boolean {
  return name === target || name.endsWith(`__${target}`);
}

/** The model-declared check method. */
export type VerificationMethod = "visual" | "logic" | "endpoint" | "none";

/** Sentinel method meaning "no runtime check needed" (by tier or extension). */
export type VerificationOutcome = VerificationMethod | "static";

/** A per-file classification the model commits to before/during verification. */
export interface VerificationDeclaration {
  /** Absolute path of the written file. */
  path: string;
  /** `runtime` files need evidence; `static` files bypass with a reason. */
  tier?: "runtime" | "static";
  /**
   * The kind of check the model commits to, which the gate matches evidence
   * against. `none` is legitimate for `static` files (docs, config, fixtures)
   * and is an auditable bypass when paired with a {@link reason}.
   */
  method?: "visual" | "logic" | "endpoint" | "none";
  /** Why a `static`/`none` file needs no runtime check. Required for a bypass. */
  reason?: string;
}

/** Internal per-path state. */
interface PathState {
  path: string;
  /** Last diff text observed for this path (excerpted into the verify message). */
  diff?: string;
  tier?: "runtime" | "static";
  method?: VerificationDeclaration["method"];
  reason?: string;
  /** Whether a qualifying tool result has covered this path this generation. */
  hasEvidence: boolean;
  /** Tool that produced the evidence, for the report. */
  evidenceTool?: string;
  /** Whether the model has declared a tier/method for this path. */
  declared: boolean;
}

/** A path that still needs evidence, with the context the verify loop needs. */
export interface VerificationGap {
  path: string;
  method: VerificationMethod;
  /** Short excerpt of the diff, to focus the check on what changed. */
  diffExcerpt?: string;
}

/** The structured verification report surfaced to the summary and the host. */
export interface VerificationReport {
  /** Runtime files with evidence behind them this run. */
  checked: Array<{ path: string; tool: string }>;
  /** Files the model certified as needing no runtime check, with reasons. */
  certified: Array<{ path: string; reason: string }>;
  /** Files still lacking evidence when the run ended (may be non-empty). */
  unverified: Array<{ path: string; method?: string; reason?: string }>;
}

import type { ProjectCategory } from "../presets/project-presets.js";

export interface VerificationGateOptions {
  /** Absolute cap on verify rounds per attempt; enforced by the orchestrator, not here. */
  maxRounds?: number;
  /**
   * Cap on full verify attempts. An attempt that ends unsatisfied (the gate could
   * not be cleared) is retried with a fresh instrument → run → inspect → decide
   * cycle, so a verify FAIL triggers a fresh run rather than giving up at
   * verified:false. Bounded so a change that genuinely cannot verify still
   * completes honestly. Default 2 (the initial attempt plus one retry).
   */
  maxAttempts?: number;
  /**
   * The project's detected category. Decides the FALLBACK check for a source file
   * the model never classified: on a project that renders screens, that check is
   * visual. A method the model declares always wins over it.
   */
  projectCategory?: ProjectCategory;
}

/**
 * Track per-written-path verification state and decide whether the run may
 * finish. One instance per `run()` invocation; threaded into every work loop.
 */
export class VerificationGate {
  private readonly states = new Map<string, PathState>();
  /** Paths in the order first written, so reports are stable. */
  private readonly order: string[] = [];

  constructor(private readonly opts: VerificationGateOptions = {}) {}

  /**
   * Record a successful write/edit. Re-writing a path RESETS its evidence — an
   * edit after a verify pass must be re-verified, because the bytes it proved
   * correct are no longer the bytes on disk.
   */
  observeWritten(path: string, diff?: string): void {
    const existing = this.states.get(path);
    if (existing) {
      existing.diff = diff ?? existing.diff;
      existing.hasEvidence = false;
      existing.evidenceTool = undefined;
      return;
    }
    this.states.set(path, { path, diff, hasEvidence: false, declared: false });
    this.order.push(path);
  }

  /**
   * Record one completed tool result. A qualifying successful result grants
   * evidence to the runtime paths currently owed it, matched by method: a visual
   * capture clears owed `visual` files, a trace clears owed `logic` files, a
   * passing build clears `logic`/`endpoint`. We do NOT try to attribute a
   * capture to a single file — the model runs one check covering the change,
   * and which file that check was "for" is something the model knows and the
   * gate does not. A passing check clears the matching outstanding runtime
   * files; if the model over-verifies, that is the cheap direction to err in.
   */
  observeCheck(
    toolName: string,
    isError: boolean,
    outputChars: number,
    outputText: string,
  ): void {
    if (isError || outputChars <= 0) return;
    const methods = this.classifyTool(toolName, outputText);
    if (methods.size === 0) return;
    for (const st of this.runtimeOwed()) {
      if (!methods.has(st.method ?? this.fallbackFor(st.path) as VerificationMethod)) continue;
      st.hasEvidence = true;
      st.evidenceTool = toolName;
    }
  }

  /**
   * Record the model's per-file classification. This IS the "ask yourself:
   * visual / logs / nothing" step, made binding — a `none`/`static` declaration
   * with a reason is an auditable bypass; `visual`/`logic`/`endpoint` create an
   * evidence requirement the gate enforces.
   *
   * A `none`/`static` declaration does NOT override evidence already recorded:
   * once a file is checked, a later "actually it needs no check" cannot demote
   * it to certified — that would make the report dishonest (a checked file
   * relabeled as skipped). It can only fill in classification for a file that
   * has none yet.
   */
  declare(declarations: VerificationDeclaration[]): void {
    for (const d of declarations) {
      const st = this.states.get(d.path);
      if (!st) continue; // declarations for unwritten files are ignored
      // Don't let a retroactive bypass demote a file that already has evidence.
      if (st.hasEvidence && (d.method === "none" || d.tier === "static")) continue;
      st.declared = true;
      if (d.tier) st.tier = d.tier;
      if (d.method) st.method = d.method;
      if (d.reason !== undefined) st.reason = d.reason;
    }
  }

  /** True when every written path is either certified or has evidence. */
  isSatisfied(): boolean {
    return this.gaps().length === 0;
  }

  /** Runtime paths still needing evidence, in write order. */
  gaps(): VerificationGap[] {
    const out: VerificationGap[] = [];
    for (const path of this.order) {
      const st = this.states.get(path)!;
      const method = this.resolveMethod(st);
      if (method === "none" || method === "static") continue;
      if (st.hasEvidence) continue;
      out.push({ path, method, ...(st.diff ? { diffExcerpt: excerptDiff(st.diff) } : {}) });
    }
    return out;
  }

  /** The full structured report. */
  toReport(): VerificationReport {
    const checked: VerificationReport["checked"] = [];
    const certified: VerificationReport["certified"] = [];
    const unverified: VerificationReport["unverified"] = [];
    for (const path of this.order) {
      const st = this.states.get(path)!;
      const method = this.resolveMethod(st);
      if (method === "none" || method === "static") {
        certified.push({ path, reason: st.reason ?? `classified ${method}` });
      } else if (st.hasEvidence) {
        checked.push({ path, tool: st.evidenceTool ?? "unknown" });
      } else {
        unverified.push({ path, method, ...(st.reason ? { reason: st.reason } : {}) });
      }
    }
    return { checked, certified, unverified };
  }

  /** The cap the orchestrator should respect. */
  get maxRounds(): number {
    // Five fits the staged verify spine (instrument → run → inspect → decide)
    // plus one re-verify round after a fix, without forcing a re-instrument
    // cycle the budget cannot finish. Still overridable via {@link VerificationGateOptions.maxRounds}.
    return this.opts.maxRounds ?? 5;
  }

  /** Cap on full verify attempts (a FAIL triggers a fresh cycle), default 2. */
  get maxAttempts(): number {
    return this.opts.maxAttempts ?? 2;
  }

  // ---- internals -----------------------------------------------------------

  /** Runtime paths that still owe evidence (excluding certified/static). */
  private runtimeOwed(): PathState[] {
    const out: PathState[] = [];
    for (const path of this.order) {
      const st = this.states.get(path)!;
      if (st.hasEvidence) continue;
      const method = this.resolveMethod(st);
      if (method === "none" || method === "static") continue;
      out.push(st);
    }
    return out;
  }

  /**
   * The effective method for a path: the declared method if present, else the
   * extension fallback. A `static` tier with no method collapses to `static`.
   * `"static"` is an internal sentinel (not a model-declared method) meaning
   * "no runtime check needed, by tier or by extension".
   */
  private resolveMethod(st: PathState): VerificationOutcome {
    if (st.tier === "static" && !st.method) return "static";
    if (st.method) return st.method;
    if (st.tier === "static") return "static";
    return this.fallbackFor(st.path);
  }

  /** {@link fallbackMethod} with this run's project category applied. */
  private fallbackFor(path: string): VerificationOutcome {
    return fallbackMethod(path, this.opts.projectCategory);
  }

  /**
   * Map a tool result to the set of methods it can satisfy, or an empty set if
   * it is not verification evidence. A tool may cover several methods — `bash`
   * running the test runner covers `logic` and `endpoint` — but a tool only
   * counts at all when its output reads as a success (a PASS verdict, a passing
   * test signal). A FAILED check covers nothing; it is the most useful thing
   * that can happen in a verify loop, but it is not evidence the change works.
   */
  private classifyTool(name: string, outputText: string): Set<VerificationMethod> {
    const out = new Set<VerificationMethod>();
    // `activity_inspect` counts as visual evidence when it EVALUATED the screen,
    // not merely when it reached one.
    //
    // It used to count unconditionally, which made a bare capture a pass: the
    // tool's `analyze` argument defaults off, so `activity_inspect {url}` returned
    // a screenshot nobody judged and the gate closed. That is the same mistake the
    // prompts warn the model against ("a capture is not an evaluation") applied to
    // the gate itself. Worse, it also produced the DOUBLE check users noticed — a
    // model that did the right thing ran `activity_inspect` and then
    // `media_analysis` on the same capture, because neither the prompt nor the
    // gate told it the first call had already done the `lens:"qa"` pass.
    //
    // So: a PASS verdict in the output is evidence; a run where analysis was
    // impossible (no `media_analysis` in the registry — the tool says so in those
    // words) falls back to accepting the capture, because otherwise the gate would
    // be unsatisfiable through no fault of the model. A FAIL is not evidence, here
    // or anywhere else in this function.
    if (matchesTool(name, "activity_inspect")) {
      if (VERDICT_PASS.test(outputText) || INSPECT_UNANALYSABLE.test(outputText)) out.add("visual");
    }
    if (matchesTool(name, "activity_collect") || matchesTool(name, "activity_study")) {
      out.add("logic");
    }
    if (matchesTool(name, "activity_tail_file")) {
      out.add("logic");
      out.add("endpoint");
    }
    if (matchesTool(name, MEDIA_ANALYSIS) && VERDICT_PASS.test(outputText)) {
      out.add("visual");
    }
    if (matchesTool(name, BASH) && BASH_PASS.some((re) => re.test(outputText))) {
      out.add("logic");
      out.add("endpoint");
    }
    // An HTTP success (a `curl`/fetch the verify message told the model to run
    // for an endpoint) is endpoint evidence on its own — it does NOT cover
    // `logic`, because a `200 OK` proves the route answers, not that the logic
    // behind it is correct. Recognised separately from the test-runner signals
    // above so a `curl health` body that says nothing about "passing" still
    // clears the endpoint file the run owes it.
    if (matchesTool(name, BASH) && HTTP_PASS.some((re) => re.test(outputText))) {
      out.add("endpoint");
    }
    return out;
  }
}

// ---- pure helpers ----------------------------------------------------------

/**
 * Extensions that are view-layer wherever they appear, whatever the project is: a
 * stylesheet, a markup template, a component file. The extension alone settles it,
 * so these need no category and behave as they always have.
 */
const VISUAL_EXTENSIONS = new Set([
  ".css", ".scss", ".sass", ".less", ".styl", ".html", ".htm", ".svg",
  ".vue", ".svelte", ".astro", ".tsx", ".jsx", ".storyboard", ".xib", ".xaml",
]);

/** Clearly-static extensions → `static` (no runtime behaviour). */
const STATIC_EXTENSIONS = new Set([
  ".md", ".mdx", ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".txt", ".lock", "",
]);

/**
 * Source extensions that are view-layer only in context — a `.dart` or `.swift`
 * file is as likely to be a model or a repository as a screen. These count as
 * visual when the PROJECT's whole output is a screen (see {@link fallbackMethod});
 * the unambiguous ones are in {@link VISUAL_EXTENSIONS} above and need no context.
 */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".dart", ".swift", ".kt", ".kts",
  ".java", ".rb", ".py", ".php", ".cs", ".go", ".rs", ".ex", ".exs",
]);

/**
 * Extension fallback used ONLY when the model never declares a method.
 *
 * The project's CATEGORY does most of the work here, because it is the signal
 * that is actually reliable. This used to be an extension test alone, and the
 * extensions it knew were web ones — so on a frontend project it was right, and on
 * every other kind of UI project a screen came back as `logic`. The consequences
 * ran the whole length of a run: the gate asked for a logic check, so the model
 * ran the project's analyzer and test runner and never drove the actual screen;
 * `needsRunningApp` saw no `visual` method, so the user was never offered the
 * running-app handoff; and the change shipped with nobody having looked at it.
 *
 * On a `frontend`, `mobile` or `games` project the output IS a screen, so editing
 * source there is a visual change and the check is to go and look at it. Guessing
 * per-file which source file "is the view" was the complicated version of this and
 * it was worse: it needed a vocabulary of directory names and filename suffixes
 * that every project spells differently.
 */
function fallbackMethod(path: string, category?: ProjectCategory): VerificationOutcome {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (VISUAL_EXTENSIONS.has(ext)) return "visual";
  if (STATIC_EXTENSIONS.has(ext)) return "static";
  // A project whose product is a screen: source changes are seen, not reasoned
  // about. `backend` (and an undetected category) keeps the old logic default.
  const rendersScreens = category === "frontend" || category === "mobile" || category === "games";
  if (rendersScreens && SOURCE_EXTENSIONS.has(ext)) return "visual";
  return "logic";
}

/** A short, line-capped excerpt of a diff, for the verify-loop message. */
function excerptDiff(diff: string | undefined | null, maxLines = 12): string | undefined {
  if (typeof diff !== "string" || !diff) return undefined;
  const lines = diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));
  const trimmed = lines.slice(0, maxLines);
  return trimmed.length ? trimmed.join("\n") : undefined;
}

/**
 * Parse `DECLARE { path, tier, method, reason }` blocks from a verify loop's
 * final text. Tolerant: one JSON object per DECLARE keyword, or a single
 *DECLARE line carrying a JSON array. Malformed blocks are skipped silently — a
 * bad declaration should not crash the verify phase.
 */
export function parseDeclarations(text: string): VerificationDeclaration[] {
  const out: VerificationDeclaration[] = [];
  if (!text) return out;
  const re = /DECLARE\s*(\{[\s\S]*?\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as Record<string, unknown>;
      if (typeof obj.path === "string") {
        out.push({
          path: obj.path,
          ...(obj.tier === "static" || obj.tier === "runtime" ? { tier: obj.tier } : {}),
          ...(obj.method === "visual" || obj.method === "logic" || obj.method === "endpoint" || obj.method === "none"
            ? { method: obj.method }
            : {}),
          ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
        });
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}
