import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { loadManifest, ManifestSchema, RotundaError } from "../../src/core/manifest.js";

const TMP_DIR = join(tmpdir(), "rotunda-manifest-test");

function writeManifest(dir: string, obj: unknown): void {
  writeFileSync(join(dir, "rotunda.json"), JSON.stringify(obj));
}

describe("loadManifest", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // 1. Valid manifest parses correctly
  it("parses a valid manifest", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [
        {
          name: "dotfiles",
          local: "/home/user/dotfiles",
          repo: "dotfiles",
          include: ["*"],
          exclude: [".git"],
        },
      ],
      globalExclude: ["*.tmp"],
    });

    const m = loadManifest(TMP_DIR);
    assert.equal(m.version, 1);
    assert.equal(m.roots.length, 1);
    assert.equal(m.roots[0].name, "dotfiles");
    assert.deepStrictEqual(m.globalExclude, ["*.tmp"]);
  });

  // 2. ~ paths are resolved to homedir
  it("resolves ~ to os.homedir()", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [
        {
          name: "home",
          local: "~/dotfiles",
          repo: "dots",
          include: ["*"],
          exclude: [],
        },
      ],
    });

    const m = loadManifest(TMP_DIR);
    const expected = join(homedir(), "dotfiles");
    assert.equal(m.roots[0].local, expected);
  });

  // 3. Missing required fields throw
  it("throws on missing required fields", () => {
    writeManifest(TMP_DIR, { version: 1 });
    assert.throws(() => loadManifest(TMP_DIR), (err: unknown) => {
      assert.ok(err instanceof RotundaError);
      assert.match(err.message, /roots/);
      return true;
    });
  });

  it("throws on missing root fields", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [{ name: "bad" }],
    });
    assert.throws(() => loadManifest(TMP_DIR), (err: unknown) => {
      assert.ok(err instanceof RotundaError);
      return true;
    });
  });

  // 4. Invalid version throws
  it("throws on invalid version", () => {
    writeManifest(TMP_DIR, {
      version: 2,
      roots: [],
    });
    assert.throws(() => loadManifest(TMP_DIR), (err: unknown) => {
      assert.ok(err instanceof RotundaError);
      assert.match(err.message, /version/);
      return true;
    });
  });

  // 5. Empty roots array is valid
  it("accepts empty roots array", () => {
    writeManifest(TMP_DIR, { version: 1, roots: [] });
    const m = loadManifest(TMP_DIR);
    assert.deepStrictEqual(m.roots, []);
  });

  // 6. globalExclude defaults to [] when omitted
  it("defaults globalExclude to []", () => {
    writeManifest(TMP_DIR, { version: 1, roots: [] });
    const m = loadManifest(TMP_DIR);
    assert.deepStrictEqual(m.globalExclude, []);
  });

  // 7. Path separators are normalized
  it("normalizes path separators", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [
        {
          name: "mixed",
          local: "~/a/b\\c",
          repo: "x\\y/z",
          include: ["*"],
          exclude: [],
        },
      ],
    });

    const m = loadManifest(TMP_DIR);
    assert.ok(
      !m.roots[0].local.includes(sep === "\\" ? "/" : "\\"),
      `local path should use OS separator (${sep}): ${m.roots[0].local}`,
    );
    assert.ok(
      !m.roots[0].repo.includes(sep === "\\" ? "/" : "\\"),
      `repo path should use OS separator (${sep}): ${m.roots[0].repo}`,
    );
  });

  it("throws RotundaError when file is missing", () => {
    assert.throws(
      () => loadManifest(join(TMP_DIR, "nonexistent")),
      (err: unknown) => {
        assert.ok(err instanceof RotundaError);
        assert.match(err.message, /Could not read/);
        return true;
      },
    );
  });

  it("throws RotundaError on invalid JSON", () => {
    writeFileSync(join(TMP_DIR, "rotunda.json"), "not json{{{");
    assert.throws(() => loadManifest(TMP_DIR), (err: unknown) => {
      assert.ok(err instanceof RotundaError);
      assert.match(err.message, /Invalid JSON/);
      return true;
    });
  });
});

describe("ManifestSchema", () => {
  it("is exported and usable for standalone validation", () => {
    const result = ManifestSchema.safeParse({ version: 1, roots: [] });
    assert.ok(result.success);
  });
});

