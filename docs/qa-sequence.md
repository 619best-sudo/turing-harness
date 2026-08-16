# The QA sequence

How a run proves that the change it made actually works — and the refusals that
stop it doing that badly.

## The run this exists because of

A real run was asked to change the title of a delete-account dialog in a Flutter
app. It did this:

```
grep → read → ask the user for the new title → edit the file → flutter analyze
→ mobile_launch_app(com.example.app)      ← the ALREADY-INSTALLED build
→ mobile_take_screenshot                  ← captured the iOS home screen
→ tap (287,188) → tap (380,110) → screenshot → screenshot
→ "the change has been verified"
→ ask the user how to log in              ← the last turn of the run
→ flutter build ios --simulator           ← the first build, never finished
```

Nothing in that sequence verified anything:

- **The app was never built.** Editing a file does not change an app already
  installed on a simulator, so every screenshot was of the *previous* code.
- **`activity_inspect` was never called.** The run used the raw device MCP, so
  the screenshots were captured and never judged — no `media_analysis`, no
  verdict, just pixels the model could not read.
- **The taps were guesses.** The first screenshot was the springboard; the taps
  went into the icon grid.
- **The login wall was hit in silence.** The one move that crosses it —
  `ask_user_question` — came after the budget was gone.

Every one of those is forbidden, in full sentences, in the phase prompts. That
is the point: prose alone did not bind. What follows is the same rules with
enforcement behind them.

## The sequence

Eight steps, in order, stated in [`QA_SEQUENCE`](../src/phases/prompts.ts) and
carried by both the loop system prompt and the staged verify messages. The order
is load-bearing: a step that runs before its predecessor verifies the wrong
thing — old code, a dead screen, a file nobody served — while looking exactly
like a real check.

| # | Step | Tool | Why it is not optional |
|---|------|------|------------------------|
| 1 | **LOG** | `activity_trace_start` → `add_log` | Probes are source edits — they must be in the binary *before* it launches, which is why this is step 1. The screen shows what rendered; the trace shows whether the data behind it flowed. Also the fallback when a screen turns out to be unreachable. Probes carry the session's unique marker (`TURING_TRACE_<suffix>`) — a previous session's (or a legacy) leftover probes are reported, never read as this run's evidence. |
| 2 | **BUILD** | `bash` (`background: true`) + wait | A capture taken before the build lands verifies the old code. Always. |
| 3 | **RUN** | the app / the dev server / `curl` | Pick by what the project *is*, start it **exactly once** (never a `file://` URL, never a second server beside the first). A mobile app has no http URL; a backend change owes the API call; a change spanning both owes both, API first. |
| 4 | **AUTOMATE** | browser/mobile automation, or `curl` | Drive the UI to the state the change lives in — deep link, login, navigate, play the animation, submit the form — so the step-5 capture shows the change, not the landing screen. A wall (login/OTP/unknown value) means `ask_user_question`, not more tapping. |
| 5 | **INSPECT** | one `activity_inspect` with `expected` | Only after RUN is up carrying the new build — an inspect before that photographs no screen or the old code. It reaches the screen, captures a screenshot *and* returns `VERDICT: PASS/FAIL`. Screenshot-only on mobile — no element trees, no coordinate taps. For **new UI**, the check covers the visual scope: positioning, alignment, colors, spacing, sizing, overlap — not just presence. |
| 6 | **LOGS** | `activity_collect { waitMs }` → `activity_study` | Study the run's trace, then verify the *data* matches what the screen claims. A screen that looks right on stale or defaulted data is a bug about to be called verified. |
| 7 | **DECIDE** | verdict → mutate files → restart at BUILD | A FAIL (or failed build/test) is not an exit: fix the files and walk steps 2-6 again until the verdict is PASS. Quality is the exit condition, not the budget; an exhausted budget ends honestly with `verified: false`. |
| 8 | **CLEANUP** | `remove_log { all: true }` / `activity_cleanup` | Remove every probe, kill any server the run started, then write the summary. Debug logging left in the user's source is a defect. |

**Stuck at any step** — a login, an OTP, a form field only the user knows, a file
to upload, a paywall, a role wall, a record that does not exist in this
environment — stop and call `ask_user_question`. The user can answer with the
value, **attach** the file, or do that one step themselves and tell you to
continue. See [asking the user](./asking-the-user.md).

**Visual work compares against the right image**, and says which one it used:

- replicating a design the user attached → the capture is gap-analysed against
  *that* image;
- fixing a reported visual bug → against the broken capture taken before the edit;
- neither → `expected` alone, judged claim by claim.

