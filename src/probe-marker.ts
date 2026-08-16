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
