import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, releaseLock, withLock } from "../../src/utils/lock.js";
import { writeFile } from "node:fs/promises";

const TMP = join(tmpdir(), "rotunda-lock-test");

function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

describe("acquireLock / releaseLock", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(join(TMP, ".rotunda"), { recursive: true });
  });
  afterEach(cleanup);

  it("creates a lock file with pid, command, and timestamp", async () => {
    await acquireLock(TMP, "test-cmd");

    const lockPath = join(TMP, ".rotunda", "lock");
    assert.ok(existsSync(lockPath), "lock file should exist");

    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.command, "test-cmd");
    assert.ok(lock.timestamp, "should have a timestamp");

    await releaseLock(TMP);
  });

  it("removes lock file on release", async () => {
    await acquireLock(TMP, "test-cmd");
    await releaseLock(TMP);

    const lockPath = join(TMP, ".rotunda", "lock");
    assert.ok(!existsSync(lockPath), "lock file should be removed");
  });

  it("releaseLock does not throw if lock file is already gone", async () => {
    // Should not throw even if no lock exists
    await assert.doesNotReject(() => releaseLock(TMP));
  });

  it("throws when another live process holds the lock", async () => {
    // Write a lock with the current PID (simulating another holder)
    const lockPath = join(TMP, ".rotunda", "lock");
    const fakeLock = {
      pid: process.pid, // current process IS running
      command: "other-cmd",
      timestamp: new Date().toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(fakeLock), "utf-8");

    await assert.rejects(
      () => acquireLock(TMP, "my-cmd"),
      (err: Error) => {
        assert.ok(err.message.includes("Another rotunda process"));
        return true;
      },
    );
  });

  it("replaces a stale lock from a dead process", async () => {
    const lockPath = join(TMP, ".rotunda", "lock");
    const staleLock = {
      pid: 999999999, // almost certainly not running
      command: "old-cmd",
      timestamp: new Date().toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(staleLock), "utf-8");

    // Should succeed — stale lock is replaced
    await assert.doesNotReject(() => acquireLock(TMP, "new-cmd"));

    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.command, "new-cmd");

    await releaseLock(TMP);
  });
});

describe("withLock", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(join(TMP, ".rotunda"), { recursive: true });
  });
  afterEach(cleanup);

  it("runs the function and releases lock on success", async () => {
    const result = await withLock(TMP, "test", async () => {
      // Lock should exist while running
      const lockPath = join(TMP, ".rotunda", "lock");
      assert.ok(existsSync(lockPath), "lock should exist during execution");
      return 42;
    });

    assert.equal(result, 42);

    // Lock should be released after
    const lockPath = join(TMP, ".rotunda", "lock");
    assert.ok(!existsSync(lockPath), "lock should be released after success");
  });

  it("releases lock even when function throws", async () => {
    await assert.rejects(
      () =>
        withLock(TMP, "test", async () => {
          throw new Error("boom");
        }),
      { message: "boom" },
    );

    const lockPath = join(TMP, ".rotunda", "lock");
    assert.ok(!existsSync(lockPath), "lock should be released after error");
  });

  it("returns the value from the wrapped function", async () => {
    const result = await withLock(TMP, "test", async () => "hello");
    assert.equal(result, "hello");
  });
});
