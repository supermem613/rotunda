import { spawn } from "node:child_process";
import chalk from "chalk";
import {
  resolveRepoRoot,
  loadGlobalConfig,
  pickShell,
} from "../core/config.js";
import { RotundaError } from "../core/manifest.js";

/**
 * `rotunda cd` — drop the user into a subshell rooted at the bound repo.
 *
 * A child process cannot mutate its parent shell's working directory; this
 * is an OS-level invariant on every platform. So `rotunda cd` follows the
 * chezmoi/helmfile pattern: it spawns a fresh interactive shell with the
 * repo as its cwd. The user works in the subshell, then types `exit` to
 * return to where they started.
 *
 * Shell selection (see core/config.ts pickShell):
 *   1. config.cdShell if explicitly set
 *   2. Windows: pwsh → powershell → cmd.exe
 *   3. Unix:    $SHELL → /bin/sh
 */
export function cdCommand(): void {
  let repoPath: string;
  try {
    repoPath = resolveRepoRoot();
  } catch (err) {
    const msg = err instanceof RotundaError ? err.message : String(err);
    console.error(chalk.red("Error:") + " " + msg);
    process.exit(1);
    return;
  }

  const config = loadGlobalConfig();
  const shell = pickShell(config.cdShell);

  console.log(chalk.cyan.bold("┌─ rotunda cd ──────────────────────────────────────────"));
  console.log(chalk.cyan("│") + " You are now in a " + chalk.bold("subshell") + " rooted at the dotfiles repo:");
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
    // Mirror the child's exit. If killed by signal, exit non-zero so callers
    // (and shells) see a failure; we don't bother computing 128+signum because
    // re-raising the signal cleanly is platform-specific and rarely worth it.
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}
