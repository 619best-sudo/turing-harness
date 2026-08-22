/**
 * Who decides where the work goes next.
 *
 * The chain used to answer this with one blind LLM turn. `routeCategorizer` gets
 * the task, a menu of ids, and ONE 240-character line per completed hop — never
 * the deliverable, never the transcript, never what the hop's own driver
 * concluded. On the run that produced this file, `read` spent twenty-four turns
 * on a reported polling bug and delivered a full root-cause analysis with fix
 * locations; the router saw the first 240 characters of it, read a finished
 * report, and answered `summarise`. The run ended having written nothing. The
 * model that knew the answer had no channel to say it, and the deterministic
 * policy that encodes the right answer (`heuristicRoute`: read + bug → reproduce
 * → fix) was only consulted when the LLM call FAILED — a well-formed wrong
 * answer went straight through.
 *
 * So the decision is made from three inputs, in this order:
 *
 *   1. THE DRIVER'S NOMINATION — `hop.nominations`, off its own `deliver` call.
 *      It did the work; it is the best-informed party in the run and the only one
 *      that gets to name a SEQUENCE ("reproduce, then fix"). Already validated
 *      against the categorizer's `children` when it was captured.
 *   2. THE POLICY FLOORS — narrow, mechanical rules that no model may override,
 *      the DRIVER INCLUDED, because they encode what the harness is FOR: a
 *      reported bug is SEEN before it is fixed, and is never resolved by being
 *      described.
 *   3. THE ROUTER LLM — asked only when 1 produced nothing usable, with the
 *      heuristic behind it as before.
 *
 * Nothing here is a jump: every id still passes through the chain's `children`
 * check and its no-repeat loop guard, and `maxHops` still bounds the run.
 */
import type { CategorizerDefinition, CategorizerHop, CategorizerId } from "./types.js";
import type { RouterChoice } from "./router.js";

/** Where a decision came from, for the log and for tests. */
export type RouteSource = "driver" | "policy" | "router" | "heuristic";

export interface RouteDecision {
  selection: RouterChoice;
  source: RouteSource;
  /** Human-readable reason, logged verbatim. */
  reason: string;
  /** What remains of the driver's nominated sequence after taking `selection`. */
  queue: CategorizerId[];
}

export interface RoutePolicyInput {
  /** Legal next categorizers at this point (the last hop's children, or entries). */
  choices: CategorizerDefinition[];
  hops: CategorizerHop[];
  /** The driver's nominated sequence not yet consumed. */
  queue: CategorizerId[];
  /** Files the run has written so far, across every hop. */
  writtenPaths: string[];
  /** Host flag OR the router's own read: this run is fixing a reported bug. */
  isBugFix?: boolean;
  /** verify:false ⇒ do not add an inspect hop. */
  preferInspect?: boolean;
}

const has = (input: RoutePolicyInput, id: CategorizerId): boolean =>
  input.choices.some((choice) => choice.id === id);

/**
 * Take the next id from the driver's nominated sequence, dropping any that is no
 * longer legal.
 *
 * Re-validated per hop on purpose: nominations were checked against the
 * NOMINATING categorizer's children, and the graph has moved since. `read`
 * nominating [activity_inspect, write_edit] is legal at the time; once
 * activity_inspect has run, `write_edit` must still be among ITS children to
 * survive — and it is. An id that does not survive is dropped silently rather
 * than failing the run: a stale nomination is a hint that expired, not an error.
 */
function takeFromQueue(input: RoutePolicyInput): { id: RouterChoice; queue: CategorizerId[] } | undefined {
  const queue = [...input.queue];
  const lastId = input.hops[input.hops.length - 1]?.id;
  while (queue.length) {
    const next = queue.shift();
    if (!next) continue;
    if (next === "summarise") return { id: "summarise", queue };
    // The chain's loop guard would refuse this anyway; dropping it here means the
    // rest of the sequence still gets its turn instead of the guard ending the run.
    if (next === lastId) continue;
    if (!has(input, next)) continue;
    return { id: next, queue };
  }
  return undefined;
}