describe("machineOverrides", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  const BASE_ROOT = {
    name: "claude",
    local: "/home/user/.claude",
    repo: ".claude",
    include: ["skills/**", "CLAUDE.md"],
    exclude: ["cache"],
  };

  it("applies global exclude from matching machine", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
      globalExclude: ["node_modules"],
      machineOverrides: {
        "WISP": { exclude: [".npmrc", "config.json"] },
      },
    });

    const m = loadManifest(TMP_DIR, "wisp"); // case-insensitive match
    assert.ok(m.globalExclude.includes("node_modules"), "keeps original");
    assert.ok(m.globalExclude.includes(".npmrc"), "adds machine exclude");
    assert.ok(m.globalExclude.includes("config.json"), "adds machine exclude");
    assert.equal(m.appliedMachine, "WISP");
  });

  it("matches hostname case-insensitively", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
      machineOverrides: {
        "Captain": { exclude: ["secret.txt"] },
      },
    });

    const m1 = loadManifest(TMP_DIR, "CAPTAIN");
    assert.ok(m1.globalExclude.includes("secret.txt"));
    assert.equal(m1.appliedMachine, "Captain");

    const m2 = loadManifest(TMP_DIR, "captain");
    assert.ok(m2.globalExclude.includes("secret.txt"));

    const m3 = loadManifest(TMP_DIR, "CaPtAiN");
    assert.ok(m3.globalExclude.includes("secret.txt"));
  });

  it("applies per-root exclude from matching machine", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
      machineOverrides: {
        "wisp": {
          roots: {
            "claude": { exclude: ["skills/odsp-web/**"] },
          },
        },
      },
    });

    const m = loadManifest(TMP_DIR, "wisp");
    const claude = m.roots.find((r) => r.name === "claude")!;
    assert.ok(claude.exclude.includes("cache"), "keeps original exclude");
    assert.ok(claude.exclude.includes("skills/odsp-web/**"), "adds machine root exclude");
  });

  it("does not apply overrides for non-matching machine", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
      globalExclude: ["node_modules"],
      machineOverrides: {
        "wisp": { exclude: [".npmrc"] },
      },
    });

    const m = loadManifest(TMP_DIR, "captain");
    assert.ok(!m.globalExclude.includes(".npmrc"));
    assert.equal(m.appliedMachine, undefined);
  });

  it("handles manifest without machineOverrides", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
    });

    const m = loadManifest(TMP_DIR, "anything");
    assert.equal(m.appliedMachine, undefined);
    assert.deepEqual(m.globalExclude, []);
  });

  it("handles empty machineOverrides object", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
      machineOverrides: {},
    });

    const m = loadManifest(TMP_DIR, "wisp");
    assert.equal(m.appliedMachine, undefined);
  });

  it("applies both global and per-root excludes together", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [
        BASE_ROOT,
        { name: "copilot", local: "/home/user/.copilot", repo: ".copilot", include: ["**"], exclude: [] },
      ],
      globalExclude: ["node_modules"],
      machineOverrides: {
        "wisp": {
          exclude: [".npmrc"],
          roots: {
            "copilot": { exclude: ["config.json"] },
          },
        },
      },
    });

    const m = loadManifest(TMP_DIR, "wisp");
    assert.ok(m.globalExclude.includes(".npmrc"));
    const copilot = m.roots.find((r) => r.name === "copilot")!;
    assert.ok(copilot.exclude.includes("config.json"));
    // claude root should NOT have the copilot override
    const claude = m.roots.find((r) => r.name === "claude")!;
    assert.ok(!claude.exclude.includes("config.json"));
  });

  it("ignores root overrides for non-existent roots", () => {
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
      machineOverrides: {
        "wisp": {
          roots: {
            "nonexistent": { exclude: ["foo"] },
          },
        },
      },
    });

    // Should not throw
    const m = loadManifest(TMP_DIR, "wisp");
    assert.equal(m.roots.length, 1);
    assert.equal(m.appliedMachine, "wisp");
  });

  it("preserves machineOverrides in output for display", () => {
    const overrides = {
      "wisp": { exclude: [".npmrc"] },
      "captain": { exclude: ["debug.log"] },
    };
    writeManifest(TMP_DIR, {
      version: 1,
      roots: [BASE_ROOT],
      machineOverrides: overrides,
    });

    const m = loadManifest(TMP_DIR, "wisp");
    assert.ok(m.machineOverrides);
    assert.ok(m.machineOverrides!["wisp"]);
    assert.ok(m.machineOverrides!["captain"]);
  });
});
