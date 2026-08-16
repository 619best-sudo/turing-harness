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

/** One coercion that happened, for the log and for the model-facing note. */
export interface CoercedArg {
  key: string;
  /** What arrived, described for a human: "array of 2 strings", "object". */
  from: string;
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
 * Coerce every argument the tool's schema declares as a string.
 *
 * Returns a NEW arguments object; the original is not mutated, so a caller that
 * logs the raw call still shows what the model actually sent.
 */
export function coerceStringArgs(tool: AgentTool, args: Record<string, unknown> | undefined): CoercionResult {
  if (!args) return { args: {}, coerced: [] };
  const properties = (tool.parameters as JSONSchema | undefined)?.properties;
  if (!properties || typeof properties !== "object") return { args, coerced: [] };

  let out: Record<string, unknown> | undefined;
  const coerced: CoercedArg[] = [];
  for (const [key, schema] of Object.entries(properties as Record<string, unknown>)) {
    if (!(key in args)) continue;
    const value = args[key];
    if (typeof value === "string" || value == null) continue;
    const types = declaredTypes(schema);
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
  const list = coerced.map((c) => `'${c.key}' arrived as ${c.from}`).join("; ");
  return (
    `NOTE: ${list}. ${coerced.length > 1 ? "Those arguments were" : "That argument was"} joined into a ` +
    `plain string and \`${toolName}\` ran normally — but send string arguments as ONE string next time ` +
    `(a single value with \\n between lines), not a list or an object.`
  );
}
