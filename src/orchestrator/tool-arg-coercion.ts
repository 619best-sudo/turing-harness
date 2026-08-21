/**
 * Making a tool call usable when the model got the ARGUMENT TYPES right-ish.
 *
 * Tool schemas say `newString` is a string. Models routinely send something
 * else, and which something varies by model family, not by anything the harness
 * controls:
 *
 *     newString: ["line one", "line two"]              // split into lines
 *     newString: [{ type: "text", text: "…" }]         // content blocks
 *     newString: { text: "…" }                         // wrapped in an object
 *     limit: "50"                                      // number as a string
 *
 * None of that is a misunderstanding of the TASK — the model knows what it wants
 * to write, and has expressed it unambiguously. It is a serialisation
 * difference, and rejecting the call spends a whole turn teaching a model
 * something it will get wrong again on the next call.
 *
 * Worse than rejecting is what the harness actually did with an array: `edit`
 * read the argument through `String(args.newString ?? "")`, and `String(["a",
 * "b"])` is `"a,b"` — so a two-line replacement was written into the user's file
 * COMMA-JOINED, with no error anywhere. A silent corruption is the worst
 * possible answer to a recoverable mistake.
 *
 * So: coerce what is unambiguous, leave everything else alone for the existing
 * validation to reject with its normal message. Driven by each tool's own JSON
 * Schema, so it applies to every tool — built-in, MCP, or a host's own — without
 * naming a single argument.
 */
import type { AgentTool, JSONSchema } from "../types.js";
import { parseJsonLoose } from "../robust-json.js";

/** One coercion that happened, for the log and for the model-facing note. */
export interface CoercedArg {
  key: string;
  /** What arrived, described for a human: "array of 2 strings", "object". */
  from: string;
  /**
   * What it was turned INTO. Absent means "string" — the original direction of
   * this module — so an existing caller reads unchanged. "arguments" means the
   * whole argument object was recovered from inside this one field.
   */
  to?: "string" | "array" | "object" | "arguments";
}

export interface CoercionResult {
  args: Record<string, unknown>;
  coerced: CoercedArg[];
}

/** The declared type(s) of a schema property, as a set. */
function declaredTypes(schema: unknown): Set<string> {
  const t = (schema as { type?: unknown } | undefined)?.type;
  if (typeof t === "string") return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === "string"));
  return new Set();
}

/**
 * Join string pieces back into one string.
 *
 * The ambiguity worth getting right: an array may be LINES (join with newlines)
 * or CHUNKS that already carry their own (join with nothing). Splitting on that
 * by guessing would corrupt one case or the other, but the pieces say which they
 * are — a piece that already ends in a newline is a chunk, and a set of lines
 * never does.
 */
function joinPieces(pieces: string[]): string {
  const anyTrailingNewline = pieces.some((p) => p.endsWith("\n"));
  return anyTrailingNewline ? pieces.join("") : pieces.join("\n");
}

/**
 * The one case this module is not certain about, stated plainly: several text
 * BLOCKS none of which ends in a newline. They could be lines (join with "\n")
 * or mid-token streaming chunks (join with ""). The rule above reads them as
 * lines, which matches what models actually send in tool arguments — a single
 * block is the overwhelmingly common shape, and multi-block replies have been
 * line-shaped every time they have been seen. A caller that finds otherwise
 * should make this reject rather than guess differently, because the note on the
 * result already tells the model the shape to use instead.
 */

/**
 * The string hiding inside a non-string value, or undefined when there is no
 * unambiguous reading.
 *
 * Deliberately conservative. Anything not listed here — a number where prose was
 * wanted, a nested structure, a mixed array — returns undefined so the call is
 * rejected by the normal validation rather than silently reinterpreted. The bar
 * is "there is exactly one thing this could have meant".
 */
