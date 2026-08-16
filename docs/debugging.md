# Debugging with real evidence

Reading code tells you what it *should* do. When the complaint is "nothing
happens", "the value is wrong" or "it works locally", the bug lives in the gap
between should and does — and no amount of re-reading closes it.

`DEBUGGING_LOOP` (in [prompts.ts](../src/phases/prompts.ts), carried by the loop,
PERFORM and PERFECT) is the method. The `activity_*` tools are what it uses.

## 1. Who runs the system — settle it first

Before instrumenting anything. If the app is already up, use it. If not,
[ask](./asking-the-user.md) whether the agent should start it or the user will:
they may have a dev server, seeded data, a device, or credentials nobody can
reproduce, and racing them to a port wastes both attempts. If they hand it over,
`activity_trace_start` with `startCommand` (+ `port` to free it) pipes the server's
own output into the trace file, so server logs and `__t()` lines land in **one**
timeline.

## 2. Instrument where code actually breaks

`activity_trace_start` opens the session; **`add_log` puts the logging in.** It takes
`edit`'s shape — `oldString` is the exact text to anchor on, `newString` is that text
with your `__t("message", { value })` line added — because that is how you already
think about placing something at a point in code, and because writing the line
yourself is the value: you choose the message and the values that decide the branch.

It is deliberately **not** an `edit`. Nothing re-authors it (an authoring model
rewrites a `newString`, and a log handed to one comes back as a fix), it never counts
as a code change (so it owes the verify gate nothing and is not gated on having
observed the bug), and it **cannot** change code — every anchor line must survive
byte-identical or the call is refused. The `__t()` helper is added the first time a
file is logged, where the language allows a declaration, which is not line 1 in Dart
or Go.

Then RUN the flow — a log records nothing until the code executes — and
`activity_collect`.

Each `add_log` returns a **`logId`**. `remove_log` takes that one out (`logId: "log-3"`)
when a log turns out to be at the wrong point and is only noise in every later
collect, or all of them (`all: true`, optionally narrowed to one `path`). The helper
goes when the last log in a file goes and stays while any remains — a surviving
`__t()` call with no helper throws the moment that path runs. `activity_cleanup` clears
them too, as part of ending the session. Removal matches the exact lines that were
written, so the file is restored byte-for-byte.

Logging is its own tool because asking did not work: a real run opened a trace, was
refused the premature fix, was told probe edits were allowed, and answered by opening
a second trace and going back to reading source. Nothing was instrumented, so nothing
was observed. (Calling `activity_trace_start` again now reuses the empty session
instead of opening another.)

Where to put them is the same list [reading and writing code](./code-changes.md)
uses: every branch of a conditional including the implicit else, what a function
**returns** on each path, both sides of an `await`, loop entry/exit with counts,
the boundary where another module takes over, and what a library actually returned.

Then log the flow **end to end** — entry, each hop, exit. That is what tells you
*where the trail stops*: the last `__t()` that printed localises the break faster
than any single clever log, and a trace that only covers your suspicion cannot tell
you your suspicion was wrong.

## 3. Logs that actually get written

**The marker is per-session: `TURING_TRACE_<suffix>`.** The family prefix says
what the line IS — a trace probe placed by the agent — and every trace session
derives a unique marker from its traceId (`turing-trace-d93647e3` →
`TURING_TRACE_d93647e3`) and prints it in the snippet. `activity_collect` (and
`activity_study`, and the trace lines `activity_inspect` folds in) match THAT
marker only. The reason is the stale-probe failure: a probe a crashed run left
in the source emits into a NEW session's trace file the moment the app
re-launches, and with a shared marker those lines were indistinguishable from
the new run's own — the new check reading the old check's output as its
evidence. Now such lines are counted as `foreign`, reported
("N lines carried OTHER probe markers — leftovers, not evidence"), and never
consumed; `add_log` refuses a bare or foreign marker up front and hands back the
exact line to paste. Detection and cleanup are family-wide (`grep -rn
TURING_TRACE` finds every probe ever written), and `activity_cleanup` reports
files whose markers remain.

**The fix for the failure you keep hitting.** The JS/TS snippet used to call
`require("fs")`, which is a no-op in a browser and throws under ESM. So an
instrumented React component logged happily to devtools, the trace file stayed
empty, and the only recovery was asking the user to run the whole flow again.

`activity_trace_start` now stands up a **local HTTP sink** (loopback only,
ephemeral port, permissive CORS because the page is served from a different
localhost port) and bakes its URL into the snippet. The snippet detects its
runtime: Node appends to the trace file directly; browser/edge code POSTs via
`sendBeacon`/`fetch`, and the line lands in the same file, in order, so
`activity_collect` sees one merged timeline. The sink closes on
`activity_cleanup`. If it cannot start, the tool says so and the snippet degrades
to console-only rather than failing silently.

