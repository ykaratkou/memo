#!/usr/bin/env bun

import {
  insertMemory,
  deleteMemory,
  getMemoryContainerTag,
  listMemories,
  countMemories,
  countMemoriesByContainer,
  closeDb,
  resetDb,
  reindexFts,
  replaceImportedChunksForSource,
} from "./db.ts";
import type { MemoryRecord } from "./db.ts";
import { searchMemories } from "./search.ts";
import { embeddingService } from "./embed.ts";
import { checkDuplicate } from "./dedup.ts";
import { stripPrivateContent, isFullyPrivate } from "./privacy.ts";
import { getProjectInfo, getNamedContainerInfo } from "./tags.ts";
import { getDbPath } from "./db.ts";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";
import {
  collectImportChunks,
  collectRepoMapEntries,
  buildRepoMapContent,
  DEFAULT_IMPORT_CHUNK_TOKENS,
  DEFAULT_IMPORT_OVERLAP_TOKENS,
} from "./importer.ts";
import { existsSync, symlinkSync, readlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const USAGE = `memo - persistent memory for LLM agent sessions

Data is stored per project in .memo/memo.db (shared across git worktrees).

Commands:
  memo add <text> [--container N]   Store a memory (scoped to current project)
  memo import --markdown <path> [--container N]
                                    Import markdown file/folder into memory
  memo import --repo-map <file.json> [--container N]
                                    Import tree-sitter project map (JSON)
  memo search <query> [--limit N] [--threshold N] [--container N] [--skip-vector] [--skip-full-text]
                                    Hybrid semantic + keyword search (default top ${CONFIG.maxMemories})
  memo list [--limit N] [--all] [--container N]
                                    List recent memories (--all for no limit)
  memo forget <id> [--container N]  Delete a memory by ID
  memo reset                        Reset project memories (irreversible)
  memo reindex                      Rebuild search indexes
  memo status                       Show system status
  memo install skills <target>      Install agent skills (--opencode, --claude, --codex)

Flags:
  --container <name>                Operate on a named container scope
  --markdown <path>                 Import markdown file/folder
  --repo-map <file.json>            Import tree-sitter repo map JSON file
  --chunk-tokens N                  Markdown chunk size in tokens (default ${DEFAULT_IMPORT_CHUNK_TOKENS})
  --overlap-tokens N                Markdown chunk overlap in tokens (default ${DEFAULT_IMPORT_OVERLAP_TOKENS})
  --all                             List all memories (no limit)
  --skip-vector                     Search: skip vector (semantic) search
  --skip-full-text                  Search: skip BM25 (keyword) search
  --help, -h                        Show this help
`;

function parseArgs(argv: string[]): {
  command: string;
  text: string;
  positionals: string[];
  limit: number;
  threshold: number | undefined;
  all: boolean;
  container: string | undefined;
  chunkTokens: number;
  overlapTokens: number;
  markdown: string | undefined;
  repoMap: string | undefined;
  skipVector: boolean;
  skipFullText: boolean;
  opencode: boolean;
  claude: boolean;
  codex: boolean;
} {
  const args = argv.slice(2);
  let command = "";
  const positionals: string[] = [];
  let limit = CONFIG.maxMemories;
  let threshold: number | undefined = undefined;
  let all = false;
  let container: string | undefined = undefined;
  let chunkTokens = DEFAULT_IMPORT_CHUNK_TOKENS;
  let overlapTokens = DEFAULT_IMPORT_OVERLAP_TOKENS;
  let markdown: string | undefined = undefined;
  let repoMap: string | undefined = undefined;
  let skipVector = false;
  let skipFullText = false;
  let opencode = false;
  let claude = false;
  let codex = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--all") {
      all = true;
      i++;
      continue;
    }
    if (arg === "--container" && i + 1 < args.length) {
      container = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--chunk-tokens" && i + 1 < args.length) {
      chunkTokens = Number.parseInt(args[i + 1]!, 10);
      i += 2;
      continue;
    }
    if (arg === "--overlap-tokens" && i + 1 < args.length) {
      overlapTokens = Number.parseInt(args[i + 1]!, 10);
      i += 2;
      continue;
    }
    if (arg === "--markdown" && i + 1 < args.length) {
      markdown = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--repo-map" && i + 1 < args.length) {
      repoMap = args[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--skip-vector") {
      skipVector = true;
      i++;
      continue;
    }
    if (arg === "--skip-full-text") {
      skipFullText = true;
      i++;
      continue;
    }
    if (arg === "--opencode") {
      opencode = true;
      i++;
      continue;
    }
    if (arg === "--claude") {
      claude = true;
      i++;
      continue;
    }
    if (arg === "--codex") {
      codex = true;
      i++;
      continue;
    }
    if (arg === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[i + 1]!, 10) || CONFIG.maxMemories;
      i += 2;
      continue;
    }
    if (arg === "--threshold" && i + 1 < args.length) {
      threshold = parseFloat(args[i + 1]!);
      if (isNaN(threshold)) threshold = undefined;
      i += 2;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      command = "help";
      i++;
      continue;
    }

    if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
    i++;
  }

  return {
    command: command || "help",
    text: positionals.join(" "),
    positionals,
    limit,
    threshold,
    all,
    container,
    chunkTokens,
    overlapTokens,
    markdown,
    repoMap,
    skipVector,
    skipFullText,
    opencode,
    claude,
    codex,
  };
}