export function coerceToString(value: unknown): { text: string; from: string } | undefined {
  if (typeof value === "string") return undefined; // already fine

  // A number or boolean in a string field: `limit: "50"` in reverse. One reading.
  if (typeof value === "number" || typeof value === "boolean") {
    return { text: String(value), from: typeof value };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { text: "", from: "empty array" };
    // Lines or chunks.
    if (value.every((v) => typeof v === "string")) {
      return { text: joinPieces(value as string[]), from: `array of ${value.length} strings` };
    }
    // Content blocks: `[{ type: "text", text: "…" }]`, the shape a model reaches
    // for when it is thinking in message parts rather than tool arguments.
    const texts = value.map((v) =>
      v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string"
        ? ((v as { text: string }).text)
        : undefined,
    );
    if (texts.every((t): t is string => typeof t === "string")) {
      return { text: joinPieces(texts), from: `array of ${value.length} text blocks` };
    }
    return undefined;
  }

  if (value && typeof value === "object") {
    // A single wrapper around the real value. Only these keys, and only when the
    // object carries nothing else — an object with two fields is a structure the
    // model meant, not a wrapper it added.
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const key = keys[0]!;
      if (["text", "content", "value", "string"].includes(key)) {
        const inner = obj[key];
        if (typeof inner === "string") return { text: inner, from: `object with a '${key}' field` };
        const nested = coerceToString(inner);
        if (nested) return { text: nested.text, from: `object with a '${key}' field` };
      }
    }
    return undefined;
  }

  return undefined;
}

/**
 * The structure hiding inside a JSON STRING, when the schema asked for structure.
 *
 * The mirror of `coerceToString`, and the same class of mistake in the other
 * direction: a model that is thinking "the arguments are JSON" serialises a field
 * twice. Observed on `deliver`, whose schema declares `files` as an array of
 * objects:
 *
 *     files: "[{\"path\": \"/a.dart\", \"role\": \"list screen\", …}]"
 *
 * That is not a misunderstanding of the task — every field the contract asked for
 * is there, correctly, one layer too deep. And the cost of letting it through is
 * silent: nothing throws, the deliverable simply carries a string where the next
 * categorizer's opening expects a list, so the structured file handoff that the
 * whole read→write contract is built on renders as an opaque blob. The run that
 * exposed this delivered nine correctly-described files and handed on none of
 * them.
 *
 * Conservative in the same way as its mirror: the text must OPEN AND CLOSE with
 * the wanted shape's brackets, the parse must SUCCEED, and it must produce that
 * shape. Anything else returns undefined and the normal validation rejects it —
 * including a doubly-encoded value, which arrives wrapped in quotes and so never
 * passes the bracket check. That is deliberate: one unambiguous reading is the
 * bar, and a model that encoded twice is guessing about the contract rather than
 * serialising a value it already has right.
 */
export function coerceFromJsonString(
  value: unknown,
  want: "array" | "object",
): { value: unknown; from: string } | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  // Cheap shape check before paying for a parse — and it keeps ordinary prose
  // that happens to contain a brace out of here. A tool ARGUMENT that was meant
  // to be structured is the whole value, not a value mentioned inside a sentence,
  // so the stricter test belongs here rather than in the shared locator.
  const opener = want === "array" ? "[" : "{";
  if (!text.startsWith(opener)) return undefined;
  const found = parseJsonLoose(text, want);
  if (!found) return undefined;
  return {
    value: found.value,
    from: found.repairs.length ? `JSON string (${found.repairs.join("; ")})` : "JSON string",
  };
}

/**
 * Rename an argument the model spelled differently to the field the tool declares.
 *
 * Two sources, both exact, neither a guess:
 *
 *   1. THE SCHEMA ITSELF, for spelling variants. `old_string`, `oldstring` and
 *      `OldString` all normalize to the same token as `oldString`, so the
 *      intended field is not in doubt. This needs no per-tool table and stays
 *      correct as schemas change.
 *   2. THE TOOL'S OWN `argAliases`, for names that mean the same thing without
 *      looking alike (`end` → `endLine`). A tool declares those because only it
 *      knows them.
 *
 * A rename never overwrites a field the model ALSO sent under its real name: two
 * different values for one parameter is ambiguous, and ambiguous is where this
 * module stops.
 */
export function resolveArgAliases(
  tool: AgentTool,
  args: Record<string, unknown> | undefined,
): { args: Record<string, unknown>; renamed: Array<{ from: string; to: string }> } {
  if (!args) return { args: {}, renamed: [] };
  const properties = (tool.parameters as JSONSchema | undefined)?.properties as
    | Record<string, unknown>
    | undefined;
  if (!properties) return { args, renamed: [] };
  const declared = Object.keys(properties);
  const byNormalized = new Map(declared.map((name) => [normalizeArgName(name), name]));
  const aliases = tool.argAliases ?? {};
  const aliasByNormalized = new Map(
    Object.entries(aliases).map(([alias, real]) => [normalizeArgName(alias), real]),
  );

  let out: Record<string, unknown> | undefined;
  const renamed: Array<{ from: string; to: string }> = [];
  for (const key of Object.keys(args)) {
    if (key in properties) continue;
    const normalized = normalizeArgName(key);
    const target = byNormalized.get(normalized) ?? aliasByNormalized.get(normalized);
    if (!target || target === key) continue;
    // The real name is already present and carries its own value — leave both
    // alone and let unknown-key detection report the stray one.
    if (target in args) continue;
    out ??= { ...args };
    out[target] = out[key];
    delete out[key];
    renamed.push({ from: key, to: target });
  }
  return { args: out ?? args, renamed };
}

