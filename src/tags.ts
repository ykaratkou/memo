import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { normalize, resolve, sep } from "node:path";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface ProjectInfo {
  tag: string;
  displayName: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

export interface NamedContainerInfo {
  tag: string;
  normalizedName: string;
  displayName: string;
}

function getGitEmail(): string | null {
  try {
    return execSync("git config user.email", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function getGitName(): string | null {
  try {
    return execSync("git config user.name", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Returns the absolute path to the shared .git directory.
 * For worktrees of the same repo this returns the same path,
 * making it a stable project identity across worktrees.
 */
function getGitCommonDir(directory: string): string | null {
  try {
    const result = execSync(
      "git rev-parse --path-format=absolute --git-common-dir",
      { encoding: "utf-8", cwd: directory, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function getGitRepoUrl(directory: string): string | null {
  try {
    return (
      execSync("git config --get remote.origin.url", {
        encoding: "utf-8",
        cwd: directory,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function getProjectName(directory: string): string {
  const normalized = normalize(directory);
  const parts = normalized.split(sep).filter((p) => p);
  return parts[parts.length - 1] || directory;
}

export function getProjectInfo(directory: string): ProjectInfo {
  const gitRepoUrl = getGitRepoUrl(directory);
  const gitCommonDir = getGitCommonDir(directory);
  const tagSource = gitCommonDir || directory;

  const projectName = gitCommonDir
    ? getProjectName(resolve(gitCommonDir, ".."))
    : getProjectName(directory);

  return {
    tag: `memo_project_${sha256(tagSource)}`,
    displayName: projectName,
    userName: getGitName() || undefined,
    userEmail: getGitEmail() || undefined,
    projectPath: directory,
    projectName,
    gitRepoUrl: gitRepoUrl || undefined,
  };
}

function normalizeContainerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getNamedContainerInfo(name: string): NamedContainerInfo {
  const displayName = name.trim();
  if (!displayName) {
    throw new Error("Container name cannot be empty.");
  }

  const normalizedName = normalizeContainerName(displayName);
  if (!normalizedName) {
    throw new Error("Container name must include at least one letter or number.");
  }

  return {
    tag: `memo_container_${normalizedName}`,
    normalizedName,
    displayName,
  };
}
