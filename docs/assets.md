# Assets: what to generate, and what to write

`assets_generator` ([`src/tools/builtin/assets-generator.ts`](../src/tools/builtin/assets-generator.ts))
produces image, video, audio and 3d assets from a prompt and returns them **by
reference** (a path plus a summary), never as inline bytes. Most of its use is
building sites and components: a hero, a section background, an ambient loop, a
voiceover.

The decision it exists to support is *generate vs author*, and the rule is not
about effort — it is about what the artifact has to **do** after it exists.

| | Reach for | Because |
|---|---|---|
| **Generate** (`assets_generator`) | photography, illustration, textures, background and gradient art, video loops, voiceover, sound effects | pixels nobody needs to edit, theme or animate |
| **Author** (`write`, as SVG/CSS/HTML) | icons, logos and wordmarks, UI chrome (arrows, chevrons, spinners, dividers), diagrams, charts, anything with readable text, **and every animated SVG** | it must be themeable, labelled, diffable, or targetable by an animation |

Two specifics behind that table:

- **Text in generated images** renders unreliably, and once it is pixels it cannot
  be translated, selected, restyled or fixed. Put type in HTML.
- **SVG is code.** Hand-authored SVG inherits the theme (`currentColor`, CSS custom
  properties), can be made accessible (`<title>`, `role="img"` + `aria-label`, or
  `aria-hidden` when decorative), stays readable in review, and — the decisive part
  — has ids and groups an animation can address. A *generated* SVG is one flattened
  path blob with none of that.

## The one case the tool refuses

A **complex static** decorative SVG is a fair thing to generate. The moment it has
to move, generating it is strictly worse than writing it: the flattened output has
nothing for a keyframe or transition to target, so the animation still has to be
hand-authored afterwards and the generation call was pure waste.

So `assets_generator` declines that request **before** spending the call. It is not
returned as an error — an error would get retried or escalated by the fallback
ladder — but as guidance that names the alternative concretely:

- one element with an `id`/`class` per moving part, related parts grouped in `<g>`;
- animate `transform` and `opacity` (compositor-friendly), not `width`/`height`/
  `x`/`y` (they force layout);
- `currentColor` and CSS custom properties for fills;
- `<title>` / `aria-label`, or `aria-hidden="true"` if purely decorative;
- the motion wrapped in `@media (prefers-reduced-motion: reduce)`;
- a `viewBox` so it scales instead of pinning pixel dimensions.

The trigger is deliberately narrow — it fires only when the request names a
**vector** format (in the prompt or `options.format`) *and* asserts **motion**.
"A complex static SVG background", "an SVG illustration of a wave crashing", "a
dynamic vector illustration" and "a photo of a spinning top" all still generate; "an
animated SVG logo", "svg icon that rotates" and "vector spinner" do not.
`detectAnimatedVectorRequest` is exported if you want to reuse or test the
classification.

If a static illustration sits *behind* the moving parts, generate that and animate
the wrapper in CSS — the decline message says so.

## Generating from an image, not just from words

Words cannot re-specify a picture you were handed. "The same scene but at night"
reliably produces a *different* scene, and a user who attached a photo and asked
for it restyled gets something that is not their photo. So the tool takes input
images alongside the prompt, with a **role** saying what each one is for:

| Role | What it does | Reach for it when |
|---|---|---|
| `reference` (default) | the generation is based on this image | remix, edit, extend; keeping a subject/product/character consistent across a set |
| `style` | borrow palette, texture and rendering only | you want the *look*, not the content |
| `mask` | only this region changes | inpainting — replace one part, preserve the rest |
| `start_frame` / `last_frame` | `video`: the frames the clip opens and closes on | animating a still you already have; a loop that closes seamlessly (same image as both) |

```jsonc
{"kind":"image","prompt":"make this a watercolour at dusk","images":[{"path":"assets/hero.png"}]}
{"kind":"video","prompt":"slow push-in, leaves drifting","images":[
  {"path":"assets/frame-a.png","role":"start_frame"},
  {"path":"assets/frame-b.png","role":"last_frame"}]}
```

The prompt should say only what should **change**; the images say what to change.

Paths, `http(s)://` URLs and `data:` URLs all work. A local path is read and
inlined as a data URL, because a generation provider has no access to the host's
disk — passing the path through would produce a call that silently ignores the
reference, which is the worst outcome available: a paid generation that looks
nothing like the input, with nothing saying why. For the same reason an unreadable
path is refused **before** any backend call, naming the path so it can be fixed.

On the wire the role maps differently per kind, and the difference matters:

