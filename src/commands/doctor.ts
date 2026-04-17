import { access, readFile, readdir, constants, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { join, normalize, dirname } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { loadManifest, RotundaError } from "../core/manifest.js";
import { loadState, saveState, getStatePath, removeFromState } from "../core/state.js";
import { discoverFiles } from "../core/engine.js";
import { isGitRepo, gitStatus } from "../utils/git.js";
import { shouldInclude } from "../utils/glob.js";
import { loadToken } from "../llm/auth.js";
import { ask } from "../llm/copilot.js";
import type { DoctorCheck, CheckStatus, Manifest, SyncState } from "../core/types.js";

// ── Formatting helpers ───────────────────────────────────────────────

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: chalk.green("✅"),
  warn: chalk.yellow("⚠️"),
  fail: chalk.red("❌"),
};

const LABEL_WIDTH = 22;

function padLabel(name: string): string {
  const dots = ".".repeat(Math.max(1, LABEL_WIDTH - name.length));
  return `${name} ${dots}`;
}

function formatCheck(check: DoctorCheck): string {
  const icon = STATUS_ICON[check.status];
  const lines = [`  ${padLabel(check.name)} ${icon} ${check.message}`];
  if (check.details?.length) {
    for (const d of check.details) {
      lines.push(`      ${chalk.dim(d)}`);
    }
  }
  return lines.join("\n");
}

function check(name: string, status: CheckStatus, message: string, details?: string[]): DoctorCheck {
  return { name, status, message, details };
}

// ── Individual checks ────────────────────────────────────────────────

function checkManifest(repoPath: string): DoctorCheck {
  try {
    const manifest = loadManifest(repoPath);
    const machineSuffix = manifest.appliedMachine
      ? `, applied overrides for: ${manifest.appliedMachine}`
      : "";
    return check(
      "Manifest",
      "pass",
      `rotunda.json valid (${manifest.roots.length} root${manifest.roots.length !== 1 ? "s" : ""}, ${manifest.globalExclude.length} global excludes${machineSuffix})`,
    );
  } catch (err) {
    const msg = err instanceof RotundaError ? err.message : String(err);
    return check("Manifest", "fail", msg);
  }
}

async function checkState(repoPath: string): Promise<DoctorCheck> {
  const statePath = getStatePath(repoPath);
  try {
    await access(statePath);
  } catch {
    return check("State", "warn", "state.json not found (run sync first)");
  }

  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as SyncState;
    if (!parsed.lastSync || typeof parsed.files !== "object") {
      return check("State", "fail", "state.json has invalid structure");
    }
    const count = Object.keys(parsed.files).length;
    return check("State", "pass", `state.json valid (${count} tracked file${count !== 1 ? "s" : ""})`);
  } catch {
    return check("State", "fail", "state.json is not valid JSON");
  }
}

async function checkRepoStructure(manifest: Manifest, repoPath: string): Promise<DoctorCheck> {
  const missing: string[] = [];
  for (const root of manifest.roots) {
    const dir = join(repoPath, root.repo);
    try {
      await access(dir);
    } catch {
      missing.push(`${root.name} → ${root.repo}`);
    }
  }
  if (missing.length) {
    return check("Repo structure", "fail", `${missing.length} repo dir${missing.length !== 1 ? "s" : ""} missing`, missing);
  }
  return check("Repo structure", "pass", `all ${manifest.roots.length} repo dirs exist`);
}

async function checkLocalStructure(manifest: Manifest): Promise<DoctorCheck> {
  const missing: string[] = [];
  for (const root of manifest.roots) {
    try {
      await access(root.local);
    } catch {
      missing.push(`${root.name} → ${root.local}`);
    }
  }
  if (missing.length) {
    return check("Local structure", "warn", `${missing.length} local dir${missing.length !== 1 ? "s" : ""} missing`, missing);
  }
  return check("Local structure", "pass", `all ${manifest.roots.length} local dirs exist`);
}

