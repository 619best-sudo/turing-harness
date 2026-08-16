/**
 * The file-search ladder.
 *
 * Finding the right file is the single most common thing an agent does, and left
 * to itself a model does it the expensive way: `grep -rn` across the repo, `ls`
 * down every directory, `find | head`, over and over, one shell call per guess.
 * This harness indexes the project once — per-file summaries, keywords, symbols
 * and roles in {@link FileMemory}, a real import/call graph in {@link GraphMemory},
 * durable cross-run facts in {@link ProjectMemory} — so the same question is one
 * ranked call instead of twenty greps.
 *
 * Prompts already state that order. This advisor keeps it in view while the loop
 * runs, by watching the turns and offering, in order:
 *
 *   1. MEMORY FIRST   — a shell search issued before memory was ever consulted
 *      gets one note naming the memory call that answers the same question.
 *   2. BROADEN        — a memory query that came back empty gets a concrete next
 *      query (fewer keywords, a symbol instead of a phrase, `stats` to check the
 *      index is warm) rather than being treated as a dead end.
 *   3. SHELL FALLBACK — after `attemptsBeforeShell` (default 3) memory queries
 *      that found nothing, memory is treated as cold or sparse for this task and
 *      the shell is explicitly endorsed, with a recipe built from the terms the
 *      model was already querying.
 *
 * ADVICE, NOT LAW. This ladder is the default because it is usually the cheapest
 * route to the right file — not because it is always right. The model has context
 * the advisor does not: it may already know the exact path, be sweeping every call
 * site of a literal it is renaming, or have good reason to distrust a stale index.
 * So every note is a suggestion that says what it is for and invites the model to
 * override it in one line of reasoning. A model that knowingly deviates and says
 * why is doing its job; the ladder exists to catch the model that is *guessing*,
 * not to overrule one that is thinking.
 *
 * Three deliberate constraints, mirroring {@link ToolFallbackAdvisor}:
 *
 *   - it never blocks, rejects or rewrites a call. Every rung is a user-message
 *     note. A cold index on a brand-new project must not stop the work.
 *   - it speaks at most once per rung per loop. Repeating a suggestion the model
 *     has already weighed is nagging, and nagging costs turns.
 *   - once rung 3 fires, rung 1 is silenced for the rest of the loop. Having just
 *     endorsed the shell, it would be incoherent to question its use.
 */

/** A tool call of one turn, as seen by a loop. */
export interface SearchLadderCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * The result produced for a call. `text` is the tool's own output — the ladder
 * needs it because an empty memory hit is a SUCCESSFUL call that found nothing,
 * which no error flag will ever reveal.
 */
export interface SearchLadderResult {
  toolCallId: string;
  isError?: boolean;
  text?: string;
}

export interface SearchAdvice {
  /**
   * `"memory-first"` — searched with the shell before ever asking memory;
   * `"broaden"`      — memory query found nothing; try a better query;
   * `"shell-fallback"` — memory is sparse here; search with the shell.
   */
  kind: "memory-first" | "broaden" | "shell-fallback";
  /** The tool the advice is about. */
  tool: string;
  /** The note to inject into the conversation as a user message. */
  note: string;
}

export interface SearchLadderOptions {
  /**
   * Memory queries that find nothing before the shell is authorized. Default 3.
   * A cold index (0 indexed files) short-circuits this — one refresh hint, then
   * the shell, because more queries against an empty index cannot help.
   */
  attemptsBeforeShell?: number;
}

