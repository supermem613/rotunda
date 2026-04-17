# Converting from Chezmoi to Rotunda

This guide walks you through migrating AI agent configuration directories (`.claude/`, `.copilot/`, etc.) from [chezmoi](https://www.chezmoi.io/) to rotunda. It covers the full conversion lifecycle: understanding your chezmoi layout, building the rotunda repo structure, initializing state, and verifying correctness.

## Overview

### Why Convert?

Chezmoi is a one-way dotfile deployer: source repo → local machine. This works well for files you author and deploy, but AI agent configs are different — agents actively modify their own directories at runtime (creating skills, updating settings, saving hooks). You need **bidirectional sync** to capture those changes back into your repo.

Rotunda provides:

- **Bidirectional sync** — `push` captures local changes, `pull` applies repo changes
- **Three-way diffing** — detects conflicts when both sides change
- **No renaming conventions** — files use their real names (no `dot_`, `executable_`, `.tmpl`)
- **Per-root include/exclude** — precise glob patterns for what to sync
- **Machine-specific overrides** — exclude files on specific machines without templates

### What Changes

| Concern | Chezmoi | Rotunda |
|---------|---------|---------|
| Sync direction | One-way (repo → local) | Bidirectional |
| File naming | `dot_`, `executable_`, `private_` prefixes | Real file names |
| Templates | `.tmpl` files with Go template syntax | Not supported (use chezmoi for templates) |
| Machine config | Template conditionals in `.chezmoiignore` | `machineOverrides` in `rotunda.json` |
| Ignore patterns | `.chezmoiignore` (one global file) | Per-root `exclude` arrays + `globalExclude` |
| State tracking | None (always re-applies) | Three-way state via `.rotunda/state.json` |

### What Stays with Chezmoi

Chezmoi is still the right tool for:

- **One-time bootstrap scripts** — app installation via `winget`, `brew`, `apt`, `choco`
- **Shell configs** — `.bashrc`, `.zshrc`, PowerShell profiles (authored once, deployed everywhere)
- **Templates with variable substitution** — files that need `{{ .chezmoi.hostname }}` or conditional blocks
- **Encrypted secrets** — chezmoi's age/gpg encryption for sensitive dotfiles

**Rotunda handles:** AI agent directories that change at runtime — skills, extensions, hooks, agents, and settings that tools like Claude Code and Copilot CLI create and modify during use.

---

## Prerequisites

1. **Install rotunda:**
   ```bash
   npm install -g rotunda
   ```
   Requires Node.js 20 or later.

2. **Have your chezmoi source directory accessible.** Usually at:
   - Linux/macOS: `~/.local/share/chezmoi`
   - Windows: `%USERPROFILE%/.local/share/chezmoi` or wherever you've configured it

3. **Know your dotfiles repo location** — the git repo where chezmoi stores its source files. This is the repo you'll convert to also support rotunda.

---

## Step 1: Inventory Your Chezmoi Setup

Before converting, map your chezmoi structure to understand what needs to move to rotunda and what stays with chezmoi.

### Understand Chezmoi Naming Conventions

Chezmoi uses filename prefixes and suffixes that transform during `chezmoi apply`:

| Prefix/Suffix | Meaning | Example |
|---------------|---------|---------|
| `dot_` | Becomes a dotfile | `dot_claude/` → `~/.claude/` |
| `executable_` | File gets `+x` permission | `executable_script.sh` → `script.sh` |
| `readonly_` | File is read-only | `readonly_config.json` → `config.json` |
| `private_` | File/dir gets restricted permissions | `private_ssh/` → `.ssh/` (mode 0700) |
| `empty_` | Creates an empty file | `empty_dot_gitkeep` → `.gitkeep` |
| `.tmpl` | Go template, variables substituted on apply | `dot_bashrc.tmpl` → `.bashrc` |

These prefixes **stack**: `private_dot_ssh/private_executable_config` is a valid chezmoi path.

### Inventory Checklist

Run these commands from your chezmoi source directory:

```bash
# List all dot_ directories (these are your dotfile roots)
ls -d dot_*/

# Find all .tmpl files (these need template evaluation — keep in chezmoi)
find . -name '*.tmpl' -type f

# Find executable_ files (note which need +x on Linux/macOS)
find . -name 'executable_*' -type f

# Find readonly_ files
find . -name 'readonly_*' -type f

# Check .chezmoiignore for machine-specific conditionals
cat .chezmoiignore

# Check .chezmoi.toml.tmpl for template variables
cat .chezmoi.toml.tmpl
```

On Windows (PowerShell):

```powershell
# List all dot_ directories
Get-ChildItem -Directory -Filter "dot_*"

# Find all .tmpl files
Get-ChildItem -Recurse -Filter "*.tmpl" -File

# Find executable_ or readonly_ files
Get-ChildItem -Recurse -File | Where-Object { $_.Name -match '^(executable_|readonly_)' }

# Check ignore patterns
Get-Content .chezmoiignore -ErrorAction SilentlyContinue
```

### Classify Each Directory

For each `dot_*` directory, decide:

| Directory | Changes at runtime? | Uses templates? | → Tool |
|-----------|---------------------|-----------------|--------|
| `dot_claude/` | Yes (skills, hooks, agents) | Usually no | **Rotunda** |
| `dot_copilot/` | Yes (extensions, agents) | Usually no | **Rotunda** |
| `dot_bashrc` | No | Often yes | **Chezmoi** |
| `dot_gitconfig` | No | Often yes | **Chezmoi** |
| `dot_config/nvim/` | Sometimes | Rarely | **Either** (your call) |

**Rule of thumb:** If an AI agent writes to it at runtime → rotunda. If you author it and deploy → chezmoi.

---

## Step 2: Create the Rotunda Repo Structure

> **⚠️ Critical: Populate from LIVE local directories, not chezmoi source.**
>
> Chezmoi's `dot_claude/` directory contains files with naming artifacts (`executable_`, `readonly_`, `.tmpl` suffixes) that don't match actual filenames. Always copy from your live local directories (`~/.claude/`, `~/.copilot/`) to get real file names and current content.

### Create Repo Directories

In your dotfiles repo, create directories that mirror the local paths:

```bash
cd ~/dotfiles   # your dotfiles/chezmoi repo

# Create directories using real names (not dot_ prefixed)
mkdir -p .claude
mkdir -p .copilot
```

### Mirror Local Content to Repo

Use a mirroring tool to copy the current local state into the repo directories. This ensures the repo matches what's actually on disk.

**Linux/macOS:**

```bash
# Mirror ~/.claude → repo/.claude (excluding ephemeral data)
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='sessions' \
  --exclude='cache' \
  --exclude='*.log' \
  --exclude='history.jsonl' \
  --exclude='telemetry' \
  --exclude='statsig' \
  --exclude='debug' \
  --exclude='todos' \
  --exclude='transcripts' \
  ~/.claude/ .claude/

# Mirror ~/.copilot → repo/.copilot
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='logs' \
  --exclude='session-state' \
  --exclude='session-store*' \
  --exclude='crash-context' \
  ~/.copilot/ .copilot/
```

**Windows (PowerShell):**

```powershell
# Mirror ~/.claude → repo\.claude
robocopy "$env:USERPROFILE\.claude" ".claude" /MIR `
  /XD node_modules sessions cache telemetry statsig debug todos transcripts `
  /XF *.log history.jsonl

# Mirror ~/.copilot → repo\.copilot
robocopy "$env:USERPROFILE\.copilot" ".copilot" /MIR `
  /XD node_modules logs session-state crash-context `
  /XF session-store* *.log
```

> **Why mirror first?** The first time rotunda runs, it compares local and repo files. If there are content differences (because the chezmoi snapshot is stale), they show up as conflicts. Mirroring local → repo ensures both sides match, giving rotunda a clean baseline.

---

## Step 3: Create `rotunda.json`

You can either run `rotunda init` to generate a default manifest, or create one manually. Here's how to map your chezmoi configuration:

### Basic Manifest

```json
{
  "version": 1,
  "roots": [
    {
      "name": "claude",
      "local": "~/.claude",
      "repo": ".claude",
      "include": [
        "skills/**",
        "agents/**",
        "hooks/**",
        "CLAUDE.md",
        "settings.json",
        "mcp.json"
      ],
      "exclude": [
        "node_modules",
        "cache",
        "sessions",
        "history.jsonl",
        "*.credentials*",
        "telemetry",
        "debug",
        "statsig",
        "todos",
        "transcripts"
      ]
    },
    {
      "name": "copilot",
      "local": "~/.copilot",
      "repo": ".copilot",
      "include": [
        "agents/**",
        "extensions/**",
        "hooks/**",
        "config.json",
        "permissions-config.json"
      ],
      "exclude": [
        "node_modules",
        "logs",
        "session-state",
        "session-store*",
        "crash-context"
      ]
    }
  ],
  "globalExclude": [
    "node_modules",
    ".git",
    "*.log",
    "*.tmp",
    "__pycache__"
  ]
}
```

### Converting Chezmoi Ignore Patterns

Map your `.chezmoiignore` entries to rotunda's `exclude` arrays:

| `.chezmoiignore` pattern | Rotunda equivalent | Where |
|--------------------------|--------------------|-------|
| `*.log` | `"*.log"` | `globalExclude` |
| `node_modules` | `"node_modules"` | `globalExclude` |
| `.claude/sessions` | `"sessions"` | `roots[claude].exclude` |
| `README.md` | `"README.md"` | `globalExclude` or per-root |

### Converting Machine-Specific Conditionals

Chezmoi uses template conditionals for machine-specific behavior, often in `.chezmoiignore`:

```
# Chezmoi (.chezmoiignore with template)
{{- if eq .chezmoi.hostname "work-laptop" }}
.npmrc
{{- end }}

{{- if not (has (lower .chezmoi.hostname) .personal_machines) }}
dot_claude/skills/personal-project/**
{{- end }}
```

Rotunda uses `machineOverrides` in `rotunda.json`:

```json
{
  "machineOverrides": {
    "personal-laptop": {
      "exclude": [".npmrc"],
      "roots": {
        "claude": {
          "exclude": ["skills/work-only/**"]
        }
      }
    },
    "work-desktop": {
      "roots": {
        "claude": {
          "exclude": ["skills/personal-project/**"]
        },
        "copilot": {
          "exclude": ["config.json"]
        }
      }
    }
  }
}
```

**Key differences:**

- Chezmoi: conditionals evaluated at template render time, pattern is "ignore this file on this machine"
- Rotunda: `machineOverrides` merged at manifest load time, additive excludes only
- Rotunda matches against `os.hostname()` (case-insensitive)

See the [Manifest Reference](manifest.md#machine-overrides) for full details.

---

## Step 4: Initialize Rotunda

Once the repo structure is in place and `rotunda.json` is configured:

```bash
cd ~/dotfiles

# Initialize rotunda (creates .rotunda/ state directory, updates .gitignore)
rotunda init

# Verify the state
rotunda status

# Run health checks
rotunda doctor
```

### What `rotunda init` Does

1. Creates `.rotunda/` directory for per-machine state
2. Adds `.rotunda/` to `.gitignore`
3. Scans all files in both local and repo directories for every root
4. Computes SHA-256 hashes and writes baseline state to `.rotunda/state.json`

### Understanding Initial State

`rotunda init` only tracks files that **exist on both sides with matching content**. After init:

- Files present on both sides with identical content → tracked, in sync
- Files only on one side → will show as "added" on the next `rotunda status`
- Files on both sides with different content → will show as "modified" or "conflict"

**This is why Step 2 (mirroring) matters.** If you mirrored local → repo before init, everything should be in sync.

If you skipped mirroring, run `rotunda status` to see what's different, then:

```bash
# If local is the source of truth:
rotunda push -y

# If repo is the source of truth:
rotunda pull -y
```

---

## Step 5: Archive Chezmoi Files

Move chezmoi-specific files for the directories rotunda now manages. You have two options:

### Option A: Archive to a `bootstrap/` Directory

Keep bootstrap-related chezmoi files but move them out of the way:

```bash
mkdir -p bootstrap

# Move chezmoi install scripts
mv run_once_*.sh bootstrap/ 2>/dev/null
mv run_once_*.ps1 bootstrap/ 2>/dev/null

# Move app manifests
mv apps.json bootstrap/ 2>/dev/null

# Keep the chezmoi config if you still use chezmoi for non-agent dotfiles
# mv .chezmoi.toml.tmpl bootstrap/  # Only if fully leaving chezmoi
```

### Option B: Remove Chezmoi Agent Directories

If chezmoi was only managing agent configs (and you're fully switching to rotunda):

```bash
# Remove chezmoi's copies of the agent directories
rm -rf dot_claude
rm -rf dot_copilot

# Remove chezmoi config files
rm -f .chezmoi.toml.tmpl
rm -f .chezmoiignore
rm -f .chezmoiroot
rm -f .chezmoiversion
```

### If Keeping Chezmoi for Non-Agent Dotfiles

Update `.chezmoiignore` to exclude the rotunda-managed directories:

```
# .chezmoiignore — tell chezmoi to leave these alone
.claude
.copilot
rotunda.json
.rotunda
```

This prevents chezmoi from trying to manage files that rotunda owns.

---

## Step 6: Verify

Run the full verification suite:

```bash
# List all tracked files
rotunda list

# Health check
rotunda doctor

# Check for any unexpected changes
rotunda status

# If everything looks clean, commit
git add -A
git commit -m "Migrate AI agent configs from chezmoi to rotunda"
git push
```

### What to Expect from `rotunda doctor`

All 10 checks should pass or show only minor warnings:

```
Manifest .............. ✅ rotunda.json valid (2 roots, 5 global excludes)
State ................. ✅ state.json valid (47 tracked files)
Repo structure ........ ✅ all 2 repo dirs exist
Local structure ....... ✅ all 2 local dirs exist
Orphan detection ...... ✅ no untracked files
State drift ........... ✅ all state entries have corresponding files
Git status ............ ⚠️ uncommitted changes (expected after migration)
Ignore coverage ....... ✅ exclude patterns are active
Cross-root conflicts .. ✅ no overlapping paths between roots
Permissions ........... ✅ all local dirs are readable/writable
```

### Cross-Check with Chezmoi

Optionally, verify that the rotunda repo has the same files your chezmoi setup was managing:

```bash
# List what chezmoi was managing for these dirs
chezmoi managed | grep -E '^\.(claude|copilot)/'

# Compare with what rotunda tracks
rotunda list
```

---

## Common Issues

### `executable_` Files Don't Have Execute Permission

**Problem:** Files that chezmoi named with the `executable_` prefix lose their execute bit when copied to the rotunda repo, because rotunda doesn't interpret chezmoi prefixes.

**Solution:** Set permissions manually after migration:

```bash
# Linux/macOS — set execute permission on scripts
chmod +x .claude/hooks/*.sh
chmod +x .copilot/hooks/*.sh
```

On Windows, file permissions aren't an issue (Windows doesn't use Unix permission bits for execution). Git will preserve the execute bit for cross-platform repos if you set it:

```bash
git update-index --chmod=+x .claude/hooks/pre-commit.sh
```

### `.tmpl` Files in Agent Directories

**Problem:** Some agent config files use chezmoi's `.tmpl` extension for template variable substitution.

**Solution:** Templates must be rendered before rotunda can manage them. Either:

1. **Run `chezmoi apply` first**, then copy the rendered output from `~/` to the rotunda repo
2. **Manually substitute variables** — replace `{{ .chezmoi.hostname }}` with actual values or remove conditionals
3. **Use `machineOverrides` instead** — if the template was just for machine-specific includes/excludes, rotunda's override system replaces that need

### Conflicts on First Sync

**Problem:** After `rotunda init`, `rotunda status` shows many conflicts (files modified on both sides).

**Cause:** The repo content came from chezmoi's last `chezmoi add`, which may be stale. The local content has been modified since then by the agents themselves.

**Solution:** Mirror local → repo first, then re-init:

```bash
# Re-mirror local to repo (see Step 2 for full commands)
rsync -av --delete --exclude='...' ~/.claude/ .claude/
rsync -av --delete --exclude='...' ~/.copilot/ .copilot/

# Re-initialize state
rm -rf .rotunda
rotunda init
rotunda status   # Should now be clean
```

### Git Safety Hooks Blocking Operations

**Problem:** Git pre-commit hooks or other safety checks block rotunda's automatic commits.

**Solution:** Rotunda creates commits as part of `push` operations. If hooks are interfering:

```bash
# Temporarily bypass hooks for the migration commit
git commit --no-verify -m "Migrate to rotunda"

# Or configure your hooks to allow rotunda commits
# (check your .husky/ or .git/hooks/ directory)
```

### `rotunda init` Fails — Directories Don't Exist

**Problem:** `rotunda init` warns that local directories don't exist.

**Solution:** This is normal if you're setting up a new machine. The directories will be created when you run `rotunda pull`. If you're on the source machine, verify the paths in `rotunda.json` match your actual directory locations (check `~` expansion).

### Large Files or Binary Files in Agent Directories

**Problem:** Agent directories sometimes contain large binary files (model caches, compiled artifacts) that shouldn't be synced.

**Solution:** Add patterns to your `exclude` arrays:

```json
{
  "exclude": [
    "*.db",
    "*.sqlite",
    "*.wasm",
    "cache/**",
    "downloads/**"
  ]
}
```

Run `rotunda doctor` after updating — the "Ignore coverage" check will confirm your patterns are filtering files.

---

## Coexistence: Chezmoi + Rotunda

The recommended setup uses both tools, each for what it does best:

```
~/dotfiles/
├── .chezmoi.toml.tmpl        # Chezmoi config (template variables)
├── .chezmoiignore            # Excludes rotunda-managed dirs
├── rotunda.json              # Rotunda manifest
├── .rotunda/                 # Rotunda state (gitignored)
│
├── # ── Chezmoi-managed (one-way deploy) ──
├── dot_bashrc.tmpl           # Shell config with templates
├── dot_gitconfig.tmpl        # Git config with conditionals
├── dot_config/               # App configs (authored, not runtime)
│   └── starship.toml
├── bootstrap/                # One-time setup scripts
│   ├── install.sh
│   └── apps.json
│
├── # ── Rotunda-managed (bidirectional sync) ──
├── .claude/                  # Claude Code runtime config
│   ├── CLAUDE.md
│   ├── settings.json
│   ├── skills/
│   ├── agents/
│   └── hooks/
└── .copilot/                 # Copilot CLI runtime config
    ├── config.json
    ├── agents/
    ├── extensions/
    └── hooks/
```

### Setup Checklist for Coexistence

1. **`.chezmoiignore`** — exclude rotunda-managed paths:
   ```
   .claude
   .copilot
   rotunda.json
   .rotunda
   ```

2. **`rotunda.json`** — only configure roots for runtime agent directories

3. **Workflow:**
   ```bash
   # Deploy chezmoi-managed configs (one-time or after editing templates)
   chezmoi apply

   # Sync agent configs (daily, after agent sessions)
   rotunda pull -y    # Get changes from other machines
   rotunda push -y    # Share local agent changes
   ```

4. **New machine bootstrap:**
   ```bash
   git clone <dotfiles-repo> ~/dotfiles
   cd ~/dotfiles

   # Step 1: Chezmoi bootstrap (install apps, deploy shell configs)
   chezmoi init --source ~/dotfiles --apply

   # Step 2: Rotunda setup (sync agent configs)
   npm install -g rotunda
   rotunda init
   rotunda pull -y
   rotunda doctor
   ```

---

## Quick Reference

| Task | Command |
|------|---------|
| See what changed | `rotunda status` |
| Preview diffs | `rotunda diff` |
| Push local → repo | `rotunda push` |
| Pull repo → local | `rotunda pull` |
| Health check | `rotunda doctor` |
| List tracked files | `rotunda list` |

## Related

- [Manifest Reference](manifest.md) — configuring `rotunda.json`, root definitions, machine overrides
- [Command Reference](commands.md) — all rotunda commands with examples
- [Architecture Guide](architecture.md) — how rotunda's three-way sync engine works
- [Authentication Guide](auth.md) — setting up Copilot auth for LLM-assisted review
