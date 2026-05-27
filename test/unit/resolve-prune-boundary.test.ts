import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, sep, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolvePruneBoundary } from "../../src/sync/apply.js";

// resolvePruneBoundary is pure path math — no fs setup needed. Building
// inputs from absolute paths under tmpdir() keeps the tests platform-safe
// without depending on a real root layout on disk.

const ROOT = resolve(join(tmpdir(), "rotunda-boundary-test", "root"));

describe("resolvePruneBoundary", () => {
  it("returns null when the setting is undefined", () => {
    const file = join(ROOT, "a", "x.txt");
    assert.equal(resolvePruneBoundary(file, ROOT, undefined), null);
  });

  it("returns null when the setting is false", () => {
    const file = join(ROOT, "a", "x.txt");
    assert.equal(resolvePruneBoundary(file, ROOT, false), null);
  });

  it("returns null when the setting is an empty array", () => {
    const file = join(ROOT, "a", "x.txt");
    assert.equal(resolvePruneBoundary(file, ROOT, []), null);
  });

  it("returns the root itself when the setting is true", () => {
    const file = join(ROOT, "a", "b", "x.txt");
    assert.equal(resolvePruneBoundary(file, ROOT, true), ROOT);
  });

  it("returns the matching sub-path boundary when the file lives under it", () => {
    const file = join(ROOT, "skills", "commit", "x.txt");
    const expected = join(ROOT, "skills");
    assert.equal(resolvePruneBoundary(file, ROOT, ["skills"]), expected);
  });

  it("returns null when no sub-path covers the file", () => {
    const file = join(ROOT, "other", "x.txt");
    assert.equal(resolvePruneBoundary(file, ROOT, ["skills", "cache"]), null);
  });

  it("picks the longest matching sub-path when several are nested", () => {
    const file = join(ROOT, "skills", "commit", "v2", "x.txt");
    const expected = join(ROOT, "skills", "commit");
    assert.equal(
      resolvePruneBoundary(file, ROOT, ["skills", "skills/commit"]),
      expected,
    );
  });

  it("does not treat the file itself as a boundary even if names happen to match", () => {
    // If the user (oddly) configured the boundary as the exact file path,
    // there's nothing to walk above the file's own dirname back up to it.
    const file = join(ROOT, "skills", "commit");
    assert.equal(resolvePruneBoundary(file, ROOT, ["skills/commit"]), null);
  });

  it("does not match a sub-path outside the root", () => {
    // A boundary entry that resolves outside the root must never be picked,
    // even if a `../` segment would make it textually look like a prefix.
    const file = join(ROOT, "a", "x.txt");
    assert.equal(resolvePruneBoundary(file, ROOT, ["../escape"]), null);
  });

  it("normalizes forward slashes in sub-path entries", () => {
    const file = join(ROOT, "skills", "commit", "x.txt");
    const expected = join(ROOT, "skills", "commit");
    assert.equal(
      resolvePruneBoundary(file, ROOT, ["skills/commit"]),
      expected,
    );
  });

  it("handles a boundary that requires walking through a separator boundary correctly", () => {
    // Regression: ensure `skills` doesn't accidentally match `skills-extras`.
    const file = join(ROOT, "skills-extras", "x.txt");
    assert.equal(
      resolvePruneBoundary(file, ROOT, ["skills"]),
      null,
      `should NOT match skills-extras against the "skills" boundary (sep=${sep})`,
    );
  });
});
