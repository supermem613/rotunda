import { homedir } from "node:os";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { discoverFiles } from "./engine.js";
import {
  type ManifestDocument,
  saveManifestDocument,
  RotundaError as RotundaErrorClass,
} from "./manifest.js";
import { updateStateFiles, removeFromState, saveState } from "./state.js";
import type { Manifest, SyncRoot, SyncState } from "./types.js";
import { hashFile } from "../utils/hash.js";
import { shouldInclude } from "../utils/glob.js";

export type TrackingOperation = "add" | "remove";
export type ManifestMutationKind =
  | "add-include"
  | "remove-include"
  | "add-exclude"
  | "create-root"
  | "remove-root";

export interface TrackingTarget {
  inputPath: string;
  absolutePath: string;
  kind: "file" | "directory";
}

export interface RootMatch {
  rawRoot: ManifestDocument["roots"][number];
  runtimeRoot: SyncRoot;
}

export interface PlannedRepoCopy {
  relativePath: string;
  displayPath: string;
  repoPath: string;
  localPath: string;
  status: "create" | "overwrite" | "already-synced";
  hash: string;
}

export interface PlannedRepoDelete {
  relativePath: string;
  displayPath: string;
  repoPath: string;
  repoPathAbs: string;
}

export interface TrackingPlan {
  kind: TrackingOperation;
  target: TrackingTarget;
  rootName: string;
  rootLocal: string;
  rootRepo: string;
  inferredPattern: string;
  manifestMutation: {
    kind: ManifestMutationKind;
    pattern?: string;
    local?: string;
    repo?: string;
  };
  nextManifest: ManifestDocument;
  repoCopies: PlannedRepoCopy[];
  repoDeletes: PlannedRepoDelete[];
  repoOnlyMatches: string[];
  stateWrites: Map<string, string>;
  stateRemovals: string[];
  gitPaths: string[];
  commitMessage: string;
}

export interface TrackingApplyResult {
  gitPaths: string[];
  log: string[];
  state: SyncState;
}

