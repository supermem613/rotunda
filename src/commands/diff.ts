import chalk from "chalk";
import { loadRepoContext } from "../core/repo-context.js";
import { loadState } from "../core/state.js";
import { computeAllChanges } from "../core/engine.js";
import { renderContentDiff } from "../utils/git.js";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileChange } from "../core/types.js";

const execFileAsync = promisify(execFile);

export async function diffCommand(
  root: string | undefined,
  options: { stat?: boolean; nameOnly?: boolean; open?: boolean; html?: boolean }
): Promise<void> {
  const { cwd, manifest } = loadRepoContext();

  const state = await loadState(cwd);
  let changes = await computeAllChanges(manifest, cwd, state);

  // Filter by root if specified (accepts either root name or repo path)
  if (root) {
    changes = changes.filter((c) => c.rootName === root || manifest.roots.some((r) => r.name === root && r.repo === c.rootName));
    if (changes.length === 0) {
      console.log(chalk.green("✓") + ` No changes in root '${root}'.`);
      return;
    }
  }

  if (changes.length === 0) {
    console.log(chalk.green("✓") + " No changes to diff.");
    return;
  }

  // --name-only: just list paths
  if (options.nameOnly) {
    for (const c of changes) {
      console.log(`${c.rootName}/${c.relativePath}`);
    }
    return;
  }

  // --stat: summary only
  if (options.stat) {
    const counts = { added: 0, modified: 0, deleted: 0, conflict: 0 };
    for (const c of changes) counts[c.action]++;
    console.log(`${changes.length} files changed: ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.conflict} conflicts`);
    return;
  }

  // --open: open in VS Code
  if (options.open) {
    for (const c of changes) {
      const rootDef = manifest.roots.find((r) => r.repo === c.rootName);
      if (!rootDef) continue;
      const localFile = join(rootDef.local, c.relativePath);
      const repoFile = join(cwd, rootDef.repo, c.relativePath);

      if (c.action === "modified" || c.action === "conflict") {
        await execFileAsync("code", ["--diff", repoFile, localFile]);
      } else if (c.action === "added") {
        const file = c.side === "local" ? localFile : repoFile;
        await execFileAsync("code", [file]);
      }
    }
    return;
  }

  // Default: terminal diff using git diff --no-index
  const byRoot = new Map<string, FileChange[]>();
  for (const c of changes) {
    const group = byRoot.get(c.rootName) ?? [];
    group.push(c);
    byRoot.set(c.rootName, group);
  }

  for (const [rootName, rootChanges] of byRoot) {
    console.log(chalk.bold(`\n── ${rootName} ${"─".repeat(Math.max(0, 55 - rootName.length))}`));

    const rootDef = manifest.roots.find((r) => r.repo === rootName);
    if (!rootDef) continue;

    for (const c of rootChanges) {
      const localFile = join(rootDef.local, c.relativePath);
      const repoFile = join(cwd, rootDef.repo, c.relativePath);

      if (c.action === "modified" || c.action === "conflict") {
        try {
          const diff = await renderContentDiff(repoFile, localFile, {
            color: true,
            file1Role: "repo",
            file2Role: "local",
          });
          if (diff) console.log(diff);
        } catch {
          console.log(chalk.dim(`  (could not diff ${c.relativePath})`));
        }
      } else if (c.action === "added") {
        const label = c.side === "local" ? "added locally" : "added in repo";
        console.log(chalk.green(`  + ${c.relativePath} (${label})`));
      } else if (c.action === "deleted") {
        const label = c.side === "local" ? "deleted locally" : "deleted in repo";
        console.log(chalk.red(`  - ${c.relativePath} (${label})`));
      }
    }
  }

  console.log();
}