interface ImportedChunkMetadata {
  sourcePath?: string;
  sourceKey?: string;
  startLine?: number;
  endLine?: number;
  chunkIndex?: number;
  chunkCount?: number;
  language?: string;
  symbols?: string[];
  importType?: string;
}

function resolveNamedContainerInfo(containerName: string): ReturnType<typeof getNamedContainerInfo> {
  try {
    return getNamedContainerInfo(containerName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

function resolveContainerTag(
  containerName: string | undefined,
  projectInfo: ReturnType<typeof getProjectInfo>,
): string {
  if (containerName !== undefined) return resolveNamedContainerInfo(containerName).tag;
  return projectInfo.tag;
}

function parseImportedChunkMetadata(raw: string | undefined): ImportedChunkMetadata | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as ImportedChunkMetadata;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function formatLineRange(startLine?: number, endLine?: number): string {
  if (!startLine || !endLine) return "";
  if (startLine === endLine) return `:${startLine}`;
  return `:${startLine}-${endLine}`;
}

async function cmdAdd(text: string, containerName?: string): Promise<void> {
  if (!text) {
    console.error("Error: no text provided.\n\nUsage: memo add <text>");
    process.exit(1);
  }

  // Privacy filtering
  const sanitized = stripPrivateContent(text);
  if (isFullyPrivate(text)) {
    console.error("Error: content is entirely private (wrapped in <private> tags).");
    process.exit(1);
  }

  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);
  const containerTag = resolveContainerTag(containerName, projectInfo);

  // Embed the content with symmetric clustering prefix
  const vector = await embeddingService.embedText(sanitized);

  // Deduplication check
  const dedup = checkDuplicate(sanitized, vector, containerTag);
  if (dedup.isDuplicate) {
    console.log(
      `Skipped: ${dedup.reason} (existing: ${dedup.existingId}, similarity: ${dedup.similarity?.toFixed(3)})`,
    );
    return;
  }

  const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const now = Date.now();

  const record: MemoryRecord = {
    id,
    content: sanitized,
    vector,
    containerTag,
    createdAt: now,
    updatedAt: now,
    displayName: projectInfo.displayName,
    userName: projectInfo.userName,
    userEmail: projectInfo.userEmail,
    projectPath: projectInfo.projectPath,
    projectName: projectInfo.projectName,
    gitRepoUrl: projectInfo.gitRepoUrl,
  };

  insertMemory(record);
  log("Memory added", { id, containerTag });
  console.log(`Stored: ${id}`);
}

async function cmdImport(
  markdownPath: string | undefined,
  repoMapPath: string | undefined,
  containerFlag: string | undefined,
  chunkTokens: number,
  overlapTokens: number,
): Promise<void> {
  if (markdownPath && repoMapPath) {
    console.error("Error: --markdown and --repo-map cannot be used together.");
    process.exit(1);
  }

  if (repoMapPath) {
    return cmdImportRepoMap(repoMapPath, containerFlag);
  }

  if (markdownPath) {
    return cmdImportMarkdown(markdownPath, containerFlag, chunkTokens, overlapTokens);
  }

  console.error(
    "Error: import requires --markdown or --repo-map.\n\nUsage:\n  memo import --markdown <path> [--container <name>]\n  memo import --repo-map <file.json> [--container <name>]",
  );
  process.exit(1);
}

async function cmdImportRepoMap(
  jsonPath: string,
  containerFlag: string | undefined,
): Promise<void> {
  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);
  const containerTag = resolveContainerTag(containerFlag, projectInfo);

  const namedContainerInfo = containerFlag
    ? resolveNamedContainerInfo(containerFlag)
    : null;

  const containerLabel = namedContainerInfo
    ? namedContainerInfo.normalizedName
    : projectInfo.displayName;

  let repoMapResult: ReturnType<typeof collectRepoMapEntries>;
  try {
    repoMapResult = collectRepoMapEntries(jsonPath, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  if (repoMapResult.entries.length === 0) {
    console.log("No entries found in repo-map file.");
    return;
  }

  const records: MemoryRecord[] = [];

  for (const entry of repoMapResult.entries) {
    const content = buildRepoMapContent(entry);
    const now = Date.now();
    const vector = await embeddingService.embedText(content);

    const metadata = JSON.stringify({
      sourcePath: entry.path,
      sourceKey: repoMapResult.sourceKey,
      language: entry.language,
      symbols: entry.symbols,
      importType: "repo-map",
    });

    records.push({
      id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      content,
      vector,
      containerTag,
      tags: repoMapResult.sourceKey,
      type: "doc_chunk",
      createdAt: now,
      updatedAt: now,
      metadata,
      displayName: containerLabel,
      userName: projectInfo.userName,
      userEmail: projectInfo.userEmail,
      projectPath: projectInfo.projectPath,
      projectName: projectInfo.projectName,
      gitRepoUrl: projectInfo.gitRepoUrl,
    });
  }

  const { deleted } = replaceImportedChunksForSource(
    containerTag,
    repoMapResult.sourceKey,
    records,
  );

  log("Repo-map import complete", {
    containerTag,
    containerLabel,
    sourceKey: repoMapResult.sourceKey,
    entries: records.length,
    replaced: deleted,
  });

  console.log(
    `Imported ${records.length} file entries from repo-map into container "${containerLabel}".`,
  );
  if (deleted > 0) {
    console.log(`Replaced ${deleted} existing entries from previous repo-map import.`);
  }
}

async function cmdImportMarkdown(
  importPath: string,
  containerFlag: string | undefined,
  chunkTokens: number,
  overlapTokens: number,
): Promise<void> {
  if (!Number.isInteger(chunkTokens) || chunkTokens <= 0) {
    console.error("Error: --chunk-tokens must be a positive integer.");
    process.exit(1);
  }

  if (!Number.isInteger(overlapTokens) || overlapTokens < 0) {
    console.error("Error: --overlap-tokens must be a non-negative integer.");
    process.exit(1);
  }

  if (overlapTokens >= chunkTokens) {
    console.error("Error: --overlap-tokens must be smaller than --chunk-tokens.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);
  const containerTag = resolveContainerTag(containerFlag, projectInfo);

  const namedContainerInfo = containerFlag
    ? resolveNamedContainerInfo(containerFlag)
    : null;

  const containerLabel = namedContainerInfo
    ? namedContainerInfo.normalizedName
    : projectInfo.displayName;

  let collected: ReturnType<typeof collectImportChunks>;
  try {
    collected = collectImportChunks(importPath, {
      cwd,
      chunkTokens,
      overlapTokens,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  if (collected.files.length === 0) {
    console.log("No markdown files with importable content found.");
    return;
  }

  let fileCount = 0;
  let insertedTotal = 0;
  let replacedTotal = 0;

  for (const file of collected.files) {
    const records: MemoryRecord[] = [];

    for (let i = 0; i < file.chunks.length; i += 1) {
      const chunk = file.chunks[i];
      if (!chunk) continue;

      const now = Date.now();
      const vector = await embeddingService.embedText(chunk.text);

      const metadata = JSON.stringify({
        sourcePath: file.sourcePath,
        sourceKey: file.sourceKey,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkIndex: i + 1,
        chunkCount: file.chunks.length,
        chunkHash: chunk.hash,
      });

      records.push({
        id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        content: chunk.text,
        vector,
        containerTag,
        tags: file.sourceKey,
        type: "doc_chunk",
        createdAt: now,
        updatedAt: now,
        metadata,
        displayName: containerLabel,
        userName: projectInfo.userName,
        userEmail: projectInfo.userEmail,
        projectPath: projectInfo.projectPath,
        projectName: projectInfo.projectName,
        gitRepoUrl: projectInfo.gitRepoUrl,
      });
    }

    const { deleted, inserted } = replaceImportedChunksForSource(
      containerTag,
      file.sourceKey,
      records,
    );

    replacedTotal += deleted;
    insertedTotal += inserted;
    fileCount += 1;
  }

  log("Markdown import complete", {
    containerTag,
    containerLabel,
    inputPath: collected.inputPath,
    files: fileCount,
    inserted: insertedTotal,
    replaced: replacedTotal,
    skippedEmptyFiles: collected.skippedEmptyFiles,
    chunkTokens,
    overlapTokens,
  });

  console.log(
    `Imported ${insertedTotal} chunks from ${fileCount} files into container \"${containerLabel}\".`,
  );
  if (replacedTotal > 0) {
    console.log(`Replaced ${replacedTotal} existing chunks from previously imported files.`);
  }
  if (collected.skippedEmptyFiles > 0) {
    console.log(`Skipped ${collected.skippedEmptyFiles} empty markdown files.`);
  }
}

async function cmdSearch(
  query: string,
  limit: number,
  containerName: string | undefined,
  threshold?: number,
  skipVector?: boolean,
  skipFullText?: boolean,
): Promise<void> {
  if (!query) {
    console.error("Error: no query provided.\n\nUsage: memo search <query> [--limit N] [--threshold N] [--container N]");
    process.exit(1);
  }

  if (skipVector && skipFullText) {
    console.error("Error: cannot skip both vector and full-text search.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);
  const containerTag = containerName ? resolveContainerTag(containerName, projectInfo) : null;

  // Embed query with symmetric clustering prefix (same as storage)
  const queryVector = skipVector ? null : await embeddingService.embedText(query);
  const results = searchMemories(queryVector, containerTag, query, limit, threshold, skipFullText);

  if (results.length === 0) {
    console.log("No memories found.");
    return;
  }

  for (const r of results) {
    const date = new Date(r.createdAt).toISOString().split("T")[0];
    console.log(`\x1b[94m[${r.similarity.toFixed(3)}] (${r.id}) ${date}\x1b[0m`);

    if (r.type === "doc_chunk") {
      const metadata = parseImportedChunkMetadata(r.metadata);
      // Repo-map content already starts with "path [lang] symbols" — no extra line needed.
      // Markdown chunks need a source attribution line since the content is just text.
      if (metadata?.sourcePath && metadata.importType !== "repo-map") {
        const lineRange = formatLineRange(metadata.startLine, metadata.endLine);
        console.log(`  ${metadata.sourcePath}${lineRange}`);
      }
    }

    console.log(r.content);
  }
}

function cmdList(limit: number, all: boolean, containerName?: string): void {
  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);
  const containerTag = containerName ? resolveContainerTag(containerName, projectInfo) : null;

  const rows = listMemories(containerTag, all ? -1 : limit);

  if (rows.length === 0) {
    console.log("No memories stored yet.");
    return;
  }

  for (const row of rows) {
    const date = new Date(Number(row.created_at)).toISOString().split("T")[0];
    console.log(`(${row.id}) ${date}`);
    console.log(`  ${row.content}`);
  }
}

function cmdForget(id: string, containerName?: string): void {
  if (!id) {
    console.error("Error: no memory ID provided.\n\nUsage: memo forget <id>");
    process.exit(1);
  }

  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);

  // If a named container is specified, verify the memory belongs to it
  if (containerName) {
    const containerTag = resolveContainerTag(containerName, projectInfo);
    const memoryTag = getMemoryContainerTag(id);
    if (!memoryTag) {
      console.error(`Memory not found: ${id}`);
      process.exit(1);
    }
    if (memoryTag !== containerTag) {
      console.error(
        `Error: memory ${id} belongs to a different container. Use the correct --container flag.`,
      );
      process.exit(1);
    }
  }

  const deleted = deleteMemory(id);
  if (deleted) {
    log("Memory deleted", { id });
    console.log(`Deleted: ${id}`);
  } else {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
}

function cmdTags(): void {
  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);

  console.log("Project:");
  console.log(`  Tag:    ${projectInfo.tag}`);
  console.log(`  Name:   ${projectInfo.projectName}`);
  console.log(`  Path:   ${projectInfo.projectPath}`);
  if (projectInfo.gitRepoUrl) console.log(`  Git:    ${projectInfo.gitRepoUrl}`);
  console.log(`  DB:     ${getDbPath(cwd)}`);
}

function cmdReset(): void {
  resetDb();
  console.log("All memories have been reset. Database cleared.");
}

function cmdReindex(): void {
  const { added, removed } = reindexFts();
  if (added === 0 && removed === 0) {
    console.log("Search indexes are up to date.");
  } else {
    if (added > 0) console.log(`Added ${added} missing entries to search index.`);
    if (removed > 0) console.log(`Removed ${removed} orphaned entries from search index.`);
    console.log("Reindex complete.");
  }
}

function formatContainerLabel(containerTag: string, projectTag: string): string {
  if (containerTag === projectTag) return "(default)";
  if (containerTag.startsWith("memo_container_")) return containerTag.slice("memo_container_".length);
  return containerTag;
}

function cmdStatus(): void {
  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);
  const dbPath = getDbPath(cwd);

  const totalCount = countMemories();
  const byContainer = countMemoriesByContainer();

  console.log("Memo Status:");
  console.log(`  Model:            ${CONFIG.embeddingModel}`);
  console.log(`  Dimensions:       ${CONFIG.embeddingDimensions}`);
  console.log(`  Model loaded:     ${embeddingService.isWarmedUp}`);
  console.log(`  DB path:          ${dbPath}`);
  console.log(`  Project:          ${projectInfo.projectName} (${projectInfo.projectPath})`);
  console.log(`  Total memories:   ${totalCount}`);
  console.log(`  Similarity threshold: ${CONFIG.similarityThreshold}`);
  console.log(`  Deduplication:    ${CONFIG.deduplicationEnabled ? "on" : "off"} (threshold: ${CONFIG.deduplicationSimilarityThreshold})`);

  if (byContainer.length > 0) {
    console.log("\nContainers:");
    for (const { containerTag, count } of byContainer) {
      const label = formatContainerLabel(containerTag, projectInfo.tag);
      console.log(`  ${label}: ${count}`);
    }
  }
}

const INSTALL_USAGE = `Usage: memo install skills --opencode | --claude | --codex

Symlinks memo agent skills into the target tool's skills directory.

Targets:
  --opencode    ~/.config/opencode/skills/
  --claude      ~/.claude/skills/
  --codex       ~/.agents/skills/
`;

function cmdInstall(
  subcommand: string,
  flags: { opencode: boolean; claude: boolean; codex: boolean },
): void {
  if (subcommand !== "skills") {
    console.error(INSTALL_USAGE);
    process.exit(1);
  }

  const targets: { name: string; dir: string }[] = [];
  const home = homedir();

  if (flags.opencode) targets.push({ name: "OpenCode", dir: join(home, ".config", "opencode", "skills") });
  if (flags.claude) targets.push({ name: "Claude Code", dir: join(home, ".claude", "skills") });
  if (flags.codex) targets.push({ name: "Codex", dir: join(home, ".agents", "skills") });

  if (targets.length === 0) {
    console.error("Error: specify at least one target: --opencode, --claude, or --codex\n");
    console.error(INSTALL_USAGE);
    process.exit(1);
  }

  // Resolve skills source directory relative to this file
  const skillsSrc = resolve(import.meta.dir, "..", "skills");
  if (!existsSync(skillsSrc)) {
    console.error(`Error: skills directory not found at ${skillsSrc}`);
    process.exit(1);
  }

  const skillNames = readdirSync(skillsSrc).filter((name) => {
    const fullPath = join(skillsSrc, name);
    try {
      return Bun.file(join(fullPath, "SKILL.md")).size > 0;
    } catch {
      return false;
    }
  });

  if (skillNames.length === 0) {
    console.error("Error: no skills found in source directory.");
    process.exit(1);
  }

  for (const target of targets) {
    console.log(`\n${target.name} (${target.dir}):`);
    mkdirSync(target.dir, { recursive: true });

    for (const skill of skillNames) {
      const src = join(skillsSrc, skill);
      const dest = join(target.dir, skill);

      if (existsSync(dest)) {
        // Check if it's already a symlink pointing to the right place
        try {
          const existing = readlinkSync(dest);
          if (resolve(existing) === resolve(src)) {
            console.log(`  ${skill} - already linked`);
            continue;
          }
          console.log(`  ${skill} - skipped (already exists, points to ${existing})`);
        } catch {
          console.log(`  ${skill} - skipped (already exists as directory/file)`);
        }
        continue;
      }

      symlinkSync(src, dest, "dir");
      console.log(`  ${skill} - linked`);
    }
  }

  console.log("\nDone.");
}

async function main(): Promise<void> {
  const {
    command,
    text,
    positionals,
    limit,
    threshold,
    all,
    container,
    chunkTokens,
    overlapTokens,
    markdown,
    repoMap,
    skipVector,
    skipFullText,
    opencode,
    claude,
    codex,
  } = parseArgs(process.argv);

  // install command doesn't need DB
  if (command === "install") {
    cmdInstall(positionals[0] || "", { opencode, claude, codex });
    return;
  }

  // reset command needs special handling (closes DB first)
  if (command === "reset") {
    cmdReset();
    return;
  }

  try {
    switch (command) {
      case "add":
        await cmdAdd(text, container);
        break;
      case "import":
        await cmdImport(markdown, repoMap, container, chunkTokens, overlapTokens);
        break;
      case "search":
        await cmdSearch(text, limit, container, threshold, skipVector, skipFullText);
        break;
      case "list":
        cmdList(limit, all, container);
        break;
      case "forget":
        cmdForget(text, container);
        break;
      case "tags":
        cmdTags();
        break;
      case "status":
        cmdStatus();
        break;
      case "reindex":
        cmdReindex();
        break;
      case "help":
        console.log(USAGE);
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } finally {
    closeDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("CLI error", { error: String(err) });
    console.error(err);
    process.exit(1);
  });