Practical consequence, stated in the guidance: console output plus an empty trace
file means **the sink, not a dead flow** — don't re-diagnose it as "the code never
ran" and don't ask for another run.

## 4. Run it smaller when you can

A whole app is a slow way to test one function. Where the suspect code can be
called directly, write a scratch script that imports it, feeds the exact input and
prints what comes back. Seconds instead of minutes, and nobody else is needed. Keep
it out of the source tree; delete it after.

## 5. Collect and read

`activity_collect` (with `waitMs` while the flow runs) returns what landed;
`activity_study` reasons over a large trace; `activity_search`/`activity_tags`
search what the harness already captured; `activity_tail_file` reads a log the
project writes itself. Read for the **last line that printed** and the **first
value that is wrong** — those two bracket the bug.

Don't hunt for trace files with `bash`/`ls`: `activity_trace_start` already handed
over the traceId and path. Searching the terminal is what these tools *are*.

## 6. UI bugs: look at the pixels

`activity_inspect` captures a page's console plus a screenshot. For a single
component, give the element a temporary unique marker (`data-turing-probe="hero-cta"`)
and screenshot **just that selector**, so the analysis covers the one piece that
changed rather than a whole page. Hand it to [`media_analysis`](./media-analysis.md)
with the lens that matches the question — `component` for anatomy/state/metrics,
`qa` with the expectation stated for a pass/fail verdict, `ocr` to read an error you
can't select — and say in the prompt what you're checking, not just "look at this".
Remove the marker with the logs. On mobile, drive the device MCP the same way.

## 7. Fix, then prove it

The part that gets skipped:

- Change **one** thing, for a stated reason: "the trail stops after X, and Y is
  null there because …".
- Re-run the **same** flow. If you can't, ask the user to try again — saying exactly
  what to do and what they should see.
- **Fixed** → remove every `__t()` and probe marker, `activity_cleanup` the session,
  and report what was wrong, why the fix addresses it, and what evidence proved it.
  Instrumentation is scaffolding; leaving it behind ships a mess.
- **Not fixed** → **revert that change** before trying the next one. Stacked
  speculative fixes are how a simple bug becomes an unexplainable codebase, and the
  trace you gathered describes the code as it *was*. Form a new hypothesis from the
  evidence (often: instrument one hop *earlier* than you thought) and go again. Two
  or three rounds is normal; the same hypothesis twice is not.
- Never report a bug fixed because the code looks right. Say what was verified, how,
  and what remains unverified.

## 8. The same loop, on work that isn't broken

Everything above is written for a bug — something misbehaves and you go find out
why. The loop is worth the same reach at the *end* of a successful run, and that
is what `VERIFY_WHAT_YOU_WROTE` asks for: every file the run created or modified
gets a check behind it before the summary is written.

The rule that makes it bite is that **re-reading a file is not a check**. The write
result already confirmed the bytes landed; reading them back proves nothing about
whether the code runs, is reached, or produces the right value. So the check is
picked from what the file actually does — the project's test runner or typecheck
for logic, a real `curl` and a real response body for an endpoint, the browser or
device MCP plus a screenshot through `media_analysis` lens `qa` for UI. Inspection
alone is legitimate only for artifacts with no runtime behaviour at all: docs,
config, fixtures.

When behaviour is internal and can't be observed from outside — a handler that may
never be reached, state that goes wrong mid-flow, a value arriving malformed, a
screen that renders with the wrong data — the answer is not to read harder. It is
sections 3 through 6 of this page, run on code you just wrote instead of code that
just failed: `activity_trace_start`, `__t()` at the real decision points, exercise
the flow, `activity_collect`, `activity_study`. One instrumented pass settles what
three rounds of staring at the source cannot.

Then section 7's cleanup applies unchanged. Probes come out, `activity_cleanup`
runs, servers get killed, and anything that *couldn't* be verified — no runner, no
browser MCP, no way to reach the path — is named in the summary along with the
capability that was missing. A check you didn't run is never a check you describe.

Two things about that closing pass are enforced rather than asked, because prose
alone did not hold: it runs in the **verify pass**, not in the work loop, and it
never captures a build that predates the edit. [The QA
sequence](./qa-sequence.md) has the six ordered steps, the six refusals behind
them, and how a live capture is matched to the right reference image.

Bug-fix runs walk the same staged spine as every other run — **build →
instrument → run → inspect → decide** — with the debugging contract at DECIDE:
the trace must emit from the *fixed* binary, so the spine restarts at *build*
after every fix edit; fixed → strip the probes and cite the trace line that
shows the reported behaviour is gone; not fixed → revert the attempt, study the
trace, form the next hypothesis and edit again. A `VERDICT: FAIL` round is a
repair round, not the end of the attempt.
