# Architecture Guide

This document explains how rotunda works internally — the data flow from manifest to engine to state, the change detection algorithm, and how each component fits together.

## High-Level Overview

```
rotunda.json          ~/.claude/           .claude/
  (manifest)      ←→  (local dirs)    ←→  (repo dirs)
      │                    │                   │
      ▼                    ▼                   ▼
  ┌─────────┐        ┌──────────┐        ┌──────────┐
  │ Manifest │        │ Discover │        │ Discover │
  │ Loader   │        │ & Hash   │        │ & Hash   │
  └────┬─────┘        └────┬─────┘        └────┬─────┘
       │                   │                   │
       ▼                   ▼                   ▼
  ┌────────────────────────────────────────────────┐
  │              Three-Way Diff Engine             │
  │     localHashes × repoHashes × stateHashes     │
  └───────────────────────┬────────────────────────┘
                          │
                     FileChange[]
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
          ┌──────┐   ┌──────┐   ┌──────┐
          │ Push │   │ Pull │   │ Sync │
          └──┬───┘   └──┬───┘   └──┬───┘
             │          │          │
             ▼          ▼          ▼
        ┌────────────────────────────┐
        │     State Manager          │
        │  .rotunda/state.json       │
        └────────────────────────────┘
```

**Data flow summary:**

1. **Manifest** defines what to sync (roots, includes, excludes).
2. **Engine** discovers files, hashes them, and computes a three-way diff.
3. **Commands** (push, pull, sync) act on the computed changes.
4. **State** records what was synced so the next diff is accurate.

## Three-Way Change Detection

Rotunda uses a three-way diff algorithm. For each file, it compares three sources:

- **Local**: the current file on the local machine (e.g., `~/.claude/CLAUDE.md`)
- **Repo**: the current file in the repository (e.g., `<repo>/.claude/CLAUDE.md`)
- **State**: the SHA-256 hash recorded at the last sync (`.rotunda/state.json`)

By comparing current hashes against the state, rotunda determines what changed on each side independently.

### Change Detection Matrix

| State | Local | Repo | Action     | Side   | Meaning                                          |
|-------|-------|------|------------|--------|--------------------------------------------------|
| —     | ✓     | —    | `added`    | local  | File was created locally                         |
| —     | —     | ✓    | `added`    | repo   | File was added to the repo                       |
| —     | ✓     | ✓    | `conflict` | both   | Added on both sides with different content       |
| ✓     | ✓\*   | ✓    | `modified` | local  | File was modified locally (repo matches state)   |
| ✓     | ✓     | ✓\*  | `modified` | repo   | File was modified in repo (local matches state)  |
| ✓     | ✓\*   | ✓\*  | `conflict` | both   | Modified on both sides with different content    |
| ✓     | —     | ✓    | `deleted`  | local  | File was deleted locally                         |
| ✓     | ✓     | —    | `deleted`  | repo   | File was deleted from the repo                   |
| ✓     | —     | —    | *(skip)*   | —      | Deleted on both sides — clean, no action needed  |
| ✓     | ✓     | ✓    | *(skip)*   | —      | Unchanged on both sides — nothing to do          |

**✓\*** = content differs from the state hash.

**Special cases:**

- If both sides added or modified a file to the **same content** (hashes match), the change is silently skipped — both sides already agree.
- If a file is deleted on one side and modified on the other, it's treated as a conflict.

### Hash Computation

All hashing uses SHA-256 via Node's built-in `crypto` module. Files are hashed in parallel with a concurrency limit of 50 to balance speed and memory usage.

```typescript
// From src/utils/hash.ts
const content = await readFile(filePath);
return createHash("sha256").update(content).digest("hex");
```

## State Management

### Per-Machine State

State is stored at `.rotunda/state.json` inside the repository. The `.rotunda/` directory is gitignored, so **each machine maintains its own independent state**. This is critical — the state records what files looked like on *this* machine at the last sync, not what the "canonical" version is.

### State Structure

```json
{
  "lastSync": "2025-01-15T10:30:00.000Z",
  "files": {
    ".claude/CLAUDE.md": {
      "hash": "a1b2c3d4...",
      "size": 0,
      "syncedAt": "2025-01-15T10:30:00.000Z"
    },
    ".copilot/config.json": {
      "hash": "e5f6a7b8...",
      "size": 0,
      "syncedAt": "2025-01-15T10:28:00.000Z"
    }
  }
}
```

**Key fields:**

| Field               | Description                                         |
|---------------------|-----------------------------------------------------|
| `lastSync`          | ISO 8601 timestamp of the most recent sync          |
| `files`             | Map of `"rootRepo/relativePath"` → file state       |
| `files[].hash`      | SHA-256 hash of the file at the time it was synced   |
| `files[].size`      | Reserved for future use (currently `0`)              |
| `files[].syncedAt`  | ISO 8601 timestamp of when this file was last synced |

