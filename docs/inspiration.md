# Inspiration: borrowing a layout without borrowing a brand

`inspiration_generator` ([`src/tools/builtin/inspiration-generator.ts`](../src/tools/builtin/inspiration-generator.ts))
is the fallback for the case that has no good answer otherwise: the agent has to
build a page, a screen, or a poster, and the user gave it **no reference**. Rather
than inventing a layout from nothing, it looks up section blueprints that were
previously reverse-engineered from real designs and hands them over as structure
to build on.

It is an **internal** tool. Its `details` payload is for the host, not the UI —
the host decides whether anything about the lookup is ever shown.

## The shape of the thing

One blueprint = one **section**, not one page. That is the whole design:

| | |
|---|---|
| `kind` | `web-ui` \| `mobile-ui` \| `poster` — nothing else |
| `category` | `navigation` \| `hero` \| `section` \| `footer` \| `background` |
| `keywords` | the retrieval index: layout pattern, mood, industry, components, and `"parallax"` when it animates |
| `layout` / `elements` / `styles` | the rebuildable skeleton, in concrete CSS values |
| `animation` | present only for scroll/parallax sections; per-layer `keyframes` of `at` (0..1 scroll progress) → `styles` |

Two consequences worth internalising:

- **Parallax is a keyword, not a kind.** An animated site is `web-ui` tagged
  `"parallax"` with an `animation` block. There is no `kind: "parallax"`.
- **Sections come from different designs.** Ask for `["navigation", "hero", "footer"]`
  and you get the best match *per section* across the whole store — three parts
  from three different sites. Making them cohere is the agent's job, not the
  store's.

## The contract: structure in, everything else replaced

A blueprint legitimately contains the *source's* copy, hex values, logos and stock
photos — that is how the source was described. None of it ships. The tool restates
this in its own output on every match (`THEME_NOTE`), and
[`INSPIRATION_REUSE`](../src/phases/prompts.ts) states it in the Perform phase and
the flat loop:

| Borrow | Replace |
|---|---|
| grid, spacing, element roles, visual rhythm | every heading, label, nav link and button text → the user's real copy |
| the *role* of each color (accent / surface / muted) | the literal hex values → the project's theme tokens |
| the size **hierarchy** of the type scale | the font families → the project's fonts |
| the icon's role (checkmark, chevron) | the icon set → the project's |
| the motion — keyframes, depth, easing, timing | the layers it moves → the project's own |
| the image *slot* and its aspect | the sample photo / brand mark → `assets_generator` output or the project's assets |

The failure mode this exists to prevent is subtle: a blueprint is plausible enough
to paste, and a pasted hex code plus a pasted headline is a clone of someone else's
site with the user's logo on it.

## Posters follow the same rule

For `kind: "poster"` the borrowed thing is the **composition** rather than the DOM:
the canvas aspect ratio, where the subject sits on it, the focal hierarchy, how type
stacks around the subject, and the margins. Placement is stored as fractions of the
canvas (`left: "8%"`), so the same composition re-renders at any size — and the
subject carries an explicit `placement` block (anchor, focal point, how much of the
canvas it occupies) that the consumer reuses verbatim while swapping in its own
product. Copy, palette and imagery are replaced exactly as above.

## Wiring a backend

The harness owns **no HTTP client** for this — same posture as `assets_generator`.
The host injects a lookup; resolving base URL and credentials is the host's job.

```ts
import { Harness, type InspirationBackend } from "@turing/harness";

const inspirationBackend: InspirationBackend = async ({ keywords, kind, sections, ctx }) => {
  const res = await fetch(`${BASE_URL}/turing-machine/inspiration/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ keywords, kind, sections }),
    signal: ctx.signal,
  });
  if (!res.ok) return null;                       // null ⇒ "no match", never an error
  const rows = (await res.json()) as Array<{ json: unknown }>;
  return { sections: rows.map((r) => r.json as never) };
};

const harness = new Harness({ apiKey, inspiration: { backend: inspirationBackend } });
```

The tool is deliberately **unfailable**. No backend configured, a backend that
throws, a timeout (8s default, `timeoutMs` to change), an aborted run, or an empty
result all produce the same thing: a one-line "proceed without a reference" and
`isError: false`. A missing inspiration store must never break a build.

## Filling the store

Blueprints are produced by running a vision model over a reference image or a
screen recording with a fixed extraction prompt, then POSTing each returned object.
That prompt is the contract's other half and lives with the backend that stores the
result: **`backend/docs/inspiration-extraction-prompt.md`**. It covers the strict
`kind`/`category` enums, the exact object schema, the placeholder rules (gray boxes,
lorem, stock photos and watermarks are *not* content), the precision rules (sample
real hex and px, omit rather than invent), and — for a video reference — capturing
3–6 keyframes per moving layer so the motion is reproducible without the video.

The round trip is:

```
image or video  →  vision model + extraction prompt  →  JSON array
                →  POST /turing-machine/inspiration   (one object per section)
                →  POST /turing-machine/inspiration/search  ← inspiration_generator
```

One operational note about that store: **send a JWT when uploading.** The create
endpoint accepts anonymous calls, but an anonymous row has no owner, is visible to
every caller, and cannot be deleted (`PATCH`/`DELETE` are owner-only). Anonymous
uploads are permanent.

## Where it sits in a run

In the flat tool loop it is simply available, and `INSPIRATION_REUSE` tells the
model when to reach for it: **once, at the start** of building UI, with the sections
actually needed — not mid-build, and not again with reworded keywords after a miss.
(The tool still declares `phases: ["perform", "perfect"]` for the legacy 4P path.)

It should not be called at all when a reference already exists. In that case
[`media_analysis`](./media-analysis.md) with `lens: "ui"` reads the user's own
mockup, which is always a better source than a stranger's layout.