async function checkOrphans(manifest: Manifest): Promise<DoctorCheck> {
  const orphans: string[] = [];
  for (const root of manifest.roots) {
    let entries: string[];
    try {
      entries = await readdirRecursive(root.local);
    } catch {
      continue; // dir doesn't exist — caught by local structure check
    }
    for (const relPath of entries) {
      if (!shouldInclude(relPath, root.include, root.exclude, manifest.globalExclude)) {
        continue; // properly excluded
      }
      // File passes include filters — it's tracked. Not an orphan.
    }
    // Orphans are files that exist but are NOT matched by include patterns
    if (root.include.length === 0) continue; // no include filter means everything is tracked
    for (const relPath of entries) {
      if (shouldInclude(relPath, root.include, root.exclude, manifest.globalExclude)) {
        continue; // tracked
      }
      // Excluded files are not orphans — only files that pass exclude but fail include
      if (root.exclude.length > 0 || manifest.globalExclude.length > 0) {
        if (!shouldInclude(relPath, [], root.exclude, manifest.globalExclude)) {
          continue; // properly excluded
        }
      }
      orphans.push(`${root.name}: ${relPath}`);
    }
  }
  if (orphans.length) {
    const shown = orphans.slice(0, 10);
    const extra = orphans.length > 10 ? [`... and ${orphans.length - 10} more`] : [];
    return check("Orphan detection", "warn", `${orphans.length} untracked file${orphans.length !== 1 ? "s" : ""} in local dirs`, [...shown, ...extra]);
  }
  return check("Orphan detection", "pass", "no untracked files in local dirs");
}

async function readdirRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = full.slice(dir.length + 1).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      const sub = await readdirRecursive(full);
      results.push(...sub.map((s) => `${rel}/${s}`));
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
  return results;
}

async function checkStateDrift(manifest: Manifest, repoPath: string, state: SyncState): Promise<DoctorCheck> {
  const drifted: string[] = [];
  for (const [stateKey] of Object.entries(state.files)) {
    // State keys are "repoDir/relativePath"
    const matchingRoot = manifest.roots.find((r) => stateKey.startsWith(r.repo + "/"));
    if (!matchingRoot) {
      drifted.push(`no root for ${stateKey}`);
      continue;
    }
    const relPath = stateKey.slice(matchingRoot.repo.length + 1);
    const localPath = join(matchingRoot.local, relPath);
    const repoFilePath = join(repoPath, stateKey);

    const [localExists, repoExists] = await Promise.all([
      access(localPath).then(() => true, () => false),
      access(repoFilePath).then(() => true, () => false),
    ]);

    if (!localExists && !repoExists) {
      drifted.push(stateKey);
    }
  }
  if (drifted.length) {
    const shown = drifted.slice(0, 10);
    const extra = drifted.length > 10 ? [`... and ${drifted.length - 10} more`] : [];
    return check("State drift", "warn", `${drifted.length} stale state entr${drifted.length !== 1 ? "ies" : "y"}`, [...shown, ...extra]);
  }
  return check("State drift", "pass", "all state entries have corresponding files");
}

async function checkGitStatus(manifest: Manifest, repoPath: string): Promise<DoctorCheck> {
  if (!(await isGitRepo(repoPath))) {
    return check("Git status", "warn", "not a git repository");
  }
  const repoPaths = manifest.roots.map((r) => r.repo);
  const status = await gitStatus(repoPath, repoPaths);
  if (status) {
    const lines = status.split("\n").filter(Boolean);
    const shown = lines.slice(0, 5);
    const extra = lines.length > 5 ? [`... and ${lines.length - 5} more`] : [];
    return check("Git status", "warn", `${lines.length} uncommitted change${lines.length !== 1 ? "s" : ""} in managed paths`, [...shown, ...extra]);
  }
  return check("Git status", "pass", "working tree clean for managed paths");
}

async function checkIgnoreCoverage(manifest: Manifest, repoPath: string): Promise<DoctorCheck> {
  const issues: string[] = [];
  for (const root of manifest.roots) {
    const allExcludes = [...root.exclude, ...manifest.globalExclude];
    if (allExcludes.length === 0) continue;

    // Check repo side
    const repoDir = join(repoPath, root.repo);
    let allRepoFiles: string[];
    try {
      allRepoFiles = await readdirRecursive(repoDir);
    } catch {
      continue;
    }

    const includedWithExcludes = allRepoFiles.filter((f) =>
      shouldInclude(f, root.include, root.exclude, manifest.globalExclude),
    );
    const includedWithout = allRepoFiles.filter((f) =>
      shouldInclude(f, root.include, [], []),
    );
    const excluded = includedWithout.length - includedWithExcludes.length;
    if (excluded > 0) {
      issues.push(`${root.name}: ${excluded} file${excluded !== 1 ? "s" : ""} excluded by patterns`);
    }
  }
  if (issues.length) {
    return check("Ignore coverage", "pass", "exclude patterns are active", issues);
  }
  if (manifest.globalExclude.length === 0 && manifest.roots.every((r) => r.exclude.length === 0)) {
    return check("Ignore coverage", "warn", "no exclude patterns configured");
  }
  return check("Ignore coverage", "pass", "exclude patterns configured (no files matched)");
}

