/**
 * LLM-assisted interactive review loop for push/pull operations.
 * For each changed file, the LLM explains the change and the user
 * can approve, reject, reshape, or skip.
 */

import chalk from "chalk";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ask, converse } from "./copilot.js";
import type { ChatMessage } from "./copilot.js";
import { buildExplainPrompt, buildReshapePrompt } from "./prompts.js";
import { gitDiffFiles } from "../utils/git.js";
import type { AuthToken } from "./auth.js";
import type { FileChange, ReviewResult, ReviewDecision, Manifest } from "../core/types.js";

async function readFileContent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Run the LLM-assisted review loop for a list of file changes.
 * Returns an array of ReviewResults indicating the user's decision for each file.
 */
export async function reviewChanges(
  token: AuthToken,
  changes: FileChange[],
  manifest: Manifest,
  repoPath: string,
  direction: "push" | "pull",
): Promise<ReviewResult[]> {
  const results: ReviewResult[] = [];

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const rootDef = manifest.roots.find((r) => r.name === change.rootName);
    if (!rootDef) continue;

    const localFile = join(rootDef.local, change.relativePath);
    const repoFile = join(repoPath, rootDef.repo, change.relativePath);

    // Read file contents
    const localContent = await readFileContent(localFile);
    const repoContent = await readFileContent(repoFile);

    // Compute diff for modified files
    let diff = "";
    if (change.action === "modified" || change.action === "conflict") {
      try {
        diff = await gitDiffFiles(repoFile, localFile);
      } catch {
        diff = "(diff unavailable)";
      }
    }

    // Header
    const actionColor =
      change.action === "added" ? chalk.green :
      change.action === "deleted" ? chalk.red :
      change.action === "conflict" ? chalk.magenta :
      chalk.yellow;

    console.log(
      chalk.bold(`\n  ── ${i + 1}/${changes.length}: ${change.rootName}/${change.relativePath} `) +
      actionColor(`(${change.action})`) +
      chalk.bold(` ${"─".repeat(Math.max(0, 40 - change.relativePath.length))}`)
    );

    // Get LLM explanation
    try {
      const { system, user } = buildExplainPrompt(change, repoContent, localContent, diff);
      const explanation = await ask(token, system, user);
      console.log(`\n  ${chalk.cyan("📝 Copilot Summary:")}`);
      // Indent each line of the explanation
      for (const line of explanation.split("\n")) {
        console.log(`  ${line}`);
      }
    } catch (err) {
      console.log(chalk.yellow("  ⚠ Could not get LLM explanation. Showing raw diff."));
      if (diff) {
        console.log(chalk.dim(diff.split("\n").map((l) => `  ${l}`).join("\n")));
      }
    }

    // Show chunks for modified files
    if (diff && change.action !== "added" && change.action !== "deleted") {
      console.log(`\n  ${chalk.dim("Chunks:")}`);
      for (const line of diff.split("\n").slice(0, 30)) {
        const colored = line.startsWith("+") ? chalk.green(`    ${line}`) :
          line.startsWith("-") ? chalk.red(`    ${line}`) :
          line.startsWith("@@") ? chalk.cyan(`    ${line}`) :
          chalk.dim(`    ${line}`);
        console.log(colored);
      }
      if (diff.split("\n").length > 30) {
        console.log(chalk.dim(`    ... (${diff.split("\n").length - 30} more lines)`));
      }
    }

    // Prompt for decision
    console.log();
    const decision = await promptDecision(change);

    if (decision === "reshape") {
      // Enter reshape loop
      const reshaped = await reshapeLoop(
        token, change, repoContent, localContent, diff
      );
      if (reshaped !== null) {
        results.push({ change, decision: "approve", reshapedContent: reshaped });
        console.log(chalk.green("  ✓ Approved (reshaped)"));
      } else {
        results.push({ change, decision: "reject" });
        console.log(chalk.red("  ✗ Rejected (reshape cancelled)"));
      }
    } else {
      results.push({ change, decision });
      const icon = decision === "approve" ? chalk.green("✓ Approved") :
        decision === "reject" ? chalk.red("✗ Rejected") :
        chalk.dim("⊘ Skipped");
      console.log(`  ${icon}`);
    }
  }

  return results;
}

async function promptDecision(change: FileChange): Promise<ReviewDecision> {
  const choices = change.action === "deleted"
    ? "[a]pprove [r]eject [s]kip"
    : "[a]pprove [r]eject [re]shape [s]kip";

  while (true) {
    const answer = await prompt(`  ${choices} > `);
    switch (answer.toLowerCase()) {
      case "a": case "approve": return "approve";
      case "r": case "reject": return "reject";
      case "re": case "reshape":
        if (change.action === "deleted") {
          console.log(chalk.dim("  (cannot reshape a deletion)"));
          continue;
        }
        return "reshape";
      case "s": case "skip": return "skip";
      default:
        console.log(chalk.dim(`  (enter a, r, re, or s)`));
    }
  }
}

async function reshapeLoop(
  token: AuthToken,
  change: FileChange,
  repoContent: string | null,
  localContent: string | null,
  diff: string,
): Promise<string | null> {
  const history: ChatMessage[] = [];
  let currentContent = localContent ?? "";

  while (true) {
    const instruction = await prompt(chalk.cyan("  Reshape instruction: "));
    if (!instruction || instruction.toLowerCase() === "cancel") {
      return null;
    }

    try {
      const { system, user } = buildReshapePrompt(
        repoContent, currentContent, diff, instruction
      );

      // Use conversation history for iterative reshaping
      if (history.length === 0) {
        history.push({ role: "system", content: system });
      }
      history.push({ role: "user", content: user });

      const reshaped = await converse(token, history);
      history.push({ role: "assistant", content: reshaped });
      currentContent = reshaped;

      // Show a preview of the reshaped content
      const lines = reshaped.split("\n");
      console.log(chalk.dim("\n  Reshaped version:"));
      for (const line of lines.slice(0, 20)) {
        console.log(chalk.dim(`    ${line}`));
      }
      if (lines.length > 20) {
        console.log(chalk.dim(`    ... (${lines.length - 20} more lines)`));
      }

      const confirm = await prompt("\n  [a]pprove reshape, reshape [a]gain, or [c]ancel? > ");
      switch (confirm.toLowerCase()) {
        case "a": case "approve": return currentContent;
        case "c": case "cancel": return null;
        // default: continue reshaping
      }
    } catch (err) {
      console.log(chalk.red(`  ⚠ Reshape failed: ${err}`));
      const retry = await prompt("  [r]etry or [c]ancel? > ");
      if (retry.toLowerCase() === "c") return null;
    }
  }
}
