# How turing-harness works (v2 — the categorizer chain)

The natural-language flow of a run: from the user's prompt to a verified,
completed task. This is the operating model the chain, the categorizers, and the
tool set are built around.

## The shape of a run

```
user prompt + attachments + /skill + #mcp mentions
   │
   │  1. MENTIONS: /skill and #mcp tokens resolve against the registry —
   │     their tools join EVERY categorizer. #file tokens that exist on disk
   │     join the run's files. Unknown mentions are named to the model.
   │
   │  2. ATTACHMENT TRIAGE: each image gets one media_analysis describe pass
   │     (role: informational / ui-replicate / ui-bug); informational text is
   │     lifted into the run's mediaFact. Disable with autoTriageAttachments:false.
   │
   ▼
 ROUTER ─── one cheap, tool-free model call: "CATEGORY: <id | summarise>"
   │         choices are rendered WITH their descriptions and deliverable
   │         contracts, so the pick is informed. Any parse failure or transport
   │         error falls back to a deterministic heuristic (chat → conversation;
   │         work → read; gather before mutate).
   ▼
 CATEGORIZER HOP ─── a FRESH tool loop with:
   │                   • only its own tools + globals + mention tools
   │                     (+ registry-scoped and preset extras)
   │                   • its own orchestrator (driver) model
   │                   • its combined prompt (guidance gated on its toolset)
   │                   • the injected terminal `deliver` tool
   │                   • the FIRST hop receives nothing but the task; later
   │                     hops receive ONLY what their accepts names:
   │                       accepts.from  → those categorizers' DELIVERABLES
   │                       accepts.tools → those tools' call records
   │                       (tool, target, output, surrounding reasoning)
   │
   │  deliver ─── the loop ENDS the moment the terminal tool completes:
   │              completion is a deterministic signal, not "the model stopped".
   │              A model that stops without delivering gets a fallback
   │              deliverable derived from what the loop tracked.
   ▼
 ROUTER over children ∪ summarise ─── never repeats the hop that just ran;
   │                                   maxHops (default 6) bounds the chain.
   ▼
 SUMMARY TURN ─── fresh context over every hop's deliverable: files changed,
   │               assets generated, verdicts. A conversation-only run reuses
   │               its own deliverable (no extra call).
   ▼
 RunLoopResult (+ thread snapshot for the next prompt on this thread)
```

After the chain: any instrumentation probes still on disk are stripped by a
bounded cleanup pass (remove_log / activity_cleanup) before the run finishes.

## The four categories and when the router picks them

- **conversation** — greetings, questions answerable in prose, internet
  lookups, quick bash. No project inspection or change. Delivers a summary; a
  chat-only run IS the user's answer.
- **read** — find and understand the files the task needs (memory-first:
  project/file/graph memory, then read the exact files). Delivers the relevant
  files with line numbers and snippets plus a `codeSummary` explaining how they
  link — a follow-up model works from that without re-reading everything.
- **write_edit** — make the changes. ALWAYS plans first (`create_plan`); with
  multiple attachments the plan routes each to only the steps that need it.
  Writes/edits declare `complexity` + `category` (ui/svg/code), which pin the
  Model-B author; inspiration/assets/design ladder for fresh UI; leaves the
  project runnable. Delivers the writes that landed.
- **activity_inspect** — QA and debugging: run the app, capture, compare
  against media, read/instrument logs and traces. Accepts the write calls a
  work pass made (echoed in its deliverable). Localises bugs; strips its own
  probes before delivering; reports findings, logPaths, bugLocation, and a
  verdict (pass / fail / needs-work).

**The loop**: read → write_edit → activity_inspect → (fail? write_edit again)
→ summarise. A bug report can go read → activity_inspect first (reproduce
before fixing). `RunOptions.isBugFix` biases that; `verify: false` discourages
the post-write inspect hop.

## Shared mechanics (carried over, unchanged in spirit)

- **Memory-first file search**: project_memory → file_memory → graph_memory →
  read; shell only when memory is cold. The search-ladder advisor nudges the
  same order at runtime.
- **Staged read with cached comprehension**: a file rated too complex for the
  loop's model is comprehended by a stronger one; measured ratings ratchet
  per-path complexity floors.
- **Attachment triage**: OCR for informational images (specs, stack traces);
  ui-replicate / ui-bug images travel as pixels to write/edit authoring.
  Plan-review step attachments join the live image set the moment the plan
  lands; mid-run ask_user_question answers do too.
- **ask_user_question** everywhere: blocking questions with options,
  attachments-in/-out, free-text escape.
- **Web tools** everywhere: current-version lookups, scraping.
- **Model-B authoring**: write/edit by complexity & category; authorOnlyWrites
  content-less mode; the inspiration → design-skill → generated-assets ladder
  for fresh UI with no reference.
- **Bounded results, compaction, stall guard, tool-failure ladder**
  (read the error → shell fallback → ask the user → honest stop).
- **clearing_doubt** everywhere: when unsure or beyond capability, the small
  model consults the big model and gets numbered steps for ITS OWN tools.

## What the guarantees are

- A categorizer never sees another's transcript — only declared deliverables
  and accepted tool records.
- A categorizer never sees a tool outside its scope (plus globals/mentions).
- `verified: true` means an inspect pass delivered a `pass` verdict; `false`
  means defects were found. No verdict, no claim.
- Plans are structured (`PLANS_JSON`), reviewed only in plan mode, and their
  per-task complexity floors the writes on their files.
- Every hop emits `categorizer_start` / `categorizer_end` (with the
  deliverable) for UI cards; the pi event stream is unchanged.
