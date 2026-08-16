# `media_analysis`: understanding what you were given

`media_analysis` ([`src/tools/builtin/media-analysis.ts`](../src/tools/builtin/media-analysis.ts))
is the read half of the media story — `assets_generator` produces, this one only
ever looks. It sends images, screenshots, video, audio or documents (PDF/DOCX/…)
to a multimodal model and returns what they contain.

The tool is available in **every phase**, because understanding a mockup or a spec
belongs at the *start* of the work, not only at the verify step the old
`ui_screen_auditor` was scoped to.

## Lenses

One generic "describe this" prompt served every caller badly: transcription wants
verbatim text, rebuilding a screen wants structure and tokens, a component wants
anatomy and states, verification wants a verdict. Same model, same attachment —
what changes is what it is asked to produce.

| `lens` | Produces | Use it for |
|---|---|---|
| `describe` *(default)* | a direct answer about the attachment | "what does this show", diagnosing a visual bug |
| `ocr` | the text, **verbatim** — exact wording, casing, punctuation, reading order preserved | error dialogs, screenshots of logs or config, scanned specs, copy you must reproduce exactly |
| `ui` | a **rebuild spec**: layout skeleton section by section, every component with state and quoted text, the inferred design system (palette with hex, type scale, spacing rhythm, radii, shadows, icon style) | "make it look like this" — a whole web or mobile screen |
| `component` | one component's anatomy, metrics, colors, the states it must support, and how it behaves as its container narrows or its text grows | a crop or exported piece, about to be implemented |
| `qa` | `VERDICT: PASS`/`FAIL` plus defects with severity and location | comparing an implementation against a stated expectation |
| `compare` | `VERDICT: MATCH`/`MISMATCH` plus, per difference, both bounding boxes, the measured delta and a `FIX:` line | replicating a design: the mockup vs. your screenshot of the build |

`qa` and `compare` both verify, and the line between them is what you are checking
**against**: an image is `compare`, a written expectation is `qa`. `compare` also
covers **UI consistency**: pass two captures of the same app
(`files:[a,b]`) and it checks both screens for the same design language,
component variants, type scale, spacing rhythm, colors and states — every
deviation reported as a measured difference.

Each lens carries the discipline its job needs: `ocr` must not summarize, translate
or correct spelling, and marks unreadable passages `[illegible]` rather than
guessing. `ui` must separate what it can **see** from what it is **inferring**.
`component` must say when a part is cut off at the crop edge instead of inventing
what continues. `qa` and `compare` list anything a still frame cannot judge under
`NOT VERIFIABLE HERE` and refuse to let it decide the verdict. `compare` states the
two images' dimensions and the scale factor first, and compares proportionally —
a 1440px design against a 1280px screenshot is not 160px of error.

An omitted or unrecognized lens falls back to `describe` rather than failing the
call.

## Screenshotting a live page

Pass `url` instead of `file` to capture a page and analyze it in one call:

```jsonc
{"prompt":"describe the layout","url":"https://example.com/pricing","lens":"ui"}
{"prompt":"the pricing card","url":"https://example.com","selector":".pricing-card","lens":"component"}
```

The screenshot is **saved** to `.turing/screenshots/<host-path>-<timestamp>.png`
and its path is returned in `details.screenshot` and named in the model-facing
output. That matters: a capture worth taking is usually worth keeping, so a later
step can attach it, re-analyze it, or diff against it without re-capturing.

`selector` and `fullPage` are forwarded **only when asked for** — MCP servers
commonly reject unknown properties, and a rejected screenshot call reads like "no
browser is connected."

Both MCP return shapes are handled: an inline `image` content block (the bytes are
written here) or prose naming a file the server already wrote (that path is
verified and used as-is, with no second copy). If neither yields an image, the tool
says so rather than analyzing nothing. With no browser MCP connected it explains
that and points at `file` — `curl` cannot render or screenshot a page.

## Analyze before you plan

This is the ordering the prompts (`MEDIA_UNDERSTANDING`) push, and it exists to
prevent one specific, expensive failure: a user attaches a mockup, the agent plans
from the words in the request alone, and discovers at step 4 that the design has a
sticky sidebar, three states nobody mentioned, and a font that was never set up. By
then the decomposition is wrong.

Two things depend on looking first:

