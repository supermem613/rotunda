/**
 * Pure render: (state, viewport) → string.
 *
 * No I/O, no side effects. The screen layer wraps the result in alt-screen
 * escapes and writes once per frame. Snapshot tests strip ANSI and compare
 * against frozen fixtures at multiple terminal sizes.
 */

import chalk from "chalk";
import type { AppState, Row } from "./state.js";
import {
  visibleIndices,
  hasUnresolvedConflicts,
  actionCounts,
  listPageSize,
  diffPageSize,
} from "./state.js";
import { colorAction, actionEffect, rowAnnotation } from "./theme.js";

const ANSI_HIDE_CURSOR = "\x1b[?25l";
// Cursor home: move to (1,1) without clearing the screen first. Each rendered
// line must end with \x1b[K (clear-to-EOL, see EOL below) so stale content is
// overwritten in place as we draw. Avoiding \x1b[2J removes the blank-flash
// between frames and, more importantly, the per-frame full-screen redraw that
// Windows ConPTY charges dearly for — e.g., when exiting a large diff view
// back to the list.
const ANSI_HOME = "\x1b[H";
// Clear-to-end-of-line. Every line in a rendered frame ends with this so
// any longer content from the previous frame at the same row gets erased.
// Exported so all line-producing helpers (padRow, separator, blank pads,
// filter-input overlay) can attach it consistently.
const EOL = "\x1b[K";
// Erase from cursor to end of screen. Appended after the frame as a belt-and-
// suspenders: if a future frame ever renders fewer lines than the previous one,
// the leftover rows below our output still get cleared.
const ANSI_CLEAR_AFTER = "\x1b[J";

/** Top-level renderer chooses between list / diff / preview / filter. */
export function render(state: AppState): string {
  switch (state.view) {
    case "diff":         return renderDiff(state);
    case "preview":      return renderPreview(state);
    case "filter-input": return renderFilterInput(state);
    case "list":
    default:             return renderList(state);
  }
}

/** Convenience: home-cursor + render + erase-below. Used by screen.ts on each tick. */
export function renderFrame(state: AppState): string {
  return ANSI_HOME + ANSI_HIDE_CURSOR + render(state) + ANSI_CLEAR_AFTER;
}

// ────────────────────────────────────────────────────────────
// List view
// ────────────────────────────────────────────────────────────

function renderList(state: AppState): string {
  const cols = state.viewport.cols;
  const lines: string[] = [];

  lines.push(headerLine(state, cols));
  lines.push(filterLine(state, cols));
  lines.push(separator(cols));

  const visible = visibleIndices(state);
  const page = listPageSize(state);
  const start = state.listScroll;
  const end = Math.min(visible.length, start + page);

  if (visible.length === 0) {
    lines.push(padRow(centered("(no rows match current filter)", cols), cols));
    // Pad to page height. EOL on every blank line so it overwrites any
    // leftover content from the previous frame at this row.
    for (let i = 1; i < page; i++) lines.push(EOL);
  } else {
    for (let i = start; i < end; i++) {
      const rowIdx = visible[i];
      lines.push(renderRow(state, state.rows[rowIdx], rowIdx === state.cursor, cols));
    }
    // Pad
    for (let i = end - start; i < page; i++) lines.push(EOL);
  }

  lines.push(separator(cols));
  lines.push(footerLine(state, cols));
  return lines.join("\n");
}

function headerLine(state: AppState, cols: number): string {
  const counts = actionCounts(state);
  const total = state.rows.length;
  const conflicts = counts.conflict;
  const merged = counts.merge;
  const deferred = counts.defer;
  const left = chalk.bold("rotunda sync");
  const summary =
    `${total} row${total === 1 ? "" : "s"} · ` +
    `${chalk.cyan(counts.push + counts.pull + " transfer")} · ` +
    `${chalk.green(counts["keep-local"] + counts["keep-repo"] + merged + " resolved")} · ` +
    `${chalk.magenta(conflicts + " conflict" + (conflicts === 1 ? "" : "s"))} · ` +
    `${chalk.yellow(deferred + " deferred")} · ` +
    `${chalk.dim(counts.skip + " skip")}`;
  return padRow(left + "  " + summary, cols);
}

function filterLine(state: AppState, cols: number): string {
  const parts: string[] = [];
  parts.push(chalk.dim("group:") + state.groupBy);
  parts.push(chalk.dim("filter:") + (state.filter || chalk.dim("(none)")));
  parts.push(chalk.dim("conflicts-only:") + (state.conflictsOnly ? chalk.yellow("on") : chalk.dim("off")));
  return padRow(parts.join("  "), cols);
}