- **image** — one flat `input_references` array (`{type:"image_url",
  image_url:{url}}`), which has no slot for a role, so `start_frame` is ordered
  first and `last_frame` last as the closest available signal.
- **video** — two arrays, because a video endpoint genuinely distinguishes them.
  `start_frame`/`last_frame` become `frame_images` entries carrying
  `frame_type: "first_frame" | "last_frame"`; everything else becomes
  `input_references`. That split is the whole reason the roles exist: a frame
  pins the picture the clip literally opens or closes on, so the model
  interpolates between two stills instead of inventing motion, while a reference
  only guides how it looks. Sending a frame down the reference channel silently
  downgrades "animate exactly this" to "make something similar".

`createBackendVideoBackend` does that split for you and puts both arrays on
`options`, so a host client that forwards `options` verbatim needs no mapping
code. Every backend also receives `req.images` with the roles intact, for one
that would rather inspect than forward.

## Asking for several at once

`count` (1–10) produces a set from one prompt — variants to choose between, or a
group that must look like it belongs together (a row of section backgrounds,
avatars for a team page, an icon family). One call is cheaper and more coherent
than repeating the call.

Every file comes back. `details.files` lists them all in order; `details.uri`
mirrors `files[0]` so single-asset callers are unchanged, and each file gets its own
`content` reference so downstream steps can address any of them. The first keeps
the plain name (`hero.png`), the rest are suffixed (`hero-2.png`) rather than
overwriting each other.

The failure this closes is the one that costs money silently: a provider billing
for `n` images while the tool reads `data[0]` and drops the rest. Each asset is
billed, so ask for the number you will actually use.

## Shipping what you generated

The prompt guidance (`ASSETS_AND_SVG`, shared by the loop and PERFORM) covers the
part that usually gets skipped:

- **Generate once and reuse.** Each call costs real money and real time, so don't
  regenerate a variant CSS can produce — a tint, crop, blur or flip.
- Put files where the project actually serves static assets; check before inventing
  an `assets/` directory.
- Reference them with explicit `width`/`height` or `aspect-ratio` so the page
  doesn't shift as they load; real alt text on anything meaningful; lazy-load below
  the fold; webp/avif for photographs.
- Don't commit large binaries the project doesn't need.

## Backends, and the placeholder contract

The harness ships **no** general generator: image/video/audio APIs differ in wire
format, auth and polling, and guessing one wrong is worse than having none. Hosts
supply backends per kind, or a `resolveBackend` callback for runtime choice.

```ts
new Harness({
  assets: {
    // The host's own media service — auth and billing stay in one place.
    backendImage: createBackendImageBackend({ client: postToMyBackendImages }),
    backendVideo: createBackendVideoBackend({ client: postToMyBackendVideos }),
    backends: { audio: myVoiceBackend },       // or per-kind, or resolveBackend
    openRouterImage: { model: "sourceful/riverflow-v2-fast" }, // or false to disable
    defaultOutDir: "public/generated",
  },
});
```

A backend returns one asset, or an **array** of them to satisfy `count`. Returning
a single object still means "one asset", so every backend written before batch
support keeps working unchanged.

**The host-delegating backends** (`createBackendImageBackend`,
`createBackendVideoBackend`) are the recommended wiring: generation goes through
the host's own proxy, which already owns auth, billing and — for video — the
asynchronous submit → poll → download the harness deliberately does not
implement. Both receive `images` and `count` as typed fields *and* folded into
`options` (`input_references`/`frame_images`/`n`), so a client that forwards
`options` verbatim needs no mapping code at all. The video client may answer with
inline `b64_json` or a fetchable `url`; the backend downloads the latter so the
tool's bytes-in-hand contract holds either way, and returns only when the clip is
ready.

Resolution order per call: `resolveBackend` → `backends[kind]` → `backendImage` /
`backendVideo` → the built-in OpenRouter image backend → placeholder. That
built-in is `image` only and is engaged **only** when an API key is resolvable —
so offline and test runs fall through to the placeholder instead of failing on a
call that could never have succeeded. `audio` and `3d` keep their placeholders
until a host supplies a backend.

**A placeholder is not an asset.** When no backend is configured the tool writes a
deterministic stand-in — one per requested `count`, for every kind, so a caller
that asked for three and silently received one never exercises a shape it will
not meet against a real backend — and the LLM-facing output starts with
`PLACEHOLDER ONLY — …
It is NOT a generated <kind>; do not present it as one.` The warning is in the
model-visible output on purpose: a model that believes it generated a real asset
will happily ship it. The prompts add the other half — wire the layout up around
it, then say plainly in the run summary which assets are still placeholders and
need a real backend or a file from the user.