## Where QA happens (and where it does not)

QA belongs to the **verify pass**, not to the work loop.

```
work loop            verify pass (one per attempt, staged)
─────────            ────────────────────────────────────
read / edit / write  instrument → build → run → inspect → decide
run the project's
own build+typecheck
        │
        └─ writes recorded ───────────► freshness measured against them
```

The work loop's job after a write is exactly two things: finish the change, and
run the project's own build so a compile error is caught while it is cheap. It
then stops. Driving the UI there does the verify pass's QA a second time and does
it worse.

The exception is **reproduction**: before the first write, driving the app is
required on a bug-fix run — that is how you learn which code is on the failing
path. See [debugging](./debugging.md).

## The staged spine and the repair loop

Each verify round targets ONE stage, picked by
[`orchestrator/verify-stages.ts`](../src/orchestrator/verify-stages.ts) from the
outstanding gaps:

- **instrument** — `add_log` probes on the changed lines, FIRST — probes are
  source edits and must be in the binary before it launches. The launch then
  goes through `activity_trace_start`, so the trace is live from the first
  frame and logs + screen are collected in ONE pass. **Enforced**: while a
  changed runtime file carries no probe, `activity_inspect` and raw screenshot
  tools are refused with the owing file list. Escapes stay open: `DECLARE` a
  static file, reach DECIDE, or exhaust the round budget honestly.
- **build** — the (now-probed) writes go onto the verified surface: rebuild +
  install (mobile/desktop) or start/hot-restart the dev server (web), through
  the trace session. A successful classified
  build/launch `bash` result, `mobile_install_app`, or a READY
  `activity_trace_start` closes the debt; a later edit re-opens it. Skipped for
  endpoint-only gaps (curl an already-running server) and in USER mode (the user
  builds and runs the app).
- **run** — exercise the changed path; `activity_collect` polls the trace.
- **inspect** — `activity_inspect` (visual verdict) + read the trace.
- **decide** — verdict per file, then strip the probes.

**VERDICT: FAIL does not end the attempt** — it triggers a *repair round*: the
next round's message lists what failed, authorizes `edit`/`write` to fix it, and
the spine restarts at **build** (the fix edit re-arms the build debt
automatically). The loop runs until every gap has evidence or the round/attempt
budget is exhausted, in which case the run still completes — honestly, with
`verified: false`. Bug-fix runs walk the same spine with the debugging contract
at DECIDE: fixed → strip probes and cite the trace line; not fixed → revert the
attempt, study the trace, edit again.

**But a FAIL the pixels cannot justify never enters that loop.** The analyst
sees a screenshot, not the code — it cannot know that an element *state* (a
disabled button, an empty list, a loading spinner) is intended. So the `qa`
lens's verdict is scoped: FAIL means an EXPECTED claim is contradicted or the
screen shows overt breakage; a state the `expected` does not mention is an
`OBSERVED` line that cannot decide the verdict. `expected` asks for intended
states in the caller's words ("Confirm disabled until the email is typed") for
the same reason. And if a FAIL still names only intended states or things a
still frame cannot show (font weights, behaviour), the DECIDE and repair
messages sanction the exit instead of a rebuild: re-run `activity_inspect` once
with those states stated, then `DECLARE { path, method:"none", reason }` quoting
each failing item and why it is intended or unverifiable — an auditable
adjudication in the report's `certified` list, not a rebuild that reproduces
the same FAIL forever. A rebuild is for broken code, not for the app working.

## The refusals

Implemented in [`orchestrator/qa-gate.ts`](../src/orchestrator/qa-gate.ts), one
run-scoped instance threaded into every loop.

### 1. Scope — QA is the verify pass's job

Once the run has written real bytes, a raw drive/capture tool
(`mobile_screenshot`, `browser_click`, `mobile_launch_app`, taps, snapshots,
`browser_snapshot`, the bare chrome-devtools verbs) in a **work** loop is
refused. The refusal names what the step owes instead and points at
`activity_inspect` for the case where the model genuinely does need to look now.

Inert before the first write (that is reproduction) and inside the verify rounds
(that *is* the QA pass). `activity_inspect` is never refused by this rule — it is
what the rule redirects to.

### 2. Freshness — never photograph a build you did not make

On a **device**, after a write, a capture is refused until a build+install has
landed. The refusal quotes the project's own launch command back, read from its
manifests by [`exec/run-commands.ts`](../src/exec/run-commands.ts):

> Build, install and launch it first: `npm run ios` (from package.json
> scripts.ios).

