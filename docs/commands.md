# Command Reference

Rotunda provides nine commands for initializing, inspecting, syncing, and maintaining your configuration files. All commands are run from the root of your dotfiles repository (the directory containing `rotunda.json`).

```
rotunda <command> [options]
```

## Commands at a Glance

| Command            | Purpose                                              |
|--------------------|------------------------------------------------------|
| `rotunda init`     | Initialize manifest and state in the current repo    |
| `rotunda status`   | Show what changed since the last sync                |
| `rotunda diff`     | Show file-level diffs for modified files             |
| `rotunda push`     | Push local changes to the repo                       |
| `rotunda pull`     | Pull repo changes to local                           |
| `rotunda sync`     | Bidirectional sync with conflict resolution          |
| `rotunda doctor`   | Structural health check (with `--fix` for LLM repair)|
| `rotunda list`     | Show manifest roots and captured files               |
| `rotunda auth`     | Authenticate with GitHub Copilot                     |

---

## `rotunda init`

Initialize rotunda in the current repository.

**Synopsis:**

```
rotunda init
```

**What it does:**

1. **Creates `rotunda.json`** — if it doesn't already exist, writes the default manifest with preconfigured roots for Claude Code (`~/.claude`) and Copilot CLI (`~/.copilot`). See the [Manifest Reference](manifest.md) for the full default configuration.

2. **Creates `.rotunda/` directory** — the state directory that tracks per-machine sync state. This directory is automatically added to `.gitignore`.

3. **Updates `.gitignore`** — appends `.rotunda/` to your `.gitignore` if not already present. Creates the file if needed.

4. **Builds initial state** — scans all files in both local directories and repo directories for every root, computes SHA-256 hashes, and writes the baseline state to `.rotunda/state.json`. This prevents a first `status` from showing everything as changed.

**Output example:**

```
✓ Created rotunda.json
✓ Created .rotunda/ directory
✓ Added .rotunda/ to .gitignore

Scanning existing files...
✓ Initial state created (47 files tracked)

✓ Rotunda initialized.
  Run `rotunda status` to see current state.
```

**Notes:**

