<p align="center">
  <img src="assets/logo.png" alt="ROTUNDA" width="600">
</p>

<h3 align="center">Bidirectional config sync with LLM-assisted review</h3>

<p align="center">
  Keep your AI agent configurations — skills, extensions, hooks, agents, and settings —
  <br>in sync across every machine, with an LLM that explains changes before they land.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#commands">Commands</a> •
  <a href="#run-from-anywhere">Run From Anywhere</a> •
  <a href="#configuration">Configuration</a>
</p>

<p align="center">
  <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/supermem613/rotunda/ci.yml?label=CI&style=flat-square">
  <img alt="npm version" src="https://img.shields.io/npm/v/rotunda?style=flat-square">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Node &gt;= 20" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square">
</p>

---

## 🔍 The Problem

Dotfile managers like chezmoi assume a one-way flow: you edit files in a repo, then apply them to machines. That model breaks down for AI agent configurations.

Tools like Claude Code and GitHub Copilot CLI generate and modify their own config files at runtime — adding skills, updating hooks, creating extensions. These changes happen *on the machine*, not in your repo. A one-way sync overwrites them. A manual sync misses them. And when you remove a skill from one machine, stale copies linger everywhere else.

**What goes wrong without Rotunda:**

- You craft a new Claude skill on your work laptop. You `chezmoi apply` on your home machine — the skill doesn't exist there because chezmoi only goes repo → local.
- Copilot CLI auto-generates an extension. You forget to commit it. Next week you re-image and it's gone.
- You delete a skill from your repo. The stale copy stays on every other machine until you manually hunt it down.
- Two machines modify the same hook file. The last `chezmoi apply` silently wins — no conflict warning.

Rotunda solves this with **bidirectional sync**: local changes push to the repo, repo changes pull to local, and a three-way diff engine detects conflicts before anything is overwritten.

---

## ⚡ Quick Start

> **TL;DR** — Install Rotunda, bind it to your dotfiles repo, then `rotunda sync` to reconcile local and repo in one interactive pass.

### 1. Get your dotfiles repo

Clone an existing one:

```bash
git clone https://github.com/you/my-dotfiles.git ~/my-dotfiles
```

Or create a fresh one and `rotunda init` it later:

```bash
mkdir ~/my-dotfiles && cd ~/my-dotfiles && git init
```

### 2. Install Rotunda

```bash
git clone https://github.com/supermem613/rotunda.git ~/rotunda
cd ~/rotunda
npm install && npm run build && npm link
```

### 3. Bind (existing repo) or initialize (new repo)

```bash
# Existing repo with rotunda.json already in it
rotunda bind ~/my-dotfiles

# OR — fresh repo: init creates rotunda.json AND binds in one shot
cd ~/my-dotfiles && rotunda init
```

`bind`/`init` writes `~/.rotunda.json` so every later command works from any directory — no need to `cd` back.

### 4. Authenticate (optional — enables LLM review)

```bash
rotunda auth
```

Without auth, sync still works — you just get a y/n prompt instead of LLM explanations.

### 5. Run your first sync

```bash
rotunda sync
```

The first sync on a fresh clone almost always shows lots of changes — local has files the repo doesn't, the repo has files local doesn't, and some files differ on both sides. The interactive TUI lets you triage all of them in one pass:

```
  rotunda sync — 12 file(s)

  ◯ PUSH        .claude/skills/commit/SKILL.md            (local-only)
  ◯ PULL        .copilot/extensions/the-shadow.json       (repo-only)
  ◯ PUSH        .claude/skills/pr-review/SKILL.md         (modified, local newer)
  ⚠ CONFLICT    .copilot/permissions-config.json          (both sides changed)
  ...

  ↑/↓ navigate  ←/→ change action  ENTER show diff  m merge  R repo-wins  L local-wins
  [a] apply  ·  [ESC] cancel & quit
```

- **←/→** cycle the per-row action: `PUSH` / `PULL` / `DELETE-LOCAL` / `DELETE-REPO` / `SKIP`.
- **ENTER** opens a scrollable diff overlay (ESC to close).
- **R** / **L** bulk-pick a winner for every row at once (handy on first sync).
- **m** drops a conflict into a `<<<<<<<` merge file you can resolve in your editor.
- **a** applies your selections; **ESC** cancels with no changes.

After sync, your local and repo are in lock-step. From here on, just run `rotunda sync` whenever you've made changes on either side.

### 6. Expand coverage one path at a time

