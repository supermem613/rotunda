# Manifest Reference

The `rotunda.json` manifest file defines what rotunda syncs, where it syncs from, and what to exclude. It lives in the root of your dotfiles repository.

## Schema Overview

```json
{
  "version": 1,
  "roots": [
    {
      "name": "claude",
      "local": "~/.claude",
      "repo": ".claude",
      "include": ["skills/**", "CLAUDE.md"],
      "exclude": ["node_modules", "cache"]
    }
  ],
  "globalExclude": ["node_modules", ".git", "**/*.log"],
  "machineOverrides": {
    "wisp": {
      "exclude": [".npmrc"],
      "roots": {
        "copilot": { "exclude": ["config.json"] }
      }
    }
  }
}
```

The manifest has three top-level fields:

| Field           | Type       | Required | Default | Description                                       |
|-----------------|------------|----------|---------|---------------------------------------------------|
| `version`       | `number`   | Yes      | —       | Schema version. Must be `1`.                      |
| `roots`         | `array`    | Yes      | —       | Array of sync root definitions (see below).       |
| `globalExclude` | `string[]` | No       | `[]`    | Glob patterns excluded from **all** roots.        |
| `machineOverrides` | `object` | No    | —       | Per-machine exclude overrides (see below).        |

## Roots

Each entry in the `roots` array maps a local directory on your machine to a directory in the repository. Rotunda syncs files bidirectionally between these two directories.

### Root Fields

| Field     | Type       | Required | Default | Description                                                |
|-----------|------------|----------|---------|------------------------------------------------------------|
| `name`    | `string`   | Yes      | —       | Human-readable identifier for this root (e.g., `"claude"`). Must be non-empty and unique across roots. |
| `local`   | `string`   | Yes      | —       | Absolute path to the local directory. Supports `~` for home directory (e.g., `"~/.claude"`). |
| `repo`    | `string`   | Yes      | —       | Relative path within the repository (e.g., `".claude"`).   |
| `include` | `string[]` | Yes      | —       | Glob patterns for files to include. An empty array `[]` means include everything not excluded. |
| `exclude` | `string[]` | Yes      | —       | Glob patterns for files to exclude from this root.         |

### Path Resolution

- **Tilde expansion**: Paths starting with `~/` are expanded to your home directory (`$HOME` on Unix, `%USERPROFILE%` on Windows).
- **Path normalization**: All paths are normalized to use the platform's native separator.
- **Repo paths**: Always relative to the repository root. Do not use absolute paths.

## Glob Pattern Syntax

