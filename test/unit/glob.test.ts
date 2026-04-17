import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldInclude, matchesAny } from "../../src/utils/glob.js";

describe("matchesAny", () => {
  it("matches simple glob pattern", () => {
    assert.ok(matchesAny("skills/commit/SKILL.md", ["skills/**"]));
  });

  it("matches exact filename", () => {
    assert.ok(matchesAny("CLAUDE.md", ["CLAUDE.md"]));
  });

  it("does not match unrelated pattern", () => {
    assert.ok(!matchesAny("config.json", ["skills/**"]));
  });

  it("normalizes backslashes", () => {
    assert.ok(matchesAny("skills\\commit\\SKILL.md", ["skills/**"]));
  });

  it("matches wildcard extension", () => {
    assert.ok(matchesAny("data.log", ["*.log"]));
  });
});

describe("shouldInclude", () => {
  it("includes file matching include pattern", () => {
    assert.ok(
      shouldInclude("skills/commit/SKILL.md", ["skills/**"], [], [])
    );
  });

  it("excludes file matching exclude pattern", () => {
    assert.ok(
      !shouldInclude(
        "skills/commit/node_modules/foo.js",
        ["skills/**"],
        ["node_modules"],
        []
      )
    );
  });

  it("exclude wins over include", () => {
    assert.ok(
      !shouldInclude("cache/data.json", ["**/*.json"], ["cache"], [])
    );
  });

  it("globalExclude applies", () => {
    assert.ok(
      !shouldInclude("deep/node_modules/pkg/index.js", ["**"], [], ["node_modules"])
    );
  });

  it("includes everything when no include patterns specified", () => {
    assert.ok(shouldInclude("anything.txt", [], [], []));
  });

  it("rejects file not matching any include pattern", () => {
    assert.ok(
      !shouldInclude("random.txt", ["skills/**", "agents/**"], [], [])
    );
  });

  it("handles dot files", () => {
    assert.ok(shouldInclude(".hidden", [], [], []));
  });

  it("excludes by directory name segment", () => {
    assert.ok(
      !shouldInclude("a/b/node_modules/c/d.js", [], ["node_modules"], [])
    );
  });

  it("handles complex glob patterns", () => {
    assert.ok(shouldInclude("hooks/pre-commit.sh", ["hooks/**"], [], []));
    assert.ok(!shouldInclude("other/file.sh", ["hooks/**"], [], []));
  });

  it("handles wildcard exclude patterns", () => {
    assert.ok(!shouldInclude("debug.log", [], ["*.log"], []));
    assert.ok(shouldInclude("debug.txt", [], ["*.log"], []));
  });
});