A **build-only** task does not clear the debt. `flutter build`, `gradlew
assemble`, `xcodebuild archive` produce an artifact and install nothing, so the
app on the screen is still the old one — this is the distinction the failing run
got wrong. `mobile_install_app` and a device-launch `bash` command both clear it;
a subsequent edit re-opens it.

Deliberately **device-only**. A web dev server hot-reloads and may have been
started outside the run, so "stale" there would be a guess; the real web failure
(a guessed URL nothing answers) is already caught by `activity_inspect`'s own
navigation-failure detection.

A **probe-only** edit — one that adds or removes `__t()` calls and nothing else —
opens no debt. Holding a capture hostage to rebuilding for instrumentation would
make the instrument → build → run → inspect spine impossible to walk.

### 3. Reaching the device: the id must be real, and the surface right

Two refusals that fire on the way to step 2/3, from
[`exec/device-target.ts`](../src/exec/device-target.ts). Both come from one run
that never got the app started.

**A mis-typed device id is corrected, not just rejected.** The booted simulator
was `E25EC6B1-342D-4CDE-9607-A09B5243E126`; the model wrote
`…-A09B243E126` — one `5` dropped. `flutter run -d <typo>` answered *"No devices
found"*, `mobile_install_app` answered *"Device not found. Use the
mobile_list_available_devices tool…"*. The model **did** re-list the devices,
read the correct id back, and re-issued the same typo twice more. Four dead
calls, and it concluded the app could not be run.

Both error messages are accurate, and neither says the only thing that closes the
loop. A 36-character UDID is exactly the token a model cannot reliably copy, so
the harness now compares the requested id against what is actually booted and, on
a near miss, refuses with the real id in the message and an instruction not to
re-list first. Budget is deliberately generous (`maxBlocks × 3`): the correction
is mechanical rather than a judgement call, and running out of it hands the run
back to the failure it exists to prevent.

A platform word (`-d chrome`, `-d macos`, `-d ios`) is never treated as an id, a
human-readable device name is never matched, and a probe that fails or finds
nothing booted stays silent.

**A mobile app is not "run" on the web.** Having failed to reach the simulator,
that run tried `flutter run -d chrome --web-server-port 5000`, then built a web
bundle, then served `build/web` with `python3 -m http.server` — twice, both times
onto a port already in use. Each of those *starts*, and none says anything about
the iOS screen the user asked about, so the run ends confidently wrong instead of
honestly stuck.

While a device is booted and the project is a mobile one, running it on
web/desktop is refused, pointing at the booted device and the project's own
device command. Gated so a genuine Flutter-for-web or desktop project is
untouched, and scoped to a **run** — `flutter build web` is a real deliverable
and is not this check's business. The refusal also names the alternative that is
*not* switching surfaces: if the device run keeps failing, that failure is the
finding — report it or ask the user.

### 4. The build has to be able to reach the device

Same run, two more dead ends — both from treating "build" and "get it onto the
simulator" as the same verb:

```
flutter build apk --debug --no-shrink    ← an ANDROID artifact. Only an iOS simulator was booted.
flutter build ios --debug --no-codesign  ← builds for a PHYSICAL device (build/ios/iphoneos/).
                                           Cannot be installed on a simulator.
mobile_install_app  …/Debug-staging-iphonesimulator/Runner.app
                                         ← a stale flavor path from an old Xcode build.
```

Neither build could have worked, both took minutes, and their failure was read as
the app being unrunnable. So an artifact build is refused when a device is booted
and the project is a mobile one: either because it targets a platform nothing is
booted for, or because a build/assemble/archive task installs nothing and leaves
an output path you then have to guess. The refusal stands down if the artifact
really is the goal — "build me a release APK" is a legitimate request that looks
identical from here — and it says so.

#### The command it hands back

Every refusal above quotes **one** command: the project's own, with the booted
device pinned onto it.

That ordering is load-bearing, and it is why a hardcoded per-stack table would be
wrong. `cards_mobile_app` has product flavors, and its CLAUDE.md says:

```
flutter run --flavor staging -t lib/main_staging.dart
```

A bare `flutter run -d <udid>` does not build that app — it fails on a missing
flavor, in a way that reads like the app is broken rather than like the command
was wrong. So [`composeDeviceLaunch`](../src/exec/run-commands.ts) takes what the
repo declares (package scripts, Makefile, README/CLAUDE.md/AGENTS.md) and adds the
device with the stack's own flag — `-d`, `--udid`, `--device`, `--deviceId`:

```
flutter run --flavor staging -t lib/main_staging.dart -d E25EC6B1-…-A09B5243E126
```

