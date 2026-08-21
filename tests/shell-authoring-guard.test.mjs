/**
 * The shell-authoring guard (`detectShellAuthoring` under authorOnlyWrites).
 *
 * Root cause of the field run: the guard split commands on newlines, so the two
 * forms a weak driver actually uses to author files through `bash` slipped past —
 * a multiline quoted `sed -i` (the `sed` and its target path ended up in
 * different segments) and a `python3 << 'EOF'` heredoc (the `open(...,'w')` write
 * sat on a later line than the `python3` prefix). Detection is now heredoc- and
 * quote-aware: those forms are caught, while builds/reads/git/log redirects stay
 * untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectShellAuthoring } from "../dist/tools/builtin/coding.js";

const caught = (label, command, form) => {
  const hit = detectShellAuthoring(command);
  assert.ok(hit, `${label}: expected the guard to catch it`);
  assert.equal(hit.form, form, `${label}: expected form "${form}", got "${hit.form}"`);
  return hit.path;
};

const allowed = (label, command) => {
  assert.equal(
    detectShellAuthoring(command),
    null,
    `${label}: expected the guard to allow it: ${command.slice(0, 80)}`,
  );
};

test("guard catches a multiline quoted sed -i (the field run's exact shape)", () => {
  const path = caught(
    "multiline sed -i",
    `cd /x/cards_mobile_app && sed -i '' '218a\\
   // Initialize LaunchDarkly on reconnect
   initialiseLdClient();' lib/services/auth_service.dart`,
    "sed -i",
  );
  assert.match(path, /auth_service\.dart$/);
});

test("guard catches a python heredoc whose open(...,'w') write is mid-body", () => {
  const p = caught(
    "python heredoc write",
    `cd /x/cards_mobile_app && python3 << 'PYEOF'
with open('lib/services/auth_service.dart', 'r') as f:
    content = f.read()
content = content.replace('old', 'new')
with open('lib/services/auth_service.dart', 'w') as f:
    f.write(content)
PYEOF`,
    "python inline write",
  );
  assert.match(p, /auth_service\.dart$/);
});

test("guard catches a python heredoc pathlib write", () => {
  const p = caught(
    "python pathlib heredoc",
    `python3 << 'PYEOF'
from pathlib import Path
Path('lib/feature_flags_service.dart').write_text('x')
PYEOF`,
    "python pathlib write",
  );
  assert.match(p, /feature_flags_service\.dart$/);
});

test("guard catches a python -c pathlib one-liner (full-command form)", () => {
  const p = caught(
    "python -c pathlib",
    `python3 -c "from pathlib import Path; Path('src/app.ts').write_bytes(b'x')"`,
    "python pathlib write",
  );
  assert.match(p, /app\.ts$/);
});

test("guard catches a python -c inline open(...,'w') one-liner", () => {
  const p = caught(
    "python -c open write",
    `python3 -c "with open('lib/a.dart', 'w') as f: f.write('x')"`,
    "python inline write",
  );
  assert.match(p, /a\.dart$/);
});

test("guard catches output redirects and tee to authored paths", () => {
  caught("echo redirect", `echo 'export const x = 1' > src/app.ts`, "output redirect");
  caught("cat redirect", `cat << 'EOF' > src/a.ts\nhi\nEOF`, "output redirect");
  caught("tee", `echo x | tee lib/a.dart`, "tee");
});

test("guard leaves builds, git, reads, sed -n and log redirects alone", () => {
  allowed("flutter build", "cd /x && flutter build apk");
  allowed("npm build + log redirect", "npm run build > build.log");
  allowed("git diff", "git diff --stat");
  allowed("cat read", "cat lib/feature_flags_service.dart | head -260");
  allowed("sed -n read", "sed -n '206,240p' lib/services/auth_service.dart");
  allowed("mkdir/rm/cp/mv", "mkdir -p lib/x && cp a.ts b.ts && rm -f old.ts");
  allowed("grep", "grep -n 'LaunchDarkly' lib/services/auth_service.dart");
});