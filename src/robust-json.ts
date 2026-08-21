/**
 * Getting the JSON out of whatever a model actually sent.
 *
 * A model asked for JSON returns JSON *and*: a sentence of preamble, a code
 * fence, a closing remark, a trailing comma, `True` instead of `true`, or the
 * first 800 tokens of a 900-token object. None of that is a misunderstanding of
 * the task — the structure is there and unambiguous — so a strict `JSON.parse`
 * throwing away a complete answer over a wrapper is the wrong trade. Every one of
 * these has cost a real run:
 *
 *   - `deliver` sent its whole argument object inside the first field's string.
 *   - The file summarizer's 800-token ceiling truncated EVERY response, so each
 *     parse failed and each file was re-summarized forever.
 *   - The plan extractor had its own balanced-brace scanner; the design skill had
 *     a second; `web` had a third. Each knew a different subset of these tricks.
 *
 * This lives at the root with no imports, for the same reason `project-tree.ts`
 * does: it is shared by modules that must not depend on each other (the
 * orchestrator, memory, and the tools all parse model output).
 *
 * WHAT IT WILL NOT DO. It never invents content. Every repair either makes the
 * text parse or is discarded, and repairs that would change the MEANING of a
 * value are absent by design: no guessing at a missing value, no coercing types,
 * no merging adjacent objects. Where a payload was cut off, the incomplete tail is
 * DROPPED rather than completed — a record keeps the fields that fully arrived and
 * loses the one it was mid-way through, so three of five files come back as three
 * files. A caller can act on a short list; it cannot act on a fabricated entry.
 *
 * Use it for MODEL OUTPUT. Do not use it for files, wire protocols, or
 * subprocess output (`files.json`, MCP frames, `simctl -j`): there, malformed
 * input is a real error and should be reported, not repaired.
 */

/** What shape the caller needs. `any` takes whichever is found first. */
export type JsonWant = "object" | "array" | "any";

export interface JsonExtraction<T = unknown> {
  value: T;
  /**
   * What had to be done, in order — for logging and for telling a model what it
   * sent. Empty means the text was already clean JSON.
   */
  repairs: string[];
}

/** How many cut-back attempts a truncated value gets before giving up. */
const MAX_TRUNCATION_ATTEMPTS = 40;
/** Candidate spans considered in one text. Bounds a pathological brace storm. */
const MAX_CANDIDATES = 40;

const matches = (value: unknown, want: JsonWant): boolean => {
  if (want === "any") return value !== null && typeof value === "object";
  if (want === "array") return Array.isArray(value);
  return !!value && typeof value === "object" && !Array.isArray(value);
};

/**
 * The main entry point: the JSON inside `text`, or undefined.
 *
 * Tried in order of how much interpretation each step costs — a clean parse
 * first, and the aggressive repairs only once everything cheaper has failed, so
 * well-formed input never touches them.
 */
export function parseJsonLoose<T = unknown>(
  text: unknown,
  want: JsonWant = "any",
): JsonExtraction<T> | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // 1. Already valid.
  const direct = tryParse(trimmed);
  if (direct.ok && matches(direct.value, want)) return { value: direct.value as T, repairs: [] };

  // 2. Fenced: ```json … ``` — the single most common wrapper.
  for (const body of codeFenceBodies(trimmed)) {
    const parsed = tryParse(body);
    if (parsed.ok && matches(parsed.value, want)) {
      return { value: parsed.value as T, repairs: ["unwrapped a code fence"] };
    }
  }

  // 3. Embedded: prose before and/or after a complete value.
  //
  //    Ordered OUTERMOST FIRST, then longest, and each span is repaired before
  //    the next is tried. Outermost, because a nested value must never beat the
  //    value that contains it. Longest, because an early `{}` or a brace inside a
  //    sentence of preamble must not beat the real payload further down.
  const spans = balancedSpans(trimmed);
  const ordered = [...spans].sort((a, b) => Number(a.nested) - Number(b.nested) || b.text.length - a.text.length);
  for (const span of ordered.slice(0, MAX_CANDIDATES)) {
    const parsed = tryParse(span.text);
    if (parsed.ok && matches(parsed.value, want)) {
      return {
        value: parsed.value as T,
        repairs: span.text.length === trimmed.length ? [] : ["extracted the JSON from surrounding text"],
      };
    }
    // Repair THIS span before moving on to a smaller one, rather than after
    // trying every span cleanly. That ordering is the point: a truncated
    // `[{"a":1},{"b":2}` contains a perfectly valid `{"a":1}`, and a pass that
    // preferred any clean parse would answer with that one record and silently
    // drop the rest of the list.
    const repaired = repair(span.text, want);
    if (repaired) return { value: repaired.value as T, repairs: repaired.repairs };
  }
  return undefined;
}

