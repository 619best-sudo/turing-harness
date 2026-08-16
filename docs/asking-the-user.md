# `ask_user_question`: which decisions are the user's

Most decisions inside a run belong to the agent. A few are genuinely the **user's**,
and getting those wrong costs far more than the interruption — an architecture
committed to, a day of work built on the wrong reading of a requirement, an
irreversible action nobody sanctioned.

Both failure modes are expensive, and they pull in opposite directions:

- An agent that **never asks** silently picks and builds on the pick.
- An agent that **asks constantly** hands back the job it was given. Each question
  costs a real interruption, so "just check" is not free caution.

The line that survives contact: **ask about what only the user knows** (intent,
priorities, trade-offs they own, access they control); **decide everything the code
knows** yourself (conventions, existing patterns, what the tests expect).

## Ask

- **Architecture** you are about to commit to and cannot cheaply undo — datastore,
  auth model, state management, a framework or heavyweight dependency, the shape of
  a public API.
- A **requirement with two honest readings** that diverge. Not "which shade of
  blue", but "does *export the report* mean a download or an emailed attachment" —
  where the wrong branch means building it twice.
- A **trade-off that is theirs**: speed vs completeness, migrate the old data or
  start clean, ship behind a flag or replace in place, match the existing (bad)
  pattern or fix it here.
- Anything **irreversible or destructive**: deleting data, force-pushing, dropping a
  column, changing production config, spending money.
- **Access only they can give**: a credential (which *they* enter, never the agent),
  an API key, a running service, a permission, a file that cannot be found.
- A **real blocker** after the agent's own options are exhausted — the escalation
  rung of the [tool-failure ladder](./loop.md#when-a-tool-keeps-failing-bash--the-user--honest-stop).

## Don't ask

- Anything a `read`, a `grep` or a `web_search` would answer — go and look.
- Style, naming, file placement — follow what the project already does.
- **Permission for work the user already asked for** (scraping the site, writing the
  file, running the tests). They asked; do it.
- "Is this okay so far?" with nothing at stake. Finish, then show them.
- A decision you could make, try, and cheaply reverse. Make it, say which way you
  went, move on.

## How to ask

The point of offering choices is to move the thinking to the side that has it. A
bare list of labels doesn't do that; a label plus its consequence does.

```jsonc
{
  "question": "Which datastore should the API use?",
  "reason": "It decides the migration story and I cannot cheaply undo it later.",
  "answerMode": "single-select",
  "options": [
    {"label": "Postgres", "description": "Relational, migrations included; needs a running service", "recommended": true},
    {"label": "SQLite",   "description": "Zero setup, single file; painful once you need concurrency"}
  ]
}
```

- `options` accepts **bare strings or objects**. `description` says what *choosing*
  that option means — the trade-off, not a restatement of the label. `recommended`
  marks the one the model would pick; at most one survives sanitization, because
  two recommendations recommend nothing. Capped at 6: past that, a "simplifying"
  picker is a second problem.
- `answerMode` is `text` / `single-select` / `multi-select`. Offering options
  without a mode infers `single-select` rather than dropping the picker. Use
  `multi-select` when several can apply at once; use a plain text box only when the
  answer is genuinely open (a name, a URL, a value you cannot enumerate).
- **One question, self-contained** — what you're doing, what you need, why it
  blocks — in the user's terms, not tool names. Bundle related parts into one
  question rather than firing three.
- Say what you'll do if they don't care, so they can answer with a shrug.
- Then **keep working on what isn't blocked**, and when the answer arrives, follow
  it: their answer outranks the agent's earlier judgement, including a plan already
  written.

## Files, in both directions

Some questions are not answerable in prose, and some are far cheaper to answer
with the thing on screen. Both are one call.

```jsonc
{
  "question": "Is this the misalignment you meant, or something else on the page?",
  "attachments": [{"path": "/abs/.turing/screenshots/hero.png", "note": "what I captured"}],

  // …and, when the answer IS a file:
  "requestAttachments": {"mode": "required", "accept": ["image/*"], "hint": "the Figma export of the hero"}
}
```

- **`attachments`** — files the agent shows *with* the question: two candidate
  renders to choose between, the capture of the defect it wants confirmed, a
  generated asset it wants approved.
- **`requestAttachments`** — asks the user to attach a file *back*. `mode:
  "required"` when the question is unanswerable without it, `"optional"` to
  invite one; `accept` hints the picker, `hint` says what you want in the user's
  terms. Asking in prose for something that only exists as a file gets you a
  paragraph describing the file, which is a worse answer than none.

**What the user attaches joins the run.** An image handed over mid-run is added
to the run's live attachment set, so the very next `write`/`edit` authors from
the pixels exactly as it would for a file attached to the original prompt — and
the tool output says so, rather than leaving a path the model has to guess at.
Non-image files are named and routed to the tool that reads them
(`media_analysis` for video/audio/documents, `read` for text and code) instead of
being forced into a vision pass.

This is the half that makes the other half worth having. Without it the agent
could ask for the mockup, the user could send it, and the next write would still
author from prose — the file named once in a tool result and never looked at
again.

## Where it comes up most

- **Planning.** An architecture fork belongs in a question *before* the plan is
  drafted, not discovered at step 6. But a plan the host reviews is itself an
  approval round trip — don't ask a question the [plan review](./plan-tool.md)
  already puts in front of them.
- **Runtime debugging.** A trace only produces data if the flow actually runs. If
  the agent cannot trigger it, that is exactly when to ask the user to exercise the
  app — naming the precise steps needed.

## Plumbing

When the host installs `ctx.askUserQuestion`, the tool **blocks in place** and the
answer returns as that call's tool result: same conversation, no new run, no lost
context. Without the callback the question rides out on `details` (with `options`,
`choices`, `answerMode`, `attachments`, `requestAttachments`) for a host that
prefers to cancel and restart with the answer; the text output carries the
trade-offs too, so a host that only logs output still shows something answerable.

The callback may return either a **plain string** (text only — the original
contract, and what every host written before attachments existed still returns)
or `{ text, attachments }`. `text` may be empty when the files *are* the answer.
Paths are absolutized and mime-typed by the tool, so a host that only tracks
paths can return those.

Both paths emit `details`, and the answered one is stamped `answered: true`. That
flag is load-bearing: `details.kind === "ask_user_question"` is how the work loop
recognises an *outstanding* question and stops the run so the host can collect an
answer out of band. Without the flag, a question that was just answered would
look like one still waiting and halt the run on the spot.

The request reports the **phase it actually came from** (`ctx.phase`). It used to
hardcode `"plan"` because that was the only phase the tool was registered for — it
now runs in all four, and a mislabeled question is one a host routes wrong.

A host that aborts (user closed the dialog) surfaces as a tool error, so the model
can ask again or choose a safe default rather than hanging.