- **The decomposition.** A design tells you what the steps *are* — which sections
  exist, which components repeat, which states must be built, what the shared
  tokens are. Planning from wording alone reliably misses half of it, and the half
  it misses surfaces mid-implementation.
- **The routing.** [`create_plan`](./plan-tool.md) attaches a file to the
  individual step that needs it — but you can only decide that a mockup belongs on
  the hero step, and a crop of the pricing card on the pricing step, once you know
  what each one shows.

So: one `ui` pass over the full screen, then a `component` pass on the pieces
intricate enough to deserve their own step, then plan — feeding what you learned
into the step summaries so each step reads like a brief rather than a title. The
planning prompt reinforces it from the other side: if an attachment is a design or
spec and the context doesn't already describe its contents, the planner is told to
say so rather than invent a decomposition from a filename.

## The triage pre-pass

The model is *told* to analyze attachments before planning, but prompt advice does
not bind, so the orchestrator does one pass itself before any loop starts. It runs
per attached image and answers two questions:

**What is this for?** A `describe` pass ends with a mandatory `CATEGORY:` line —
`informational` (reference material), `ui-replicate` (a mockup to rebuild),
`ui-bug` (a defect being fixed), or `other`. That category is what routes the file:
a mockup becomes vision input for the write, a spec becomes context, an error
screenshot becomes evidence. It is rendered into the loop's opening message too, so
the model sees each image's role without spending a call re-deriving it.

**What does it say?** For `informational` and `ui-bug` only, a second `ocr` pass
extracts the text **verbatim**, and that text — not the describe paraphrase — is
what seeds the run's media fact and reaches the authoring pass as `KNOWN CONTEXT
FROM AN ATTACHMENT`. The distinction is the whole point: `describe` returns "a
screenshot of a spec sheet listing configuration values", which is right for
routing and useless for building. The exact `MAX_RETRIES = 7`, the exact error code
`0x8007`, the exact heading copy — those only survive an OCR pass, and nothing
downstream can recover them once they are gone.

A `ui-replicate` mockup is deliberately exempt: it is handed to a vision model at
write time, which reads the copy off the image itself, so OCR there would be a paid
call for something the authoring pass already sees.

Two timing details:

- **Plan-review attachments get the same treatment.** The run-level pass only sees
  what existed at the start; a file the user drops onto a step while reviewing the
  plan is triaged just before that step runs, and its text seeds that step. It is
  the attachment they chose most deliberately — it should not arrive as an
  undifferentiated image.
- **Each file is triaged once.** A path attached to the run *and* pinned to a step
  is not paid for twice.

Failures degrade rather than propagate: an OCR error falls back to the describe
analysis, and a whole-triage failure leaves the images un-enriched. Set
`autoTriageAttachments: false` to skip the pass entirely.

## Replicating an existing site

Capture it (`url`, or the image you were given) → read it with `lens: "ui"` → build
from the **system** it reports, tokens first and then sections, rather than
eyeballing the picture element by element. Keep the original: at the end,
screenshot your own build and run `lens: "compare"` with the original as
`reference`.

```jsonc
{"prompt":"does the hero match?","reference":"/designs/hero.png","url":"http://localhost:3000","lens":"compare"}
```

Each difference comes back as the element's box in both images, the measured delta
(dx/dy, dw/dh, the two hex values, the two font sizes) and a `FIX:` line — so a
`MISMATCH` says what to change rather than that something is wrong. Apply the fixes
and re-compare until it matches. "It looks about right" is not a check, and neither
is a verdict you did not act on.

A `compare` call with only one attachment is refused rather than answered: a diff
with one side would come back reading like "no differences found".

## Configuration

```ts
new Harness({
  mediaAnalysis: {
    model: "google/gemini-3.7-flash",   // must be multimodal; default shown
    analyze: myBackend,                  // optional: replace the bundled OpenRouter path
  },
});
```

A host backend receives the resolved request — prompt, lens system prompt, and
attachments already classified, verified readable, and marked inline-vs-by-
reference — so it only has to make the request itself. `openRouterMediaAnalysisBackend`
is exported if you want to wrap or fall back to it.

Attachments over 20 MB, and **all** video, are passed by reference rather than
base64-inlined: base64 inflates payloads ~33% and providers cap request size well
before a recording would fit. Paths that don't exist or whose modality can't be
named are reported in the output alongside the analysis, so a partial result is
never mistaken for a complete one.
