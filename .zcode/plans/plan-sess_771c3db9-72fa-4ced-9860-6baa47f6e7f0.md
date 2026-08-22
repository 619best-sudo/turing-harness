# Fix `activity_reproduce` end-to-end

## Diagnosis (from the OpenWaggleMain dev db + target project)

6 runs against the same Flutter bug, all failed at the reproduce pass. **Every `turing-trace-*.log` on the machine is 0 bytes** — the pass has never captured evidence. Root causes, in order of impact:

1. **The instructed launch path cannot capture probe output on mobile.** Prompt STEP 5 (prompts.ts:580-594) says launch via `mobile {action:"launch"}` (= `simctl launch`, stdout → os_log, never the trace file). Only `activity_trace_start {startCommand}` pipes stdout into the trace — and nothing in the reproduce prompt/guidance/gates teaches that. The one line that does ("launch THROUGH the trace") lives in `QA_SEQUENCE`, attached to `write_edit` only (prompts.ts:179-208).
2. **`add_log` refusals don't name the offender.** Last run: agent *replaced* an existing `debugPrint('🔄 …')` line → correctly refused → message doesn't say which line → agent misdiagnosed → `sed -i`/`python3` fallbacks → shell-guard refusals → ask_user_question → pass abandoned. Yesterday: anchor-not-found → `cat -A`/`od -c` archaeology → heredocs.
3. **"NOT READY YET" advice is harmful** (activity-monitor.ts:1544): says "Re-issue `activity_trace_start`" first — that spawns a *second* build while the first still compiles. Cold Flutter iOS builds exceed the fixed 180s deadline (:1512).
4. Smaller: `add_log` accepts wrong-language probe calls (`console.log` into `.dart`); build-only commands (`flutter build web`) aren't refused; foreign probes from crashed runs pollute the next run.

## Changes

### A. Make the evidence path work (P0)

**`src/categorizer/prompts.ts`**
- Rewrite STEP 4 (line 572-578): `activity_trace_start` **with `startCommand` = the run command STEP 2 established** is the mandated way to open the session for an INVISIBLE defect — the trace session and the launch are one act. Without startCommand, probe output has nowhere to flow.
- Rewrite STEP 5 (580-594): `mobile`/`drive` are for **driving** an app the trace already launched (tap/type/look), not for launching it when a trace is open; `mobile {action:"launch"}` of an installed app never reaches the trace file.
- Add a `REPRO_SEQUENCE` ordered-steps block (mirroring `QA_SEQUENCE`'s style: classify → runnable → probes+startCommand → drive → collect → study → cleanup → deliver) as `GUIDANCE.reproOrder` in `src/categorizer/guidance.ts`, and add it to `CATEGORIZER_GUIDANCE.activity_reproduce` (prompts.ts:198-208).

**`src/categorizer/chain.ts`**
- Launch-deadline refusal (:561-578): mention `startCommand` explicitly.
- Cleanup refusal (:606-619): replace the `mobile {action:"launch"}` advice with "the app runs through the trace's `startCommand`; poll `activity_collect {waitMs}`".

**`src/tools/builtin/activity-monitor.ts`**
- NOT READY message (:1544): reorder — keep the session, poll `activity_collect {traceId, waitMs: 30000}`; **do NOT re-issue `activity_trace_start` while it's still building (that starts a second build)**; re-issue only after FAILED TO START.
- Readiness deadline: 180s → 420s for non-web (mobile) commands.

### B. Self-healing refusals (P1)

**`src/tools/builtin/coding.ts`**
- Extend `probeOnlyReplacement` (814-833) with a detailed variant `probeOnlyReplacementDetailed` returning `{kind, lostLines[]}` (the exact original lines that didn't survive). Keep `probeOnlyReplacement` as a wrapper so the shared contract and existing callers/tests stay intact.

**`src/tools/builtin/activity-monitor.ts` — `addLogAction`**
- Not-log-only refusal (:1730-1752): list up to 3 lost/rewritten lines verbatim ("your `newString` dropped or rewrote this original line: …") and state the fix: re-send the anchor with that line verbatim + your probe lines only.
- Anchor-not-found (:1783): whitespace/indent-tolerant fallback — locate the closest normalized match and return **the exact bytes from the file** (with line numbers) to use as `oldString`. Kills the `cat -A`/`od -c` archaeology.
- New language check: added marker lines must use a call from a per-language allowlist (`printByExample` + idiomatic extras: dart → `print`/`debugPrint`, ts/js → `console.log`, …). Wrong-language probe = broken build discovered minutes later; refuse with the right form.

### C. Hardening (P2)

**`src/categorizer/chain.ts`** — one-shot build-only refusal in the QA-hop bash wrapper: when the command is a build/assemble/compile shape (`isRuntimeCommand` already exists :464-487), nothing observed yet, and no prior refusal → refuse once with "build-only produces an artifact, not a run; the run command belongs in `activity_trace_start`'s `startCommand`".

**`src/tools/builtin/activity-monitor.ts` — `traceStartAction`** — sweep foreign probes at session open: reuse `findProbeMarkerFiles` (:316) + `stripProbeLines` (probe-marker.ts) to deterministically remove *pure* probe lines from previous sessions and report mixed-line leftovers. Consistent with the existing chain-end strip; guarantees a clean baseline per run.

**Docs/dead refs** — update `docs/qa-sequence.md` + `docs/debugging.md` to the current architecture (they cite deleted `src/phases/prompts.ts`, `qa-gate.ts`, `verify-stages.ts`, `__t()`); remove stale `ReproductionGate` references in `loop.ts:1101`, `activity-monitor.ts:2816`, `clarify-gate.ts:2` (verify each is a comment, not live code, at implementation time).

### D. Tests

- `tests/activity-monitor.test.mjs`: refusal names the lost line; anchor fallback returns exact bytes; wrong-language probe refused; NOT-READY message order (collect-first, no re-issue advice); foreign sweep at start.
- `tests/qa-two-roles.test.mjs`: updated gate messages; build-only one-shot refusal.
- Keep `tests/probe-strip.test.mjs`, `shell-authoring-guard.test.mjs` green (wrapper preserves `probeOnlyReplacement` semantics).

### E. Verification

- Re-run the full test suite + `tsc` build.
- Replay the **exact recorded failure inputs** from session `f56143d4` (the refused `add_log` oldString/newString, the anchor-mismatch case from `54fcef43`) against the new tool code in a scratch project — assert the refusal now names `debugPrint('🔄 EnrichmentPolling: viewport loop started');` and offers the corrected anchor.

## Out of scope (follow-ups)

- os_log capture for already-installed apps (`simctl spawn … log stream` into the trace) — a second capture path; only worth it if `flutter run`-as-startCommand proves insufficient in the field.
- End-to-end re-run of the bug through OpenWaggleMain (needs the app + simulator); the replay tests above cover the failure modes deterministically.