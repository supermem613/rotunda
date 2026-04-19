/**
 * Centralised color/label helpers for the sync TUI.
 *
 * Pure: no console writes. The render layer composes strings using these.
 * Keeping this file dependency-light (only chalk) makes layout snapshot
 * tests easy — strip ANSI and compare.
 */

import chalk from "chalk";
import type { ResolvedAction, Row } from "./state.js";

/** Short tag shown in the action column of each row. */
export function actionLabel(action: ResolvedAction): string {
  switch (action) {
    case "push":         return "PUSH →";
    case "pull":         return "← PULL";
    case "delete-local": return "DEL LOC";
    case "delete-repo":  return "DEL REP";
    case "keep-local":   return "KEEP L→";
    case "keep-repo":    return "←KEEP R";
    case "merge":        return "MERGED";
    case "defer":        return "DEFER ⊕";
    case "skip":         return "SKIP   ";
    case "conflict":     return "CONFL ⚠";
  }
}

/** ANSI-coloured action label for the row column. */
export function colorAction(action: ResolvedAction): string {
  const label = actionLabel(action);
  switch (action) {
    case "push":         return chalk.cyan(label);
    case "pull":         return chalk.cyan(label);
    case "delete-local": return chalk.red(label);
    case "delete-repo":  return chalk.red(label);
    case "keep-local":   return chalk.green(label);
    case "keep-repo":    return chalk.green(label);
    case "merge":        return chalk.green(label);
    case "defer":        return chalk.yellow(label);
    case "skip":         return chalk.dim(label);
    case "conflict":     return chalk.magenta(label);
  }
}

/** "what will happen" plain-English suffix for a row. */
export function actionEffect(action: ResolvedAction): string {
  switch (action) {
    case "push":         return "local copy will be pushed to repo";
    case "pull":         return "repo copy will be pulled to local";
    case "delete-local": return "local file will be deleted";
    case "delete-repo":  return "repo file will be removed";
    case "keep-local":   return "conflict resolved → local pushed to repo";
    case "keep-repo":    return "conflict resolved → repo pulled to local";
    case "merge":        return "merged content will be written to both sides";
    case "defer":        return "snapshotted to .rotunda/conflicts/, skipped this run";
    case "skip":         return "no change this run";
    case "conflict":     return "UNRESOLVED — pick a side, merge, or defer";
  }
}

/** Format the row's right-hand label including merge-error annotation. */
export function rowAnnotation(row: Row): string {
  if (row.action === "conflict" && row.mergeError) {
    return chalk.dim("(LLM error: " + row.mergeError + ")");
  }
  if (row.action === "merge") {
    return chalk.dim("(merged content ready)");
  }
  if (row.action === "defer") {
    return chalk.dim("(deferred)");
  }
  return "";
}