function checkCrossRootConflicts(manifest: Manifest, repoPath: string): DoctorCheck {
  const conflicts: string[] = [];
  const roots = manifest.roots;
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = normalize(join(repoPath, roots[i].repo)).replace(/\\/g, "/") + "/";
      const b = normalize(join(repoPath, roots[j].repo)).replace(/\\/g, "/") + "/";
      if (a.startsWith(b) || b.startsWith(a)) {
        conflicts.push(`${roots[i].name} (${roots[i].repo}) ↔ ${roots[j].name} (${roots[j].repo})`);
      }

      const la = normalize(roots[i].local).replace(/\\/g, "/") + "/";
      const lb = normalize(roots[j].local).replace(/\\/g, "/") + "/";
      if (la.startsWith(lb) || lb.startsWith(la)) {
        conflicts.push(`${roots[i].name} (${roots[i].local}) ↔ ${roots[j].name} (${roots[j].local})`);
      }
    }
  }
  if (conflicts.length) {
    return check("Cross-root conflicts", "fail", `${conflicts.length} overlapping path${conflicts.length !== 1 ? "s" : ""}`, conflicts);
  }
  return check("Cross-root conflicts", "pass", "no overlapping paths between roots");
}

async function checkPermissions(manifest: Manifest): Promise<DoctorCheck> {
  const issues: string[] = [];
  for (const root of manifest.roots) {
    try {
      await access(root.local, constants.R_OK | constants.W_OK);
    } catch {
      // Check if it exists at all
      try {
        await access(root.local);
        issues.push(`${root.name}: ${root.local} — not readable/writable`);
      } catch {
        // dir doesn't exist — reported by local structure check
      }
    }
  }
  if (issues.length) {
    return check("Permissions", "fail", `${issues.length} dir${issues.length !== 1 ? "s" : ""} with permission issues`, issues);
  }
  return check("Permissions", "pass", "all local dirs are readable/writable");
}

// ── Prompt helper ────────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── LLM fix prompts ──────────────────────────────────────────────────

function buildDoctorFixSystemPrompt(): string {
  return `You are a CLI repair assistant for "rotunda", a bidirectional config sync tool.

The user ran \`rotunda doctor\` and got warnings/errors. You analyze the issues and
produce a JSON array of fix actions. Each fix is one of these types:

- { "type": "delete_file", "path": "<absolute path>", "reason": "<why>" }
- { "type": "delete_dir", "path": "<absolute path>", "reason": "<why>" }
- { "type": "create_dir", "path": "<absolute path>", "reason": "<why>" }
- { "type": "remove_state_entry", "key": "<state key>", "reason": "<why>" }
- { "type": "git_commit", "paths": ["<path>", ...], "message": "<commit msg>", "reason": "<why>" }
- { "type": "write_file", "path": "<absolute path>", "content": "<file content>", "reason": "<why>" }
- { "type": "manual", "instruction": "<what the user should do>", "reason": "<why>" }

Rules:
- Only fix issues that are clearly safe. When in doubt, use "manual".
- Never delete files that might contain user data without using "manual".
- For state drift (stale entries), use "remove_state_entry".
- For missing repo/local dirs, use "create_dir".
- For uncommitted git changes, use "git_commit".
- For permission issues, use "manual" (requires OS-level intervention).
- For cross-root conflicts, use "manual" (requires manifest redesign).

Output ONLY the JSON array, no markdown fences, no explanation.
If no fixes are possible, output \`[]\`.`;
}

