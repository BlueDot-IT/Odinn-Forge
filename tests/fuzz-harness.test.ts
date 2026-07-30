import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("continuous fuzzing is bounded, replayable, retained, and credential-free", async () => {
  const [script, workflow, documentation, pkgText] = await Promise.all([
    read("scripts/ci/security-fuzz.ts"),
    read(".github/workflows/continuous-fuzz.yml"),
    read("docs/security/continuous-fuzzing.md"),
    read("package.json")
  ]);
  const pkg = JSON.parse(pkgText);

  assert.equal(pkg.scripts["fuzz:security"], "node scripts/ci/security-fuzz.ts");
  assert.equal(pkg.scripts["fuzz:replay"], "node scripts/ci/security-fuzz.ts");
  assert.match(script, /const MAX_RUNS = 100_000/u);
  assert.match(script, /const MAX_SECONDS = 300/u);
  assert.match(script, /totalRuns < selectedScenarios\.length/u);
  assert.match(script, /deadline - performance\.now\(\)/u);
  assert.match(script, /totalRuns % selectedScenarios\.length/u);
  assert.match(script, /interruptAfterTimeLimit/u);
  assert.match(script, /details\.failed \|\| details\.interrupted/u);
  assert.match(script, /counterexamplePath/u);
  assert.match(script, /replay\.json/u);
  assert.match(script, /GITHUB_SHA/u);

  assert.match(workflow, /cron: "29 6 \* \* \*"/u);
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/u);
  assert.match(workflow, /continuous-security-fuzz-\$\{\{ github\.ref \}\}-\$\{\{ matrix\.os \}\}/u);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  assert.match(workflow, /timeout-minutes: 12/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /retention-days: 30/u);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write/u);

  assert.match(documentation, /promote the minimized counterexample/u);
  assert.match(documentation, /not a substitute for unit tests/u);
  assert.match(documentation, /30 days/u);
});