- Safe to re-run. If `rotunda.json` already exists, it is not overwritten.
- If scanning fails (e.g., local directories don't exist yet), init still completes and prints a warning.

---

## `rotunda status`

Show what has changed since the last sync.

**Synopsis:**

```
rotunda status
```

**What it does:**

Computes a three-way diff between local files, repo files, and the saved state from the last sync. Groups results by sync root and shows a summary.

**Output format:**

```
  12 change(s) detected:

  [claude]
    added     skills/new-skill/SKILL.md  (local)
    modified  CLAUDE.md                  (repo)
    deleted   hooks/old-hook.ts          (local)

  [copilot]
    modified  agents/custom/agent.md     (both sides)
    CONFLICT  config.json                (both sides)

  Summary: 1 added, 3 modified, 1 deleted, 1 conflict(s)
```

**Status meanings:**

| Status       | Color   | Meaning                                                    |
|--------------|---------|-------------------------------------------------------------|
| `added`      | Green   | File exists on one side but not in the last sync state      |
| `modified`   | Yellow  | File content has changed on one side since last sync        |
| `deleted`    | Red     | File was removed on one side since last sync                |
| `CONFLICT`   | Magenta | File changed on **both** sides with different content       |

**Side indicators:**

| Side         | Meaning                                                          |
|--------------|------------------------------------------------------------------|
| `(local)`    | Change originated from the local machine                         |
| `(repo)`     | Change originated from the repository                            |
| `(both sides)` | Change detected on both sides (may or may not be a conflict)  |

When everything is in sync:

```
✓ Everything in sync. No changes detected.
```

---

## `rotunda diff`

Show file-level diffs for modified files.

**Synopsis:**

```
rotunda diff [root] [options]
```

**Arguments:**

| Argument | Required | Description                                    |
|----------|----------|------------------------------------------------|
| `root`   | No       | Filter diffs to a specific sync root by name   |

**Options:**

| Flag          | Description                                                        |
|---------------|--------------------------------------------------------------------|
| `--stat`      | Summary only — show counts of added, modified, deleted, conflicts  |
| `--name-only` | List only the changed file paths, one per line                     |
| `--open`      | Open each changed file in the VS Code diff viewer                  |
| `--html`      | Generate an interactive HTML diff report and open in browser       |

**Default output:**

With no flags, rotunda uses `git diff --no-index` to produce a unified diff between the repo and local copies of each file. Output is grouped by root:

```
── claude ─────────────────────────────────────────────────────
diff --git a/.claude/CLAUDE.md b/CLAUDE.md
--- a/.claude/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,5 +1,6 @@
 # Claude Configuration
+## New Section
 ...

  + skills/new-skill/SKILL.md (added locally)
  - hooks/old-hook.ts (deleted locally)

── copilot ────────────────────────────────────────────────────
diff --git a/.copilot/config.json b/config.json
...
```

**`--stat` output:**

```
12 files changed: 3 added, 6 modified, 2 deleted, 1 conflicts
```

**`--name-only` output:**

```
claude/skills/new-skill/SKILL.md
claude/CLAUDE.md
copilot/config.json
```

**`--open` behavior:**

For modified and conflicting files, opens VS Code with the diff view (`code --diff <repo-file> <local-file>`). For added files, opens the new file directly.

**Filtering by root:**

```
rotunda diff claude          # Only show diffs for the claude root
rotunda diff copilot --stat  # Summary for copilot root only
```

---

## `rotunda push`

Push local changes to the repository.

**Synopsis:**

```
rotunda push [-y | --yes]
```

**Options:**

| Flag         | Description                                     |
|--------------|-------------------------------------------------|
| `-y, --yes`  | Push all changes without interactive confirmation |

**What it does:**

1. Computes changes where the local side has modified, added, or deleted files.
2. Shows a preview of all changes that will be pushed.
3. Lists any conflicts separately (conflicts are **skipped** — use `rotunda sync` to resolve them).
4. Prompts for confirmation (unless `-y` is passed).
5. Copies local files → repo for additions and modifications.
6. Deletes files from repo for local deletions.
7. Updates the sync state.
8. Creates a git commit with the staged changes.

**Output example:**

```
  Changes to push (local → repo):

    added     claude/skills/new-skill/SKILL.md
    modified  claude/CLAUDE.md
    deleted   claude/hooks/old-hook.ts

  ⚠ 1 conflict(s) skipped (use rotunda sync to resolve):
    CONFLICT  copilot/config.json

  Push 3 file(s)? [y/N] y
  ✓ claude/skills/new-skill/SKILL.md
  ✓ claude/CLAUDE.md
  ✗ claude/hooks/old-hook.ts (removed from repo)

  ✓ Committed: "rotunda push — 3 file(s)"
  ✓ Push complete.
```

**Conflict behavior:**

Files that changed on both sides are not pushed. Rotunda warns you and directs you to `rotunda sync` for conflict resolution. This prevents accidentally overwriting changes made on another machine.

**Git integration:**

After copying files, rotunda stages the changed paths and `.rotunda/` state directory, then creates a commit with the message `rotunda push — N file(s)`. The commit is local — rotunda does not `git push` to the remote by default.

---

## `rotunda pull`

Pull repository changes to the local machine.

**Synopsis:**

```
rotunda pull [-y | --yes]
```

**Options:**

| Flag         | Description                                      |
|--------------|--------------------------------------------------|
| `-y, --yes`  | Pull all changes without interactive confirmation |

**What it does:**

1. Computes changes where the repo side has modified, added, or deleted files.
2. Shows a preview of all changes that will be pulled.
3. Lists any conflicts separately (conflicts are **skipped**).
4. Prompts for confirmation (unless `-y` is passed).
5. Copies repo files → local for additions and modifications.
6. Deletes files from local for repo deletions (**orphan cleanup**).
7. Updates the sync state.

**Output example:**

```
  Changes to pull (repo → local):

    added     copilot/extensions/new-ext/manifest.json
    modified  claude/settings.json
    deleted   claude/agents/retired/agent.md

  Pull 3 file(s)? [y/N] y
  ✓ copilot/extensions/new-ext/manifest.json
  ✓ claude/settings.json
  ✗ claude/agents/retired/agent.md (removed from local)

  ✓ Pull complete. 3 file(s) applied.
```

**Orphan cleanup:**

When a file has been deleted from the repo (e.g., removed on another machine and pushed), `rotunda pull` removes the corresponding local file. After removing a file, rotunda checks if the parent directory is now empty and cleans it up too. This prevents stale files from accumulating on your machines.

**Conflict behavior:**

Same as `push` — conflicts are skipped and must be resolved with `rotunda sync`.

---

## `rotunda sync`

Bidirectional sync with conflict resolution.

**Synopsis:**

```
rotunda sync [-y | --yes]
```

**Options:**

| Flag         | Description                                                  |
|--------------|--------------------------------------------------------------|
| `-y, --yes`  | Sync all non-conflicting changes without review              |

**What it does:**

Combines push and pull into a single operation:

1. Computes all changes across all roots.
2. Applies non-conflicting changes automatically:
   - Local-only changes → pushed to repo
   - Repo-only changes → pulled to local
3. For **conflicts** (files changed on both sides), invokes the LLM review flow:
   - Shows diffs from both sides
   - Asks the LLM to analyze whether the changes overlap
   - Presents options: accept local, accept repo, merge, or skip

**When to use:**

- After working on multiple machines and wanting to reconcile all changes in one step.
- When `rotunda status` shows conflicts that `push` and `pull` skip.

> **Note:** `rotunda sync` is currently a placeholder and not yet fully implemented. Use `rotunda push` and `rotunda pull` for non-conflicting changes.

---

## `rotunda doctor`

Run a structural health check on your rotunda setup.

**Synopsis:**

```
rotunda doctor [--fix]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--fix` | Use LLM to analyze issues and suggest/apply fixes (requires auth) |

**What it does:**

Runs 10 independent checks and reports the result of each. Checks are run in parallel where possible for speed. When machine overrides are active, the manifest check shows which machine was matched.

**Output format:**

```
  Manifest .............. ✅ rotunda.json valid (2 roots, 5 global excludes, applied overrides for: CAPTAIN)
  State ................. ✅ state.json valid (47 tracked files)
  Repo structure ........ ✅ all 2 repo dirs exist
  Local structure ....... ✅ all 2 local dirs exist
  Orphan detection ...... ⚠️ 3 untracked files in local dirs
      claude: some-random-file.txt
      copilot: leftover.bak
      copilot: old-config.json
  State drift ........... ✅ all state entries have corresponding files
  Git status ............ ⚠️ 2 uncommitted changes in managed paths
      M .claude/CLAUDE.md
      ?? .copilot/new-file.json
  Ignore coverage ....... ✅ exclude patterns are active
      claude: 12 files excluded by patterns
  Cross-root conflicts .. ✅ no overlapping paths between roots
  Permissions ........... ✅ all local dirs are readable/writable

  Summary: 0 errors, 2 warnings, 8 passed
```

### `--fix`: LLM-Assisted Repair

When `--fix` is passed and there are warnings or errors, rotunda sends the full doctor output to GitHub Copilot. The LLM analyzes the issues and suggests concrete fix actions:

```
  🔧 Analyzing issues with Copilot...

  3 fixes suggested:

  1. create_dir
     Missing repo directory for copilot root
     Path: /home/user/dotfiles/.copilot
     Apply this fix? [y/N/s(kip all)] y
     ✓ Created directory: /home/user/dotfiles/.copilot

  2. remove_state_entry
     Stale state entry — file no longer exists on either side
     Key: .claude/skills/old-removed-skill/SKILL.md
     Apply this fix? [y/N/s(kip all)] y
     ✓ Removed state entry: .claude/skills/old-removed-skill/SKILL.md

  3. manual
     Local directory ~/.copilot not writable — check filesystem permissions
     ℹ Manual action needed: Run chmod 755 ~/.copilot

  ✓ Fix review complete.
    Run `rotunda doctor` again to verify.
```

**Fix action types:**

| Type | What it does | Auto-applied? |
|------|-------------|---------------|
| `create_dir` | Creates missing directory | Yes (with approval) |
| `delete_file` | Deletes a specific file | Yes (with approval) |
| `delete_dir` | Deletes a directory recursively | Yes (with approval) |
| `remove_state_entry` | Removes stale entry from state.json | Yes (with approval) |
| `git_commit` | Stages and commits specified files | Yes (with approval) |
| `write_file` | Creates or overwrites a file | Yes (with approval) |
| `manual` | Shows instruction for user to act on | No — informational only |

### Check Descriptions

| #  | Check                  | What it verifies                                                                |
|----|------------------------|---------------------------------------------------------------------------------|
| 1  | **Manifest**           | `rotunda.json` exists, is valid JSON, and passes Zod schema validation.         |
| 2  | **State**              | `.rotunda/state.json` exists, is valid JSON, and has the expected structure.     |
| 3  | **Repo structure**     | Every root's `repo` directory exists in the repository.                         |
| 4  | **Local structure**    | Every root's `local` directory exists on the machine.                           |
| 5  | **Orphan detection**   | Finds files in local directories that exist but aren't matched by include patterns. |
| 6  | **State drift**        | Checks for state entries whose files no longer exist on either side.            |
| 7  | **Git status**         | Checks for uncommitted changes in managed paths (repo directories).            |
| 8  | **Ignore coverage**    | Verifies that exclude patterns are actually filtering files.                    |
| 9  | **Cross-root conflicts** | Checks for overlapping paths between roots (both local and repo sides).      |
| 10 | **Permissions**        | Verifies local directories are readable and writable.                           |

**Status icons:**

| Icon | Status | Meaning                                          |
|------|--------|--------------------------------------------------|
| ✅   | Pass   | Check passed, no issues found                    |
| ⚠️   | Warn   | Non-critical issue that may need attention        |
| ❌   | Fail   | Critical issue that will prevent syncing          |

**Failure behavior:**

If the manifest check fails, all subsequent checks are skipped since they depend on a valid manifest. Each skipped check shows a warning with "skipped (manifest not available)".

---

## `rotunda list`

Show what files rotunda is configured to capture and what's actually on disk.

**Synopsis:**

```
rotunda list [--local] [--repo]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--local` | Show only local files |
| `--repo` | Show only repo files |

**What it does:**

For each sync root, displays the manifest configuration (local path, repo path, include/exclude patterns) followed by every file that matches, with sync status indicators.

**Output format:**

```
  ┌─ claude
  │  local: ~/.claude
  │  repo:  .claude
  │  include: skills/**, agents/**, hooks/**, CLAUDE.md, settings.json, mcp.json
  │  exclude: node_modules, cache, sessions (+8 more)
  │
  │  skills/
  │    ◉ commit/SKILL.md
  │    ◉ pr-review/SKILL.md
  │    ◉ pr-review/references/REVIEW_CHECKLIST.md
  │    ◐ new-local-skill/SKILL.md              (local-only)
  │
  │  agents/
  │    ◉ the-shadow.md
  │
  │  (root)
  │    ◉ CLAUDE.md
  │    ◉ settings.json
  │    ◑ mcp.json                              (repo-only)
  │
  └─ 47 files: 44 synced, 2 local-only, 1 repo-only

  Legend: ◉ synced  ◐ local-only  ◑ repo-only
```

**Status indicators:**

| Icon | Meaning |
|------|---------|
| ◉ | File exists on both local and repo sides |
| ◐ | File exists locally but not in repo (needs `push`) |
| ◑ | File exists in repo but not locally (needs `pull`) |

**Filtering:**

```bash
rotunda list --local    # Only show files from local side
rotunda list --repo     # Only show files from repo side
```

---

## `rotunda auth`

Authenticate with GitHub Copilot for LLM-assisted review.

**Synopsis:**

```
rotunda auth
```

**What it does:**

Initiates a [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) to obtain a Copilot API token for the LLM review features used during push, pull, and sync.

See the [Authentication Guide](auth.md) for the complete walkthrough.

> **Note:** `rotunda auth` is currently a placeholder. Authentication will be required for LLM-assisted review features in a future release.

---

## Common Workflows

### Daily Sync

The most common workflow when working across machines:

```bash
cd ~/dotfiles               # Navigate to your dotfiles repo
git pull                    # Get latest changes from remote
rotunda status              # See what changed
rotunda pull -y             # Apply repo changes to local
# ... work on your machine, edit configs ...
rotunda push -y             # Push local changes to repo
git push                    # Share with other machines
```

### New Machine Setup

Setting up rotunda on a fresh machine:

```bash
git clone <your-dotfiles-repo> ~/dotfiles
cd ~/dotfiles
npm install -g rotunda      # Install rotunda globally
rotunda init                # Create state (manifest already in repo)
rotunda pull -y             # Pull all config files to local directories
rotunda doctor              # Verify everything looks good
```

### After an Agent Session

After Claude or Copilot modifies your local configuration:

```bash
cd ~/dotfiles
rotunda status              # See what the agent changed
rotunda diff claude         # Review the specific changes
rotunda push                # Push with review (confirm each change)
git add -A && git commit    # Or just commit directly
git push
```

### Checking Health

When something seems off:

```bash
rotunda doctor              # Run all health checks
rotunda diff --stat         # Quick overview of divergence
rotunda status              # Detailed change list
```

## Related

- [Manifest Reference](manifest.md) — configuring `rotunda.json`
- [Authentication Guide](auth.md) — setting up Copilot authentication
- [Architecture Guide](architecture.md) — how rotunda works internally
