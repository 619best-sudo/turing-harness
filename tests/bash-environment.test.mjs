/**
 * What `bash` actually runs, and what it reports back.
 *
 * The run this closes: on a Flutter repo, every `flutter` command answered
 * `/bin/sh: flutter: command not found`, each of those tool calls came back
 * `isError: false` (the `| head -50` owned the exit code), and the run concluded
 * "Flutter is not available in this environment" and declared a UI change
 * verified by reading the file back. Three separate defects, one per test group
 * below.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CODING_TOOLS } from "../dist/index.js";

const bashTool = CODING_TOOLS.find((t) => t.name === "bash");
const bashReadonly = CODING_TOOLS.find((t) => t.name === "bash_readonly");

async function scratch(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `bash-env-${name}-`));
}

const ctx = (cwd) => ({ cwd, log: () => {} });

// ---------------------------------------------------------------------------
// 1. The environment: the user's PATH, not the parent process's.
// ---------------------------------------------------------------------------

test("commands run with the login shell's PATH, not a bare inherited one", async () => {
  const dir = await scratch("path");
  const res = await bashTool.execute("b", { command: "echo $PATH" }, ctx(dir));
  assert.equal(res.isError, undefined, res.output);
  const dirs = res.output.split(":");
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (entry) assert.ok(dirs.includes(entry), `kept ${entry}`);
  }
});

test("commands run in a shell that understands more than POSIX sh", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("shell");
  // `[[ ]]` is a bash/zsh construct; /bin/sh in strict POSIX mode rejects it.
  const res = await bashTool.execute("b", { command: 'if [[ "a" == "a" ]]; then echo yes; fi' }, ctx(dir));
  assert.match(res.output, /yes/, res.output);
});

// ---------------------------------------------------------------------------
// 2. The project's own toolchain, when the bare name is on nobody's PATH.
// ---------------------------------------------------------------------------

test("a project-pinned binary is found, used, and reported", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("pinned");
  const bin = path.join(dir, ".fvm", "flutter_sdk", "bin", "flutter");
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, '#!/bin/sh\necho "Flutter 3.38.4"\n', "utf8");
  await fs.chmod(bin, 0o755);

  const res = await bashTool.execute("b", { command: "flutter --version" }, ctx(dir));
  assert.equal(res.isError, undefined, res.output);
  assert.match(res.output, /Flutter 3\.38\.4/, "the pinned SDK actually ran");
  assert.match(res.output, /\[toolchain\]/, "the model is told what happened");
  assert.match(res.output, /not on PATH/);
  assert.equal(res.details.toolchain[0].missing, "flutter");
});

test("the read-only shell resolves the same pins", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("pinned-ro");
  // A name no machine has on PATH: `npm test` prepends `node_modules/.bin`, so a
  // real tool name would resolve for the wrong reason and pass vacuously.
  const bin = path.join(dir, "node_modules", ".bin", "turing-fake-linter");
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, '#!/bin/sh\necho "Version 5.5.0"\n', "utf8");
  await fs.chmod(bin, 0o755);

  const res = await bashReadonly.execute("b", { command: "turing-fake-linter --version" }, ctx(dir));
  assert.match(res.output, /Version 5\.5\.0/, res.output);
  assert.match(res.output, /\[toolchain\]/, res.output);
});

// ---------------------------------------------------------------------------
// 3. `command not found` is a failure, whatever the exit code says.
// ---------------------------------------------------------------------------

test("a missing executable is an error even when a pipe swallows the exit code", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("notfound");
  const res = await bashTool.execute(
    "b",
    { command: "definitely-not-a-real-binary-xyz analyze 2>&1 | head -50" },
    ctx(dir),
  );
  assert.equal(res.isError, true, "the pipeline exited 0; the result must not");
  assert.deepEqual(res.details.missingExecutables, ["definitely-not-a-real-binary-xyz"]);
  assert.match(res.output, /RESOLUTION failure/);
  assert.match(res.output, /do NOT conclude the environment/);
});

test("output that merely MENTIONS command-not-found is not an error", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("mention");
  await fs.writeFile(path.join(dir, "build.log"), "/bin/sh: flutter: command not found\n", "utf8");
  const res = await bashTool.execute("b", { command: "cat build.log" }, ctx(dir));
  assert.notEqual(res.isError, true, "grepping a log is not a failed command");
  assert.match(res.output, /command not found/, "the text still comes through");
});

test("a plain non-zero exit is still an error, with its output intact", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("exit");
  const res = await bashTool.execute("b", { command: "echo boom >&2; exit 3" }, ctx(dir));
  assert.equal(res.isError, true);
  assert.match(res.output, /boom/);
});

// ---------------------------------------------------------------------------
// 4. A killed command must say it was killed.
//
// From a real run: `flutter build apk --debug 2>&1 | tail -30` with
// timeoutMs 180000 returned the single line `Command failed: <cmd>` — no
// stdout, no stderr, no mention of a timeout. The model diagnosed a broken
// build, abandoned the plan to put the app on a simulator, and finished with
// the UI change unverified. The build had not failed; it had been killed
// halfway through.
// ---------------------------------------------------------------------------

test("a timeout says it timed out, and after how long", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("timeout");
  const res = await bashTool.execute("b", { command: "sleep 5", timeoutMs: 700 }, ctx(dir));
  assert.equal(res.isError, true);
  assert.match(res.output, /\[timeout\]/);
  assert.match(res.output, /did NOT fail, it ran out of time/);
  assert.equal(res.details.timedOutAfterMs, 700);
});

test("a killed `| tail` pipeline explains why nothing came back", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("tailkill");
  // `tail` only emits at EOF, so killing the shell takes the whole log with it.
  const res = await bashTool.execute(
    "b",
    { command: "for i in 1 2 3 4 5; do echo line $i; sleep 1; done | tail -30", timeoutMs: 700 },
    ctx(dir),
  );
  assert.equal(res.isError, true);
  assert.match(res.output, /only emit at EOF/);
  assert.match(res.output, /redirect to a file/);
});

test("a heavy command killed early is told the default it overrode", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  // The real shape: an fvm-pinned SDK running a build that outlives the
  // timeoutMs the model chose.
  const dir = await scratch("heavykill");
  await fs.writeFile(path.join(dir, "pubspec.yaml"), "name: app\n", "utf8");
  const sdk = path.join(dir, ".fvm", "flutter_sdk", "bin", "flutter");
  await fs.mkdir(path.dirname(sdk), { recursive: true });
  await fs.writeFile(sdk, "#!/bin/sh\nsleep 5\n", "utf8");
  await fs.chmod(sdk, 0o755);

  const res = await bashTool.execute("b", { command: "flutter build apk --debug", timeoutMs: 700 }, ctx(dir));
  assert.equal(res.isError, true);
  assert.match(res.output, /\[timeout\]/);
  assert.match(res.output, /routinely exceeds/);
  assert.match(res.output, /600s/, "names the default an explicit timeoutMs overrode");
});

test("a long-running command is steered to background, not to a bigger timeout", async (t) => {
  if (process.platform === "win32") return t.skip("posix only");
  const dir = await scratch("bgadvice");
  const res = await bashTool.execute("b", { command: "sleep 5", timeoutMs: 700 }, ctx(dir));
  assert.match(res.output, /background: true/);
});