/** Case- and separator-insensitive form of an argument name. */
function normalizeArgName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, "");
}

/** The line a corrected call should have been, for the model-facing note. */
export function renameNote(
  toolName: string,
  renamed: ReadonlyArray<{ from: string; to: string }>,
  repeated: boolean,
  parameters?: { properties?: Record<string, unknown>; required?: unknown },
): string {
  const list = renamed.map((r) => `'${r.from}' → '${r.to}'`).join("; ");
  const lines = [
    `NOTE: ${toolName} does not have ${renamed.length > 1 ? "those arguments" : "that argument"}; ` +
      `${list} was applied and the call ran normally.`,
  ];
  if (repeated) {
    // Saying it once did not stop it. Say it with the whole signature, and say
    // that it has happened before — a note identical to the last one reads as
    // the same generic warning rather than a second correction.
    const props = (parameters?.properties ?? {}) as Record<string, { type?: string }>;
    const required = new Set(Array.isArray(parameters?.required) ? (parameters?.required as string[]) : []);
    const signature = Object.entries(props)
      .map(([name, spec]) => `${name}${required.has(name) ? "" : "?"}: ${spec?.type ?? "any"}`)
      .join(", ");
    lines.push(
      `You have now sent ${renamed.length > 1 ? "these names" : "this name"} more than once in this ` +
        `categorizer. The signature is \`${toolName}({ ${signature} })\` — use exactly those names.`,
    );
  }
  return lines.join("\n");
}

/**
 * The whole argument object, spilled into the first field's string.
 *
 * The worst shape seen so far, and it defeats every check above because the
 * string is not JSON — it is the TAIL OF THE ARGUMENT OBJECT with its opening
 * `{"files": ` chopped off. From a real `deliver` call:
 *
 *     { files: "[{\"path\": \"…\"}], \"codeSummary\": \"…\", \"nextCategorizers\": [\"write_edit\"]" }
 *
 * The model wrote every argument correctly, opened a quote before the first
 * value, and never closed it — so `files` swallowed the rest of the object and
 * the other three arguments vanished. What the run then saw was "missing required
 * argument 'codeSummary'", which is true and completely unhelpful: the model
 * DID send it, is told it did not, re-sends the identical call, and the hop dies
 * two rejections later. That is what happened — twice, then a `bash {}` out of
 * desperation, then the run ended having written nothing.
 *
 * The repair is exact rather than heuristic: put the missing prefix back and
 * parse. `{"<key>": <the string, verbatim>}` either yields the object the model
 * meant or it does not parse at all. Two more conditions before it is accepted:
 * every recovered key must be one the schema DECLARES (so a parse that happens to
 * succeed on unrelated text is rejected), and it must recover more than it
 * started with. Nothing here guesses at content.
 */
export function recoverSpilledArgs(
  tool: AgentTool,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; key: string } | undefined {
  const properties = (tool.parameters as JSONSchema | undefined)?.properties as
    | Record<string, unknown>
    | undefined;
  if (!properties) return undefined;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    // Only a value that OPENED a structure can have swallowed what followed it.
    if (!text.startsWith("[") && !text.startsWith("{")) continue;
    // A value that parses on its own did not spill — `coerceFromJsonString` owns
    // that case. This one is for text with the rest of the object trailing it.
    try {
      JSON.parse(text);
      continue;
    } catch {
      // expected: "Extra data" — the trailing arguments. Anything else (a cut-off
      // value) is also welcome here: the repair below handles both.
    }
    // Put the missing prefix back. The shared parser then also survives a
    // response that was CUT OFF as well as spilled — the tail it cannot complete
    // is dropped rather than losing every argument.
    const parsed = parseJsonLoose(`{${JSON.stringify(key)}: ${text}}`, "object");
    if (!parsed) continue;
    const recovered = parsed.value as Record<string, unknown>;
    const keys = Object.keys(recovered);
    if (keys.length <= Object.keys(args).length) continue;
    if (!keys.every((name) => name in properties)) continue;
    // Keep any argument the model sent alongside the spill; the recovered object
    // wins where they collide, since it is the more complete statement.
    return { args: { ...args, ...recovered }, key };
  }
  return undefined;
}