function normalizeFsPath(p: string): string {
  const normalized = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathWithin(base: string, target: string): boolean {
  const normalizedBase = normalizeFsPath(base);
  const normalizedTarget = normalizeFsPath(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + "/");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function findUniqueRootByName<T extends { name: string }>(
  roots: T[],
  rootName: string,
): T {
  const matches = roots.filter((root) => root.name === rootName);
  if (matches.length === 0) {
    throw new RotundaErrorClass(`No root named "${rootName}" exists in rotunda.json.`);
  }
  if (matches.length > 1) {
    throw new RotundaErrorClass(
      `Root name "${rootName}" is not unique in rotunda.json. Add/remove requires unique root names.`,
    );
  }
  return matches[0];
}

function displayPath(root: Pick<SyncRoot, "repo">, relativePath: string): string {
  return `${root.repo.replace(/\\/g, "/")}/${relativePath}`;
}

function getRootStatePaths(state: SyncState, rootRepo: string): string[] {
  const prefix = `${rootRepo}/`;
  const stateKeys = Object.keys(state.files)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  const deferredKeys = Object.keys(state.deferred ?? {})
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  return uniqueSorted([...stateKeys, ...deferredKeys]);
}

function rootLocalForNewTarget(target: TrackingTarget): string {
  return target.kind === "directory" ? target.absolutePath : dirname(target.absolutePath);
}

function relativePattern(rootLocal: string, targetPath: string): string {
  return relative(rootLocal, targetPath).replace(/\\/g, "/");
}

function inferPattern(rootLocal: string, target: TrackingTarget): string {
  const rel = relativePattern(rootLocal, target.absolutePath);
  if (target.kind === "file") return rel;
  return rel === "" ? "**" : `${rel}/**`;
}

function isWithinTarget(relativePath: string, targetRel: string, targetKind: TrackingTarget["kind"]): boolean {
  if (targetRel === "") return true;
  if (targetKind === "file") return relativePath === targetRel;
  return relativePath === targetRel || relativePath.startsWith(targetRel + "/");
}

function collectManagedPaths(
  rootRepo: string,
  localFiles: Map<string, string>,
  repoFiles: Map<string, string>,
  state: SyncState,
  include: string[],
  exclude: string[],
  globalExclude: string[],
  targetRel: string,
  targetKind: TrackingTarget["kind"],
): string[] {
  const statePaths = getRootStatePaths(state, rootRepo)
    .filter((relativePath) => shouldInclude(relativePath, include, exclude, globalExclude));
  return uniqueSorted([
    ...localFiles.keys(),
    ...repoFiles.keys(),
    ...statePaths,
  ].filter((relativePath) => isWithinTarget(relativePath, targetRel, targetKind)));
}

function toManifestLocalPath(absPath: string): string {
  const home = homedir();
  if (normalizeFsPath(absPath) === normalizeFsPath(home)) {
    return "~";
  }
  if (isPathWithin(home, absPath)) {
    const rel = relative(home, absPath).replace(/\\/g, "/");
    return rel.length === 0 ? "~" : `~/${rel}`;
  }
  return absPath.replace(/\\/g, "/");
}

function suggestNameFromPath(raw: string): string {
  return raw.replace(/^\.+/, "").replace(/\.[^.]+$/, "") || "root";
}

export function suggestNewRootName(target: TrackingTarget): string {
  const localRoot = rootLocalForNewTarget(target);
  if (normalizeFsPath(localRoot) === normalizeFsPath(homedir())) {
    return "home";
  }
  return suggestNameFromPath(basename(localRoot));
}

function inferRepoPathForNewRoot(rootLocal: string, rootName: string): string {
  if (normalizeFsPath(rootLocal) === normalizeFsPath(homedir())) {
    return rootName.startsWith(".") ? rootName : `.${rootName}`;
  }
  return basename(rootLocal).replace(/\\/g, "/");
}

async function discoverManagedFiles(
  cwd: string,
  root: SyncRoot | undefined,
  globalExclude: string[],
): Promise<{ localFiles: Map<string, string>; repoFiles: Map<string, string> }> {
  if (!root) {
    return { localFiles: new Map(), repoFiles: new Map() };
  }
  const repoDir = join(cwd, root.repo);
  const [localFiles, repoFiles] = await Promise.all([
    discoverFiles(root.local, root.include, root.exclude, globalExclude),
    discoverFiles(repoDir, root.include, root.exclude, globalExclude),
  ]);
  return { localFiles, repoFiles };
}

function buildRuntimeRoot(
  local: string,
  repo: string,
  name: string,
  include: string[],
  exclude: string[],
): SyncRoot {
  return { name, local, repo, include, exclude };
}

function buildCommitMessage(
  kind: TrackingOperation,
  rootName: string,
  target: TrackingTarget,
  mutation: ManifestMutationKind,
): string {
  const suffix = target.kind === "directory"
    ? basename(target.absolutePath).replace(/\\/g, "/") || rootName
    : basename(target.absolutePath);
  if (mutation === "remove-root") {
    return `rotunda remove — drop root ${rootName}`;
  }
  if (mutation === "create-root") {
    return `rotunda add — create root ${rootName}`;
  }
  return `rotunda ${kind} — ${rootName} ${suffix}`;
}

export async function resolveTrackingTarget(
  inputPath: string,
  invocationCwd: string,
): Promise<TrackingTarget> {
  const expanded = inputPath === "~" || inputPath.startsWith("~/") || inputPath.startsWith("~\\")
    ? join(homedir(), inputPath.slice(1))
    : inputPath;
  const absolutePath = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(invocationCwd, expanded);

  let entry;
  try {
    entry = await stat(absolutePath);
  } catch (err) {
    throw new RotundaErrorClass(
      `Path does not exist: ${absolutePath}`,
      { cause: err },
    );
  }

  if (entry.isDirectory()) {
    return { inputPath, absolutePath, kind: "directory" };
  }
  if (entry.isFile()) {
    return { inputPath, absolutePath, kind: "file" };
  }
  throw new RotundaErrorClass(
    `Path must be a file or directory: ${absolutePath}`,
  );
}

export function findMatchingRootForTarget(
  manifest: Manifest,
  manifestDocument: ManifestDocument,
  targetAbsolutePath: string,
): RootMatch | undefined {
  const matches = manifest.roots
    .filter((root) => isPathWithin(root.local, targetAbsolutePath))
    .sort((a, b) => normalizeFsPath(b.local).length - normalizeFsPath(a.local).length);

  if (matches.length === 0) return undefined;

  const best = matches[0];
  if (matches.length > 1 && normalizeFsPath(matches[1].local) === normalizeFsPath(best.local)) {
    throw new RotundaErrorClass(
      `Path matches multiple roots with the same local directory: ${best.name}, ${matches[1].name}.`,
    );
  }

  return {
    runtimeRoot: best,
    rawRoot: findUniqueRootByName(manifestDocument.roots, best.name),
  };
}

export async function planTrackingPathChange(
  cwd: string,
  manifest: Manifest,
  manifestDocument: ManifestDocument,
  state: SyncState,
  target: TrackingTarget,
  kind: TrackingOperation,
  newRootName?: string,
): Promise<TrackingPlan> {
  const match = findMatchingRootForTarget(manifest, manifestDocument, target.absolutePath);
  const nextManifest = structuredClone(manifestDocument);

  let beforeRawRoot = match?.rawRoot;
  let beforeRuntimeRoot = match?.runtimeRoot;
  let afterRuntimeRoot: SyncRoot | undefined;
  let rootName: string;
  let rootRepo: string;
  let rootLocal: string;
  let inferredPattern: string;
  let manifestMutation: TrackingPlan["manifestMutation"] | undefined;

  if (!match) {
    if (kind === "remove") {
      throw new RotundaErrorClass(
        `No existing root covers ${target.absolutePath}. rotunda remove only works for already-tracked paths.`,
      );
    }
    if (!newRootName) {
      throw new RotundaErrorClass(
        `No existing root covers ${target.absolutePath}. A new root name is required.`,
      );
    }
    if (nextManifest.roots.some((root) => root.name === newRootName)) {
      throw new RotundaErrorClass(`A root named "${newRootName}" already exists in rotunda.json.`);
    }
    rootName = newRootName;
    rootLocal = rootLocalForNewTarget(target);
    rootRepo = inferRepoPathForNewRoot(rootLocal, rootName);
    if (nextManifest.roots.some((root) => root.repo === rootRepo)) {
      throw new RotundaErrorClass(
        `Creating "${rootName}" would reuse repo path "${rootRepo}", which already belongs to another root.`,
      );
    }
    inferredPattern = inferPattern(rootLocal, target);
    const newRoot = {
      name: rootName,
      local: toManifestLocalPath(rootLocal),
      repo: rootRepo,
      include: [inferredPattern],
      exclude: [] as string[],
    };
    nextManifest.roots.push(newRoot);
    afterRuntimeRoot = buildRuntimeRoot(rootLocal, rootRepo, rootName, newRoot.include, newRoot.exclude);
    manifestMutation = {
      kind: "create-root",
      pattern: inferredPattern,
      local: newRoot.local,
      repo: newRoot.repo,
    };
  } else {
    const matchedRuntimeRoot = match.runtimeRoot;
    const matchedRawRoot = match.rawRoot;
    rootName = matchedRuntimeRoot.name;
    rootRepo = matchedRuntimeRoot.repo;
    rootLocal = matchedRuntimeRoot.local;
    inferredPattern = inferPattern(rootLocal, target);
    const nextRawRoot = findUniqueRootByName(nextManifest.roots, rootName);
    const targetMatchesRoot =
      target.kind === "directory" &&
      normalizeFsPath(target.absolutePath) === normalizeFsPath(rootLocal);

    if (kind === "add") {
      if (matchedRawRoot.exclude.includes(inferredPattern)) {
        throw new RotundaErrorClass(
          `Path is explicitly excluded by root "${rootName}" via "${inferredPattern}". Edit rotunda.json manually if you want to change that.`,
        );
      }
      if (!nextRawRoot.include.includes(inferredPattern)) {
        nextRawRoot.include = [...nextRawRoot.include, inferredPattern];
      }
      afterRuntimeRoot = buildRuntimeRoot(rootLocal, rootRepo, rootName, nextRawRoot.include, nextRawRoot.exclude);
      manifestMutation = { kind: "add-include", pattern: inferredPattern };
    } else if (targetMatchesRoot) {
      nextManifest.roots = nextManifest.roots.filter((root) => root.name !== rootName);
      afterRuntimeRoot = undefined;
      manifestMutation = { kind: "remove-root", local: matchedRawRoot.local, repo: matchedRawRoot.repo };
    } else {
      let usedRemoveInclude = false;
      if (nextRawRoot.include.includes(inferredPattern) && nextRawRoot.include.length > 1) {
        const candidateManifest = structuredClone(nextManifest);
        const candidateRoot = findUniqueRootByName(candidateManifest.roots, rootName);
        candidateRoot.include = candidateRoot.include.filter((entry) => entry !== inferredPattern);
        const candidateAfterRoot = buildRuntimeRoot(
          rootLocal,
          rootRepo,
          rootName,
          candidateRoot.include,
          candidateRoot.exclude,
        );
        const { localFiles, repoFiles } = await discoverManagedFiles(cwd, candidateAfterRoot, manifest.globalExclude);
        const targetRel = relativePattern(rootLocal, target.absolutePath);
        const candidateAfterManaged = collectManagedPaths(
          rootRepo,
          localFiles,
          repoFiles,
          state,
          candidateAfterRoot.include,
          candidateAfterRoot.exclude,
          manifest.globalExclude,
          targetRel,
          target.kind,
        );
        if (candidateAfterManaged.length === 0) {
          nextRawRoot.include = candidateRoot.include;
          afterRuntimeRoot = candidateAfterRoot;
          manifestMutation = { kind: "remove-include", pattern: inferredPattern };
          usedRemoveInclude = true;
        }
      }

      if (!usedRemoveInclude) {
        if (!nextRawRoot.exclude.includes(inferredPattern)) {
          nextRawRoot.exclude = [...nextRawRoot.exclude, inferredPattern];
        }
        afterRuntimeRoot = buildRuntimeRoot(rootLocal, rootRepo, rootName, nextRawRoot.include, nextRawRoot.exclude);
        manifestMutation = { kind: "add-exclude", pattern: inferredPattern };
      }
    }
  }

  const { localFiles: beforeLocalFiles, repoFiles: beforeRepoFiles } = await discoverManagedFiles(
    cwd,
    beforeRuntimeRoot,
    manifest.globalExclude,
  );
  const { localFiles: afterLocalFiles, repoFiles: afterRepoFiles } = await discoverManagedFiles(
    cwd,
    afterRuntimeRoot,
    manifest.globalExclude,
  );

  const targetRel = beforeRuntimeRoot
    ? relativePattern(beforeRuntimeRoot.local, target.absolutePath)
    : afterRuntimeRoot
      ? relativePattern(afterRuntimeRoot.local, target.absolutePath)
      : "";

  const beforeManagedTargetPaths = beforeRuntimeRoot
    ? collectManagedPaths(
      rootRepo,
      beforeLocalFiles,
      beforeRepoFiles,
      state,
      beforeRuntimeRoot.include,
      beforeRuntimeRoot.exclude,
      manifest.globalExclude,
      targetRel,
      target.kind,
    )
    : [];
  const afterManagedTargetPaths = afterRuntimeRoot
    ? collectManagedPaths(
      rootRepo,
      afterLocalFiles,
      afterRepoFiles,
      state,
      afterRuntimeRoot.include,
      afterRuntimeRoot.exclude,
      manifest.globalExclude,
      targetRel,
      target.kind,
    )
    : [];

  const repoCopies: PlannedRepoCopy[] = [];
  const repoDeletes: PlannedRepoDelete[] = [];
  const stateWrites = new Map<string, string>();
  const repoOnlyMatches: string[] = [];

  if (kind === "add") {
    const newlyManagedLocal = uniqueSorted(
      [...afterLocalFiles.keys()].filter((relativePath) => !beforeLocalFiles.has(relativePath)),
    );

    for (const relativePath of newlyManagedLocal) {
      const localPath = afterLocalFiles.get(relativePath)!;
      const repoPath = join(rootRepo, relativePath);
      const localHash = await hashFile(localPath);
      stateWrites.set(relativePath, localHash);

      if (!afterRepoFiles.has(relativePath)) {
        repoCopies.push({
          relativePath,
          displayPath: displayPath({ repo: rootRepo }, relativePath),
          repoPath,
          localPath,
          status: "create",
          hash: localHash,
        });
        continue;
      }

      const repoHash = await hashFile(afterRepoFiles.get(relativePath)!);
      repoCopies.push({
        relativePath,
        displayPath: displayPath({ repo: rootRepo }, relativePath),
        repoPath,
        localPath,
        status: repoHash === localHash ? "already-synced" : "overwrite",
        hash: localHash,
      });
    }

    const newlyManagedRepo = uniqueSorted(
      [...afterRepoFiles.keys()].filter((relativePath) => !beforeRepoFiles.has(relativePath)),
    );
    for (const relativePath of newlyManagedRepo) {
      if (!afterLocalFiles.has(relativePath)) {
        repoOnlyMatches.push(displayPath({ repo: rootRepo }, relativePath));
      }
    }

    if (
      beforeManagedTargetPaths.length > 0 &&
      repoCopies.filter((entry) => isWithinTarget(entry.relativePath, targetRel, target.kind)).length === 0 &&
      repoOnlyMatches.filter((entry) => isWithinTarget(
        entry.replace(`${rootRepo.replace(/\\/g, "/")}/`, ""),
        targetRel,
        target.kind,
      )).length === 0
    ) {
      throw new RotundaErrorClass(
        `${target.absolutePath} is already fully tracked by root "${rootName}".`,
      );
    }

    if (target.kind === "file" && stateWrites.size === 0 && beforeManagedTargetPaths.length === 0) {
      throw new RotundaErrorClass(
        `${target.absolutePath} did not become managed after adding "${inferredPattern}". It may already be excluded by this root.`,
      );
    }
  } else {
    if (beforeManagedTargetPaths.length === 0) {
      throw new RotundaErrorClass(
        `${target.absolutePath} is not currently tracked by root "${rootName}".`,
      );
    }

    const newlyUnmanagedRepo = uniqueSorted(
      [...beforeRepoFiles.keys()].filter((relativePath) => !afterRepoFiles.has(relativePath)),
    );
    for (const relativePath of newlyUnmanagedRepo) {
      repoDeletes.push({
        relativePath,
        displayPath: displayPath({ repo: rootRepo }, relativePath),
        repoPath: join(rootRepo, relativePath),
        repoPathAbs: join(cwd, rootRepo, relativePath),
      });
    }
  }

  const stateRemovals = getRootStatePaths(state, rootRepo)
    .filter((relativePath) => {
      const beforeManaged = beforeRuntimeRoot
        ? shouldInclude(relativePath, beforeRuntimeRoot.include, beforeRuntimeRoot.exclude, manifest.globalExclude)
        : false;
      const afterManaged = afterRuntimeRoot
        ? shouldInclude(relativePath, afterRuntimeRoot.include, afterRuntimeRoot.exclude, manifest.globalExclude)
        : false;
      return beforeManaged && !afterManaged;
    });

  const gitPaths = uniqueSorted([
    "rotunda.json",
    ...repoCopies.filter((entry) => entry.status !== "already-synced").map((entry) => entry.repoPath),
    ...repoDeletes.map((entry) => entry.repoPath),
  ]);

  if (!manifestMutation) {
    throw new RotundaErrorClass("Internal error: manifest mutation was not determined.");
  }

  return {
    kind,
    target,
    rootName,
    rootLocal,
    rootRepo,
    inferredPattern,
    manifestMutation,
    nextManifest,
    repoCopies,
    repoDeletes,
    repoOnlyMatches,
    stateWrites,
    stateRemovals,
    gitPaths,
    commitMessage: buildCommitMessage(kind, rootName, target, manifestMutation.kind),
  };
}

export async function applyTrackingPlan(
  cwd: string,
  plan: TrackingPlan,
  initialState: SyncState,
): Promise<TrackingApplyResult> {
  let state = initialState;
  const gitPathSet = new Set<string>(["rotunda.json"]);
  const log: string[] = [];

  saveManifestDocument(cwd, plan.nextManifest);
  log.push(`MANIFEST ${plan.manifestMutation.kind.toUpperCase()} ${plan.rootName}`);

  if (plan.kind === "add") {
    for (const entry of plan.repoCopies) {
      if (entry.status === "already-synced") {
        log.push(`TRACK ${entry.displayPath} (repo already matched local)`);
        continue;
      }
      await mkdir(dirname(join(cwd, entry.repoPath)), { recursive: true });
      await copyFile(entry.localPath, join(cwd, entry.repoPath));
      gitPathSet.add(entry.repoPath);
      log.push(
        `${entry.status === "overwrite" ? "OVERWRITE" : "ADD"} ${entry.displayPath}`,
      );
    }

    if (plan.stateWrites.size > 0) {
      state = updateStateFiles(state, plan.rootRepo, plan.stateWrites);
      log.push(`STATE +${plan.stateWrites.size}`);
    }
  } else {
    for (const entry of plan.repoDeletes) {
      await rm(entry.repoPathAbs, { recursive: true, force: true });
      gitPathSet.add(entry.repoPath);
      log.push(`DEL-REPO ${entry.displayPath}`);
    }
  }

  if (plan.stateRemovals.length > 0) {
    state = removeFromState(state, plan.rootRepo, plan.stateRemovals);
    log.push(`STATE -${plan.stateRemovals.length}`);
  }

  await saveState(cwd, state);

  return {
    gitPaths: uniqueSorted(gitPathSet),
    log,
    state,
  };
}
