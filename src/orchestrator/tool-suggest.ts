/**
 * "Did you mean" suggestions for unknown tool calls.
 *
 * The model occasionally calls a tool name that is not registered — most often
 * when it reaches for an MCP server's name (`playwright`) instead of the
 * server's actual tool names (`browser_navigate`, `browser_take_screenshot`),
 * because the function-calling list is the ONLY channel that carries tool names
 * and the system prompt deliberately does not enumerate them. A bare
 * `Unknown tool "X"` leaves the model to guess, costing a full turn before it
 * falls back. Surfacing the closest real name (and the full roster when no
 * close match exists) lets it recover immediately.
 *
 * Mirrors the established "closest confirmed path" pattern (`suggestKnownPath`
 * in phase-runner.ts): tell the model the closest valid value rather than just
 * rejecting the call.
 */

/**
 * Bounded Levenshtein distance. Returns `Infinity` once the running cost
 * exceeds `max`, so a wildly-unrelated candidate short-circuits instead of
 * computing the full matrix. Self-contained (not imported from phase-runner)
 * so this helper stays a leaf module with no orchestrator-internal deps.
 */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  if (Math.abs(al - bl) > max) return Infinity;
  let prev = Array.from({ length: bl + 1 }, (_, i) => i);
  const cur = new Array<number>(bl + 1).fill(0);
  for (let i = 0; i < al; i++) {
    cur[0] = i + 1;
    let rowMin = cur[0];
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur[j + 1] = Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost);
      if (cur[j + 1] < rowMin) rowMin = cur[j + 1];
    }
    if (rowMin > max) return Infinity;
    for (let j = 0; j < prev.length; j++) prev[j] = cur[j];
  }
  return prev[bl] ?? Infinity;
}

/**
 * Whether `requested` is a plausible near-miss for `candidate`. Beyond raw edit
 * distance this catches the common MCP-confusion shapes:
 *   - the candidate CONTAINS the requested token (`playwright` →
 *     `mcp__playwright__browser_navigate`) or vice-versa;
 *   - the requested and candidate share a segment (`browser` → `browser_navigate`).
 * These are not typos — they are category reaches — and they are the case the
 * bare Levenshtein misses because the strings differ in length so much.
 */
function plausiblyRelated(requested: string, candidate: string): boolean {
  const r = requested.toLowerCase();
  const c = candidate.toLowerCase();
  if (r === c) return true;
  // A shared meaningful segment (length 4+ so "ed"/"at" never qualify).
  const rTokens = r.split(/[_\W]+/).filter((t) => t.length >= 4);
  const cTokens = c.split(/[_\W]+/).filter((t) => t.length >= 4);
  if (rTokens.some((t) => cTokens.includes(t))) return true;
  // One contains the other as a substring.
  if (r.length >= 4 && c.includes(r)) return true;
  if (c.length >= 4 && r.includes(c)) return true;
  return false;
}

/**
 * The closest registered tool name to `requested`, or undefined when nothing is
 * close enough to be worth suggesting. Combines edit distance (typos) with the
 * `plausiblyRelated` category check (MCP name confusion).
 */
export function suggestToolName(requested: string, known: Iterable<string>): string | undefined {
  const req = requested.toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const candidate of known) {
    const dist = levenshtein(req, candidate.toLowerCase(), 4);
    const related = plausiblyRelated(req, candidate);
    // Accept a close edit-distance match OR a plausible category relation, but
    // rank edit-distance wins above category relations (a typo of a real name
    // is a stronger signal than a shared token).
    if (dist > 4 && !related) continue;
    const score = related ? Math.min(dist, 3) + 0.5 : dist;
    if (!best || score < best.score) best = { name: candidate, score };
  }
  // A suggestion is only helpful if it is meaningfully different from the name
  // the model already tried; an exact (case-insensitive) match would not have
  // reached the unknown-tool branch, but the guard keeps the contract honest.
  return best?.name && best.name.toLowerCase() !== req ? best.name : undefined;
}

/**
 * Build the model-facing message for an unknown tool call. Leads with the
 * closest match when one exists, then lists the actually-available tools so the
 * model can pick the right one and re-issue the call instead of guessing.
 *
 * The roster is capped to keep the message short when a run has many tools
 * (a host with a large MCP surface can register dozens); the cap is generous
 * enough to cover the common case in full.
 */
