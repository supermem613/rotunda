import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadRepoContext } from "../core/repo-context.js";
import { loadManifestDocument, RotundaError } from "../core/manifest.js";
import {
  applyTrackingPlan,
  findMatchingRootForTarget,
  planTrackingPathChange,
  resolveTrackingTarget,
  suggestNewRootName,
  type TrackingOperation,
  type TrackingPlan,
} from "../core/include-glob.js";
import { loadState } from "../core/state.js";
import { isGitRepo } from "../utils/git.js";
import { withLock } from "../utils/lock.js";
import { resolveBackend } from "../utils/vcs.js";

type PromptSession = {
  promptLine(question: string): Promise<string>;
  close(): void;
};

async function createPromptSession(): Promise<PromptSession> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const answers = Buffer.concat(chunks).toString("utf-8").replace(/\r\n/g, "\n").split("\n");
    let index = 0;
    return {
      async promptLine(question: string): Promise<string> {
        process.stdout.write(question);
        const answer = answers[index] ?? "";
        index += 1;
        return answer.trim();
      },
      close(): void {},
    };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    promptLine(question: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer.trim());
        });
      });
    },
    close(): void {
      rl.close();
    },
  };
}

async function confirm(promptSession: PromptSession, prompt: string): Promise<boolean> {
  const answer = await promptSession.promptLine(prompt);
  return answer.toLowerCase().startsWith("y");
}

async function promptForRootName(
  promptSession: PromptSession,
  suggestedName: string,
  existingNames: Set<string>,
): Promise<string> {
  while (true) {
    const answer = await promptSession.promptLine(
      `  No existing root matches this path. Root name [${suggestedName}]: `,
    );
    const rootName = answer || suggestedName;
    if (existingNames.has(rootName)) {
      console.log(chalk.yellow(`  ⚠ Root "${rootName}" already exists. Pick a different name.`));
      continue;
    }
    return rootName;
  }
}

function renderExistingRootTarget(plan: TrackingPlan): void {
  console.log(`    ${chalk.dim("root")}   ${plan.rootName}`);
  console.log(`    ${chalk.dim("local")}  ${plan.rootManifestLocal}`);
  console.log(`    ${chalk.dim("repo")}   ${plan.rootRepo}`);
}

function classifyGitPathPreview(plan: TrackingPlan, cwd: string, gitPath: string): "add" | "update" | "remove" {
  const removedGitPaths = new Set(plan.repoDeletes.map((entry) => entry.repoPath.replace(/\\/g, "/")));
  if (removedGitPaths.has(gitPath)) {
    return "remove";
  }

  const repoCopy = plan.repoCopies.find((entry) => entry.repoPath.replace(/\\/g, "/") === gitPath);
  if (repoCopy) {
    return repoCopy.status === "create" ? "add" : "update";
  }

  return existsSync(join(cwd, gitPath)) ? "update" : "add";
}

