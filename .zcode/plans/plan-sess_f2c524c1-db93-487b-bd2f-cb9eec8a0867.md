## Goal
Route the two remaining direct OpenRouter calls — **image generation** and **media/vision analysis** — through the backend's `turing-machine` module (same as `/chat/completions`), authenticated via the **existing login JWT** (strict — no shared-token), with billing. Then rewire OpenWaggleMain to call these backend endpoints instead of hitting OpenRouter directly.

## Decisions (confirmed)
- **Auth**: strict JWT on the new endpoints (`JwtAuthGuard`, *not* `TuringMachineAuthGuard`). Every caller must be a logged-in user.
- **Vision billing**: reuse chat's Turing-Machine USD wallet (`recordTextConsumption` with `meta.api='turing-machine'`). **No DB schema changes.**
- **Image billing**: reuse `recordImageConsumption` (already wired: `imageGenerations` column + pricing). **Also** debit the `turingMachine*` sub-ledger so the `assertTuringMachineAccess` quota check stays consistent (otherwise image gen would bypass the budget gate that protects the wallet). I'll extend `recordImageConsumption` to optionally bump the turing-machine columns + daily activity when `meta.api==='turing-machine'` — mirroring exactly how `recordTextConsumption` already does it.

---

## Part A — Backend (`/Users/shashankv/Projects/backend`): two new endpoints

### 1. New DTOs in `src/turing-machine/dto/`
- `image-generation.dto.ts`: `{ model?: string, prompt: string, options?: Record<string,unknown> }` (model optional → defaults via env `TURING_MACHINE_IMAGE_MODEL` / `OPENWAGGLE_IMAGE_GEN_MODEL` / `sourceful/riverflow-v2-fast`; `options` forwarded verbatim for per-model knobs).
- `media-analysis.dto.ts`: `{ model?: string, systemPrompt?: string, prompt: string, images: Array<{mimeType, data|uri}> }` — reuses the `TuringMachineChatMessageDto` content-part shape (image_url data URIs). model optional → defaults via `TURING_MACHINE_VISION_MODEL` / `OPENWAGGLE_VISION_MODEL` / `google/gemini-2.5-flash`.

### 2. Service methods in `turing-machine.service.ts`
Reuse the existing `assertAccess` (now **strict** — throw 401 if no user), `getOpenRouterHeaders`, and the `recordConsumption` wrapper. Add:
- `createImageGeneration(dto, user)`:
  - `assertAccess(user)` (strict) → turing-machine budget check
  - `fetch(getImagesUrl(), { POST, headers, body: { model, prompt, ...options } })` where `getImagesUrl()` = `${OPENROUTER_BASE_URL}/images` (new helper mirroring `getChatCompletionsUrl`)
  - on non-2xx → `buildUpstreamError`
  - record: `recordImageConsumption({ ..., meta: { api: 'turing-machine', stage: 'turing-machine.image' } })`
  - return upstream response as-is (`{ data: [{ b64_json, media_type }] }`)
- `analyzeMedia(dto, user)`:
  - `assertAccess(user)` (strict)
  - build OpenRouter `/chat/completions` request: messages = [systemPrompt?, { role:'user', content:[ {type:'text', text:prompt}, ...images→{type:'image_url', image_url:{url: dataUri}} ] }], `stream:false, temperature:0`
  - `fetch(getChatCompletionsUrl(), ...)`
  - record: `recordTextConsumption({ ..., meta: { api:'turing-machine', stage:'turing-machine.media-analysis' } })`
  - return upstream response

**Strict access**: the new endpoints need a real user. I'll add `assertAccessRequired(user)` that throws `UnauthorizedException` when `user` is null (vs the existing `assertAccess` that returns null for shared-token). This keeps the chat path's shared-token behavior untouched.

### 3. Controller routes in `turing-machine.controller.ts`
Add (class guard stays `TuringMachineAuthGuard`, but these methods override with `@UseGuards(JwtAuthGuard)`):
- `@Post('images')` + `@UseGuards(JwtAuthGuard)` → `createImageGeneration`
- `@Post('media/analysis')` + `@UseGuards(JwtAuthGuard)` → `analyzeMedia`

(Both read `req.user as UserEntity`; JwtAuthGuard guarantees a real user.)

### 4. Billing extension in `subscriptions.service.ts`
Extend `recordImageConsumption` (lines 3040-3065) so that when `meta.api === 'turing-machine'` it ALSO increments `turingMachineUsdCents`/`turingMachineUsdMicros` and (if userId) the daily-activity row — mirroring the existing `recordTextConsumption` branch at 2323-2354. This requires adding an optional `userId` param to `recordImageConsumption`. This keeps the USD-wallet quota check honest for image gen.

### 5. Module
No change — `TuringMachineModule` already imports `AuthModule` (provides `JwtStrategy` so `JwtAuthGuard` works) and `SubscriptionsModule`.

---

## Part B — turing-harness (`/Users/shashankv/Projects/turing-harness`): backend-delegating backends

The harness must be able to call a **backend** (not OpenRouter directly) for both image gen and vision, so OpenWaggleMain can inject the backend URL + JWT. Add injection seams mirroring the `AssetBackend` pattern:

