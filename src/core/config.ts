/**
 * Global rotunda config (~/.rotunda.json).
 *
 * Stores the persistent binding from "this machine" → "the dotfiles repo on
 * disk". This is what allows rotunda commands to be invoked from any
 * directory: they read the config, find the repo, and operate on it.
 *
 * The file is intentionally tiny and version-stamped so future fields can be
 * added without breaking older rotunda binaries.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { RotundaError } from "./manifest.js";

// ── Config schema ────────────────────────────────────────────────────

export const GlobalConfigSchema = z.object({
  version: z
    .number()
    .int()
    .refine((v) => v === 1, { message: "unsupported config version (expected 1)" }),
  /** Absolute path to the bound dotfiles repo. Null if no binding set. */
  dotfilesRepo: z.string().nullable(),
  /**
   * Optional shell to spawn for `rotunda cd`. Null = auto-detect.
   * On Windows, auto-detect prefers pwsh → powershell → cmd.exe.
   * On Unix, auto-detect uses $SHELL → /bin/sh.
   */
  cdShell: z.string().nullable().default(null),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// ── Paths ────────────────────────────────────────────────────────────

/**
 * Path to the global config file. Cross-platform: ~/.rotunda.json.
 *
 * This deliberately uses the home directory (not %APPDATA%) so the file
 * is in a single, predictable location on every OS, and so the user can
 * easily back it up alongside other dotfiles if they want to.
 */
export function getGlobalConfigPath(): string {
  return join(homedir(), ".rotunda.json");
}

// ── Load / save ──────────────────────────────────────────────────────

/**
 * Load ~/.rotunda.json. Returns an empty config if the file doesn't exist.
 * Throws RotundaError if the file exists but is malformed.
 *
 * The optional `path` parameter is for testing — production callers should
 * always omit it so the canonical home location is used.
 */
export function loadGlobalConfig(path: string = getGlobalConfigPath()): GlobalConfig {
  if (!existsSync(path)) {
    return { version: 1, dotfilesRepo: null, cdShell: null };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new RotundaError(`Could not read ${path}`, { cause: err });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RotundaError(`Invalid JSON in ${path}`, { cause: err });
  }

  const result = GlobalConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new RotundaError(`Invalid config at ${path}:\n${issues}`);
  }

  return result.data;
}

/**
 * Atomically write ~/.rotunda.json. Creates parent dir if needed.
 * The optional `path` parameter is for testing.
 */
export function saveGlobalConfig(
  config: GlobalConfig,
  path: string = getGlobalConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(path, content, "utf-8");
}

// ── Path helpers ─────────────────────────────────────────────────────

/**
 * Resolve `~` and turn relative paths into absolute paths (rooted at cwd).
 * Used when accepting paths from the user.
 */