/** Index of the last hop matching a predicate, or -1. */
function lastHopIndex(input: RoutePolicyInput, match: (hop: CategorizerHop) => boolean): number {
  for (let i = input.hops.length - 1; i >= 0; i -= 1) if (match(input.hops[i])) return i;
  return -1;
}

/**
 * FLOOR 0 — A CHANGE THAT WAS WRITTEN IS A CHANGE THAT GETS LOOKED AT.
 *
 * The bug-fix floors below all stand down the moment the run has written
 * something, which left the ordinary development task — the majority of runs —
 * with no floor at all. From the run that produced this: `write_edit` changed a
 * dialog title in two Flutter files, nominated `summarise`, and the chain
 * obliged. The report said the files "were written to but does not indicate
 * what the new title value is or whether any verification was performed" —
 * because none was. `activity_inspect` was write_edit's ONLY child and it was
 * never entered, so nothing built the app, nothing captured the screen, and the
 * run ended one hop short of the evidence it exists to produce.
 *
 * So: while a hop that WROTE files is more recent than the last hop that
 * inspected them, `summarise` is not available. Keyed off the hop index rather
 * than a boolean because the repair loop writes again after a FAIL — the second
 * write owes a second look, exactly like the first.
 *
 * This is not the harness overruling the user about whether to do QA: the
 * inspect hop OPENS by asking them (agent / manual / skip — see
 * `enforceQaHandshake`), which is a question they can only be asked from inside
 * the hop. `verify: false` (`preferInspect === false`) still turns the whole
 * thing off up front.
 */
function applyVerifyFloor(input: RoutePolicyInput, selection: RouterChoice): RouteDecision | undefined {
  if (selection !== "summarise") return undefined;
  if (input.preferInspect === false) return undefined;
  if (input.writtenPaths.length === 0) return undefined;
  if (!has(input, "activity_inspect")) return undefined;
  const lastId = input.hops[input.hops.length - 1]?.id;
  if (lastId === "activity_inspect") return undefined;
  const lastWrite = lastHopIndex(input, (hop) => (hop.writtenPaths?.length ?? 0) > 0);
  const lastInspect = lastHopIndex(input, (hop) => hop.id === "activity_inspect");
  // With per-hop write records, "the last write is newer than the last look" is
  // the exact question. Without them (a host that reports run-level writes only)
  // fall back to "has anything inspected at all" — the writes exist either way.
  if (lastWrite >= 0 ? lastWrite < lastInspect : lastInspect >= 0) return undefined;
  return {
    selection: "activity_inspect",
    source: "policy",
    reason:
      `refusing to summarise ${input.writtenPaths.length} written file(s) that nothing has verified — ` +
      "the change gets run and looked at before the run is called finished (the inspect hop asks the " +
      "user whether it drives, they drive, or QA is skipped)",
    queue: [...input.queue],
  };
}

/**
 * The floors. Applied to whatever 1 or 3 produced — INCLUDING a driver nomination.
 *
 * Deliberately narrow. A floor that fires on "understand the auth flow and give
 * me a summary" would force a pointless QA hop onto a run that correctly has
 * nothing to change, which is a worse failure than the ones being fixed — so
 * each rule keys off a signal that something is OWED: files written and never
 * looked at (FLOOR 0), or a reported bug the run has done nothing about at all
 * (FLOORS 1-2, which stand down the moment anything is written).
 */
