/**
 * Bash-as-last-resort escalation.
 *
 * A tool that keeps failing is a dead end the model rarely escapes on its own:
 * it retries `write` on an unwritable path, or keeps calling a browser MCP tool
 * whose server never came up, until the loop stalls out with the work undone —
 * even though the same thing was achievable through the shell all along.
 *
 * This advisor watches per-tool CONSECUTIVE failures and walks a fixed ladder,
 * one rung per escalation, so the harness exhausts its own capability before it
 * ever spends the user's attention:
 *
 *   1. the dedicated tool keeps failing → inject a concrete bash recipe for that
 *      specific tool and its actual arguments ("write keeps failing on src/x.ts —
 *      do it with `cat > … <<'EOF'` instead");
 *   2. the shell can't do it either (or the run has no shell) → tell the model to
 *      escalate to a human through `ask_user_question`, with a specific, answerable
 *      question naming what was tried and what it needs;
 *   3. no human channel exists → stop retrying and report the blocker honestly.
 *
 * Two deliberate constraints:
 *
 *   - bash is a fallback, never the default. Advice only fires after real,
 *     repeated failure of the dedicated tool, and the note says so.
 *   - it only suggests a shell that the run actually has. Presets legitimately
 *     withhold `bash` (mobile/frontend perform) or expose only `bash_readonly`
 *     (plan); a mutating recipe is never suggested through a read-only shell.
 */

/** A tool call as seen by a loop. */
export interface FallbackCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** The result produced for a call. */
export interface FallbackResult {
  toolCallId: string;
  isError?: boolean;
}

export interface FallbackAdvice {
  /** The tool that kept failing. */
  tool: string;
  /**
   * Which rung of the ladder this advice is:
   * `"fallback"` — do it with bash instead;
   * `"escalate"` — bash couldn't either: ask the human via `ask_user_question`;
   * `"abandon"`  — no human channel: stop retrying and report the blocker.
   */
  kind: "fallback" | "escalate" | "abandon";
  /** The note to inject into the conversation as a user message. */
  note: string;
}

export interface ToolFallbackOptions {
  /**
   * Consecutive failures of the same tool before the bash fallback is offered.
   * Default 2. Keep it BELOW `StallGuard`'s `stallTurns` (3): advice the model
   * never gets a turn to act on is worthless, which is why the loop also grants
   * the guard one grace turn whenever advice fires.
   */
  failuresBeforeFallback?: number;
}

export class ToolFallbackAdvisor {
  /** Consecutive failure count + last failing args, per tool name. */
  private readonly failures = new Map<string, number>();
  /** How many times advice has already been issued for a tool. */
  private readonly advised = new Map<string, number>();
  /** Tools the model has already been told to escalate to the user. */
  private readonly escalated = new Set<string>();

  constructor(private readonly opts: ToolFallbackOptions = {}) {}

  /**
   * Judge one completed turn. Call once per turn with the turn's calls, their
   * results, and the tool names currently available to the model.
   */
  observe(calls: FallbackCall[], results: FallbackResult[], availableTools: Iterable<string>): FallbackAdvice[] {
    const threshold = Math.max(1, this.opts.failuresBeforeFallback ?? 2);
    const errorById = new Map(results.map((r) => [r.toolCallId, r.isError ?? false]));
    // Materialize once: `availableTools` is typically a live iterator (a Map's
    // `keys()`), which can only be walked a single time.
    const toolNames = new Set(availableTools);
    const shell = pickShell(toolNames);
    const canAskHuman = toolNames.has("ask_user_question");
    const advice: FallbackAdvice[] = [];

    for (const call of calls) {
      const failed = errorById.get(call.id) ?? false;
      if (!failed) {
        // Any success clears the streak — the tool evidently works now.
        this.failures.delete(call.name);
        this.advised.delete(call.name);
        this.escalated.delete(call.name);
        continue;
      }
      const count = (this.failures.get(call.name) ?? 0) + 1;
      this.failures.set(call.name, count);
      if (count < threshold) continue;

      // Advise on the threshold hit and on every `threshold` failures after it,
      // so a model that ignores the first note is escalated, not spammed.
      if ((count - threshold) % threshold !== 0) continue;

      // Walk the ladder: bash → human → honest stop. Rungs the run cannot offer
      // (no shell, no human channel) are skipped rather than suggested uselessly.
      const rung = (this.advised.get(call.name) ?? 0) + 1;
      const recipe = shell ? bashRecipe(call.name, call.arguments, shell) : undefined;
      let kind: FallbackAdvice["kind"];
      if (rung === 1 && shell && recipe) {
        kind = "fallback";
      } else if (canAskHuman && !this.escalated.has(call.name)) {
        // Ask the user ONCE. Repeating the escalation would just burn turns; if the
        // model ignored it, the next rung is to stop and report.
        kind = "escalate";
        this.escalated.add(call.name);
      } else {
        kind = "abandon";
      }
      this.advised.set(call.name, rung);

      advice.push({
        tool: call.name,
        kind,
        note:
          kind === "fallback"
            ? fallbackNote(call.name, count, recipe as string, shell as "bash" | "bash_readonly")
            : kind === "escalate"
              ? escalateNote(call.name, count, shell, rung === 1)
              : abandonNote(call.name, count, shell),
      });
    }
    return advice;
  }
}

