# Debug Session: prepare-phase-logs
- **Status**: [OPEN]
- **Issue**: Instrument the planner (`Prepare`) with debugger-grade before/after runtime logs that prove whether it received all registered MCPs/skills and what file complexity/provider distribution object it produced.
- **Debug Server**: http://127.0.0.1:7778/event
- **Log File**: .dbg/trae-debug-log-prepare-phase-logs.ndjson

## Reproduction Steps
1. Start the debug server for session `prepare-phase-logs`.
2. Run the app and trigger a task that enters `Prepare`.
3. Confirm the chain stops after `Prepare` and inspect the debug log entries.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | `Prepare` is receiving all registered MCP and skill metadata, but the current logs are only host-local and not visible through the debugger flow. | High | Low | Confirmed by NDJSON lines 7, 11 showing `receivedAllRegisteredMcps=true` and `receivedAllRegisteredSkills=true` in debug-server events. |
| B | The before-log is emitted too early or with incomplete provider metadata, so the registered-vs-received comparison is inaccurate. | Medium | Low | Rejected by NDJSON lines 7 and 11 where registered and received provider arrays match exactly, including extra MCPs/skills. |
| C | The after-log is emitted before the final `Prepare` result is fully patched, so `files` or provider distribution can be incomplete. | Medium | Low | Inconclusive overall: NDJSON lines 8 and 10 show fully populated structured handoff objects, while lines 12 and 14 show legitimate empty arrays when Prepare emitted none. |
| D | The temporary stop-after-prepare path prevents later inspection hooks, so only explicit debugger instrumentation around the boundary will give reliable runtime evidence. | Medium | Low | Confirmed by the presence of both before/after events in the NDJSON despite prepare-only short-circuiting. |

## Log Evidence
- Instrumentation added in `src/orchestrator/orchestrator.ts` at the `Prepare` boundary.
- Debug point `A` reports the pre-run provider snapshot: registered MCPs/skills, received MCPs/skills, and missing lists.
- Debug point `C` reports the post-run structured handoff: `files[{path, complexity}]` and `toolsDistribution[{phase, providers}]`.
- Example evidence:
  - NDJSON line 7 shows `mcp:playwright-lite`, `skill:figma-helper`, and `skill:ui-auditor` were all received with no missing providers.
  - NDJSON line 8 shows `files=[{path: ".../index.html", complexity: "high"}]` and `toolsDistribution` mapping those providers to `plan` / `perform` / `perfect`.
  - NDJSON line 10 shows the repo-root `index.html` handed off with `complexity: "medium"` and built-in provider routing.
  - NDJSON line 12 shows a valid case with no relevant files but non-empty provider routing (`skill:docs-helper`, `mcp:browser-verifier`).
  - Current entries appear to be automated-test evidence, not yet a distinct app reproduction, based on temp `harness-*` paths and fixture provider ids.
  - Root cause for missing OpenWaggle runtime logs: the debugger reporter resolved `.dbg/prepare-phase-logs.env` relative to the host app cwd instead of the harness module location, so OpenWaggle fell back to port `7777` even though the live debug server was on `7778`.

## Verification Conclusion
- Debugger instrumentation is active and verified through the debug server NDJSON.
- Minimal fix applied: the debugger reporter now resolves `prepare-phase-logs.env` from an absolute module-relative path using `import.meta.url`.
- Runtime app reproduction is still needed to capture your exact real-world planner run and separate it from automated test fixtures.
