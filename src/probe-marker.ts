/**
 * The single source of truth for the activity-trace log marker.
 *
 * Instrumentation is just the model adding a line in the file's normal
 * `print`/`console.log` that starts with this session's marker, e.g.
 *   print("TURING_TRACE_d93647e3 [2026-08-14T06:01:02Z] screen=profile loaded=true")
 * `activity_collect` greps the trace file for this session's marker, and the
 * probe detection (the gates, instrumentation stripping) keys off the family
 * regex — so a plain prefixed log line is both the message AND the marker. No
 * injected helper function, no imports, no file writes: stdout carries the line
 * into the trace file (via `activity_trace_start`'s `startCommand`), and the
 * marker is what is searched for.
 *
 * Keep this a leaf module (no imports) so every caller — including the lower-
 * level `coding.ts` — can depend on it without forming a cycle.
 */

/**
 * Fixed, greppable prefix every trace log line starts with. The name says what
 * the line IS — a trace probe placed by the turing agent — so a human reading
 * the app's own logs knows what it is at a glance.
 */
export const TRACE_MARKER_PREFIX = "TURING_TRACE";

/** Matches any marker in the family, bare or session-suffixed. */
function markerAlternation(): string {
  return TRACE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches any line/source that carries a trace probe. Built from the prefix so
 * the prefix and the detector cannot drift apart.
 */
export const PROBE_MARKER_RE = new RegExp(markerAlternation());

/**
 * The marker for ONE trace session: `TURING_TRACE_<traceId suffix>`, e.g.
 * `turing-trace-d93647e3` → `TURING_TRACE_d93647e3`.
 *
 * The family prefix alone identifies the KIND (a probe, any session) — which is
 * what detection and cleanup want: `PROBE_MARKER_RE` finds every probe ever
 * written, including one a crashed run left behind. But collection wants the
 * exact opposite: a stale probe still in the source emits into a NEW session's
 * trace file when the app re-launches, and with a shared marker its lines are
 * indistinguishable from this run's — the new check would read the old check's
 * output as its own evidence. So the marker a session's probes carry (and
 * `activity_collect` greps for) is unique to that session, derived
 * deterministically from its traceId — no session state, so it still resolves
 * after a restart.
 */
export function traceMarker(traceId: string): string {
  const suffix = traceId.includes("-") ? traceId.slice(traceId.lastIndexOf("-") + 1) : traceId;
  return `${TRACE_MARKER_PREFIX}_${suffix}`;
}

/**
 * Every probe marker a line may carry — for reports that name which foreign
 * markers were seen (e.g. `activity_collect`'s leftover note) and for `grep`
 * hints that must find all probes. Matches the longest marker at a position, so
 * `TURING_TRACE_ab12` is reported whole rather than as its family prefix.
 */
export const ANY_MARKER_RE = new RegExp(`${markerAlternation()}[_A-Za-z0-9-]*`);

/**
 * A line whose ONLY purpose is a probe: whitespace, then a log call that carries
 * the marker, then optional whitespace. `print("TURING_TRACE_x …");`,
 * `console.log(`TURING_TRACE_x …`)`, `printf("TURING_TRACE_x …\n")`, a `//`
 * comment about one.
 *
 * Deliberately narrow, because deleting a line is not reversible. A line that
 * MIXES a probe with code — `if (x) { print("TURING_TRACE_x"); return; }` — is
 * not matched: removing the probe there means re-authoring the statement, which
 * is a judgement call and belongs to a model or a human, not to a regex. Those
 * get REPORTED instead.
 */
export const PURE_PROBE_LINE_RE = new RegExp(
  String.raw`^[ \t]*(?:\/\/|#|--)[^\n]*` +
    markerAlternation() +
    String.raw`[^\n]*$|` +
    String.raw`^[ \t]*(?:await\s+)?` +
    String.raw`(?:[\w.$]*(?:print|log|write|puts|echo|NSLog|Debug\.\w+|Log\.\w+|fmt\.Print\w*)[\w.$]*)` +
    String.raw`\s*\(?[^;]*` +
    markerAlternation() +
    String.raw`[\s\S]*?\)?\s*;?\s*$`,
);

/** What a deterministic strip did to one file. */
export interface ProbeStripResult {
  /** Lines removed whole — they were nothing but a probe. */
  removed: number;
  /** 1-based line numbers that carry a marker MIXED with code, left in place. */
  mixed: number[];
  /**
   * 1-based line numbers of blocks the removal left EMPTY — `} else {` followed
   * by `}`, an `if (…) {` with nothing in it.
   *
   * Found by observation, not anticipated: stripping 24 probes from a real
   * project left two `} else { }` husks, because the instrumenting run had added
   * those else-branches for no purpose but to host a probe. The result compiles
   * and reads as sloppy code nobody wrote, so it is reported — deciding whether
   * an emptied block should collapse is a judgement about the surrounding code,
   * which is the model pass's job, not a regex's.
   */
  emptiedBlocks: number[];
  /** The file's new content, or undefined when nothing changed. */
  content?: string;
}

/**
 * Remove every whole-line probe from `source`, reporting any that are entangled
 * with code.
 *
 * Deterministic and model-free ON PURPOSE. The chain's existing strip pass asks a
 * model to do this, which makes it slow, costly, and — the reason this exists —
 * abortable: a run stopped by hand takes its own cleanup down with it, and the
 * probes stay in the tree. One field run left 24 of them across three files that
 * way, and the NEXT run read them as product code and authored a fix around them.
 */
export function stripProbeLines(source: string): ProbeStripResult {
  if (!PROBE_MARKER_RE.test(source)) return { removed: 0, mixed: [], emptiedBlocks: [] };
  const lines = source.split("\n");
  const kept: string[] = [];
  const mixed: number[] = [];
  let removed = 0;
  for (const [index, line] of lines.entries()) {
    if (!PROBE_MARKER_RE.test(line)) {
      kept.push(line);
      continue;
    }
    if (PURE_PROBE_LINE_RE.test(line)) {
      removed += 1;
      continue;
    }
    mixed.push(index + 1);
    kept.push(line);
  }
  if (!removed) return { removed: 0, mixed, emptiedBlocks: [] };
  return { removed, mixed, emptiedBlocks: findEmptiedBlocks(kept), content: kept.join("\n") };
}

/**
 * Blocks with nothing left in them: an opening brace whose next non-blank line
 * closes it.
 *
 * Line-based on purpose. A real parser per language is not on the table here, and
 * the shape this catches is the one a removed probe leaves behind — a brace, then
 * its match. Reported, never rewritten.
 */
function findEmptiedBlocks(lines: string[]): number[] {
  const out: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/\{\s*$/.test(line)) continue;
    let next = index + 1;
    while (next < lines.length && lines[next]!.trim() === "") next += 1;
    if (next < lines.length && /^\s*\}/.test(lines[next]!)) out.push(index + 1);
  }
  return out;
}