### 1. `src/llm/backend-image-backend.ts` (new) — image
- `export interface BackendImageRequest { model; prompt; options? }`
- `export interface BackendImageResponse { bytes: Uint8Array; mimeType: string }`
- `export type BackendImageClient = (req, opts: { signal?, baseUrl, token }) => Promise<{ b64_json, media_type }>`
- `export function createBackendImageBackend(config: { client: BackendImageClient; model?; defaults? }): AssetBackend` — same return contract as `createOpenRouterImageBackend` (`{bytes, mimeType, ext, summary}`), but delegates to `config.client`.

### 2. `src/tools/builtin/media-analysis.ts` — add a backend backend
- `export type MediaAnalysisClient = (req, ctx) => Promise<{ text; usage? }>` (already matches `MediaAnalysisBackend`)
- `export function createBackendMediaAnalysisBackend(client: MediaAnalysisClient): MediaAnalysisBackend` — thin wrapper so a host can inject a backend-calling function instead of the OpenRouter one.
- Re-export from `src/index.ts`.

### 3. Expose via `AssetsGeneratorConfig`
Add `backendImage?: AssetBackend` to `AssetsGeneratorConfig`; `resolveBackend`/`assetBackendFor` for `image` consults `backendImage` BEFORE the OpenRouter built-in, so OpenWaggleMain can inject the backend-backed one. (Mirror how `resolveBackend` already precedes `backends`/`openRouterImage`.)

### 4. Tests
Add `tests/backend-image-backend.test.mjs`: stub client → bytes returned with correct mimeType; error path; model defaulting. (media-analysis backend is a thin pass-through — covered by existing tests.)

---

## Part C — OpenWaggleMain (`/Users/shashankv/Projects/OpenWaggleMain`): route through backend

### 1. New client module `src/main/adapters/turing/media/turing-media-client.ts`
Two functions mirroring `fetchToolSelection`/the inspiration client (global `fetch`, `AbortController`+timeout, Bearer from `readStoredApiKey('turing-machine')`, `resolveTuringMachineBaseUrl()`, **silent/delegating error handling**):
- `generateImageViaTuring({ prompt, model?, options? })` → `POST {base}/images` → returns `{ b64_json, media_type }`
- `analyzeMediaViaTuring({ prompt, systemPrompt?, images, model? })` → `POST {base}/media/analysis` → returns the chat-completions JSON (text + usage)

### 2. Rewire `turing-media-providers.ts`
- `assetBackendFor('image')`: when `resolveAssetProvider()` resolves to a new `'turing'` provider (env `OPENWAGGLE_ASSET_PROVIDER=turing`), return `createBackendImageBackend({ client: generateImageViaTuring, model })`. Keep OpenRouter as the fallback default so nothing breaks if the env isn't set. (Defaulting to `'turing'` is the goal, but I'll gate on env so the change is opt-in/safe and reversible.)

### 3. Rewire vision
`turing-memory-prewarm.ts` currently sets `mediaAnalysis: { model: visionModel }`. I'll extend the harness `mediaAnalysis` config to accept an injected `backend` (the backend media-analysis client), and OpenWaggleMain passes `createBackendMediaAnalysisBackend(analyzeMediaViaTuring)` so vision calls also route through the backend. Falls back to the bundled OpenRouter backend when not injected.

### 4. Env
Add `OPENWAGGLE_ASSET_PROVIDER` value `'turing'` to the env literal union (currently `'openrouter' | 'runware'`). Document that `=turing` routes image gen through the backend.

---

## Verification
- **backend**: `npm run build`; smoke-test both endpoints with a real JWT (POST /images → bytes; POST /media/analysis with a data-URI image → text). Confirm `subscription_consumption` rows increment (`imageGenerations` for images; `textInputTokens`/`turingMachineUsdCents` for vision) and the daily-activity row bumps.
- **harness**: `npm run build && npm test` (existing + new backend-image test).
- **OpenWaggleMain**: `pnpm install` (refresh file: copy) + `pnpm typecheck:node`. With `OPENWAGGLE_ASSET_PROVIDER=turing`, an `assets_generator` image call hits the backend; a `media_analysis` call hits the backend.

## Files touched (summary)
- **backend**: `dto/image-generation.dto.ts` + `dto/media-analysis.dto.ts` (new), `turing-machine.service.ts` (image + vision methods, strict access, images URL), `turing-machine.controller.ts` (2 routes, JwtAuthGuard), `subscriptions.service.ts` (`recordImageConsumption` → turing-machine sub-ledger).
- **harness**: `src/llm/backend-image-backend.ts` (new), `src/tools/builtin/media-analysis.ts` (backend backend + export), `src/tools/builtin/assets-generator.ts` (`backendImage` config), `src/index.ts` (re-export), `tests/backend-image-backend.test.mjs` (new).
- **OpenWaggleMain**: `media/turing-media-client.ts` (new), `turing-media-providers.ts` (`turing` provider branch), `turing-memory-prewarm.ts` (vision backend), `env.ts` (`'turing'` literal).

## Note on the strict-JWT choice
Because image + vision are JWT-only, they will **not** work with a shared token — unlike chat, which still allows the shared-token dev path. OpenWaggleMain already sends the user JWT under the `turing-machine` credential slot, so this is fine for the app; just flagging that a shared-token curl of `/images` will 401 (expected).