export function expandUserPath(p: string, base: string = process.cwd()): string {
  let expanded = p;
  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

// ── Repo resolution ──────────────────────────────────────────────────

/**
 * Resolve the bound dotfiles repo path.
 *
 * Single source of truth: ~/.rotunda.json's `dotfilesRepo` field. There is
 * deliberately no env-var override and no walk-up fallback — the binding
 * is the binding, and any deviation is a bug worth surfacing.
 *
 * Throws RotundaError with an actionable message when:
 *   - no binding is set (instructs the user to run `rotunda bind`)
 *   - the bound path no longer exists (instructs them to re-bind)
 *   - the bound path doesn't contain a rotunda.json (no longer a rotunda repo)
 *
 * The optional `configPath` parameter is for testing.
 */
export function resolveRepoRoot(configPath?: string): string {
  const config = loadGlobalConfig(configPath);

  if (!config.dotfilesRepo) {
    throw new RotundaError(
      "No dotfiles repo bound.\n" +
        "  Run `rotunda bind` from inside your dotfiles repo, or\n" +
        "  Run `rotunda bind <path>` to bind to a specific path.",
    );
  }

  if (!existsSync(config.dotfilesRepo)) {
    throw new RotundaError(
      `Bound dotfiles repo no longer exists: ${config.dotfilesRepo}\n` +
        `  Run \`rotunda bind <new-path>\` to point rotunda at the new location.`,
    );
  }

  if (!existsSync(join(config.dotfilesRepo, "rotunda.json"))) {
    throw new RotundaError(
      `Bound path is not a rotunda repo (no rotunda.json): ${config.dotfilesRepo}\n` +
        `  Run \`rotunda init\` inside a dotfiles repo to bootstrap it, or\n` +
        `  Run \`rotunda bind <path>\` to point rotunda at the correct repo.`,
    );
  }

  return config.dotfilesRepo;
}

// ── Shell selection for `rotunda cd` ─────────────────────────────────

/** Result of picking a shell to spawn for `rotunda cd`. */
export interface ShellChoice {
  cmd: string;
  args: string[];
}

/**
 * Test whether `cmd` is invokable on PATH by running `cmd --version`.
 * Returns true on exit code 0, false on ENOENT or any other failure.
 */
function canInvoke(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ["--version"], {
      stdio: "ignore",
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detect the parent shell process name (lowercase, no extension).
 * Returns null if detection fails.
 *
 * On Windows: queries `tasklist` for the parent PID.
 * On Unix:    reads `/proc/<ppid>/comm` (Linux) or runs `ps` (macOS/BSD).
 */
function detectParentShell(): string | null {
  const ppid = process.ppid;
  if (!ppid) return null;

  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${ppid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      if (result.status !== 0 || !result.stdout) return null;
      // CSV: "name.exe","pid",...
      const match = result.stdout.match(/^"([^"]+)"/);
      if (!match) return null;
      return match[1].replace(/\.exe$/i, "").toLowerCase();
    }

    // Unix: try /proc first (fast, no subprocess), fall back to ps.
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const comm = fs.readFileSync(`/proc/${ppid}/comm`, "utf8").trim();
      if (comm) return comm.toLowerCase();
    } catch {
      // /proc not available (macOS, BSD); use ps.
    }
    const result = spawnSync("ps", ["-p", String(ppid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || !result.stdout) return null;
    // ps may print full path; take basename.
    const name = result.stdout.trim().split(/[\\/]/).pop();
    return name ? name.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Map a detected parent shell name to a ShellChoice.
 * Returns null if the name isn't a recognized interactive shell (e.g.,
 * if rotunda was launched from VS Code's `Code.exe` or a build tool).
 */
function shellChoiceFromName(name: string): ShellChoice | null {
  switch (name) {
    case "pwsh":
      return { cmd: "pwsh", args: ["-NoLogo"] };
    case "powershell":
      return { cmd: "powershell", args: ["-NoLogo"] };
    case "cmd":
      return { cmd: process.env.ComSpec || "cmd.exe", args: [] };
    case "bash":
    case "zsh":
    case "fish":
    case "sh":
    case "ksh":
    case "dash":
    case "tcsh":
    case "csh":
      return { cmd: name, args: [] };
    default:
      return null;
  }
}

/**
 * Pick a shell to spawn for `rotunda cd`.
 *
 * Order:
 *   1. Explicit `cdShell` from config (always honored verbatim)
 *   2. Auto-detected parent shell (the shell rotunda was launched from)
 *   3. Windows: pwsh → powershell → %ComSpec% (cmd.exe)
 *   4. Unix:    $SHELL → /bin/sh
 *
 * Auto-detection uses the parent process name. If that process isn't a
 * recognized interactive shell (e.g., rotunda was launched from an IDE
 * task runner), we fall back to the OS default. The Windows default
 * order favors PowerShell because most rotunda users on Windows live
 * there; defaulting to cmd.exe (chezmoi's default) would surprise them.
 */
export function pickShell(cdShell: string | null = null): ShellChoice {
  if (cdShell) {
    return { cmd: cdShell, args: [] };
  }

  const parent = detectParentShell();
  if (parent) {
    const detected = shellChoiceFromName(parent);
    if (detected && (detected.cmd === parent || canInvoke(detected.cmd))) {
      return detected;
    }
  }

  if (process.platform === "win32") {
    if (canInvoke("pwsh")) return { cmd: "pwsh", args: ["-NoLogo"] };
    if (canInvoke("powershell")) return { cmd: "powershell", args: ["-NoLogo"] };
    return { cmd: process.env.ComSpec || "cmd.exe", args: [] };
  }

  return { cmd: process.env.SHELL || "/bin/sh", args: [] };
}
