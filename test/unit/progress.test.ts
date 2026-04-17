import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createProgress } from "../../src/utils/progress.js";

describe("createProgress", () => {
  let originalIsTTY: boolean | undefined;
  let written: string[];

  beforeEach(() => {
    originalIsTTY = process.stderr.isTTY;
    written = [];
    // Capture stderr writes
    mock.method(process.stderr, "write", (chunk: string) => {
      written.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    (process.stderr as { isTTY?: boolean }).isTTY = originalIsTTY;
    mock.restoreAll();
  });

  it("renders progress bar on TTY", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
    const p = createProgress(10);
    // Initial render should have happened (0%)
    const initial = written.join("");
    assert.ok(initial.includes("0%"), "should show 0% initially");
    assert.ok(initial.includes("Analyzing"), "should show default label");
    p.done();
  });

  it("tick advances the percentage", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
    const p = createProgress(4);
    written = []; // clear initial render
    p.tick(2); // 50%
    const after = written.join("");
    assert.ok(after.includes("50%"), `should show 50%, got: ${after}`);
    p.done();
  });

  it("tick clamps to total", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
    const p = createProgress(2);
    written = [];
    p.tick(999); // way over total
    const after = written.join("");
    assert.ok(after.includes("100%"), "should clamp to 100%");
    p.done();
  });

  it("done clears the progress line", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
    const p = createProgress(5);
    written = [];
    p.done();
    // Should have written a blank overwrite
    const cleared = written.join("");
    assert.ok(cleared.includes("\r"), "should use carriage return to clear");
  });

  it("done prints optional message after clearing", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
    const p = createProgress(5);
    written = [];
    p.done("All done");
    const output = written.join("");
    assert.ok(output.includes("All done"), "should print the done message");
  });

  it("accepts a custom label", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
    const p = createProgress(5, "Processing");
    const output = written.join("");
    assert.ok(output.includes("Processing"), "should show custom label");
    p.done();
  });

  it("does not write when not a TTY", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = false;
    const p = createProgress(5);
    p.tick(3);
    p.done();
    // No carriage-return output expected (done message could still print)
    const hasProgressBar = written.some((w) => w.includes("█") || w.includes("░"));
    assert.ok(!hasProgressBar, "should not render progress bar on non-TTY");
  });

  it("handles zero total gracefully", () => {
    (process.stderr as { isTTY?: boolean }).isTTY = true;
    const p = createProgress(0);
    const output = written.join("");
    assert.ok(output.includes("0%"), "zero total should show 0%");
    p.tick(1);
    p.done();
  });
});