/** Memory tools that answer "which file / which symbol", in ladder order. */
const DISCOVERY_TOOLS = new Set(["file_memory", "graph_memory"]);
/** Shell-ish search: the thing the ladder is trying to postpone, not forbid. */
const SHELL_SEARCH_TOOLS = new Set(["grep", "ls", "glob", "find"]);
/** Shell commands that are really a file search wearing a shell. */
const SHELL_SEARCH_COMMAND = /(^|[\s;|&(])(grep|rg|ag|ack|find|fd|ls|tree|locate)\b/;

export class SearchLadderAdvisor {
  /** Memory discovery calls made this loop. */
  private attempts = 0;
  /** Memory discovery calls that returned something usable. */
  private hits = 0;
  /** Distinct query strings already tried against memory (for the recipe). */
  private readonly queries: string[] = [];
  private memoryFirstAdvised = false;
  private shellAuthorized = false;
  private coldIndexAdvised = false;
  private broadenAdvised = 0;

  constructor(private readonly opts: SearchLadderOptions = {}) {}

  /** True once the ladder has told the model to search with the shell. */
  get shellFallbackAuthorized(): boolean {
    return this.shellAuthorized;
  }

  /**
   * Judge one completed turn. Call once per turn with its calls, their results
   * (including output text), and the tools currently available to the model.
   */
  observe(
    calls: SearchLadderCall[],
    results: SearchLadderResult[],
    availableTools: Iterable<string>,
  ): SearchAdvice[] {
    // `availableTools` is typically a live Map iterator: walk it exactly once.
    const toolNames = new Set(availableTools);
    const hasMemory = [...DISCOVERY_TOOLS].some((name) => toolNames.has(name));
    const byId = new Map(results.map((r) => [r.toolCallId, r]));
    const advice: SearchAdvice[] = [];
    const threshold = Math.max(1, this.opts.attemptsBeforeShell ?? 3);

    for (const call of calls) {
      const result = byId.get(call.id);
      if (isDiscoveryCall(call)) {
        if (result?.isError) continue; // a broken call is the fallback advisor's job
        this.attempts += 1;
        const query = discoveryQuery(call);
        if (query && !this.queries.includes(query)) this.queries.push(query);

        if (!isEmptyMemoryResult(result?.text)) {
          this.hits += 1;
          continue;
        }

        // Nothing found. A cold index is a different problem from a bad query:
        // no rephrasing helps when there is nothing indexed to match against.
        if (isColdIndex(result?.text) && !this.coldIndexAdvised) {
          this.coldIndexAdvised = true;
          this.shellAuthorized = true;
          advice.push({ kind: "shell-fallback", tool: call.name, note: coldIndexNote(call.name, toolNames) });
          continue;
        }

        if (this.attempts >= threshold && !this.shellAuthorized) {
          this.shellAuthorized = true;
          advice.push({
            kind: "shell-fallback",
            tool: call.name,
            note: shellFallbackNote(this.attempts, this.queries, toolNames),
          });
          continue;
        }
        // Still inside the memory budget: spend the remaining attempts on better
        // queries, and say how many are left so the model can pace itself.
        if (!this.shellAuthorized && this.broadenAdvised < threshold) {
          this.broadenAdvised += 1;
          advice.push({
            kind: "broaden",
            tool: call.name,
            note: broadenNote(call.name, query, threshold - this.attempts, toolNames),
          });
        }
        continue;
      }

      // A shell search. Only worth a note when memory exists, was never asked,
      // and the ladder has not already sent the model here itself.
      if (
        isShellSearchCall(call) &&
        hasMemory &&
        this.attempts === 0 &&
        !this.memoryFirstAdvised &&
        !this.shellAuthorized
      ) {
        this.memoryFirstAdvised = true;
        advice.push({ kind: "memory-first", tool: call.name, note: memoryFirstNote(call, toolNames) });
      }
    }
    return advice;
  }
}

/** A memory call that is asking "which file / which symbol", not writing a note. */
export function isDiscoveryCall(call: SearchLadderCall): boolean {
  if (!DISCOVERY_TOOLS.has(call.name)) return false;
  const action = String(call.arguments?.action ?? "").trim();
  // `refresh` re-indexes rather than asks; `stats` is a health check. Neither is
  // an attempt to find something, so neither should burn the memory budget.
  return action !== "refresh" && action !== "stats";
}

/** A call that searches the filesystem through the shell. */
export function isShellSearchCall(call: SearchLadderCall): boolean {
  if (SHELL_SEARCH_TOOLS.has(call.name)) return true;
  if (call.name !== "bash" && call.name !== "bash_readonly") return false;
  const command = String(call.arguments?.command ?? "");
  return SHELL_SEARCH_COMMAND.test(command);
}

/** The query text a discovery call was asking about, for use in later advice. */
function discoveryQuery(call: SearchLadderCall): string {
  const a = call.arguments ?? {};
  for (const key of ["query", "symbol", "qualifiedName", "path"]) {
    const value = a[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * True when a memory tool succeeded but found nothing. Matches the tools' own
 * "nothing here" renderings plus the zero-count summaries, because both mean the
 * model learned nothing it can act on.
 */
export function isEmptyMemoryResult(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (/\(no (matching|entry|file graph|blast-radius|symbol)/i.test(t)) return true;
  if (/^Matches:\s*0\b/im.test(t)) return true;
  if (/^Indexed files:\s*0\b/im.test(t)) return true;
  // A dependency traversal that resolved a target but found no edges around it:
  // technically an answer, practically a dead end for discovery.
  if (/^Direct (dependencies|files):\s*0\b/im.test(t) && /^Transitive [a-z]+:\s*0\b/im.test(t)) return true;
  return false;
}

/** True when the emptiness is an unindexed project rather than a poor query. */
export function isColdIndex(text: string | undefined): boolean {
  return /^Indexed (files|symbols):\s*0\b/im.test((text ?? "").trim());
}

/** The best shell search the run actually exposes, if any. */
function shellSearch(names: Set<string>): string | undefined {
  if (names.has("grep")) return "grep";
  if (names.has("bash")) return "bash";
  if (names.has("bash_readonly")) return "bash_readonly";
  return undefined;
}

function memoryFirstNote(call: SearchLadderCall, names: Set<string>): string {
  const term =
    str(call.arguments?.pattern) ??
    str(call.arguments?.query) ??
    firstSearchTerm(str(call.arguments?.command)) ??
    "<what you are looking for>";
  const graph = names.has("graph_memory");
  return (
    `SUGGESTION: you searched the filesystem with \`${call.name}\` without asking memory first. In case it is ` +
    `useful: this project is INDEXED — \`file_memory\` holds a per-file summary, keywords, symbols and role for ` +
    `every file, so one call usually ranks the candidates a shell sweep has to grind out directory by directory.\n\n` +
    `Worth trying:\n` +
    `- \`file_memory({ action: "search", query: "${term}" })\` — a natural-language or keyword query is fine; ` +
    `read the summaries in the result before opening anything.\n` +
    (graph
      ? `- then \`graph_memory({ action: "blast_radius", path: "<the candidate>" })\` to pull in the files that ` +
        `import it or that it imports, so you find the whole change set rather than one file of it.\n`
      : "") +
    `- then \`read\` only the files that survived.\n\n` +
    `Your call, though — you know what you are looking for and this is only a default. \`${call.name}\` is the ` +
    `better tool when you already know where to look and want an exact literal sweep (every call site of a symbol ` +
    `you are renaming, say), or when you have reason to think the index is stale. If you are staying with ` +
    `\`${call.name}\` deliberately, say so in one line and carry on — no need to detour through memory to satisfy ` +
    `this note.`
  );
}

function broadenNote(tool: string, query: string, remaining: number, names: Set<string>): string {
  const left = Math.max(1, remaining);
  const asked = query ? ` for "${query}"` : "";
  const tips =
    tool === "file_memory"
      ? [
        `- drop to ONE distinctive term — a symbol, filename fragment, route or error string — rather than a phrase.`,
        `- try the vocabulary the CODE would use, not the user's: "middleware", "handler", "provider", "reducer".`,
        `- widen the net: remove any \`extensions\`/\`tags\` filters and raise \`limit\`.`,
        names.has("graph_memory")
          ? `- if you know a symbol, ask the graph instead: \`graph_memory({ action: "find_symbol", symbol: "<name>" })\`.`
          : "",
      ]
      : [
        `- confirm the node exists first: \`graph_memory({ action: "get_file_node", path: "<path>" })\`; the graph ` +
          `keys on the real on-disk path, so a guessed or relative path misses.`,
        `- for a symbol, try \`find_symbol\` with just the bare name before \`symbol_deps\`.`,
        `- locate the file with \`file_memory({ action: "search", query: "<term>" })\` and feed THAT path back in.`,
      ];
  return (
    `SUGGESTION: \`${tool}\` found nothing${asked}. In our experience that is usually the query rather than the ` +
    `project, so one more refined attempt is often cheaper than switching tools:\n` +
    tips.filter(Boolean).join("\n") +
    `\n\nRoughly ${left} more memory quer${left === 1 ? "y" : "ies"} is a reasonable budget here; after that the ` +
    `shell is the better bet and this note will say so. Go to the shell sooner if you judge that faster — this is ` +
    `a default, not a gate. The one thing worth insisting on: an empty index entry is NOT evidence that the file ` +
    `does not exist, so don't conclude the code is missing on this basis.`
  );
}

function shellFallbackNote(attempts: number, queries: string[], names: Set<string>): string {
  const shell = shellSearch(names);
  const terms = queries.slice(-3);
  const pattern = terms[terms.length - 1] ?? "<term>";
  const tried = terms.length ? ` (tried: ${terms.map((q) => `"${q}"`).join(", ")})` : "";
  if (!shell) {
    return (
      `NOTE: ${attempts} memory queries${tried} found nothing, and this phase has no shell or search tool to fall ` +
      `back to. \`read\` on the paths you already know is the remaining option; if you genuinely cannot locate the ` +
      `code, say so in your summary along with the queries you tried. More variations on the same query are ` +
      `unlikely to pay — though you know the query space better than this note does.`
    );
  }
  const recipe =
    shell === "grep"
      ? `- \`grep({ pattern: "${pattern}", path: "." })\` — then narrow with \`include\` once you see the hit rate.`
      : `- \`${shell}({ command: "grep -rn --include='*.*' -e '${pattern}' . | head -50" })\`\n` +
        `- if that is too noisy, find by name instead: \`${shell}({ command: "find . -path ./node_modules -prune -o ` +
        `-iname '*${pattern}*' -print | head -50" })\``;
  return (
    `NOTE: memory has come back empty ${attempts} times${tried}, so the index looks sparse or stale for this task. ` +
    `Searching the shell is the right move now and is fully sanctioned — not a workaround, and nothing further will ` +
    `question it:\n${recipe}\n\n` +
    `Skip \`node_modules\`, \`dist\`, \`.git\` and lockfiles. Once the shell finds the real path, the indexed tools ` +
    `are worth another look for what they are still better at: \`file_memory({ action: "refresh", paths: [<the path>] })\`` +
    `${names.has("graph_memory") ? ` and \`graph_memory({ action: "blast_radius", path: "<the path>" })\` to catch what else the change touches` : ""}. ` +
    `Re-querying memory for this same target is probably a dead end — but if you have a specific reason to think a ` +
    `different query would land, spend it.`
  );
}

function coldIndexNote(tool: string, names: Set<string>): string {
  const shell = shellSearch(names);
  return (
    `NOTE: \`${tool}\` reports an EMPTY index (0 files), so no query can match — this is a cold or brand-new ` +
    `project, not a missing file. Further queries against it cannot help, so pick one of these instead:\n` +
    `- warm it for the paths you care about if you know them: ` +
    `\`${tool}({ action: "refresh", paths: ["<dir-or-file>"] })\`, then query again.\n` +
    (shell
      ? `- otherwise search the shell directly this time: ` +
        `${shell === "grep" ? `\`grep({ pattern: "<term>", path: "." })\`` : `\`${shell}({ command: "grep -rn '<term>' . | head -50" })\``} ` +
        `(skip \`node_modules\`, \`dist\`, \`.git\`).\n`
      : `- otherwise work from the paths you already know via \`read\`.\n`) +
    `Report in your summary that memory was cold, so the sparse index is visible rather than mistaken for an ` +
    `empty project.`
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Pull the searched-for term out of a shell command, for a concrete suggestion. */
function firstSearchTerm(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const quoted = /(?:grep|rg|ag|ack)\b[^|]*?(?:-e\s+)?['"]([^'"]{2,})['"]/.exec(command);
  if (quoted) return quoted[1];
  const named = /(?:-iname|-name)\s+['"]?\*?([^'"*\s]{2,})\*?['"]?/.exec(command);
  if (named) return named[1];
  const bare = /(?:grep|rg|ag|ack)\s+(?:-\S+\s+)*([^\s'"|]{2,})/.exec(command);
  return bare?.[1];
}