A generic stack default is the **last** resort, offered only when the repo
declares nothing and labelled as not read from the project, with a note to check
for a flavor or entrypoint. Where nothing honest can be derived (a bare Xcode
project needs a scheme), nothing is quoted.

The harness already knew both halves of this — it had detected that CLAUDE.md
line and it knew the simulator's id. It just never put them together where the
model could see them.

### 5. Blind taps — coordinates are derived from the screenshot, never nudged

The sanctioned one-call path is `mobile_tap_visual { element }`: it captures (native resolution,
local simctl/adb first), consults the element list for GROUND-TRUTH coordinates, and
auto-calibrates the tap tool's coordinate space (logical points vs physical pixels — learned
from the first tap that changes the screen). It
localizes the element in image pixels (vision), converts to logical points in
code, taps, and re-captures to confirm the screen changed — retrying the
derivation once on a silent miss. Hand-computing the pixel ratio is how runs
die by ±5px on a 40pt icon.

A coordinate tap (`mobile_tap` and the tap family)
is a claim that you KNOW where the element is. The only evidence for that claim
is a position read off a capture — `activity_inspect` or `media_analysis` on a
screenshot. A real run instead tapped a guessed (350,55), screenshotted, nudged
to (365,55), screenshotted, nudged to (368,48)… never landing on the small
avatar it was circling. So: **one tap per analysis**. An analysis earns the tap;
the tap spends it; a raw screenshot between taps does not re-earn it (looking is
not reading a position off the image). The refusal teaches the derivation —
`mobile_elements` first (its rects and centres are already LOGICAL POINTS —
tap them as-is, no arithmetic), and only for targets missing from the
accessibility tree: capture → read the position (`media_analysis` / inspect
verdict) → divide the image pixels by the scale factor from
`mobile_device_info` → tap the reported centre once. Then the exits: scroll,
deep link, or `ask_user_question` when the element is not tappable that way.

`mobile_tap` also refuses an out-of-bounds coordinate outright and prints the
logical equivalent, so sending physical pixels fails loudly instead of being
silently dropped by the driver — which is what made this look like a flaky
tap tool for so long.

### 6. Stuck — a wall is a question, not a puzzle

After enough capture/drive calls with no write, no deploy and no question, a
nudge is injected naming `ask_user_question`, what the wall usually is, and the
three shapes an answer can take (a value, an attachment, or the user doing that
one step). A nudge rather than a refusal — the model may be three taps from the
target; what it needs is the reminder, not a stop. Fires once per streak; asking,
writing or deploying resets it.

### None of them can deadlock

Each rule stands down after `maxBlocks` refusals (default 2, counted separately
per rule; the device-id correction gets `maxBlocks × 3` because it is mechanical). A model that cannot satisfy one proceeds with the warning on the log
under the `qa-gate` tag. A gate that could wedge a run would be worse than no
gate.

## Which reference image a capture is graded against

`activity_inspect` compares the live capture against "the run's reference image".
That is only well-defined when the run carries exactly one image, and real runs
carry several — a mockup *and* a screenshot of a stack trace. Picking
positionally meant a rendered screen could be graded against the stack trace:
a fluent, confident, meaningless `FAIL`.

`resolveReference` now picks by the **role** attachment triage assigned each
image (see [media analysis](./media-analysis.md)):

| Order | Role | Meaning |
|-------|------|---------|
| 0 | explicit `reference` argument | the caller named it; always wins |
| 1 | `ui-replicate` | the design to rebuild |
| 2 | `ui-bug` | the broken state to have fixed |
| — | `informational` | **never** a reference — text/data the task should know |

Ties between same-role candidates go to one whose `targets` name a file the run
changed. An untriaged set resolves only when it holds exactly one image; two
un-roled images are genuinely ambiguous and nothing is chosen, so the capture is
QA'd against `expected` instead of gap-analysed against a coin flip.

The result **names the file it compared against** on its first line:

> Compared against `/attachments/mockup.png` — the run's attached design to replicate.

Read that line. If it named the wrong image, pass `reference: "<the right path>"`
and run it again.

## Related

- [Debugging](./debugging.md) — the `activity_*` loop, reproduction-first, fix→prove→revert
- [Asking the user](./asking-the-user.md) — which decisions are theirs
- [Media analysis](./media-analysis.md) — the QA lens and attachment triage
- [Shell execution](./shell-execution.md) — project-pinned toolchains, capturing a booted simulator with no MCP
- [The 4P phases](./4p-phases.md) — where the verify pass sits in a chain run