/** The best shell tool the run exposes, if any. */
function pickShell(names: Set<string>): "bash" | "bash_readonly" | undefined {
  if (names.has("bash")) return "bash";
  if (names.has("bash_readonly")) return "bash_readonly";
  return undefined;
}

const HEADER = (tool: string, count: number) =>
  `NOTE: \`${tool}\` has now failed ${count} times in a row. Stop retrying it as-is.`;

/** Rung 1: do it with the shell instead. */
function fallbackNote(tool: string, count: number, recipe: string, shell: "bash" | "bash_readonly"): string {
  return (
    `${HEADER(tool, count)} Fall back to \`${shell}\` and do the same work directly:\n\n${recipe}\n\n` +
    `Prefer \`${tool}\` again afterwards for the remaining work — the shell is the fallback for this specific ` +
    `blocked operation, not the new default. Do not give up on the task: if this recipe needs adapting to what ` +
    `you find, adapt it. Only if the shell genuinely cannot do it should you ask the user for help.`
  );
}

/**
 * Rung 2: the harness has spent its own options, so buy a human answer — but only
 * with a question that is actually answerable.
 */
function escalateNote(
  tool: string,
  count: number,
  shell: "bash" | "bash_readonly" | undefined,
  firstRung: boolean,
): string {
  const tried = firstRung
    ? shell
      ? `There is no shell recipe that stands in for \`${tool}\` here`
      : `This run has no shell tool to fall back to`
    : `You have already tried the \`${shell ?? "shell"}\` fallback and it did not work either`;
  return (
    `${HEADER(tool, count)} ${tried}, so this is now a genuine blocker and it is time to ask the user — ` +
    `call \`ask_user_question\` rather than guessing or silently skipping the work.\n\n` +
    `Make the question answerable in one reply:\n` +
    `- what you were trying to do, in the user's terms (not tool names alone)\n` +
    `- what you already tried: \`${tool}\` ${count} times${shell ? `, then \`${shell}\`` : ""}, and the exact error each gave\n` +
    `- precisely what you need from them: a correct path, a credential they must enter themselves, a running ` +
    `server, a permission, or a decision between two options you name\n\n` +
    `Then continue with whatever parts of the task are NOT blocked while you wait — do not stall the whole run ` +
    `on this one operation.`
  );
}

/** Rung 3: nothing left to try and no one to ask. Be honest, don't spin. */
function abandonNote(tool: string, count: number, shell: "bash" | "bash_readonly" | undefined): string {
  return (
    `${HEADER(tool, count)} The fallbacks are exhausted${shell ? ` (including \`${shell}\`)` : ""} and this run ` +
    `has no way to ask the user, so do not call \`${tool}\` again for this operation. State plainly in your ` +
    `summary what could not be done, the exact error, and what a human would need to do to unblock it — then ` +
    `carry on with the parts of the task that are still possible.`
  );
}

/**
 * A concrete shell recipe for the tool that is failing, using its real arguments
 * so the model can act on it without re-deriving anything.
 */