function applyFloors(input: RoutePolicyInput, selection: RouterChoice): RouteDecision | undefined {
  const verify = applyVerifyFloor(input, selection);
  if (verify) return verify;
  if (!input.isBugFix) return undefined;
  if (input.writtenPaths.length > 0) return undefined;
  if (!input.hops.length) return undefined;

  const lastId = input.hops[input.hops.length - 1]?.id;

  // FLOOR 1 — SEE IT BEFORE YOU FIX IT.
  //
  // From a run where the split had just landed: read was offered
  // [activity_reproduce, write_edit], nominated `write_edit`, and went straight
  // to editing the file its reading had pointed at. Nothing was reproduced,
  // nothing was instrumented, and the user stopped the run.
  //
  // The nomination channel exists because the driver knows more than the router
  // does — but "more" is about the code it just read, and no amount of reading
  // tells you whether the defect you inferred is the defect the user has. On a
  // reported bug that is the one question the run cannot answer from source, so
  // this is not the driver's call to make.
  //
  // The nomination is not discarded: it goes to the FRONT of the queue, so the
  // fix the driver asked for happens immediately after reproduction, with the
  // evidence in hand and without another routing call.
  const alreadyReproduced = input.hops.some((hop) => hop.id === "activity_reproduce");
  if (
    !alreadyReproduced &&
    input.preferInspect !== false &&
    (selection === "summarise" || selection === "write_edit") &&
    has(input, "activity_reproduce") &&
    lastId !== "activity_reproduce"
  ) {
    return {
      selection: "activity_reproduce",
      source: "policy",
      reason:
        `a reported bug is reproduced before it is fixed — ${selection} was chosen with nothing ` +
        "written yet and the defect never observed",
      // `summarise` is not worth queueing: if reproduction finds nothing to do it
      // can say so itself.
      queue: selection === "summarise" ? [...input.queue] : [selection, ...input.queue],
    };
  }

  if (selection !== "summarise") return undefined;

  // FLOOR 2 — a reported bug is not resolved by describing it. Reaches here when
  // reproduction has already run, or when there is no reproduce hop to route to.
  for (const id of ["activity_reproduce", "activity_inspect"] as const) {
    if (input.preferInspect === false) break;
    if (!has(input, id) || lastId === id || (id === "activity_reproduce" && alreadyReproduced)) continue;
    return {
      selection: id,
      source: "policy",
      reason:
        "refusing to summarise a reported bug that nothing has been done about — " +
        `the run has written no files, so ${id === "activity_reproduce" ? "reproduce" : "inspect"} ` +
        "it before it is called finished",
      queue: [],
    };
  }
  if (has(input, "write_edit") && lastId !== "write_edit") {
    return {
      selection: "write_edit",
      source: "policy",
      reason:
        "refusing to summarise a reported bug with no fix — the run has written no files " +
        "and describing a defect is not repairing it",
      queue: [],
    };
  }
  return undefined;
}

/**
 * Decide the next hop from the driver's nomination alone, or report that the
 * router is needed.
 *
 * Split from the router call so the chain can skip that LLM turn entirely when
 * the driver already answered — which is the common case once a categorizer
 * fills in `nextCategorizers`, and is one fewer model call per hop.
 */
export function decideFromDriver(input: RoutePolicyInput): RouteDecision | undefined {
  const taken = takeFromQueue(input);
  if (!taken) return undefined;
  const floored = applyFloors({ ...input, queue: taken.queue }, taken.id);
  if (floored) return floored;
  const lastId = input.hops[input.hops.length - 1]?.id ?? "entry";
  return {
    selection: taken.id,
    source: "driver",
    reason: `${lastId}'s deliver nominated ${taken.id}`,
    queue: taken.queue,
  };
}

/** Apply the floors to a decision the ROUTER made. */
export function applyPolicyToRouted(
  input: RoutePolicyInput,
  selection: RouterChoice,
  reason: string,
  fallback: boolean,
): RouteDecision {
  const floored = applyFloors(input, selection);
  if (floored) return { ...floored, reason: `${floored.reason} (router said summarise: ${reason})` };
  return { selection, source: fallback ? "heuristic" : "router", reason, queue: input.queue };
}
