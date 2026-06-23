import chalk from "chalk";
import { join } from "node:path";
import { loadRepoContext } from "../core/repo-context.js";
import { discoverFiles } from "../core/engine.js";

interface ListedFile {
  path: string;
  inLocal: boolean;
  inRepo: boolean;
}

interface RootInventory {
  repo: string;
  local: string;
  include: string[];
  exclude: string[];
  files: ListedFile[];
  counts: InventoryCounts;
}

interface InventoryCounts {
  total: number;
  synced: number;
  localOnly: number;
  repoOnly: number;
}

export async function listCommand(options: { local?: boolean; repo?: boolean }): Promise<void> {
  const { cwd, manifest } = loadRepoContext();

  const showLocal = !options.repo || options.local;  // default: show both
  const showRepo = !options.local || options.repo;
  const roots: RootInventory[] = [];

  for (const root of manifest.roots) {
    const localDir = root.local;
    const repoDir = join(cwd, root.repo);

    const [localFiles, repoFiles] = await Promise.all([
      showLocal
        ? discoverFiles(localDir, root.include, root.exclude, manifest.globalExclude)
        : Promise.resolve(new Map<string, string>()),
      showRepo
        ? discoverFiles(repoDir, root.include, root.exclude, manifest.globalExclude)
        : Promise.resolve(new Map<string, string>()),
    ]);

    const allPaths = new Set([...localFiles.keys(), ...repoFiles.keys()]);
    const files = [...allPaths].sort().map((p) => ({
      path: p,
      inLocal: localFiles.has(p),
      inRepo: repoFiles.has(p),
    }));

    roots.push({
      repo: root.repo,
      local: root.local,
      include: root.include,
      exclude: root.exclude,
      files,
      counts: countInventory(files),
    });
  }

  const totals = roots.reduce<InventoryCounts>((acc, root) => ({
    total: acc.total + root.counts.total,
    synced: acc.synced + root.counts.synced,
    localOnly: acc.localOnly + root.counts.localOnly,
    repoOnly: acc.repoOnly + root.counts.repoOnly,
  }), { total: 0, synced: 0, localOnly: 0, repoOnly: 0 });

  console.log();
  console.log(chalk.bold.cyan(`  ┌─ rotunda inventory`));
  console.log(chalk.dim(`  │  repo:  ${cwd}`));
  console.log(chalk.dim(`  │  roots: ${manifest.roots.length}`));

  console.log(chalk.dim(`  │`));
  console.log(chalk.bold(`  │  roots (${roots.length})`));
  if (roots.length === 0) {
    console.log(chalk.dim(`  │    (none declared)`));
  }

  for (const root of roots) {
    renderRoot(root);
  }

  console.log(chalk.dim(`  │`));
  console.log(chalk.cyan(`  └─ ${roots.length} roots, ${formatCounts(totals)}`));
  console.log();
  console.log(chalk.dim(`  Legend: ${chalk.green("◉")} synced  ${chalk.yellow("◐")} local-only  ${chalk.blue("◑")} repo-only`));
  console.log();
}

function renderRoot(root: RootInventory): void {
  console.log(chalk.dim(`  │`));
  console.log(`  │    ${chalk.green("◉")} ${root.repo.padEnd(28)} ${formatCounts(root.counts)}`);
  console.log(chalk.dim(`  │      local:   ${root.local}`));
  console.log(chalk.dim(`  │      repo:    ${root.repo}`));
  console.log(chalk.dim(`  │      include: ${formatPatterns(root.include)}`));
  console.log(chalk.dim(`  │      exclude: ${formatPatterns(root.exclude)}`));
  console.log(chalk.dim(`  │`));
  console.log(chalk.bold(`  │  files (${root.counts.total})`));

  if (root.files.length === 0) {
    console.log(chalk.dim(`  │    (none captured)`));
    return;
  }

  const width = Math.min(
    48,
    Math.max(16, ...root.files.map((file) => file.path.length)),
  );

  for (const file of root.files) {
    const indicator = fileIndicator(file);
    const status = fileStatus(file);
    console.log(`  │    ${indicator} ${file.path.padEnd(width)} ${status}`);
  }
}

function countInventory(files: ListedFile[]): InventoryCounts {
  const synced = files.filter((file) => file.inLocal && file.inRepo).length;
  const localOnly = files.filter((file) => file.inLocal && !file.inRepo).length;
  const repoOnly = files.filter((file) => !file.inLocal && file.inRepo).length;
  return {
    total: files.length,
    synced,
    localOnly,
    repoOnly,
  };
}

function fileIndicator(file: ListedFile): string {
  if (file.inLocal && file.inRepo) {
    return chalk.green("◉");
  }
  if (file.inLocal) {
    return chalk.yellow("◐");
  }
  return chalk.blue("◑");
}

function fileStatus(file: ListedFile): string {
  if (file.inLocal && file.inRepo) {
    return chalk.green("synced");
  }
  if (file.inLocal) {
    return chalk.yellow("local-only");
  }
  return chalk.blue("repo-only");
}

function formatCounts(counts: InventoryCounts): string {
  const parts: string[] = [];
  if (counts.synced) {
    parts.push(chalk.green(`${counts.synced} synced`));
  }
  if (counts.localOnly) {
    parts.push(chalk.yellow(`${counts.localOnly} local-only`));
  }
  if (counts.repoOnly) {
    parts.push(chalk.blue(`${counts.repoOnly} repo-only`));
  }
  const detail = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  return `${counts.total} files${detail}`;
}

function formatPatterns(patterns: string[]): string {
  return patterns.length > 0 ? patterns.join(", ") : chalk.dim("(none)");
}
