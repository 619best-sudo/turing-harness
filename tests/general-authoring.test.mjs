/**
 * Authoring through the shell, in whatever language the model reaches for.
 *
 * The guard began as a statement about two commands — `sed -i` and a `python3`
 * write — which made it a statement about Python and sed rather than about
 * writing source. `node -e "fs.writeFileSync(…)"` walked straight through it, and
 * so did `perl -pi -e`, `ruby -i`, `File.write`, `file_put_contents`, `dd of=`,
 * `git apply` and a `cp` of a scratch file over a real one.
 *
 * The subject is the ACT — a shell command putting bytes into a source file — so
 * the forms cover every interpreter and in-place editor a model might know, the
 * source-file test covers ~90 extensions plus the extensionless build files
 * (Makefile, Dockerfile, Gemfile…), and scratch destinations are exempt.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectShellAuthoring as D } from "../dist/index.js";

const q = String.fromCharCode(39);
const should = [
  [`node -e "require('fs').writeFileSync('lib/a.js', x)"`, "node writeFileSync"],
  [`node --eval "fs.appendFileSync('src/a.ts','x')"`, "node appendFileSync"],
  [`deno eval "await Deno.writeTextFile('src/a.ts', c)"; node -e "fs.writeFile('src/b.ts',c)"`, "node writeFile"],
  [`ruby -e "File.write('app/models/user.rb', c)"`, "ruby File.write"],
  [`ruby -e "File.open('app/a.rb', 'w') { |f| f.puts c }"`, "ruby File.open w"],
  [`php -r ${q}file_put_contents("src/A.php", $c);${q}`, "php file_put_contents"],
  [`perl -e ${q}open(FH, ">", "lib/a.pm"); print FH $c;${q}`, "perl 3-arg open"],
  [`perl -pi -e ${q}s/a/b/${q} lib/main.dart`, "perl -pi -e"],
  [`ruby -i -pe ${q}gsub(/a/,"b")${q} app/a.rb`, "ruby -i"],
  [`gsed -i ${q}s/a/b/${q} src/main.c`, "gsed -i"],
  [`sed --in-place ${q}s/a/b/${q} src/main.go`, "sed --in-place"],
  [`awk -i inplace ${q}{print}${q} src/a.py`, "awk -i inplace"],
  [`dd if=/tmp/new of=lib/main.dart`, "dd of="],
  [`git apply /tmp/fix.patch`, "git apply"],
  [`patch -p1 < /tmp/fix.diff`, "patch -p1"],
  [`cp /tmp/fixed.dart lib/providers/leads_provider.dart`, "cp INTO source"],
  [`mv /tmp/a.kt app/src/Main.kt`, "mv INTO source"],
  [`cat > Makefile << 'EOF'\nall:\n\techo hi\nEOF`, "extensionless Makefile"],
  [`echo x > Dockerfile`, "Dockerfile"],
  [`python3 -c "open('src/a.zig','w').write(x)"`, "a .zig file"],
  [`python3 -c "import fileinput\nfor l in fileinput.input(['lib/a.py'], inplace=True): print(l)"`, "python fileinput inplace"],
];
const shouldNot = [
  [`npm run build > build.log`, "a log redirect"],
  [`flutter test 2>&1 | tee /tmp/out.txt`, "tee to a temp file"],
  [`cp lib/a.dart /tmp/backup.dart`, "backing a source file UP"],
  [`node -e "console.log(require('fs').readFileSync('lib/a.js','utf8'))"`, "node READING"],
  [`ruby -e "puts File.read('app/a.rb')"`, "ruby READING"],
  [`grep -rn foo lib/`, "grep"],
  [`sed -n ${q}1,20p${q} lib/a.dart`, "sed printing, not -i"],
  [`git diff lib/a.dart`, "git diff"],
  [`mv /tmp/a /tmp/b`, "tmp to tmp"],
  [`ls -la lib/`, "ls"],
  [`cd /app && flutter test`, "running the suite"],
];
test("writing source through the shell is caught in any language", () => {
  for (const [command, label] of should) {
    assert.ok(D(command), `${label} must be detected: ${command.split("\n")[0]}`);
  }
});

test("and everything that is not writing source is left alone", () => {
  for (const [command, label] of shouldNot) {
    assert.equal(D(command), null, `${label} must be allowed: ${command.split("\n")[0]}`);
  }
});

test("a project-internal move is not authorship; a scratch source is", () => {
  // The bytes of `src/a.ts` were authored when it was written, so renaming or
  // duplicating them is not a second act of authorship — and the documented
  // `authorOnlyWrites` contract says move/copy/delete are unaffected.
  assert.equal(D("mv src/a.ts src/b.ts"), null);
  assert.equal(D("cp a.ts b.ts"), null);
  assert.equal(D("mkdir -p lib/x && cp a.ts b.ts && rm -f old.ts"), null);
  // But bytes arriving from scratch space are bytes the authoring model never
  // saw: write /tmp/fixed.dart (fine, it is scratch), copy it over the real file
  // one command later, and that is a heredoc with an extra step.
  for (const command of [
    "cp /tmp/fixed.dart lib/providers/leads.dart",
    "mv /tmp/a.kt app/src/Main.kt",
    "cp /var/folders/xy/T/new.ts src/a.ts",
  ]) {
    const hit = D(command);
    assert.ok(hit, command);
    assert.equal(hit.form, "copy from scratch into source");
  }
});