State keys are constructed as `rootRepo + "/" + relativePath` (e.g., `.claude/skills/commit/SKILL.md`).

### Atomic Writes

State is written atomically to prevent corruption if the process is interrupted:

1. Write the new state to `state.json.tmp`.
2. Rename `state.json.tmp` → `state.json` (atomic on most filesystems).
3. On Windows, if rename fails (target exists), fall back to a direct write.

This ensures you never end up with a half-written state file.

## Sync Flows

### Push Flow (local → repo)

```
1. Load manifest + state
2. Auto-pull from git remote (git pull --ff-only)
3. Compute changes (three-way diff)
4. Filter to local-side changes (added/modified/deleted locally)
5. Skip conflicts (warn user)
6. Show preview → confirm (or -y to skip)
7. For each change:
   - added/modified: copy local file → repo directory
   - deleted: remove file from repo directory
8. Update state with new hashes
9. If any repo files changed, git commit and push to remote
   (state lives in the gitignored `.rotunda/`, so it is never committed)
```

### Pull Flow (repo → local)

```
1. Load manifest + state
2. Auto-pull from git remote (git pull --ff-only)
3. Compute changes (three-way diff)
4. Filter to repo-side changes (added/modified/deleted in repo)
5. Skip conflicts (warn user)
6. Show preview → confirm (or -y to skip)
7. For each change:
   - added/modified: copy repo file → local directory
   - deleted: remove local file + clean empty parent dirs
8. Update state with new hashes
9. No git commit (pull only writes to local files and per-machine state)
```

### Sync Flow (bidirectional)

```
1. Load manifest + state
2. Auto-pull from git remote (git pull --ff-only)
3. Compute changes (three-way diff)
4. Partition changes:
   - Local-only → push to repo (automatic)
   - Repo-only → pull to local (automatic)
   - Conflicts → interactive resolution (keep local, keep repo, or skip)
5. Apply all decisions
6. Update state
7. If any repo files changed, git commit and push to remote
   (purely pull-direction syncs make no commit)
```

## LLM Integration

Rotunda uses GitHub Copilot as an LLM backend for intelligent review during sync operations. See the [Authentication Guide](auth.md) for setup.

### Prompt Construction

Three prompt types are defined in `src/llm/prompts.ts`:

| Prompt Type     | Purpose                                                           |
|-----------------|-------------------------------------------------------------------|
| **Explain**     | Summarize what changed in a file — used during interactive review |
| **Reshape**     | Apply a user instruction to modify file content before syncing    |
| **Conflict**    | Analyze whether both-side changes overlap and suggest a merge     |

Each prompt is a `{ system, user }` pair:

- **System message**: sets the LLM's role (code reviewer, editor, or merge assistant).
- **User message**: includes the file path, change type, diffs, and/or file contents.

### Review Loop

During interactive push/pull (without `-y`), each file change goes through a review loop:

```
For each change:
  1. Build explain prompt with diff and file contents
  2. Send to Copilot API
  3. Display LLM explanation to user
  4. User decides: approve / reject / reshape / skip
  5. If reshape:
     a. User provides instruction (e.g., "remove the debug lines")
     b. Build reshape prompt with instruction + file contents
     c. LLM produces modified file content
     d. Apply reshaped content instead of original
```

### Conflict Resolution

When `rotunda sync` encounters a conflict (file changed on both sides):

```
1. Build conflict prompt with:
   - Diff of repo changes since last sync
   - Diff of local changes since last sync
2. LLM analyzes whether changes overlap
3. If non-overlapping: LLM suggests merged content
4. If overlapping: LLM explains the conflict, shows both versions
5. User chooses: accept local / accept repo / accept merge / skip
```

## File Discovery

### Directory Walking

The engine recursively walks each root's local and repo directories to discover files. The walk uses `readdir` with `withFileTypes` for efficiency.

```
For each root:
  1. Walk the local directory recursively
  2. Walk the repo directory recursively
  3. For each file encountered:
     a. Compute relative path (forward slashes)
     b. Check against include/exclude patterns
     c. If included, add to file map
```

### Include/Exclude Logic

```
shouldInclude(relativePath, include, exclude, globalExclude):
  1. Check excludes first (exclude always wins):
     - Merge root excludes + globalExclude
     - For simple patterns (no / or *): match against any path segment
       e.g., "node_modules" matches "foo/node_modules/bar.js"
     - For complex patterns: match against the full relative path
  2. If excluded → return false
  3. If include is empty → return true (include everything)
  4. Must match at least one include pattern → return true/false
```