When you want Rotunda to start tracking something new, point Rotunda at the exact file or directory and inspect the preview before anything is copied or deleted.

**Claude (`.claude`) examples:**

```bash
rotunda add ~/.claude/snippets
rotunda add ~/.claude/prompts/release
```

**Copilot (`.copilot`) examples:**

```bash
rotunda add ~/.copilot/prompts
rotunda add ~/.copilot/policies/review.json
```

Each `rotunda add` / `rotunda remove` run previews:

- the `rotunda.json` root/include/exclude change
- repo file writes or deletes
- sync-state updates
- the commit/push plan

If the path is already covered by a root, Rotunda updates that root automatically. If nothing matches, it asks for a root name, previews the new root it would create, and only applies anything after you confirm.

Prefer targeted paths like `~/.claude/snippets` or `~/.copilot/policies/review.json` over broad catch-alls like `~/.claude`.

---

## ✨ Features

### Bidirectional Sync

Push local changes to the repo, pull repo changes to local, or sync both directions at once. Each direction is explicit — no surprises.

```
rotunda push    # local → repo
rotunda pull    # repo → local
rotunda sync    # both directions with conflict resolution
```

### LLM-Assisted Review

Before any file is synced, GitHub Copilot explains what changed and why it matters. You can **approve**, **reject**, **skip**, or **reshape** each file — telling the LLM to modify it before syncing.

```
  modified  copilot/extensions/pr-review/index.js  (local)

  Copilot: "Added a new regex pattern to catch SQL injection
            in string interpolation. The existing XSS check
            is unchanged."

  [a]pprove  [r]eject  [s]kip  re[sh]ape  →
```

Reshape lets you give natural language instructions:
> "Keep the SQL injection check but also add a check for command injection"

The LLM rewrites the file, and the modified version is what gets synced.

### Doctor Health Check

10 independent checks catch problems before they bite — manifest validation, orphan detection, state drift, git status, and more. Add `--fix` to let Copilot analyze issues and suggest repairs.

```bash
$ rotunda doctor
  Manifest ............. ✅ rotunda.json valid (2 roots, 5 global excludes)
  State ................ ✅ state.json valid (47 tracked files)
  ...
  Summary: 10 passed
```