function bashRecipe(
  tool: string,
  args: Record<string, unknown> | undefined,
  shell: "bash" | "bash_readonly",
): string | undefined {
  const readOnly = shell === "bash_readonly";
  const p = str(args?.path) ?? str(args?.file) ?? str(args?.filePath) ?? str(args?.filename);
  const url = str(args?.url);
  const name = tool.toLowerCase();

  if (tool === "write") {
    if (readOnly) return undefined; // a read-only shell cannot stand in for a write
    const target = p ?? "<path>";
    return (
      `- check what is in the way: \`ls -la ${dirOf(target)} && test -w ${dirOf(target)} && echo writable\`\n` +
      `- create the parent directory if that was the problem: \`mkdir -p ${dirOf(target)}\`\n` +
      `- write the file with a quoted heredoc (no shell expansion inside):\n` +
      `  \`cat > ${target} <<'TURING_EOF'\\n<file contents>\\nTURING_EOF\`\n` +
      `- verify: \`wc -l ${target}\``
    );
  }

  if (tool === "edit") {
    if (readOnly) return undefined;
    const target = p ?? "<path>";
    return (
      `- \`edit\` fails when its \`oldString\` does not match the file byte-for-byte. Look at the real text first: ` +
      `\`grep -n '<anchor>' ${target}\` then \`sed -n '<start>,<end>p' ${target}\`\n` +
      `- then make the change non-interactively, e.g.\n` +
      `  \`python3 - <<'TURING_EOF'\\nimport pathlib\\np = pathlib.Path("${target}")\\ns = p.read_text()\\n` +
      `assert "<old>" in s\\np.write_text(s.replace("<old>", "<new>", 1))\\nTURING_EOF\`\n` +
      `- verify the result: \`grep -n '<new>' ${target}\``
    );
  }

  if (tool === "read" || tool === "cat") {
    const target = p ?? "<path>";
    return (
      `- confirm the file exists and how big it is: \`ls -la ${target}\`\n` +
      `- read it in slices: \`sed -n '1,200p' ${target}\`\n` +
      `- if the path itself was wrong, find the real one: \`find ${dirOf(target)} -maxdepth 3 -name '${baseOf(target)}'\``
    );
  }

  if (tool === "ls") {
    return `- \`ls -la ${p ?? "."}\`, or \`find ${p ?? "."} -maxdepth 2\` if the directory listing is the problem.`;
  }

  if (tool === "grep") {
    const pattern = str(args?.pattern) ?? str(args?.query) ?? "<pattern>";
    return `- \`grep -rn '${pattern}' ${p ?? "."}\` (add \`--include='*.ts'\` to narrow it).`;
  }

  // `web_search`/`web_fetch`/`web_scrape` deliberately have NO shell fallback:
  // curl returns unrendered markup, so a missing browser MCP is a capability to
  // report (and to ask the user about), not something to fake with the shell.
  if (tool === "web_search" || tool === "web_fetch" || tool === "web_scrape") return undefined;

  if (/playwright|browser|chrome|devtools|puppeteer|webpage/.test(name)) {
    const target = url ?? "<url>";
    return (
      `- first check the app is actually up — an MCP browser tool cannot navigate to a dead server: ` +
      `\`curl -sS -o /dev/null -w '%{http_code}\\n' ${target}\`\n` +
      `- for content checks, the page HTML is enough: \`curl -sS ${target} | head -c 2000\`\n` +
      (readOnly
        ? `- a visual check needs a mutating shell, which this phase does not have; report it as unverified if the MCP tool stays down.`
        : `- for a visual check without the MCP server: \`npx --yes playwright screenshot ${target} /tmp/page.png\` ` +
          `(then analyze that file with the media/vision tool).`)
    );
  }

  if (/mobile|simulator|emulator|expo|ios|android/.test(name)) {
    return (
      `- verify a device/app is actually there before retrying the MCP tool:\n` +
      `  iOS: \`xcrun simctl list devices booted\`; Android: \`adb devices\`\n` +
      `- screenshot without the MCP server: \`xcrun simctl io booted screenshot /tmp/screen.png\` ` +
      `(Android: \`adb exec-out screencap -p > /tmp/screen.png\`), then analyze that file with the media/vision tool\n` +
      `- check the dev server the app connects to is up: \`curl -sS -o /dev/null -w '%{http_code}\\n' http://localhost:8081/status\``
    );
  }

  if (/test|lint|typecheck|build|compile/.test(name)) {
    return (
      `- run the underlying command yourself instead of going through the tool, e.g. ` +
      `\`npm test\` / \`npx tsc --noEmit\` / \`npm run build\` (check \`package.json\` scripts first: ` +
      `\`sed -n '1,40p' package.json\`) and read the real output.`
    );
  }

  if (/git|commit|diff|branch/.test(name)) {
    return `- use git directly: \`git status --short\`, \`git diff\`, \`git log --oneline -5\`.`;
  }

  if (/http|fetch|curl|request|api/.test(name)) {
    return `- \`curl -sS ${url ?? "<url>"} | head -c 2000\` (add \`-i\` to see the status and headers).`;
  }

  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : ".";
}

function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
