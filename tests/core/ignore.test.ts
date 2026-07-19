import assert from "node:assert/strict";
import test from "node:test";
import { IgnoreMatcher, parseIgnoreFile } from "../../src/core/index";

test("gitignore-compatible rules honor directory scope and negation", () => {
  const matcher = new IgnoreMatcher();
  matcher.addFile(
    ["dist/*", "!dist/keep.js", "*.log", "docs/**/draft?.md"].join("\n"),
  );

  assert.equal(matcher.isIgnored("dist", true), false);
  assert.equal(matcher.isIgnored("dist/other.js", false), true);
  assert.equal(matcher.isIgnored("dist/keep.js", false), false);
  assert.equal(matcher.isIgnored("nested/debug.log", false), true);
  assert.equal(matcher.isIgnored("docs/guide/draft1.md", false), true);
  assert.equal(matcher.isIgnored("docs/draft2.md", false), true);
});

test("nested ignore files only affect descendants of their base directory", () => {
  const rules = parseIgnoreFile("cache/\n", { baseDir: "packages/api" });
  const matcher = new IgnoreMatcher(rules);

  assert.equal(matcher.isIgnored("packages/api/cache", true), true);
  assert.equal(matcher.isIgnored("packages/web/cache", true), false);
});

test("invalid character ranges are skipped instead of stopping a scan", () => {
  assert.deepEqual(parseIgnoreFile("[z-a]\nvalid.log\n").map((rule) => rule.pattern), [
    "valid.log",
  ]);
});