See [Command Reference](docs/commands.md#rotunda-doctor) for all 10 checks.

### Manifest-Driven Configuration

One `rotunda.json` declares what to sync — directory pairs with include/exclude globs. Use `rotunda add <path>` / `rotunda remove <path>` to grow or shrink tracked scope one path at a time, or edit the manifest directly when you need bigger structural changes. See [Manifest Reference](docs/manifest.md).

### Three-Way Change Detection

SHA-256 hashes at last sync vs. current local vs. current repo — determines exactly *what* changed and *who* changed it. Automatically resolves non-conflicting changes; surfaces real conflicts for human review. See [Architecture](docs/architecture.md#three-way-diff-table).

### Clean Orphan Removal

Delete a skill from one machine and push. On the next `rotunda pull`, it's cleanly removed from every other machine — including empty parent directories. No stale files, no manual cleanup.

### File Inventory

See exactly what rotunda captures vs. what exists locally:

```bash
rotunda list
```

```
  ┌─ claude
  │  local: ~/.claude
  │  repo:  .claude
  │
  │  skills/
  │    ◉ commit/SKILL.md
  │    ◉ pr-review/SKILL.md
  │    ◐ new-local-skill/SKILL.md     (local-only)
  │
  └─ 47 files: 45 synced, 2 local-only

  Legend: ◉ synced  ◐ local-only  ◑ repo-only
```

---

## 📋 Commands

| Command | Description |
|---------|-------------|
| `rotunda add <path>` | Add a file or directory path to tracking, copy matching local files into the repo, then commit/push |
| `rotunda auth [--force]` | Authenticate with GitHub Copilot (device flow) |
| `rotunda bind [path]` | Bind rotunda to a dotfiles repo (defaults to cwd). `--show` prints current binding, `--unset` clears it |
| `rotunda cd` | Spawn a subshell whose working directory is the bound dotfiles repo |
| `rotunda diff [root]` | Show file-level diffs for modified files |
| `rotunda doctor [--fix]` | Structural health check; `--fix` uses LLM to suggest and apply repairs |
| `rotunda home` | Spawn a subshell whose working directory is the rotunda source repo |
| `rotunda init` | Initialize `rotunda.json` and state in the current repo, and bind it |
| `rotunda list [--local] [--repo]` | Show manifest roots and what files are actually captured |
| `rotunda pull [-y]` | Pull repo changes to local (with LLM review) |
| `rotunda push [-y]` | Push local changes to repo (with LLM review) |
| `rotunda remove <path>` | Stop tracking a file or directory path, delete matching repo files, then commit/push |
| `rotunda status` | Show what changed since last sync |
| `rotunda sync [-y]` | Bidirectional sync with conflict resolution |
| `rotunda update` | Self-update: git pull, npm install, and rebuild rotunda |
| `rotunda where` | Print the absolute path of the bound dotfiles repo |

### Diff Options

```bash
rotunda diff              # Full terminal diff
rotunda diff claude       # Diff only the "claude" root
rotunda diff --stat       # Summary: files changed, insertions, deletions
rotunda diff --name-only  # Just list changed file paths
rotunda diff --open       # Open each changed file in VS Code diff viewer
rotunda diff --html       # Generate interactive HTML diff report
```

### Push/Pull Flags

```bash
rotunda push -y    # Push all changes without interactive review
rotunda pull -y    # Pull all changes without interactive review
rotunda sync -y    # Sync all non-conflicting changes without review
```

---

## 🔄 Typical Workflow

> All `rotunda` commands below work from **any directory**. After `rotunda bind` (or `rotunda init`), the binding in `~/.rotunda.json` tells rotunda which repo to operate on.

### Daily driver: `rotunda sync`

```bash
rotunda sync            # The one command you'll use 95% of the time
```

`sync` auto-pulls from the remote, detects what changed on both sides, drops you in an interactive TUI to triage, then commits and pushes the result. It handles single-direction edits (local-only or repo-only changes) just as well as true two-sided conflicts.

If a sync run shows nothing to do, you're done. If it shows changes, the TUI walks you through them — see the [Quick Start](#-quick-start) for the keybindings.

### One-direction shortcuts (when you know which side wins)

```bash
rotunda push            # local → repo only (e.g., publishing a finished change)
rotunda pull            # repo → local only (e.g., pulling teammate's update)
```

These are sub-modes of sync. Reach for them when you want explicit control; otherwise prefer `sync`.

### Brand-new machine

```bash
git clone https://github.com/you/my-dotfiles.git ~/my-dotfiles
git clone https://github.com/supermem613/rotunda.git ~/rotunda && cd ~/rotunda
npm install && npm run build && npm link
rotunda bind ~/my-dotfiles
rotunda auth            # optional: enables LLM review
rotunda sync            # interactive: choose what to keep on first run
```

### Inspecting before syncing

```bash
rotunda status          # what changed since last sync (no LLM, no I/O)
rotunda diff            # raw unified diffs (file-level)
rotunda diff --html     # interactive HTML diff report
rotunda doctor          # 10 health checks (manifest, state, git, ...)
```

### Self-update

```bash
rotunda update           # Pulls latest source, installs deps, rebuilds
```

---

## 📍 Run From Anywhere

Rotunda binds itself to **one dotfiles repo per machine** so every command works from any directory.

### How binding works

- `rotunda init` writes the bound repo path into `~/.rotunda.json` (a global config file in your home directory).
- All subsequent commands — `status`, `push`, `pull`, `sync`, `diff`, `list`, `doctor` — read that path and operate on the bound repo, regardless of your current working directory.
- There is **no environment variable** and **no walk-up-the-tree discovery**. The global config is the single source of truth. This keeps behavior predictable across shells, terminals, IDEs, and CI.

### `~/.rotunda.json`

```jsonc
{
  "version": 1,
  "dotfilesRepo": "C:/Users/you/repos/dotfiles"
}
```

You can edit this by hand, but `rotunda bind` is easier:

```bash
rotunda bind                  # bind to current directory
rotunda bind ~/repos/dotfiles # bind to an explicit path (~ is expanded)
rotunda bind --show           # print the currently bound path
rotunda bind --unset          # forget the binding
```

`bind` validates that the target directory contains a `rotunda.json` before writing, so you can't accidentally bind to a non-rotunda repo.

### Jumping into the repo

Because a child process can't change its parent shell's working directory, `rotunda cd` **spawns a subshell** rooted at the bound repo (the same trick `chezmoi cd` uses):

```bash
$ pwd
/some/random/dir
$ rotunda cd
# new shell starts, cwd is your dotfiles repo
$ pwd
/home/you/repos/dotfiles
$ exit       # back to the original shell, original cwd
```

On Windows the subshell is `pwsh` if available, otherwise `powershell`, otherwise `cmd.exe`. On Unix it's `$SHELL`. (`rotunda cd` and `rotunda home` first try to detect the shell that launched rotunda and re-use it.)

### Hacking on rotunda itself

If you want to jump into the **rotunda source repo** (not your dotfiles), use `rotunda home`:

```bash
$ rotunda home
# new shell starts, cwd is the rotunda source repo
$ pwd
/home/you/repos/rotunda
$ exit       # back to where you were
```

`home` works the same way as `cd`, just rooted at the rotunda install (resolved from the `rotunda` binary's location, following any `npm link` symlinks).

### Moving the repo

If you move your dotfiles repo, the binding goes stale:

```bash
mv ~/repos/dotfiles ~/code/dotfiles
rotunda status        # error: bound path no longer exists
rotunda bind ~/code/dotfiles
rotunda status        # works again
```

`rotunda doctor` checks the binding first and will tell you exactly what's wrong (missing config, missing path, missing `rotunda.json`, etc.) and what command to run to fix it.

### Multiple machines, one repo

The global config is **per-machine**. Each machine binds independently — you can have the repo at `~/dotfiles` on one box and `D:\code\dotfiles` on another without coordination.

### Multiple GitHub remotes (optional)

If you publish the same dotfiles repo to two GitHub accounts (e.g., personal + work for Codespaces), configure dual-push on the single clone:

```bash
git remote set-url --add --push origin https://you@github.com/you/dotfiles.git
git remote set-url --add --push origin https://you-work@github.com/you-work/dotfiles.git
git config credential.https://github.com.useHttpPath true
```

Now `git push` updates both. Rotunda doesn't know or care — it operates on the local clone.

---


## ⚙️ Configuration

### `rotunda.json`

The manifest lives at the root of your dotfiles repo:

```jsonc
{
  "version": 1,
  "roots": [
    {
      "name": "claude",
      "local": "~/.claude",
      "repo": ".claude",
      "include": ["skills/**", "agents/**", "hooks/**", "CLAUDE.md"],
      "exclude": ["node_modules", "cache", "sessions", "*.credentials*"]
    }
  ],
  "globalExclude": ["node_modules", ".git", "**/*.log"],
  "machineOverrides": {
    "personal-laptop": {
      "roots": { "copilot": { "exclude": ["config.json"] } }
    }
  }
}
```

Full field reference, default config, and machine overrides documentation: [docs/manifest.md](docs/manifest.md)

---

## 📦 Installation

### Prerequisites

- **Node.js** ≥ 20.0.0
- **Git** (for committing synced changes)
- **GitHub Copilot** access (for LLM-assisted review — optional)

### From Source (recommended)

```bash
git clone https://github.com/supermem613/rotunda.git
cd rotunda
npm install && npm run build && npm link
```

Verify: `rotunda` (prints version + help)

---

## 🔐 Authentication

LLM-assisted review uses GitHub Copilot. Authenticate once per machine:

```bash
rotunda auth
```

**Without auth**, all commands still work — you just get a simple y/n prompt instead of LLM explanations. Use `-y` to skip review entirely. See [docs/auth.md](docs/auth.md) for details.

---

## ⚖️ vs. chezmoi

| | chezmoi | Rotunda |
|---|---------|---------|
| Sync direction | One-way (repo → local) | Bidirectional |
| Runtime changes | Overwritten | Detected and merged |
| Orphan cleanup | Manual | Automatic |
| Conflict detection | Last-write-wins | Three-way with conflict surfacing |
| Change review | `chezmoi diff` | LLM explains + reshape |

Rotunda is not a replacement for chezmoi — they coexist. Use chezmoi for shell configs, Rotunda for AI agent configs. See [Converting from chezmoi](docs/converting-from-chezmoi.md).

---

## 📚 Documentation

| Guide | Description |
|-------|-------------|
| [Command Reference](docs/commands.md) | Every command with flags, options, and examples |
| [Manifest Reference](docs/manifest.md) | Full `rotunda.json` schema, machine overrides, defaults |
| [Architecture](docs/architecture.md) | Three-way diff algorithm, state management, project structure |
| [Authentication](docs/auth.md) | GitHub Copilot setup, token management, troubleshooting |
| [Converting from chezmoi](docs/converting-from-chezmoi.md) | Step-by-step migration guide |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, PR guidelines, tech stack |

---

## 📄 License

[MIT](LICENSE)
