/**
 * Core types for rotunda sync engine.
 */

/** A sync root: maps a local directory to a repo directory. */
export interface SyncRoot {
  name: string;
  local: string; // absolute path after ~ resolution
  repo: string; // relative path within the repo
  include: string[];
  exclude: string[];
}

/** Per-root override within a machine override. */
export interface MachineRootOverride {
  exclude?: string[];
}

/** Per-machine overrides — matched case-insensitively against os.hostname(). */
export interface MachineOverride {
  exclude?: string[];
  roots?: Record<string, MachineRootOverride>;
}

/** The rotunda manifest (rotunda.json). */
export interface Manifest {
  version: number;
  roots: SyncRoot[];
  globalExclude: string[];
  /** Raw machine overrides from the manifest (before applying). */
  machineOverrides?: Record<string, MachineOverride>;
  /** The hostname that was matched (if any), for display purposes. */
  appliedMachine?: string;
}

/** Action type for a file change. */
export type ChangeAction =
  | "added"
  | "modified"
  | "deleted"
  | "conflict";

/** Which side originated the change. */
export type ChangeSide = "local" | "repo" | "both";

/** A detected file change between local, state, and repo. */
export interface FileChange {
  /** Relative path within the sync root (e.g., "skills/commit/SKILL.md"). */
  relativePath: string;
  /** Which sync root this file belongs to. */
  rootName: string;
  /** What kind of change. */
  action: ChangeAction;
  /** Which side changed. */
  side: ChangeSide;
  /** SHA256 hash of the local version (if exists). */
  localHash?: string;
  /** SHA256 hash of the repo version (if exists). */
  repoHash?: string;
  /** SHA256 hash from the last sync state (if exists). */
  stateHash?: string;
}

/** Per-file state record from the last sync. */
export interface FileState {
  hash: string;
  size: number;
  syncedAt: string; // ISO 8601
}

/** A file whose conflict resolution has been deferred to a later sync. */
export interface DeferredEntry {
  /** Why this row is deferred. 'conflict' = user pressed defer in TUI; 'user' = reserved. */
  reason: "conflict" | "user";
  /** ISO 8601 timestamp when the deferral was captured. */
  capturedAt: string;
}

/** The full sync state for a machine. */
export interface SyncState {
  lastSync: string; // ISO 8601
  files: Record<string, FileState>;
  /**
   * Map of root-prefixed path → deferral metadata. Sync skips deferred rows
   * in the apply pass and surfaces them in the TUI as 'deferred (resolve via
   * .rotunda/conflicts/...)'. Optional for backward compatibility with state
   * files written by earlier rotunda versions.
   */
  deferred?: Record<string, DeferredEntry>;
}

/** Result of a doctor check. */
export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string[];
}

/** LLM review decision for a file. */
export type ReviewDecision = "approve" | "reject" | "reshape" | "skip";

/** Result of reviewing a single file change. */
export interface ReviewResult {
  change: FileChange;
  decision: ReviewDecision;
  /** If reshaped, the new file content. */
  reshapedContent?: string;
}