/**
 * Coerce every argument the tool's schema declares as a string.
 *
 * Returns a NEW arguments object; the original is not mutated, so a caller that
 * logs the raw call still shows what the model actually sent.
 */
export function coerceStringArgs(tool: AgentTool, args: Record<string, unknown> | undefined): CoercionResult {
  if (!args) return { args: {}, coerced: [] };
  const properties = (tool.parameters as JSONSchema | undefined)?.properties;
  if (!properties || typeof properties !== "object") return { args, coerced: [] };

  const coerced: CoercedArg[] = [];
  // First, because it changes WHICH arguments exist: a spill hides every
  // argument after the first one, and the per-key pass below cannot coerce a
  // field it cannot see.
  const spill = recoverSpilledArgs(tool, args);
  if (spill) {
    args = spill.args;
    coerced.push({ key: spill.key, from: "the whole argument object", to: "arguments" });
  }
  let out: Record<string, unknown> | undefined;
  for (const [key, schema] of Object.entries(properties as Record<string, unknown>)) {
    if (!(key in args)) continue;
    const value = args[key];
    if (value == null) continue;
    const types = declaredTypes(schema);
    // A string where the schema wanted structure — the JSON-in-JSON direction.
    if (typeof value === "string") {
      if (types.has("string")) continue; // the string is what was asked for
      const want = types.has("array") ? "array" : types.has("object") ? "object" : undefined;
      if (!want) continue;
      const unwrapped = coerceFromJsonString(value, want);
      if (!unwrapped) continue;
      out ??= { ...args };
      out[key] = unwrapped.value;
      coerced.push({ key, from: unwrapped.from, to: want });
      continue;
    }
    // Only where the schema actually asked for a string, and did not also accept
    // the shape that arrived (a `["string","array"]` field means both are valid).
    if (!types.has("string")) continue;
    if (Array.isArray(value) && types.has("array")) continue;
    if (typeof value === "object" && types.has("object")) continue;
    if (typeof value === "number" && (types.has("number") || types.has("integer"))) continue;
    if (typeof value === "boolean" && types.has("boolean")) continue;

    const fixed = coerceToString(value);
    if (!fixed) continue;
    out ??= { ...args };
    out[key] = fixed.text;
    coerced.push({ key, from: fixed.from });
  }
  return { args: out ?? args, coerced };
}

/**
 * The note appended to a coerced call's result.
 *
 * Repairing silently would make a model that keeps getting this wrong look like
 * one that gets it right, and the run would never learn to stop. Naming it costs
 * one line and tells the model the exact shape to send next time.
 */
export function coercionNote(coerced: readonly CoercedArg[], toolName: string): string {
  const lines: string[] = [];
  const toStrings = coerced.filter((c) => (c.to ?? "string") === "string");
  const toStructures = coerced.filter((c) => c.to === "array" || c.to === "object");
  if (toStrings.length) {
    const list = toStrings.map((c) => `'${c.key}' arrived as ${c.from}`).join("; ");
    lines.push(
      `NOTE: ${list}. ${toStrings.length > 1 ? "Those arguments were" : "That argument was"} joined into a ` +
        `plain string and \`${toolName}\` ran normally — but send string arguments as ONE string next time ` +
        `(a single value with \\n between lines), not a list or an object.`,
    );
  }
  const spilled = coerced.filter((c) => c.to === "arguments");
  if (spilled.length) {
    lines.push(
      `NOTE: every argument was collapsed into '${spilled[0]?.key}' as one string — you opened a quote ` +
        `before its value and never closed it, so that field swallowed the rest of the argument list. ` +
        `They were recovered and \`${toolName}\` ran normally. Send each argument as its own JSON value: ` +
        `an array field takes [ … ], a string field takes "…", and no field contains the others.`,
    );
  }
  if (toStructures.length) {
    const list = toStructures.map((c) => `'${c.key}' arrived as a ${c.from} (expected an ${c.to})`).join("; ");
    lines.push(
      `NOTE: ${list}. ${toStructures.length > 1 ? "They were" : "It was"} parsed and \`${toolName}\` ran ` +
        `normally — but send structured arguments as REAL JSON values, not as a string containing JSON. ` +
        `The arguments object is already JSON; encoding a field again puts it one layer too deep, and a ` +
        `consumer expecting a list gets an opaque string.`,
    );
  }
  return lines.join("\n\n");
}