/** `parseJsonLoose` narrowed to an object. */
export function parseJsonObjectLoose(text: unknown): Record<string, unknown> | undefined {
  return parseJsonLoose<Record<string, unknown>>(text, "object")?.value;
}

/** `parseJsonLoose` narrowed to an array. */
export function parseJsonArrayLoose(text: unknown): unknown[] | undefined {
  return parseJsonLoose<unknown[]>(text, "array")?.value;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Bodies of every ``` fence in the text, in order, plus the remainder of an
 * UNCLOSED fence (a response cut off mid-block) when there are no closed ones.
 *
 * Exported because a caller that accepts JSON SCALARS — `browser_evaluate` may
 * legitimately return `42` or a re-encoded string — needs the fence bodies
 * without this module's objects-and-arrays-only filter.
 */
export function codeFenceBodies(text: string): string[] {
  const out: string[] = [];
  const fence = /```[a-zA-Z0-9]*\s*([\s\S]*?)```/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const body = m[1]?.trim();
    if (body) out.push(body);
  }
  // An UNCLOSED fence — the model started one and the response was cut off.
  if (!out.length) {
    const open = text.match(/```[a-zA-Z0-9]*\s*([\s\S]*)$/);
    const body = open?.[1]?.trim();
    if (body) out.push(body);
  }
  return out;
}

interface Span {
  text: string;
  start: number;
  end: number;
  /** Contained inside another candidate — considered only after the outer ones. */
  nested: boolean;
}

/**
 * Every balanced `{…}` / `[…]` span in the text, plus, for the first opener that
 * never closes, the unterminated remainder — that one is the truncation case and
 * is what the repair pass works on.
 *
 * String-aware: a brace inside a string literal is text, not structure, and
 * missing that is how a naive scanner mangles a payload containing code (a
 * `snippet` field full of Dart, for instance).
 */
function balancedSpans(text: string): Span[] {
  const found: Array<{ text: string; start: number; end: number }> = [];
  const stack: Array<{ char: string; index: number }> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{" || char === "[") {
      if (stack.length < 200) stack.push({ char, index: i });
      continue;
    }
    if (char === "}" || char === "]") {
      const open = stack.pop();
      if (!open) continue;
      // A mismatched pair (`[` closed by `}`) is not balanced; keep scanning
      // rather than emitting a span that cannot parse.
      if ((open.char === "{") !== (char === "}")) continue;
      if (found.length < MAX_CANDIDATES) found.push({ text: text.slice(open.index, i + 1), start: open.index, end: i + 1 });
    }
  }
  // Whatever is still open ran off the end of the text.
  const truncated = stack[0];
  if (truncated) found.push({ text: text.slice(truncated.index), start: truncated.index, end: text.length });
  return found.map((span) => ({
    ...span,
    nested: found.some((other) => other !== span && other.start <= span.start && other.end >= span.end),
  }));
}