This design means:
- Exclude patterns are simple and defensive — `node_modules` just works at any depth.
- Include patterns are selective — `skills/**` only matches files under `skills/`.
- Global excludes cannot be overridden by root includes.

### Directory Exclusion

Directories are also checked against exclude patterns during the walk. If a directory name matches an exclude pattern, the entire subtree is skipped. This prevents unnecessary traversal of large excluded directories like `node_modules`.

## Git Integration

Rotunda uses git as a transport mechanism — your dotfiles repo is a regular git repository.

### How Git Is Used

| Operation          | Git commands used                                    |
|--------------------|------------------------------------------------------|
| Auto-pull          | `git pull --ff-only`                                 |
| Health checks      | `git rev-parse --is-inside-work-tree`, `git status`  |
| Commit and push    | `git add <paths>`, `git commit -m <message>`, `git push` |
| Diff display       | `git diff --no-index -- <file1> <file2>`             |

**Key design decisions:**

- **Automatic git pull**: All sync commands (`push`, `pull`, `sync`) automatically run `git pull --ff-only` before computing changes, ensuring you're working against the latest remote state. If the pull fails (e.g., no remote configured, diverged history), the command warns and continues.
- **Automatic git push**: After applying changes, rotunda commits and pushes any repo-side file changes to the remote automatically. No manual `git push` needed. Pure pull operations don't commit because per-machine state lives in the gitignored `.rotunda/` directory.
- **`git diff --no-index`**: Used for diffing because the local files are outside the repo. The `--no-index` flag compares arbitrary files without requiring them to be in a git repository.
- **Exit code handling**: `git diff --no-index` exits with code 1 when files differ (not an error). Rotunda handles this in the git utility layer.

## Project Structure

```
src/
├── cli.ts              # Entry point — Commander.js program definition
├── commands/
│   ├── init.ts         # rotunda init — manifest creation + initial state
│   ├── status.ts       # rotunda status — three-way diff display
│   ├── diff.ts         # rotunda diff — file-level diff output
│   ├── push.ts         # rotunda push — local → repo sync
│   ├── pull.ts         # rotunda pull — repo → local sync
│   ├── sync.ts         # rotunda sync — bidirectional sync
│   ├── doctor.ts       # rotunda doctor — 10 health checks
│   ├── list.ts         # rotunda list — file inventory display
│   ├── auth.ts         # rotunda auth — GitHub device flow
│   └── update.ts       # rotunda update — self-update from source
├── core/
│   ├── types.ts        # TypeScript interfaces (Manifest, FileChange, SyncState, etc.)
│   ├── manifest.ts     # Manifest loader with Zod validation
│   ├── state.ts        # State read/write with atomic saves
│   └── engine.ts       # File discovery, hashing, three-way diff
├── display/            # Terminal display utilities
├── llm/
│   ├── auth.ts         # Copilot token management
│   ├── copilot.ts      # Copilot API client
│   ├── prompts.ts      # LLM prompt templates (explain, reshape, conflict)
│   └── review.ts       # LLM-assisted file review flow
└── utils/
    ├── git.ts          # Git command wrappers (pull, commit, push, diff, status)
    ├── glob.ts         # Glob pattern matching (minimatch wrapper)
    ├── hash.ts         # SHA-256 file hashing
    └── lock.ts         # File-based lock for concurrent operation prevention
```

### Module Responsibilities

| Module           | Responsibility                                                    |
|------------------|-------------------------------------------------------------------|
| `core/manifest`  | Load and validate `rotunda.json` using Zod. Resolve `~` paths.   |
| `core/state`     | Read/write `.rotunda/state.json`. Atomic writes. State updates.   |
| `core/engine`    | File discovery, hashing, and the three-way change detection algorithm. |
| `core/types`     | Shared TypeScript interfaces used across all modules.             |
| `commands/*`     | CLI command handlers. Each maps to one Commander.js command.      |
| `llm/prompts`    | Prompt construction for Copilot API calls.                        |
| `utils/git`      | Git command execution with error handling.                        |
| `utils/glob`     | Include/exclude pattern matching using minimatch.                 |
| `utils/hash`     | SHA-256 file and content hashing.                                 |

### Key Dependencies

| Package      | Purpose                            |
|--------------|-------------------------------------|
| `commander`  | CLI argument parsing and help text  |
| `chalk`      | Terminal color output               |
| `minimatch`  | Glob pattern matching               |
| `zod`        | Schema validation for the manifest  |

## Related

- [Manifest Reference](manifest.md) — manifest schema details
- [Command Reference](commands.md) — all commands and their behavior
- [Authentication Guide](auth.md) — Copilot authentication setup
