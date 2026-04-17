import chalk from "chalk";
import { loadRepoContext } from "../core/repo-context.js";
import { loadState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import type { FileChange } from "../core/types.js";

const ACTION_LABELS: Record<string, string> = {
  added: chalk.green("added"),
  modified: chalk.yellow("modified"),
  deleted: chalk.red("deleted"),
  conflict: chalk.magenta("CONFLICT"),
};

const SIDE_LABELS: Record<string, string> = {
  local: "local",
  repo: "repo",
  both: "both sides",
};

export async function statusCommand(): Promise<void> {
  const { cwd, manifest } = loadRepoContext();

  const state = await loadState(cwd);
  const changes = await computeAllChanges(manifest, cwd, state);

  if (changes.length === 0) {
    console.log(chalk.green("✓") + " Everything in sync. No changes detected.");
    return;
  }

  // Group by root
  const byRoot = new Map<string, FileChange[]>();
  for (const change of changes) {
    const group = byRoot.get(change.rootName) ?? [];
    group.push(change);
    byRoot.set(change.rootName, group);
  }

  console.log(
    chalk.bold(`\n  ${changes.length} change(s) detected:\n`)
  );

  for (const [rootName, rootChanges] of byRoot) {
    console.log(chalk.bold.cyan(`  [${rootName}]`));
    for (const change of rootChanges) {
      const action = ACTION_LABELS[change.action] ?? change.action;
      const side = SIDE_LABELS[change.side] ?? change.side;
      console.log(`    ${action}  ${change.relativePath}  ${chalk.dim(`(${side})`)}`);
    }
    console.log();
  }

  // Summary
  const counts = { added: 0, modified: 0, deleted: 0, conflict: 0 };
  for (const c of changes) {
    counts[c.action]++;
  }

  const parts: string[] = [];
  if (counts.added) parts.push(chalk.green(`${counts.added} added`));
  if (counts.modified) parts.push(chalk.yellow(`${counts.modified} modified`));
  if (counts.deleted) parts.push(chalk.red(`${counts.deleted} deleted`));
  if (counts.conflict) parts.push(chalk.magenta(`${counts.conflict} conflict(s)`));

  console.log(`  Summary: ${parts.join(", ")}`);
}
