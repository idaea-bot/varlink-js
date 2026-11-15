// Guards of .github/workflows/release.yml (DESIGN §8, §9 Q1): plain line checks, no YAML parser, so weakening a
// guard (another trigger, a missing repository check, no approval environment, no provenance) fails a test.
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
});