/**
 * Provider tool-call framing that has leaked into the tool NAME.
 *
 * Some endpoints delimit tool calls with sentinel tokens, and when the stream is
 * mis-segmented the framing lands in the `name` field. Sometimes the whole call —
 * delimiters, JSON arguments and all — arrives there with empty `arguments`;
 * sometimes only the name is mangled and the arguments come through intact, in
 * which case the loop repairs the name and runs the call (see the
 * framing-recovery block in `loop.ts`). Observed four times in one run:
 *
 *   name: `bash<|tool_call_begin|>cat /var/…/bash-….log 2>&1 | head -50</arg_value>`
 *   name: `mobile_click_on_screen_at_coordinates<|tool_call_begin|>{"device": …}<|tool_call_end|>`
 *
 * Every one came back as a bare `Unknown tool "<the whole mess>"`, which is true
 * and useless: the name is nowhere near any real tool, so the edit-distance
 * suggestion cannot fire, and the model is told only that a tool it never meant to
 * name does not exist. It retried differently each time, which is how a transport
 * hiccup turns into a run wandering.
 */
const TOOL_FRAMING_RE = /<\|[a-z_]+\|>|<\/?arg_value>|<\/?tool_call[a-z_]*>/i;

/**
 * The real tool name hiding in front of leaked framing, when there is one.
 *
 * Only the leading identifier is trusted. The rest of the string is the mangled
 * payload and is never parsed, so this can recover the NAME but never
 * reconstructs arguments — a call is only re-run when its own `arguments` field
 * survived the transport.
 */
export function nameBeforeFraming(requested: string, known: Iterable<string>): string | undefined {
  if (!TOOL_FRAMING_RE.test(requested)) return undefined;
  const head = requested.split(TOOL_FRAMING_RE)[0]?.trim();
  if (!head) return undefined;
  for (const name of known) if (name === head) return name;
  return undefined;
}

export function unknownToolMessage(requested: string, known: Iterable<string>): string {
  const knownList = [...known];
  // A framing leak is a TRANSPORT fault, not a wrong tool name, and saying so is
  // the difference between a one-line correction and another wasted turn.
  //
  // Reaching this branch now means the call could NOT be repaired — the loop
  // rewrites the name and runs the call whenever the arguments survived (see the
  // framing-recovery block in `loop.ts`). So the arguments really are missing or
  // unreadable here, and the message may say so. It did not used to be true: this
  // text asserted "the arguments were empty" for every framed call, including one
  // observed arriving as `read<|channel|>clipboard` with a complete
  // `{path, offset, limit}` — a false diagnosis the model then tried to act on.
  const framed = nameBeforeFraming(requested, knownList);
  if (framed) {
    return [
      `Your tool call arrived malformed: the tool NAME field contained call-framing tokens, and no readable ` +
        `arguments came with it, so nothing ran.`,
      `The tool you meant is "${framed}" — that part was correct.`,
      `Re-issue it as a normal call: the name "${framed}" on its own, with the arguments as a JSON object. ` +
        `Do not include tokens like <|tool_call_begin|> in the name. (Had the arguments come through, the ` +
        `harness would have repaired the name and run it for you.)`,
    ].join("\n");
  }
  const suggestion = suggestToolName(requested, knownList);
  const lines = [`Unknown tool "${requested}".`];
  if (suggestion) {
    lines.push(`Did you mean "${suggestion}"? Re-issue the call with that name.`);
  }
  if (knownList.length) {
    const sorted = [...knownList].sort();
    // Cap the list: a very large MCP registry would make this message dominate
    // the turn. The model almost always wants a named tool it can see.
    const cap = 40;
    const shown = sorted.length > cap ? [...sorted.slice(0, cap), `... (${sorted.length - cap} more)`] : sorted;
    lines.push(`Available tools: ${shown.join(", ")}.`);
  }
  lines.push(`Do not repeat the "${requested}" call; it is not a registered tool.`);
  return lines.join("\n");
}

/**
 * Argument keys the model supplied that are NOT in the tool's schema.
 *
 * The harness validates that `required` fields are present, but it never checked
 * that the fields the model actually sent are real — so a hallucinated property
 * (`timeout` on a tool that has none), a typo (`comand` for `command`), or a
 * cross-tool schema conflation (`bash({url, command})`, mixing two tools'
 * fields) was accepted silently and passed to the tool, which ignored the
 * unknown key. The real required field was missing, the call ran with wrong or
 * no intent, and the failure looked like a model mistake the harness could do
 * nothing about. Catching the unknown key UP FRONT names the hallucination,
 * suggests the closest real field for a typo, and tells the model which fields
 * this tool actually accepts — so it re-issues a well-formed call.
 */