function buildDoctorFixUserPrompt(
  checks: DoctorCheck[],
  repoPath: string,
  manifest?: Manifest,
): string {
  const issues = checks.filter((c) => c.status !== "pass");
  const lines: string[] = [
    `Repo path: ${repoPath}`,
    "",
    "Doctor results with issues:",
    "",
  ];

  for (const c of issues) {
    lines.push(`[${c.status.toUpperCase()}] ${c.name}: ${c.message}`);
    if (c.details?.length) {
      for (const d of c.details) {
        lines.push(`  - ${d}`);
      }
    }
  }

  if (manifest) {
    lines.push("");
    lines.push("Manifest roots:");
    for (const root of manifest.roots) {
      lines.push(`  ${root.name}: local=${root.local} repo=${root.repo}`);
    }
  }

  lines.push("");
  lines.push("Suggest fixes as a JSON array of actions.");
  return lines.join("\n");
}

// ── Fix action types ─────────────────────────────────────────────────

interface FixAction {
  type: "delete_file" | "delete_dir" | "create_dir" | "remove_state_entry" | "git_commit" | "write_file" | "manual";
  path?: string;
  paths?: string[];
  key?: string;
  content?: string;
  message?: string;
  instruction?: string;
  reason: string;
}

async function applyFix(action: FixAction, repoPath: string, state: SyncState | undefined): Promise<boolean> {
  switch (action.type) {
    case "create_dir":
      if (!action.path) return false;
      await mkdir(action.path, { recursive: true });
      console.log(chalk.green("    ✓") + ` Created directory: ${action.path}`);
      return true;

    case "delete_file":
      if (!action.path) return false;
      await rm(action.path, { force: true });
      console.log(chalk.green("    ✓") + ` Deleted file: ${action.path}`);
      return true;

    case "delete_dir":
      if (!action.path) return false;
      await rm(action.path, { recursive: true, force: true });
      console.log(chalk.green("    ✓") + ` Deleted directory: ${action.path}`);
      return true;

    case "remove_state_entry":
      if (!action.key || !state) return false;
      delete state.files[action.key];
      await saveState(repoPath, state);
      console.log(chalk.green("    ✓") + ` Removed state entry: ${action.key}`);
      return true;

    case "git_commit":
      if (!action.paths?.length || !action.message) return false;
      try {
        const { git } = await import("../utils/git.js");
        await git(["add", ...action.paths], repoPath);
        await git(["commit", "-m", action.message], repoPath);
        console.log(chalk.green("    ✓") + ` Committed: "${action.message}"`);
        return true;
      } catch {
        console.log(chalk.yellow("    ⚠") + ` Git commit failed — commit manually`);
        return false;
      }

    case "write_file":
      if (!action.path || action.content === undefined) return false;
      await mkdir(dirname(action.path), { recursive: true });
      await writeFile(action.path, action.content, "utf-8");
      console.log(chalk.green("    ✓") + ` Wrote file: ${action.path}`);
      return true;

    case "manual":
      console.log(chalk.cyan("    ℹ") + ` Manual action needed: ${action.instruction}`);
      return false;

    default:
      console.log(chalk.yellow("    ⚠") + ` Unknown fix type: ${(action as FixAction).type}`);
      return false;
  }
}

// ── Main command ─────────────────────────────────────────────────────

