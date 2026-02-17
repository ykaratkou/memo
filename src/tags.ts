import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { normalize, resolve, sep } from "node:path";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface TagInfo {
  tag: string;
  displayName: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
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

export function getUserTagInfo(): TagInfo {
  const email = getGitEmail();
  const name = getGitName();

  if (email) {
    return {
      tag: `memo_user_${sha256(email)}`,
      displayName: name || email,
      userName: name || undefined,
      userEmail: email,
    };
  }

  const fallback =
    name || process.env.USER || process.env.USERNAME || "anonymous";
  return {
    tag: `memo_user_${sha256(fallback)}`,
    displayName: fallback,
    userName: fallback,
  };
}

export function getProjectTagInfo(directory: string): TagInfo {
  const gitRepoUrl = getGitRepoUrl(directory);

  // Use git common dir as a stable identity across worktrees.
  // For all worktrees of the same repo, this resolves to the same
  // absolute path (e.g. /path/to/repo/.git), producing the same tag.
  const gitCommonDir = getGitCommonDir(directory);
  const tagSource = gitCommonDir || directory;

  // Derive project name from git root (parent of .git dir) when available,
  // so worktrees share the same display name as the main checkout.
  const projectName = gitCommonDir
    ? getProjectName(resolve(gitCommonDir, ".."))
    : getProjectName(directory);

  return {
    tag: `memo_project_${sha256(tagSource)}`,
    displayName: projectName,
    projectPath: directory,
    projectName,
    gitRepoUrl: gitRepoUrl || undefined,
  };
}

export function getTags(directory: string): {
  user: TagInfo;
  project: TagInfo;
} {
  return {
    user: getUserTagInfo(),
    project: getProjectTagInfo(directory),
  };
}