/**
 * Argument keys the runner reads off `call.arguments` but which are NOT in any
 * tool's JSON schema, because they are runner-level signals rather than tool
 * inputs:
 *   - `complexity`/`category`: per-call model routing. The model is told it MAY
 *     self-rate write/edit, and defensively including them on another tool is
 *     harmless (the loop only consumes them under `canDeclareComplexity`).
 *   - `verify`: the verification gate declaration, read for write/edit.
 *
 * These must be excluded from unknown-key detection globally, or every call
 * that carries a self-rating (and a test stub standing in for write/edit)
 * would false-positive. They are harness-wide reserved argument names.
 */
const RUNNER_RESERVED_KEYS = new Set(["complexity", "category", "verify"]);

/**
 * Authoring fields the schema deliberately OMITS under `authorOnlyWrites` (the
 * authoring model supplies the bytes, so Model A is told to send only the path
 * + anchor). They are nonetheless ALWAYS semantically valid for the model to
 * send — and the tools read them when present (`coding.ts` draftNewStr/draft).
 *
 * They must NOT be flagged as unknown-argument typos: the call succeeds either
 * way (Model B authors, or the draft is used), and the "re-issue the call"
 * warning a flagged key produces was observed making the model re-issue an
 * IDENTICAL edit — which then failed `oldString not found` because the first
 * one had already applied. A real, silent double-edit traced to this warning.
 * Keyed by tool name so the exemption is narrow: only the field that tool
 * accepts-but-omits, never a blanket pass on an unrelated hallucinated key.
 */
const AUTHORING_FIELDS_BY_TOOL: Record<string, Set<string>> = {
  edit: new Set(["newString"]),
  write: new Set(["content"]),
};

/** The set of property names declared in a tool's JSON-schema `properties`. */
function declaredProperties(parameters: { properties?: Record<string, unknown> } | undefined): Set<string> {
  const out = new Set<string>();
  const props = parameters?.properties;
  if (props && typeof props === "object") {
    for (const key of Object.keys(props)) out.add(key);
  }
  return out;
}

/**
 * The unknown argument keys the model supplied for `tool`, paired with the
 * closest declared field name when one looks like a typo (edit distance ≤ 3).
 * Returns an empty array when every key is declared (or a runner-reserved
 * signal the loop reads separately). `mutates` is accepted for symmetry with
 * the loop's mutating flag and reserved for a tighter future gate; the
 * runner-reserved exclusion is tool-name-agnostic by design (see above).
 */
export function unknownArgumentKeys(
  toolName: string,
  parameters: { properties?: Record<string, unknown> } | undefined,
  args: Record<string, unknown> | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _mutates = true,
): Array<{ key: string; suggestion?: string }> {
  void toolName;
  const declared = declaredProperties(parameters);
  const authoringFields = AUTHORING_FIELDS_BY_TOOL[toolName];
  const supplied = args ? Object.keys(args) : [];
  const out: Array<{ key: string; suggestion?: string }> = [];
  for (const key of supplied) {
    if (declared.has(key) || RUNNER_RESERVED_KEYS.has(key)) continue;
    if (authoringFields?.has(key)) continue;
    // A typo is the common case: suggest the closest declared field within a
    // small edit distance so the model can correct `comand` → `command`.
    let suggestion: string | undefined;
    let best = Infinity;
    for (const real of declared) {
      const d = levenshtein(key.toLowerCase(), real.toLowerCase(), 3);
      if (d < best) {
        best = d;
        suggestion = real;
      }
    }
    out.push({ key, ...(suggestion && best <= 3 ? { suggestion } : {}) });
  }
  return out;
}

/**
 * Build the model-facing message for a call that carries unknown argument keys.
 * Names each unknown key, suggests the typo fix when one exists, and lists the
 * fields the tool actually accepts so the model can re-issue correctly.
 */
export function unknownArgumentMessage(
  toolName: string,
  parameters: { properties?: Record<string, unknown> } | undefined,
  unknown: Array<{ key: string; suggestion?: string }>,
): string {
  const accepted = [...declaredProperties(parameters)].sort();
  const lines: string[] = [];
  for (const { key, suggestion } of unknown) {
    if (suggestion) {
      lines.push(`${toolName}: argument '${key}' is not recognised — did you mean '${suggestion}'?`);
    } else {
      lines.push(`${toolName}: argument '${key}' is not a field this tool accepts.`);
    }
  }
  if (accepted.length) {
    lines.push(`${toolName} accepts: ${accepted.join(", ")}.`);
  }
  lines.push(
    `Re-issue the call with only the fields listed above; unknown arguments are dropped and the call ` +
      `runs with the wrong intent or none. Do not repeat the unknown key${unknown.length > 1 ? "s" : ""}.`,
  );
  return lines.join("\n");
}
