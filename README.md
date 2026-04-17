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
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a>
</p>

<p align="center">
  <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/supermem613/rotunda/ci.yml?label=CI&style=flat-square">
  <img alt="npm version" src="https://img.shields.io/npm/v/rotunda?style=flat-square">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Node >= 20" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square">
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

> **TL;DR** — Clone a config repo, install Rotunda, run `rotunda init`, then `rotunda push` to sync your local AI agent configs into the repo.

### 1. Create your config repo

```bash
mkdir my-agent-configs && cd my-agent-configs
git init
```

Or clone an existing one:

```bash
git clone https://github.com/you/my-agent-configs.git
cd my-agent-configs
```

### 2. Install Rotunda

```bash
git clone https://github.com/supermem613/rotunda.git ~/rotunda
cd ~/rotunda
npm install && npm run build && npm link
```

### 3. Authenticate (optional — enables LLM review)

```bash
rotunda auth
```

### 4. Initialize

```bash
cd /path/to/my-agent-configs
rotunda init
```

This creates:
- **`rotunda.json`** — manifest with sensible defaults for `~/.claude` and `~/.copilot`
- **`.rotunda/`** — state directory (gitignored) tracking file hashes per machine
- **`.gitignore`** — updated to exclude `.rotunda/`

### 5. See what's out there

```bash
rotunda status
```

```
  12 change(s) detected:

  [claude]
    added  skills/commit/SKILL.md          (local)
    added  skills/pr-review/SKILL.md       (local)
    added  hooks/pre-commit.json           (local)

  [copilot]
    added  extensions/code-review/index.js (local)
    added  agents/the-shadow.json          (local)

  Summary: 12 added
```

Now push your local configs to the repo:

```bash
rotunda push
```

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

One `rotunda.json` declares what to sync — directory pairs with include/exclude globs. Add any directory, not just Claude and Copilot. See [Manifest Reference](docs/manifest.md).

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
| `rotunda init` | Initialize `rotunda.json` and state in the current repo |
| `rotunda status` | Show what changed since last sync |
| `rotunda diff [root]` | Show file-level diffs for modified files |
| `rotunda push [-y]` | Push local changes to repo (with LLM review) |
| `rotunda pull [-y]` | Pull repo changes to local (with LLM review) |
| `rotunda sync [-y]` | Bidirectional sync with conflict resolution |
| `rotunda doctor [--fix]` | Structural health check; `--fix` uses LLM to suggest and apply repairs |
| `rotunda list [--local] [--repo]` | Show manifest roots and what files are actually captured |
| `rotunda auth` | Authenticate with GitHub Copilot (device flow) |

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

### Single machine: edit and push

```bash
# You modified a Claude skill locally
rotunda status          # See what changed
rotunda diff claude     # Review the diff
rotunda push            # Copilot explains each change, you approve → committed to repo
git push                # Push to remote
```

### Second machine: pull changes

```bash
cd ~/my-agent-configs
git pull                # Get latest from remote
rotunda pull            # Apply repo changes to local directories
```

### Both machines changed: sync

```bash
rotunda sync            # Detects changes on both sides
                        # Non-conflicting changes sync automatically
                        # Conflicts are surfaced for LLM-assisted resolution
```

### New machine setup

```bash
# On a fresh machine
git clone https://github.com/you/my-agent-configs.git
cd my-agent-configs
npm install -g rotunda   # or npm link from source
rotunda init             # Creates state from existing files
rotunda pull -y          # Pull everything from repo to local
# Done — all your AI agent configs are in place
```

---

## ⚙️ Configuration

### `rotunda.json`

The manifest lives at the root of your config repo:

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
  "globalExclude": ["node_modules", ".git", "*.log"],
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

Verify: `rotunda --version`

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
