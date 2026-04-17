import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import chalk from "chalk";
import { loadGlobalConfig, pickShell } from "../core/config.js";

/**
 * `rotunda home` — drop the user into a subshell rooted at the rotunda
 * source repo (the repo where rotunda itself is developed).
 *
 * Mirrors `rotunda cd` but for the rotunda source rather than the user's
 * dotfiles repo. Useful when you want to hack on rotunda itself without
 * remembering where you cloned it.
 *
 * The rotunda source path is derived from this script's location at
 * runtime: walk up from `dist/cli.js` (or wherever the bin lives after
 * `npm link`) until a package.json with `name: "rotunda"` is found. This
 * works for both `npm link` setups (symlinked back to the source repo)
 * and direct `node dist/cli.js` invocations.
 */
function findRotundaSourceRepo(): string | null {
  // Resolve the real path of this module (follows symlinks created by `npm link`).
  let dir: string;
  try {
    const here = fileURLToPath(import.meta.url);
    dir = dirname(realpathSync(here));
  } catch {
    return null;
  }

  // Walk up looking for a package.json with name === "rotunda".
  let prev = "";
  while (dir !== prev) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "rotunda") return dir;
      } catch {
        // Malformed package.json — ignore and keep walking up.
      }
    }
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}

export function homeCommand(): void {
  const repoPath = findRotundaSourceRepo();
  if (!repoPath) {
    console.error(
      chalk.red("Error:") +
        " Could not locate the rotunda source repo from this binary.\n" +
        "  This usually means rotunda was installed in a way that detached it from\n" +
        "  its source (e.g., copied rather than `npm link`-ed).",
    );
    process.exit(1);
    return;
  }

  const config = loadGlobalConfig();
  const shell = pickShell(config.cdShell);

  console.log(chalk.cyan.bold("┌─ rotunda home ────────────────────────────────────────"));
  console.log(chalk.cyan("│") + " You are now in a " + chalk.bold("subshell") + " rooted at the rotunda source repo:");
  console.log(chalk.cyan("│") + "   " + chalk.green(repoPath));
  console.log(chalk.cyan("│"));
  console.log(chalk.cyan("│") + " Shell: " + chalk.dim(shell.cmd));
  console.log(chalk.cyan("│") + " Type " + chalk.bold.yellow("exit") + " (or press " + chalk.bold.yellow("Ctrl+D") + ") to leave this subshell");
  console.log(chalk.cyan("│") + " and return to your previous shell and directory.");
  console.log(chalk.cyan.bold("└───────────────────────────────────────────────────────"));

  const child = spawn(shell.cmd, shell.args, {
    cwd: repoPath,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error(
      chalk.red("Error:") +
        ` Failed to spawn shell '${shell.cmd}': ${err.message}\n` +
        `  Set \`cdShell\` in ~/.rotunda.json to override.`,
    );
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}