Rotunda uses [minimatch](https://github.com/isaacs/minimatch) for glob pattern matching. Patterns use forward slashes (`/`) regardless of the operating system.

| Pattern        | Matches                                            | Example                              |
|----------------|----------------------------------------------------|--------------------------------------|
| `*`            | Any characters within a single path segment        | `*.md` matches `README.md`           |
| `**`           | Any characters across multiple path segments       | `skills/**` matches `skills/a/b.md`  |
| `?`            | Exactly one character                              | `file?.txt` matches `file1.txt`      |
| `*.ext`        | All files with a given extension                   | `*.log` matches `debug.log`          |
| `dir/**`       | Everything inside a directory, recursively         | `agents/**` matches `agents/x/y.ts`  |
| `name`         | Exact segment match (no slash = matches any level) | `node_modules` excludes it anywhere  |

### Include vs. Exclude Behavior

1. **Exclude patterns are checked first** — exclude always wins over include.
2. **Segment matching for excludes** — if an exclude pattern contains no `/` or `*`, it matches against any individual path segment. For example, `node_modules` in the exclude list will match `foo/node_modules/bar.js`.
3. **If `include` is empty** — all files not excluded are included.
4. **If `include` is non-empty** — a file must match at least one include pattern to be tracked.

### Managing Tracked Paths

You can grow or shrink tracked scope by pointing Rotunda at an existing local file or directory:

```bash
rotunda add <path>
rotunda remove <path>
```

These commands:

- resolve `~`, absolute paths, and relative paths from your current shell
- edit the base manifest's `roots[].include` / `roots[].exclude` arrays
- preview the manifest diff plus repo/state changes
- require confirmation before any files are copied or deleted
- commit and push the resulting repo changes

For `add`, Rotunda either:

- adds an inferred include to an existing root, or
- prompts for a new root name and creates a new root if nothing matches

For `remove`, Rotunda either:

- removes an exact include,
- adds an exclude when the path sits under a broader include, or
- removes the whole root when you target that root directory directly

They do **not** manage:

- `globalExclude`
- `machineOverrides`

If you need to make larger structural edits than that, edit `rotunda.json` directly.

### Global Excludes

The `globalExclude` array applies to every root. Use it for patterns that should always be excluded regardless of root:

```json
"globalExclude": ["node_modules", ".git", "**/*.log", "**/*.tmp", "__pycache__"]
```

## Machine Overrides

The `machineOverrides` field lets you exclude specific files or patterns on specific machines. This is useful when some machines shouldn't sync certain configs (e.g., work-only skills on a personal machine).

Hostnames are matched **case-insensitively** against `os.hostname()`.

### Structure

```json
{
  "machineOverrides": {
    "<hostname>": {
      "exclude": ["<pattern>", ...],
      "roots": {
        "<root-name>": {
          "exclude": ["<pattern>", ...]
        }
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `<hostname>` | `string` (key) | Machine hostname, matched case-insensitively. |
| `exclude` | `string[]` | Additional patterns added to `globalExclude` on this machine. |
| `roots.<name>.exclude` | `string[]` | Additional patterns added to the named root's `exclude` on this machine. |

### How It Works

When rotunda loads the manifest, it checks `os.hostname()` against the keys in `machineOverrides` (case-insensitive). If a match is found:

1. The machine's `exclude` patterns are **merged** into `globalExclude`
2. Each root's override `exclude` patterns are **merged** into that root's `exclude`
3. Only one machine can match (first match wins)

This is additive-only — you can only add excludes per machine, not includes. This keeps the behavior predictable: every machine gets the base config minus its specific exclusions.

### Example: Work vs. Personal Machine

```json
{
  "version": 1,
  "roots": [
    {
      "name": "claude",
      "local": "~/.claude",
      "repo": ".claude",
      "include": ["skills/**", "agents/**", "hooks/**", "CLAUDE.md", "settings.json"],
      "exclude": ["node_modules", "cache"]
    },
    {
      "name": "copilot",
      "local": "~/.copilot",
      "repo": ".copilot",
      "include": ["agents/**", "extensions/**", "hooks/**", "config.json"],
      "exclude": ["node_modules"]
    }
  ],
  "globalExclude": ["node_modules", ".git"],
  "machineOverrides": {
    "wisp": {
      "exclude": [".npmrc"],
      "roots": {
        "claude": {
          "exclude": ["skills/odsp-web/**", "skills/rumone/**"]
        },
        "copilot": {
          "exclude": ["config.json"]
        }
      }
    }
  }
}
```

In this example, on the machine named `wisp`:
- `.npmrc` is excluded globally
- `skills/odsp-web/**` and `skills/rumone/**` are excluded from the claude root
- `config.json` is excluded from the copilot root
- All other machines get the full config

### Checking Which Overrides Applied

Run `rotunda doctor` to see which machine was matched:
```
Manifest ............ ✅ rotunda.json valid (2 roots, applied overrides for: wisp)
```

## Default Configuration

When you run `rotunda init`, the following manifest is created if no `rotunda.json` exists:

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
        "downloads",
        "file-history",
        "paste-cache",
        "plans",
        "session-env",
        "shell-snapshots",
        "stats-cache.json",
        "statsig",
        "tasks",
        "todos",
        "transcripts",
        "ide",
        "backups",
        "commands",
        "plugins",
        "projects",
        "policy-limits.json",
        "settings.local.json",
        "config.json"
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
        "crash-context",
        "ide",
        "installed-plugins",
        "marketplace-cache",
        "mcp-oauth-config",
        "pkg",
        "restart",
        "command-history-state.json"
      ]
    }
  ],
  "globalExclude": [
    "node_modules",
    ".git",
    "**/*.log",
    "**/*.tmp",
    "__pycache__"
  ]
}
```

This default configuration syncs Claude Code and Copilot CLI customizations (skills, agents, hooks, settings) while excluding ephemeral data (sessions, caches, logs, telemetry).

## Examples

### Adding a Custom Root

To sync your Neovim configuration alongside Claude and Copilot:

```json
{
  "version": 1,
  "roots": [
    { "...existing roots..." },
    {
      "name": "nvim",
      "local": "~/.config/nvim",
      "repo": "nvim",
      "include": [],
      "exclude": ["plugin/packer_compiled.lua", "*.bak"]
    }
  ],
  "globalExclude": ["node_modules", ".git", "**/*.log", "**/*.tmp"]
}
```

Setting `include` to `[]` means every file in `~/.config/nvim` is tracked (except excluded patterns). The repo counterpart will be the `nvim/` directory in your dotfiles repo.

### Excluding Additional Patterns

To prevent large or sensitive files from syncing:

```json
{
  "exclude": [
    "node_modules",
    "*.credentials*",
    "*.secret",
    "large-model-weights/**",
    "*.db"
  ]
}
```

### Minimal Manifest

The simplest possible manifest tracks a single directory:

```json
{
  "version": 1,
  "roots": [
    {
      "name": "dotfiles",
      "local": "~/dotfiles-local",
      "repo": "dotfiles",
      "include": [],
      "exclude": []
    }
  ]
}
```

## Schema Versioning

The `version` field enables future evolution of the manifest format. Currently, the only supported version is `1`. If the schema changes in a future release, rotunda will validate against the declared version and provide migration guidance.

Rotunda validates the manifest on every command using [Zod](https://zod.dev/) schema validation. If the manifest is invalid, you will see a clear error message listing each issue:

```
Error: Invalid manifest at /path/to/rotunda.json:
  • version: unsupported manifest version (expected 1)
  • roots.0.name: root name must be non-empty
```

## Related

- [Command Reference](commands.md) — all rotunda commands
- [Architecture Guide](architecture.md) — how the manifest feeds into the sync engine