/** Repairs applied in order; each is retried against the parser. */
function repair(span: string, want: JsonWant): JsonExtraction | undefined {
  const repairs: string[] = [];
  let text = span;

  const attempt = (): JsonExtraction | undefined => {
    const parsed = tryParse(text);
    return parsed.ok && matches(parsed.value, want) ? { value: parsed.value, repairs: [...repairs] } : undefined;
  };

  // Typographic quotes, from a model that formatted its answer for a human.
  if (/[“”‘’]/.test(text)) {
    text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    repairs.push("replaced typographic quotes");
    const done = attempt();
    if (done) return done;
  }

  // Python literals — the tell of a model whose training leans that way.
  if (/\b(True|False|None)\b/.test(text)) {
    text = text
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null");
    repairs.push("converted Python literals to JSON");
    const done = attempt();
    if (done) return done;
  }

  // Single-quoted keys and values. ONLY when the text contains no double quote at
  // all: otherwise an apostrophe inside a legitimate string ("don't") would be
  // rewritten into a quote and corrupt the value.
  if (!text.includes('"') && text.includes("'")) {
    text = text.replace(/'/g, '"');
    repairs.push("converted single quotes to double quotes");
    const done = attempt();
    if (done) return done;
  }

  // Trailing commas before a closer.
  if (/,\s*[}\]]/.test(text)) {
    text = text.replace(/,(\s*[}\]])/g, "$1");
    repairs.push("removed trailing commas");
    const done = attempt();
    if (done) return done;
  }

  // Truncation: close what is open, dropping any incomplete tail.
  const completed = completeTruncated(text, want);
  if (completed) {
    return { value: completed.value, repairs: [...repairs, ...completed.repairs] };
  }
  return undefined;
}

/**
 * Close a value that ran off the end of the text.
 *
 * Two moves, in this order. First: shut the open string (if any) and append the
 * closers the bracket stack asks for — enough when the cut landed cleanly, e.g.
 * `[{"a":1},{"b":2}` . Second, when that still will not parse, walk back to the
 * previous element boundary and try again, repeatedly: a cut mid-record leaves
 * `{"path": "…", "role":` , which no amount of closing makes valid, and the
 * honest answer is the records that DID arrive.
 *
 * The dropped tail is reported, so a caller can say "3 of the 5 files arrived"
 * rather than presenting a partial list as complete.
 */
function completeTruncated(text: string, want: JsonWant): JsonExtraction | undefined {
  let body = text;
  for (let attempt = 0; attempt < MAX_TRUNCATION_ATTEMPTS; attempt += 1) {
    const state = scan(body);
    if (state.stack.length || state.inString) {
      const closed =
        body +
        (state.inString ? '"' : "") +
        state.stack
          .slice()
          .reverse()
          .map((char) => (char === "{" ? "}" : "]"))
          .join("");
      const parsed = tryParse(closed);
      // An empty result is not a recovery: a lone `{` in a sentence closes into a
      // valid `{}`, which reads to a caller as "the model sent an empty payload"
      // when nothing was sent at all. A genuinely empty `{}`/`[]` parses cleanly
      // long before this and never reaches the repair path.
      if (parsed.ok && matches(parsed.value, want) && !isEmptyStructure(parsed.value)) {
        return {
          value: parsed.value,
          repairs: [
            attempt === 0
              ? "closed a truncated value"
              : `closed a truncated value, dropping ${attempt} incomplete trailing item${attempt === 1 ? "" : "s"}`,
          ],
        };
      }
    }
    // Walk back to the previous element boundary and try again.
    const cut = lastBoundary(body);
    if (cut === undefined) return undefined;
    body = body.slice(0, cut);
  }
  return undefined;
}

function isEmptyStructure(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return !!value && typeof value === "object" && Object.keys(value).length === 0;
}

/** The bracket stack and string state at the end of `text`. */
function scan(text: string): { stack: string[]; inString: boolean } {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  return { stack, inString };
}

/**
 * Index to cut at to drop the last (incomplete) element: just past the previous
 * element's closer, or before the comma that introduced it.
 *
 * String-aware, so a comma or brace inside a value does not read as structure.
 */
function lastBoundary(text: string): number | undefined {
  let inString = false;
  let escaped = false;
  let boundary: number | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "," || char === "}" || char === "]") boundary = i;
  }
  // Nothing to cut back to, or cutting would leave only the opener.
  if (boundary === undefined || boundary <= 1) return undefined;
  return boundary;
}
