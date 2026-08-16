## Goal

End-to-end correctness for the per-phase handoff object: (1) fix the `handoff.reasoning` data bug, and (2) emit a dedicated `phase_summary` event at the end of every phase carrying ONLY the UI-facing `uiSummary` + the structured `handoff` object — so a UI host gets the lightweight signal it needs without unpacking the heavy `PhaseResult`.

This is additive to the pi-compatible event stream (the namespaced 4P events are explicitly ignorable by a pi UI), so it carries no back-compat risk.

---

## Part 1 — Verify the 4P chain (no code change; already done)

Traced `runChain` end-to-end and ran the suite: **build clean, 50/50 tests pass**. Per-phase continuity is correctly threaded (Prepare→Plan→Perform↔Perfect retry, with paths/reads/writes/relevant-files/tool-transcript/profile/runbook/capabilities/provider-assignments carried via `record()` + `prior*` opts). The permission-callback refactor in the working tree is consistent with the types. **No fix needed here.**

## Part 2 — The handoff object: two fixes

### Fix A — `PhaseHandoff.reasoning` is populated with the wrong section (BUG)

`src/orchestrator/phase-runner.ts:1198-1204`

The `handoff.reasoning` field is documented (types.ts:550) as *"Free-form reasoning summary for the next phase"* — i.e. the next-phase briefing = the `SUMMARY:` section. But it's assigned `uiSummary` (the `UI SUMMARY:` user-facing card). Nothing reads `handoff.reasoning` today (grep-confirmed across src/tests/examples), so it's inert — but wrong and would mislead any host that starts consuming the `handoff` object.

**Change:** assign `summary` (the next-phase briefing) instead of `uiSummary`:
```ts
const handoff: PhaseHandoff = {
  from: phase,
  to: nextPhase(phase),
  files: relevantFiles,
  toolChain,
  ...(summary ? { reasoning: summary } : {}),
};
```
This restores the documented contract. `uiSummary` is no longer duplicated into the reasoning slot (it now flows only via `result.uiSummary` + the new event — see Fix B). No test asserts on `handoff.reasoning`, and the multiplan test only checks `handoff.from`/`.to`, so this is safe.

### Fix B — Emit a dedicated `phase_summary` event at end of each phase (FEATURE)

The single chokepoint is `Orchestrator.runPhase` (`orchestrator.ts:569-662`) — **every** chain phase and standalone phase passes through it. The conversational short-circuit path builds its own `prepareResult` without calling `runPhase`, so it won't accidentally double-emit.

**1. New event variant** in `src/types.ts` `AgentEvent` union (namespaced 4P section, ~line 379):
```ts
| { type: "phase_summary"; phase: Phase; uiSummary?: string; handoff?: PhaseHandoff }
```
`PhaseHandoff` is defined above it, so no import/order issue.

**2. Emit it** at the tail of `Orchestrator.runPhase` (`orchestrator.ts`, right before `return runPhase(runInput);`, ~line 661). Wrap the result so it emits once for every call path:
```ts
const result = await runPhase(runInput);
this.emit({
  type: "phase_summary",
  phase,
  uiSummary: result.uiSummary,
  handoff: result.handoff,
});
return result;
```
This sends the UI host exactly what it needs: `uiSummary` (the one user-facing string) + the structured `handoff` (files/toolChain/reasoning for continuity). The full `PhaseResult` still arrives via `phase_end` for hosts that want detail. Other handoff fields (toolChain, files, etc.) stay threaded phase-to-phase unchanged via the existing `record()`/`prior*` mechanism — they do NOT need to ride the event.

**Why not also emit for the conversational path?** The conversational reply already streams its answer via `message_start`/`message_update`/`message_end` (the standard pi transcript path a UI already renders), and there's no `handoff`/`uiSummary` to carry. Emitting `phase_summary` there would be noise; the existing transcript events are the correct surface. Leaving it out keeps `phase_summary` meaning exactly "a real 4P phase finished."

---

## Why nothing else needs changing

- **"Rest parameters may or may not be used for passing on to next phase, only pass if relevant"** — already handled. The orchestrator's `record()` selectively threads only the fields that have content (`if (r.relevantFiles?.length) relevantFiles = r.relevantFiles;`, etc.), and each phase's `PhaseRunInput` only surfaces the `prior*` fields that phase actually consumes. The `handoff` object is a *complementary* view (per its type doc), not the plumbing — the plumbing already passes only what's relevant per phase. No change needed.
- **"Make this work end to end. If something is a problem fix it."** — The only broken thing was `handoff.reasoning`; Fix A corrects it. The chain itself is end-to-end working (Part 1).

## Tests

Add to `tests/multiplan.test.mjs` (which already asserts handoff shape and runs a full `runChain`):
- Assert the new `phase_summary` event fires exactly 4× per single-iteration chain (prepare/plan/perform/perfect) and each carries the phase + a `handoff` object with correct `from`/`to`.
- Assert `prepare`'s `phase_summary` carries `uiSummary` matching the stub's `UI SUMMARY:` text.
- Assert `handoff.reasoning` now equals the phase `summary` (next-phase briefing), not the uiSummary (guards the Fix A regression).

Run `npm test` (builds, then `node --test tests/*.test.mjs`) — expect 53/53 green.

## Files touched
- `src/types.ts` — add `phase_summary` event variant.
- `src/orchestrator/phase-runner.ts` — Fix A (1 line: `uiSummary`→`summary` in `handoff.reasoning`).
- `src/orchestrator/orchestrator.ts` — emit `phase_summary` at the tail of `runPhase`.
- `tests/multiplan.test.mjs` — 1 new test (3 assertions).

No changes to types' public shapes (PhaseResult/PhaseHandoff unchanged), no breaking changes to existing events.