function renderPreview(plan: TrackingPlan, cwd: string): void {
  console.log(chalk.bold(`\n  rotunda ${plan.kind} ${plan.target.absolutePath}\n`));

  console.log(chalk.bold("  rotunda.json:"));
  switch (plan.manifestMutation.kind) {
    case "create-root":
      console.log(`    ${chalk.green("create root")}  ${plan.rootName}`);
      console.log(`    ${chalk.dim("local")}  ${plan.manifestMutation.local}`);
      console.log(`    ${chalk.dim("repo")}   ${plan.manifestMutation.repo}`);
      console.log(`    ${chalk.dim("include +")} ${plan.manifestMutation.pattern}`);
      break;
    case "add-include":
      renderExistingRootTarget(plan);
      console.log(`    ${chalk.green("include +")}  ${plan.manifestMutation.pattern}`);
      break;
    case "remove-include":
      renderExistingRootTarget(plan);
      console.log(`    ${chalk.red("include -")}  ${plan.manifestMutation.pattern}`);
      break;
    case "add-exclude":
      renderExistingRootTarget(plan);
      console.log(`    ${chalk.red("exclude +")}  ${plan.manifestMutation.pattern}`);
      break;
    case "remove-root":
      console.log(`    ${chalk.red("remove root")}  ${plan.rootName}`);
      console.log(`    ${chalk.dim("local")}  ${plan.manifestMutation.local}`);
      console.log(`    ${chalk.dim("repo")}   ${plan.manifestMutation.repo}`);
      break;
  }

  if (plan.pruneEmptyDirsChange !== undefined) {
    const v = plan.pruneEmptyDirsChange;
    if (v === false) {
      console.log(`    ${chalk.yellow("unset")} pruneEmptyDirs`);
    } else if (v === true) {
      console.log(`    ${chalk.green("set")} pruneEmptyDirs = true`);
    } else {
      console.log(`    ${chalk.green("set")} pruneEmptyDirs = [${v.join(", ")}]`);
    }
  }

  if (plan.repoOnlyMatches.length > 0) {
    console.log(chalk.bold("\n  Notes:"));
    for (const displayPath of plan.repoOnlyMatches) {
      console.log(`    ${chalk.blue("repo-only")}  ${displayPath}${chalk.dim(" (left unchanged)")}`);
    }
  }

  console.log(chalk.bold("\n  Dotfiles repo changes:"));
  console.log(`    ${chalk.cyan("commit")}  ${plan.commitMessage}`);
  for (const gitPath of plan.gitPaths.map((path) => path.replace(/\\/g, "/"))) {
    const action = classifyGitPathPreview(plan, cwd, gitPath);
    const verb = action === "remove"
      ? chalk.red("remove")
      : action === "update"
        ? chalk.yellow("update")
        : chalk.cyan("add");
    console.log(`    ${verb}  ${gitPath}`);
  }
}

export async function runIncludeLifecycleCommand(
  kind: TrackingOperation,
  pathInput: string,
  options: { pruneEmptyDirs?: boolean | string[] } = {},
): Promise<void> {
  const invocationCwd = process.cwd();
  const { cwd, manifest } = loadRepoContext();
  let backend = resolveBackend(cwd);
  const promptSession = await createPromptSession();

  try {
    await withLock(cwd, kind, async () => {
      if (await isGitRepo(cwd)) {
        try {
          const pulled = await backend.pull(cwd);
          if (pulled) {
            console.log(chalk.dim("  ↓ Pulled latest from remote."));
            // A pull can change the manifest's vcs field, so re-resolve the
            // backend to publish through the backend the repo now declares.
            backend = resolveBackend(cwd);
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.log(chalk.yellow("  ⚠ Pull failed — continuing with local state."));
          console.log(chalk.dim("    " + detail.split("\n").join("\n    ")));
        }
      }

      try {
        const manifestDocument = loadManifestDocument(cwd);
        const state = await loadState(cwd);
        const target = await resolveTrackingTarget(pathInput, invocationCwd);

        let newRootName: string | undefined;
        if (kind === "add" && !findMatchingRootForTarget(manifest, manifestDocument, target.absolutePath)) {
          newRootName = await promptForRootName(
            promptSession,
            suggestNewRootName(target),
            new Set(manifestDocument.roots.map((root) => root.name)),
          );
        }

        const plan = await planTrackingPathChange(
          cwd,
          manifest,
          manifestDocument,
          state,
          target,
          kind,
          newRootName,
          options.pruneEmptyDirs,
        );

        renderPreview(plan, cwd);
        console.log();

        const ok = await confirm(promptSession, `  Proceed with ${kind}? [y/N] `);
        if (!ok) {
          console.log(chalk.dim("  Cancelled — no changes applied."));
          return;
        }

        const result = await applyTrackingPlan(cwd, plan, state);
        console.log();
        console.log(chalk.green("  ✓") + " Updated rotunda.json");

        if (result.gitPaths.length > 0 && await isGitRepo(cwd)) {
          try {
            await backend.publish(cwd, result.gitPaths, plan.commitMessage);
            console.log(chalk.green(`  ✓ Committed and pushed: "${plan.commitMessage}"`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.yellow("  ⚠ Changes applied but git commit/push failed. Commit manually."));
            console.log(chalk.dim("    " + msg.split("\n").join("\n    ")));
          }
        }

        console.log(chalk.green(`  ✓ ${kind === "add" ? "Add" : "Remove"} complete.`));
      } catch (err) {
        if (err instanceof RotundaError) {
          console.error(chalk.red("Error:") + " " + err.message);
          return;
        }
        throw err;
      }
    });
  } finally {
    promptSession.close();
  }
}
