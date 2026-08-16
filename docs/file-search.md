# File search: the memory-first ladder

Finding the right file is the most frequent thing a coding agent does, and the
default way models do it is the expensive way: `grep -rn` across the repo, `ls`
down every directory, `find | head`, one shell call per guess, several turns
before the first real read.

This harness indexes the project instead, and points the agent at the index.
Search follows a **ladder**, stated once in the prompts (`FILE_SEARCH_LADDER` in
[`src/phases/prompts.ts`](../src/phases/prompts.ts)) and offered again at runtime
by [`SearchLadderAdvisor`](../src/orchestrator/search-ladder.ts). Those two must
be changed together — the prompt states the default, the advisor keeps it in view
mid-run.

**It is a default, not a rule.** The ladder is here because it is usually the
cheapest route to the right file, not because it is always right — and the model
routinely has context the advisor does not: it already knows the path, it is
sweeping every call site of a literal it is renaming, or it has concrete reason to
distrust a stale index. So every note says what it is for and invites the model to
override it with one line of reasoning. A model that knowingly deviates and says
why is doing its job; the ladder is there to catch the one that is *guessing*.
Nothing here blocks, rejects or rewrites a tool call.

## The ladder

| Rung | Tool | Answers |
|------|------|---------|
| 1 | `project_memory` (`get` / `recall`) | What do we already know about this project — category, stack, runbook, facts previous runs left? |
| 2 | `file_memory` (`search`) | Which files are candidates? Ranked matches with per-file summary, keywords, symbols, role, dependencies. |
| 3 | `graph_memory` (`blast_radius` / `file_deps` / `symbol_deps` / `find_symbol`) | What does a change here touch? The real import/export/call graph, not a text match. |
| 4 | `read` | Confirm against the actual bytes. Memory is a hypothesis, not ground truth. |
| 5 | `grep` / `ls` / shell | The recommended point to switch once memory has been tried and came back empty — and the *better* tool outright for an exact literal sweep when the path is already known. |

Rung 3 earns its place. A change set derived from `file_memory` alone is
the file the model asked about; running `blast_radius` on that candidate is what
pulls in the callers and importers that also have to change. The prompts recommend
it before editing and again before declaring the work done.

## When memory finds nothing

An empty result is usually the **query**, not the project — so the ladder spends
a small budget on better queries before giving up on the index:

1. **Broaden** (attempts 1–2): the advisor suggests a concrete next query — one
   distinctive term (symbol, filename fragment, route, error string) instead of a
   phrase, in the vocabulary the code would use, with `extensions`/`tags` filters
   dropped. `file_memory` itself also appends this hint to its own empty result,
   so a model that never sees the advisor still gets the nudge.
2. **Shell fallback** (after ~3 empty queries, `attemptsBeforeShell`): memory is
   treated as sparse or stale for this target and the shell is *explicitly
   endorsed*, with a recipe built from the terms already queried and the usual
   exclusions (`node_modules`, `dist`, `.git`). Three is a budget, not a quota —
   switching sooner on judgement is fine, and the note says so. Two things do hold
   regardless: an empty index is never evidence that the code does not exist, and
   never a reason to refuse the task.
3. **Cold index** short-circuits all of that: when a memory tool reports
   `Indexed files: 0`, no rephrasing can help, so the advisor immediately offers
   `refresh` on the paths of interest or a direct shell search.

Once the shell finds the path, coming back *up* the ladder pays:
`file_memory` `refresh` on that path, then `graph_memory` `blast_radius` before
editing. The shell found the file; the graph is still the only thing that knows
what else the change touches.

## What the advisor does and does not do

- It **never blocks a call.** Every rung is an advisory note injected as a user
  message, plus a grace turn from `StallGuard` so advice is never given on the
  turn the loop stops. The model is free to disagree and proceed.
- It **only suggests tools the run actually has.** A phase with no memory tools
  gets no memory-first note; a phase with no shell is told to work from known
  paths and report honestly instead of being handed an impossible recipe.
- It speaks **once per rung.** A `grep` issued before memory earns exactly one
  memory-first note per loop, and once the shell has been endorsed that note is
  silenced for good — having just sent the model to the shell, questioning its use
  of the shell would be incoherent. Repeating a suggestion the model has already
  weighed is nagging, and nagging costs turns.
- It **ignores failed memory calls.** A call that errored is
  [`ToolFallbackAdvisor`](../src/orchestrator/tool-fallback.ts)'s job. This
  advisor exists precisely because "found nothing" is a *successful* call that no
  error flag reveals — it reads each tool's output text, not just its status.
- `refresh` and `stats` are not discovery. Re-indexing and health checks don't
  burn the memory-query budget.

Log tags: `loop:search` with `search:memory-first` / `search:broaden` /
`search:shell-fallback`, so a run's search behaviour is auditable after the fact.

## Per-phase differences

`PREPARE` is memory-first and file-read-only by design — `bash`, `ls` and `grep`
are not in its toolset at all, so its discovery order stops at rung 4. `PLAN`
reads the handed-over shortlist rather than rediscovering the repo. `PERFORM` and
`PERFECT` carry the full ladder, shell included.

## Tuning

```ts
new SearchLadderAdvisor({ attemptsBeforeShell: 3 }); // default
```

Lower it for repos where the index is known to be thin; raise it when the index
is well warmed and shell sweeps are expensive (very large monorepos).