export async function doctorCommand(options: { fix?: boolean }): Promise<void> {
  const repoPath = process.cwd();
  const checks: DoctorCheck[] = [];

  // 1. Manifest check (synchronous, needed for subsequent checks)
  const manifestCheck = checkManifest(repoPath);
  checks.push(manifestCheck);

  let manifest: Manifest | undefined;
  let state: SyncState | undefined;

  if (manifestCheck.status !== "fail") {
    manifest = loadManifest(repoPath);

    // 2. State file
    const stateCheck = await checkState(repoPath);
    checks.push(stateCheck);

    // Load state for drift check
    if (stateCheck.status !== "fail") {
      state = await loadState(repoPath);
    }

    // 3–10: Run remaining checks in parallel where possible
    const [
      repoStructure,
      localStructure,
      orphans,
      stateDrift,
      gitStatusResult,
      ignoreCoverage,
      permissions,
    ] = await Promise.all([
      checkRepoStructure(manifest, repoPath),
      checkLocalStructure(manifest),
      checkOrphans(manifest),
      state
        ? checkStateDrift(manifest, repoPath, state)
        : Promise.resolve(check("State drift", "warn", "no state file to check")),
      checkGitStatus(manifest, repoPath),
      checkIgnoreCoverage(manifest, repoPath),
      checkPermissions(manifest),
    ]);

    checks.push(repoStructure);
    checks.push(localStructure);
    checks.push(orphans);
    checks.push(stateDrift);
    checks.push(gitStatusResult);
    checks.push(ignoreCoverage);

    // Cross-root conflicts (synchronous)
    checks.push(checkCrossRootConflicts(manifest, repoPath));

    checks.push(permissions);
  } else {
    // Manifest failed — still run the remaining checks as skipped
    const names = [
      "State", "Repo structure", "Local structure", "Orphan detection",
      "State drift", "Git status", "Ignore coverage", "Cross-root conflicts", "Permissions",
    ];
    for (const name of names) {
      checks.push(check(name, "warn", "skipped (manifest not available)"));
    }
  }

  // ── Output ──────────────────────────────────────────────────────────

  console.log();
  for (const c of checks) {
    console.log(formatCheck(c));
  }
  console.log();

  const errors = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const passed = checks.filter((c) => c.status === "pass").length;

  const parts: string[] = [];
  if (errors) parts.push(chalk.red(`${errors} error${errors !== 1 ? "s" : ""}`));
  if (warnings) parts.push(chalk.yellow(`${warnings} warning${warnings !== 1 ? "s" : ""}`));
  if (passed) parts.push(chalk.green(`${passed} passed`));

  console.log(`  Summary: ${parts.join(", ")}`);
  console.log();

  // ── --fix: LLM-assisted repair ─────────────────────────────────────

  if (options.fix && (errors > 0 || warnings > 0)) {
    const token = await loadToken();
    if (!token) {
      console.log(chalk.yellow("  ⚠ --fix requires GitHub auth. Run `rotunda auth` first."));
      console.log(chalk.dim("    (Without auth, doctor can only report issues, not fix them.)"));
      return;
    }

    console.log(chalk.bold("  🔧 Analyzing issues with Copilot...\n"));

    try {
      const systemPrompt = buildDoctorFixSystemPrompt();
      const userPrompt = buildDoctorFixUserPrompt(checks, repoPath, manifest);
      const response = await ask(token, systemPrompt, userPrompt);

      let fixes: FixAction[];
      try {
        fixes = JSON.parse(response) as FixAction[];
      } catch {
        // LLM may have wrapped in markdown fences
        const cleaned = response.replace(/```json?\n?/g, "").replace(/```\n?/g, "").trim();
        fixes = JSON.parse(cleaned) as FixAction[];
      }

      if (!Array.isArray(fixes) || fixes.length === 0) {
        console.log(chalk.dim("  No automated fixes suggested. Issues may require manual intervention."));
        return;
      }

      console.log(chalk.bold(`  ${fixes.length} fix${fixes.length !== 1 ? "es" : ""} suggested:\n`));

      for (let i = 0; i < fixes.length; i++) {
        const fix = fixes[i];
        const typeLabel =
          fix.type === "manual" ? chalk.cyan("MANUAL") :
          fix.type === "delete_file" || fix.type === "delete_dir" ? chalk.red(fix.type) :
          chalk.green(fix.type);

        console.log(`  ${chalk.bold(`${i + 1}.`)} ${typeLabel}`);
        console.log(`     ${chalk.dim(fix.reason)}`);
        if (fix.path) console.log(`     Path: ${fix.path}`);
        if (fix.key) console.log(`     Key: ${fix.key}`);
        if (fix.instruction) console.log(`     ${fix.instruction}`);

        if (fix.type === "manual") {
          console.log();
          continue;
        }

        const answer = await prompt(`     Apply this fix? [y/N/s(kip all)] `);
        if (answer.toLowerCase() === "s") {
          console.log(chalk.dim("     Skipping remaining fixes."));
          break;
        }
        if (answer.toLowerCase() === "y") {
          await applyFix(fix, repoPath, state);
        } else {
          console.log(chalk.dim("     Skipped."));
        }
        console.log();
      }

      console.log(chalk.green("  ✓ Fix review complete."));
      console.log(chalk.dim("    Run `rotunda doctor` again to verify."));
    } catch (err) {
      console.log(chalk.red(`  ✗ LLM analysis failed: ${err}`));
      console.log(chalk.dim("    Fix issues manually based on the doctor output above."));
    }
  } else if (options.fix && errors === 0 && warnings === 0) {
    console.log(chalk.green("  ✓ Nothing to fix — all checks passed!"));
  }
}
