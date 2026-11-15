// Guards of .github/workflows/release.yml (DESIGN §8, §9 Q1): plain line checks, no YAML parser, so weakening a
// guard (another trigger, a missing repository check, no approval environment or no check that it requires
// reviewers, a tag off master, a skipped or failure-tolerant verify step, write permissions in verify, a publish job
// that rebuilds instead of using the verified tarball, no provenance) fails a test. What the repository settings
// say (the environment's tag rule, where NPM_TOKEN lives, the npm trusted publisher's binding) cannot be checked
// from here; the workflow's header lists them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readRepoFile } from "./helpers.ts";

const TEXT = readRepoFile(".github/workflows/release.yml");
/** The lines without comments and trailing blanks; comment-only lines are dropped. */
const LINES = TEXT.split("\n")
  .map((l) => l.replace(/\s+#.*$/, "").trimEnd())
  .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));

/** The lines of a top-level block (`on:`, `jobs:`) up to the next top-level key. */
function topLevel(key: string): string[] {
  const start = LINES.indexOf(`${key}:`);
  assert.ok(start >= 0, `no top-level ${key}:`);
  const rest = LINES.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Jobs by name: their lines (two-space-indented keys under `jobs:`). */
function jobs(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of topLevel("jobs")) {
    const m = /^ {2}([\w-]+):$/.exec(line);
    if (m?.[1] !== undefined) {
      current = [];
      result.set(m[1], current);
    } else if (current !== undefined) current.push(line);
  }
  return result;
}

describe(".github/workflows/release.yml guards", () => {
  test("triggers only on pushes of v* tags", () => {
    assert.deepEqual(topLevel("on"), ["  push:", '    tags: ["v*"]']);
    // No other trigger anywhere (workflow_dispatch, pull_request, schedule, branches).
    for (const banned of [
      "workflow_dispatch",
      "pull_request",
      "schedule",
      "branches",
      "workflow_run",
      "repository_dispatch",
    ])
      assert.ok(!LINES.some((l) => l.includes(banned)), `unexpected ${banned}`);
  });

  test("every job runs only in pzmarzly/varlink-js", () => {
    const all = jobs();
    assert.deepEqual([...all.keys()], ["verify", "publish"]);
    for (const [name, lines] of all)
      assert.ok(
        lines.includes("    if: github.repository == 'pzmarzly/varlink-js'"),
        `job ${name} lacks the repository guard`,
      );
  });

  test("publish needs verify, uses the npm-release environment and id-token: write", () => {
    const publish = jobs().get("publish") ?? [];
    assert.ok(publish.includes("    needs: verify"));
    const env = publish.indexOf("    environment:");
    assert.ok(env >= 0, "no environment");
    assert.equal(publish[env + 1], "      name: npm-release");
    assert.ok(publish.includes("      id-token: write"));
    // Read-only contents at the top level too.
    assert.deepEqual(topLevel("permissions"), ["  contents: read"]);
  });

  test("publishes the verified tarball with --provenance; nothing else publishes", () => {
    const publishLines = LINES.filter((l) => /\bnpm publish\b/.test(l) && !l.includes("name:"));
    assert.equal(publishLines.length, 1, publishLines.join("\n"));
    assert.match(publishLines[0] ?? "", /npm publish "\$tarball" --provenance --access public --tag "\$dist_tag"$/);
    assert.ok(!(jobs().get("verify") ?? []).some((l) => /npm publish/.test(l)), "verify must not publish");
    // Prereleases go to `next`, never `latest`.
    assert.ok(LINES.includes("            *-*) dist_tag=next ;;"));
  });

  test("the tag must equal v + package.json version, and verify runs lint, typecheck and the tests", () => {
    const verify = jobs().get("verify") ?? [];
    assert.ok(verify.includes(`          version="$(node -p 'require("./package.json").version')"`));
    assert.ok(verify.includes('          if [ "$TAG" != "v$version" ]; then'));
    assert.ok(verify.includes("            exit 1"));
    assert.ok(verify.includes("          TAG: ${{ github.ref_name }}"));
    for (const step of ["npm ci", "npm run lint", "npm run typecheck", "npm test"])
      assert.ok(verify.includes(`      - run: ${step}`), `verify lacks ${step}`);
  });

  test("verify fails unless the npm-release environment exists with a required_reviewers rule", () => {
    const verify = jobs().get("verify") ?? [];
    const start = verify.indexOf("      - name: The npm-release environment exists and requires reviewers");
    assert.ok(start >= 0, "no environment check step");
    // It is the first step, so nothing else runs (or is uploaded) without it.
    assert.equal(verify.indexOf("    steps:"), start - 1, "the environment check must be the first step");
    const step = verify.slice(
      start,
      verify.findIndex((l, i) => i > start && l.startsWith("      - ")),
    );
    assert.ok(step.includes("          GH_TOKEN: ${{ github.token }}"));
    assert.ok(
      step.includes('          if ! env_json="$(gh api "repos/$GITHUB_REPOSITORY/environments/npm-release")"; then'),
      "the environment is fetched with gh api",
    );
    assert.ok(
      step.includes(
        `          if ! printf '%s' "$env_json" | jq -e 'any(.protection_rules[]?; .type == "required_reviewers")' > /dev/null; then`,
      ),
      "the jq check requires a required_reviewers rule",
    );
    assert.equal(step.filter((l) => l === "            exit 1").length, 2, "both checks exit 1");
  });

  test("verify checks out the full history and fails unless the tagged commit is on master", () => {
    const verify = jobs().get("verify") ?? [];
    const checkout = verify.indexOf("      - uses: actions/checkout@v7");
    assert.ok(checkout >= 0);
    assert.deepEqual(verify.slice(checkout + 1, checkout + 3), ["        with:", "          fetch-depth: 0"]);
    const check = verify.indexOf('          if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/master; then');
    assert.ok(check > checkout, "no master ancestry check after the checkout");
    assert.match(verify[check + 1] ?? "", /^ {12}echo "::error::tagged commit \$GITHUB_SHA is not on master"$/);
    assert.equal(verify[check + 2], "            exit 1");
    assert.ok(check < verify.indexOf("      - run: npm ci"), "checked before anything is built");
  });

  test("verify has read-only permissions and no conditional or failure-tolerant steps", () => {
    const verify = jobs().get("verify") ?? [];
    const perms = verify.indexOf("    permissions:");
    assert.ok(perms >= 0, "verify must set its own (read-only) permissions");
    const block = verify.slice(
      perms + 1,
      verify.findIndex((l, i) => i > perms && /^ {4}\S/.test(l)),
    );
    assert.deepEqual(block, ["      contents: read", "      actions: read"]);
    assert.ok(!verify.some((l) => /:\s*write\b/.test(l)), "no write permission in verify");
    // The only `if:` in verify is the job-level repository guard; a step-level `if:` could skip a check.
    const ifs = verify.filter((l) => /^\s*(-\s+)?if:/.test(l));
    assert.deepEqual(ifs, ["    if: github.repository == 'pzmarzly/varlink-js'"]);
  });

  test("nothing may continue on error, and publish neither checks out nor rebuilds", () => {
    assert.ok(!LINES.some((l) => l.includes("continue-on-error")), "continue-on-error is not allowed");
    const publish = jobs().get("publish") ?? [];
    assert.ok(!publish.some((l) => l.includes("actions/checkout")), "publish must use the verified artifact only");
    assert.ok(!publish.some((l) => /\bnpm (ci|install|run|pack|test)\b/.test(l)), "publish must not rebuild");
    assert.ok(publish.includes("      - uses: actions/download-artifact@v8"));
  });
});