function renderRow(state: AppState, row: Row, isCursor: boolean, cols: number): string {
  const cursor = isCursor ? chalk.cyan("▶ ") : "  ";
  const actionCol = colorAction(row.action);
  const path = row.change.rootName + "/" + row.change.relativePath;
  const sideCol = chalk.dim(`(${row.change.action}/${row.change.side})`);
  const annot = rowAnnotation(row);
  const left = `${cursor}${actionCol}  ${path}  ${sideCol}`;
  // Right-align annotation if it fits.
  const visLen = stripAnsi(left).length + (annot ? stripAnsi(annot).length + 2 : 0);
  let line: string;
  if (annot && visLen <= cols) {
    const padding = " ".repeat(Math.max(1, cols - visLen));
    line = `${left}${padding}${annot}`;
  } else {
    line = left;
  }
  if (isCursor) {
    // Reverse video on the cursor row for clear focus
    return chalk.inverse(padRow(stripAnsi(line), cols));
  }
  return padRow(line, cols);
}

function footerLine(state: AppState, cols: number): string {
  if (state.view !== "list") return "";
  // Two-line footer: primary actions on top (bold), navigation + bulk + per-row
  // details on the second line (dim). The primary line is what the user needs
  // to know to *finish* the session — apply or quit. Everything else is
  // discoverable on the second line.
  const primary = `${chalk.bold.green("[a]")} apply  ·  ${chalk.bold.red("[ESC]")} cancel & quit`;
  const details =
    "↑/↓ move · ←/→ change action · SPACE skip · ENTER diff · m merge · e edit · d defer · " +
    "/ filter · c conflicts · 1 repo-wins · 2 local-wins · 3 skip-all · 4 reset";
  const status = state.message ? "  " + formatStatusForFooter(state.message) : "";
  return padRow(primary + status, cols) + "\n" + padRow(chalk.dim(details), cols);
}

/**
 * Hide internal sentinel messages (__merge__:N etc.) from the footer; the
 * screen layer consumes them and replaces with real status. We still want
 * to render something even before that completes.
 */
function formatStatusForFooter(msg: string): string {
  if (msg.startsWith("__merge__:"))  return chalk.cyan("merging…");
  if (msg.startsWith("__editor__:")) return chalk.cyan("opening editor…");
  if (msg.startsWith("__defer__:"))  return chalk.cyan("deferring…");
  return chalk.yellow(msg);
}

// ────────────────────────────────────────────────────────────
// Diff modal
// ────────────────────────────────────────────────────────────

