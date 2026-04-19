# Testing Rotunda

Rotunda uses Node's built-in test runner with [tsx](https://github.com/privatenumber/tsx) for TypeScript execution.

## Running Tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration
```

## Test Structure

```
test/
├── unit/                   # Fast, isolated tests
│   ├── engine.test.ts      # Three-way diff algorithm
│   ├── git.test.ts         # Git utilities (pull, status, commit, diff)
│   ├── glob.test.ts        # Include/exclude pattern matching
│   ├── hash.test.ts        # SHA-256 hashing
│   ├── lock.test.ts        # File-based locking
│   ├── manifest.test.ts    # Manifest loading and validation
│   ├── prompts.test.ts     # LLM prompt construction
│   ├── rootname.test.ts    # Root name resolution
│   ├── auth.test.ts        # Authentication module
│   └── state.test.ts       # State management
├── integration/            # Tests that touch the filesystem and run CLI
│   ├── push-pull.test.ts   # Push/pull/conflict engine integration
│   ├── scenarios.test.ts   # End-to-end scenario data
│   └── auto-pull.test.ts   # Auto git-pull, commit+push, CLI integration
└── scenarios/              # End-to-end scenario data
```

Unit tests should be fast and not touch the filesystem. Integration tests create temporary directories and test real file operations. The auto-pull integration tests run the CLI as a subprocess against real git repos.

## Writing Tests

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("myFunction", () => {
  it("should do the expected thing", () => {
    const result = myFunction("input");
    assert.equal(result, "expected");
  });
});
```

## Tenets

These tenets are non-negotiable. They exist because every one of them was learned from a regression that wasted real time.

### Tenet 1: tests must never touch the rotunda repo

**Tests must not create, modify, or delete any files inside the rotunda repository itself**, even temporarily and even if it would "in theory" be safe. Always work in a directory under `os.tmpdir()`.

Why: a test that pollutes the working tree can corrupt git state, defeat `.gitignore`, race with other tests, or — if the CLI is spawned with `cwd` inside the repo — accidentally rebind the developer's real `~/.rotunda.json`. Using `os.tmpdir()` makes tests hermetic regardless of where they run from.

Concretely:

```typescript
import { tmpdir } from "node:os";
import { join } from "node:path";

// ✓ Correct
const TMP = join(tmpdir(), "rotunda-myfeature-test");

// ✗ Wrong — writes inside the repo
const TMP = join(import.meta.dirname, "__myfeature_tmp__");
```

When a test must spawn the rotunda CLI as a subprocess, also point `HOME`/`USERPROFILE` at an isolated temp directory so the test's `~/.rotunda.json` binding can't clobber the developer's real binding. See `test/integration/auto-pull.test.ts` for the pattern.

### Tenet 2: tests must never pass locally and fail in CI

If a test passes on your machine but fails in CI, the test is not detecting a CI bug — the test is broken. CI is the authoritative environment; your machine is the lying one. The usual culprit is *implicit dependence on developer state* (a real `~/.rotunda.json`, a configured `git user.name`, an env var, an installed global tool, a network resource), which the test reads without declaring.

To make local runs match CI, `test/run.mjs` stubs `HOME`/`USERPROFILE` to a throwaway directory before spawning tests, so any test that secretly reads `~/.rotunda.json` (or any other dotfile) fails locally the same way it would in CI. **Do not work around this** — fix the test to be hermetic instead.

If you genuinely need to inspect behavior against your real home for ad-hoc debugging:

```bash
ROTUNDA_TEST_REAL_HOME=1 npm test
```

Required properties of every test:

- **No reads** of `process.env.HOME`, `os.homedir()`, `~/...`, `git config --global`, network endpoints, or any path outside the test's own temp dir, unless the test sets that state itself first.
- **No writes** anywhere except a directory the test created under `os.tmpdir()` (see Tenet 1).
- **Identical exit code** whether run by the developer, by `npm test`, by `npm run test:unit`/`:integration`, or by the CI workflow.
