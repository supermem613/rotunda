/**
 * Inline ASCII progress indicator that overwrites itself on each tick.
 *
 * Usage:
 *   const p = createProgress(totalFiles);
 *   // … after each unit of work completes:
 *   p.tick(filesJustCompleted);
 *   // … when finished:
 *   p.done();          // clears the line
 *   p.done("Done ✓");  // clears the line, prints message
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 24;

export interface Progress {
  /** Advance by `n` completed units (default 1). */
  tick(n?: number): void;
  /** Clear the progress line. Optionally print a final message. */
  done(message?: string): void;
}

export function createProgress(total: number, label = "Analyzing"): Progress {
  let completed = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const isTTY = process.stderr.isTTY ?? false;

  function render(): void {
    if (!isTTY) return;

    const pct = total > 0 ? completed / total : 0;
    const filled = Math.round(pct * BAR_WIDTH);
    const bar =
      "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const percent = `${Math.round(pct * 100)}%`;
    const spinner = SPINNER[frame % SPINNER.length];
    frame++;

    const line = `  ${spinner} ${label}  ${bar}  ${percent}`;
    process.stderr.write(`\r${line}`);
  }

  // Start the spinner animation (~80 ms per frame)
  if (isTTY) {
    render();
    timer = setInterval(render, 80);
  }

  return {
    tick(n = 1) {
      completed = Math.min(completed + n, total);
      render();
    },
    done(message?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (isTTY) {
        // Clear the progress line
        process.stderr.write("\r" + " ".repeat(80) + "\r");
      }
      if (message) {
        process.stderr.write(`  ${message}\n`);
      }
    },
  };
}