function renderDiff(state: AppState): string {
  const cols = state.viewport.cols;
  const lines: string[] = [];
  const row = state.rows[state.cursor];

  if (!row) {
    lines.push(padRow(chalk.bold("DIFF — (no row)"), cols));
    return lines.join("\n");
  }

  const path = row.change.rootName + "/" + row.change.relativePath;
  lines.push(padRow(chalk.bold("DIFF — " + path) + "  " + colorAction(row.action), cols));
  lines.push(separator(cols));

  const page = diffPageSize(state);
  // Lines are normalised (CR stripped, tabs expanded) and cached on the row
  // by the reducer's diff-loaded handler, so this render is a pure slice —
  // no per-frame O(N) string work, even for multi-megabyte diffs.
  const diffLines = row.diffLines ?? ["(loading diff…)"];
  const start = Math.min(state.diffScroll, Math.max(0, diffLines.length - page));
  const end = Math.min(diffLines.length, start + page);

  for (let i = start; i < end; i++) {
    const line = diffLines[i];
    if (line.startsWith("+++") || line.startsWith("---")) {
      lines.push(padRow(chalk.bold(line), cols));
    } else if (line.startsWith("+")) {
      lines.push(padRow(chalk.green(line), cols));
    } else if (line.startsWith("-")) {
      lines.push(padRow(chalk.red(line), cols));
    } else if (line.startsWith("@@")) {
      lines.push(padRow(chalk.cyan(line), cols));
    } else {
      lines.push(padRow(chalk.dim(line), cols));
    }
  }
  for (let i = end - start; i < page; i++) lines.push(EOL);

  lines.push(padRow(
    chalk.dim("ESC/q close · ↑/↓ scroll · PgUp/PgDn page · Home/End jump · ←/→ change action · m merge · e edit · d defer"),
    cols,
  ));
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// Apply preview
// ────────────────────────────────────────────────────────────

function renderPreview(state: AppState): string {
  const cols = state.viewport.cols;
  const lines: string[] = [];
  const counts = actionCounts(state);
  const blocked = hasUnresolvedConflicts(state);

  lines.push(padRow(chalk.bold("APPLY PREVIEW"), cols));
  lines.push(separator(cols));
  lines.push(EOL);
  lines.push(padRow("  Pending operations:", cols));
  for (const [action, count] of Object.entries(counts) as [keyof typeof counts, number][]) {
    if (count === 0) continue;
    if (action === "skip") continue;
    lines.push(padRow(`    ${colorAction(action)}  ${count}  — ${chalk.dim(actionEffect(action))}`, cols));
  }
  if (counts.skip > 0) {
    lines.push(padRow(`    ${colorAction("skip")}  ${counts.skip}  — ${chalk.dim("no change this run")}`, cols));
  }
  lines.push(EOL);

  if (blocked) {
    lines.push(padRow("  " + chalk.magenta("⚠ ") +
      `${counts.conflict} unresolved conflict${counts.conflict === 1 ? "" : "s"}.`, cols));
    lines.push(padRow("  " + chalk.dim("Resolve them (←/→/m/e) or press [d] to defer, then re-apply."), cols));
    lines.push(EOL);
    lines.push(padRow("  " + chalk.dim("[ESC/n] back to list   [q] quit without applying"), cols));
  } else {
    lines.push(padRow("  " + chalk.green("All rows resolved."), cols));
    lines.push(EOL);
    lines.push(padRow("  " + chalk.bold.green("[ENTER] apply now") + "   " +
      chalk.bold("[ESC] back to list") + "   " + chalk.dim("[q] quit"), cols));
  }
  // Pad to viewport
  while (lines.length < state.viewport.rows) lines.push(EOL);
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// Filter input
// ────────────────────────────────────────────────────────────

function renderFilterInput(state: AppState): string {
  const cols = state.viewport.cols;
  const lines: string[] = [];
  // Render the underlying list dimmed. stripAnsi eats the per-line \x1b[K,
  // so re-pad through padRow to reattach EOL and the width budget.
  const listFrame = renderList({ ...state, view: "list" }).split("\n");
  for (const l of listFrame) lines.push(padRow(chalk.dim(stripAnsi(l)), cols));
  // Overlay an input box near the bottom
  const prompt = "filter> " + state.filterDraft + chalk.inverse(" ");
  // Replace the second-to-last line with the prompt
  const idx = Math.max(0, lines.length - 2);
  lines[idx] = padRow(chalk.bold(prompt), cols);
  lines[lines.length - 1] = padRow(chalk.dim("ENTER apply · ESC cancel · BACKSPACE delete"), cols);
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function separator(cols: number): string {
  // EOL so this row clears any leftover content from the previous frame.
  return chalk.dim("─".repeat(Math.max(0, cols - 1))) + EOL;
}

function centered(s: string, cols: number): string {
  const visLen = stripAnsi(s).length;
  if (visLen >= cols - 1) return truncateVisible(s, cols - 1);
  const pad = Math.floor((cols - 1 - visLen) / 2);
  return " ".repeat(pad) + s;
}

/**
 * Trim every line to `cols-1` visible chars, append `\x1b[0m` (reset color)
 * + `\x1b[K` (clear to end of line). Two reasons:
 *
 *   1. Many terminals (notably Windows ConPTY / Windows Terminal) auto-wrap
 *      when the cursor reaches column `cols`, not when something is written
 *      past it. Trimming to `cols-1` leaves a one-column safety margin so
 *      a full-width line never causes a wrap that would push the rest of
 *      the frame down a row and visually corrupt the display.
 *
 *   2. `\x1b[K` clears stale content from earlier frames without us having
 *      to pad with spaces — cheaper to write and never wraps.
 */
function padRow(s: string, cols: number): string {
  const max = Math.max(1, cols - 1);
  const truncated = truncateVisible(s, max);
  return truncated + EOL;
}

// CSI sequences (ESC [ … letter) — covers SGR colors (m), clear-to-EOL (K),
// cursor moves (H/A/B/C/D/J), etc.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Truncate while preserving ANSI escape sequences. We walk the string
 * counting visible characters; ANSI bytes don't count toward the budget.
 * Final reset code is appended to avoid bleeding colour past the edge.
 */
function truncateVisible(s: string, max: number): string {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < max) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      // CSI sequence: ESC [ params… final-byte (any letter A–Z, a–z)
      let j = i + 2;
      while (j < s.length && !/[A-Za-z]/.test(s[j])) j++;
      if (j >= s.length) break;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += s[i];
    visible++;
    i++;
  }
  return out + "\x1b[0m";
}
