#!/usr/bin/env bun

import {
  insertMemory,
  deleteMemory,
  listMemories,
  countMemories,
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
import { getTags, getNamedContainerInfo } from "./tags.ts";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";
import {
  collectImportChunks,
  DEFAULT_IMPORT_CHUNK_TOKENS,
  DEFAULT_IMPORT_OVERLAP_TOKENS,
} from "./importer.ts";
import { existsSync, symlinkSync, readlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const USAGE = `memo - persistent memory for LLM agent sessions

Commands:
  memo add <text>                   Store a memory (scoped to current project)
  memo import <path> [--container N]
                                    Import markdown file/folder into memory
  memo import <container> <path>
                                    Import markdown into a named container
  memo search <query> [--limit N] [--threshold N] [--container N]
                                    Hybrid semantic + keyword search (default top ${CONFIG.maxMemories})
  memo list [--limit N] [--all] [--container N]
                                    List recent memories (--all for no limit)
  memo forget <id>                  Delete a memory by ID
  memo reset                        Reset all memories (irreversible)
  memo reindex                      Rebuild search indexes
  memo tags                         Show detected project/user info
  memo status                       Show system status
  memo install skills <target>      Install agent skills (--opencode, --claude, --codex)

Flags:
  --global                          Operate across all projects
  --container <name>                Operate on a named container scope
  --chunk-tokens N                  Import chunk size in tokens (default ${DEFAULT_IMPORT_CHUNK_TOKENS})
  --overlap-tokens N                Import chunk overlap in tokens (default ${DEFAULT_IMPORT_OVERLAP_TOKENS})
  --all                             List all memories (no limit)
  --help, -h                        Show this help
`;

function parseArgs(argv: string[]): {
  command: string;
  text: string;
  positionals: string[];
  limit: number;
  threshold: number | undefined;
  global: boolean;
  all: boolean;
  container: string | undefined;
  chunkTokens: number;
  overlapTokens: number;
  opencode: boolean;
  claude: boolean;
  codex: boolean;
} {
  const args = argv.slice(2);
  let command = "";
  const positionals: string[] = [];
  let limit = CONFIG.maxMemories;
  let threshold: number | undefined = undefined;
  let global = false;
  let all = false;
  let container: string | undefined = undefined;
  let chunkTokens = DEFAULT_IMPORT_CHUNK_TOKENS;
  let overlapTokens = DEFAULT_IMPORT_OVERLAP_TOKENS;
  let opencode = false;
  let claude = false;
  let codex = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--global") {
      global = true;
      i++;
      continue;
    }
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
    global,
    all,
    container,
    chunkTokens,
    overlapTokens,
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
}

function ensureScopeFlags(global: boolean, containerName?: string): void {
  if (global && containerName !== undefined) {
    console.error("Error: --global and --container cannot be used together.");
    process.exit(1);
  }
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

function resolveNamedContainerTag(containerName: string): string {
  return resolveNamedContainerInfo(containerName).tag;
}

function resolveReadContainerTag(
  global: boolean,
  containerName: string | undefined,
  tagInfo: ReturnType<typeof getTags>,
): string | null {
  ensureScopeFlags(global, containerName);
  if (containerName !== undefined) return resolveNamedContainerTag(containerName);
  return global ? null : tagInfo.project.tag;
}

function resolveWriteContainerTag(
  global: boolean,
  containerName: string | undefined,
  tagInfo: ReturnType<typeof getTags>,
): string {
  ensureScopeFlags(global, containerName);
  if (containerName !== undefined) return resolveNamedContainerTag(containerName);
  return global ? tagInfo.user.tag : tagInfo.project.tag;
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

async function cmdAdd(text: string, global: boolean, containerName?: string): Promise<void> {
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
  const tagInfo = getTags(cwd);
  const containerTag = resolveWriteContainerTag(global, containerName, tagInfo);

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
    displayName: tagInfo.project.displayName,
    userName: tagInfo.user.userName,
    userEmail: tagInfo.user.userEmail,
    projectPath: tagInfo.project.projectPath,
    projectName: tagInfo.project.projectName,
    gitRepoUrl: tagInfo.project.gitRepoUrl,
  };

  insertMemory(record);
  log("Memory added", { id, containerTag });
  console.log(`Stored: ${id}`);
}

async function cmdImport(
  positionals: string[],
  global: boolean,
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

  if (positionals.length === 0) {
    console.error(
      "Error: no import path provided.\n\nUsage:\n  memo import <path>\n  memo import <container> <path>\n  memo import <path> --container <container>",
    );
    process.exit(1);
  }

  let importPath = "";
  let containerName = containerFlag;

  if (containerFlag) {
    importPath = positionals.join(" ").trim();
  } else if (positionals.length === 1) {
    importPath = positionals[0] || "";
  } else {
    containerName = positionals[0];
    importPath = positionals.slice(1).join(" ").trim();
  }

  if (!importPath) {
    console.error(
      "Error: no import path provided.\n\nUsage:\n  memo import <path>\n  memo import <container> <path>\n  memo import <path> --container <container>",
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const tagInfo = getTags(cwd);
  const containerTag = resolveWriteContainerTag(global, containerName, tagInfo);

  const namedContainerInfo = containerName
    ? resolveNamedContainerInfo(containerName)
    : null;

  const containerLabel = namedContainerInfo
    ? namedContainerInfo.normalizedName
    : global
      ? tagInfo.user.displayName
      : tagInfo.project.displayName;

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
        userName: tagInfo.user.userName,
        userEmail: tagInfo.user.userEmail,
        projectPath: tagInfo.project.projectPath,
        projectName: tagInfo.project.projectName,
        gitRepoUrl: tagInfo.project.gitRepoUrl,
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
  global: boolean,
  containerName: string | undefined,
  threshold?: number,
): Promise<void> {
  if (!query) {
    console.error("Error: no query provided.\n\nUsage: memo search <query> [--limit N] [--threshold N] [--container N]");
    process.exit(1);
  }

  const cwd = process.cwd();
  const tagInfo = getTags(cwd);
  const containerTag = resolveReadContainerTag(global, containerName, tagInfo);

  // Embed query with symmetric clustering prefix (same as storage)
  const queryVector = await embeddingService.embedText(query);
  const results = searchMemories(queryVector, containerTag, query, limit, threshold);

  if (results.length === 0) {
    console.log("No memories found.");
    return;
  }

  for (const r of results) {
    const date = new Date(r.createdAt).toISOString().split("T")[0];
    console.log(`[${r.similarity.toFixed(3)}] (${r.id}) ${date}`);

    if (r.type === "doc_chunk") {
      const metadata = parseImportedChunkMetadata(r.metadata);
      if (metadata?.sourcePath) {
        const lineRange = formatLineRange(metadata.startLine, metadata.endLine);
        console.log(`  ${metadata.sourcePath}${lineRange}`);
      }
    }

    console.log(`  ${r.content}`);
  }
}

function cmdList(limit: number, global: boolean, all: boolean, containerName?: string): void {
  const cwd = process.cwd();
  const tagInfo = getTags(cwd);
  const containerTag = resolveReadContainerTag(global, containerName, tagInfo);

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

function cmdForget(id: string): void {
  if (!id) {
    console.error("Error: no memory ID provided.\n\nUsage: memo forget <id>");
    process.exit(1);
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
  const tagInfo = getTags(cwd);

  console.log("User:");
  console.log(`  Tag:   ${tagInfo.user.tag}`);
  console.log(`  Name:  ${tagInfo.user.displayName}`);
  if (tagInfo.user.userEmail) console.log(`  Email: ${tagInfo.user.userEmail}`);

  console.log("\nProject:");
  console.log(`  Tag:   ${tagInfo.project.tag}`);
  console.log(`  Name:  ${tagInfo.project.projectName}`);
  console.log(`  Path:  ${tagInfo.project.projectPath}`);
  if (tagInfo.project.gitRepoUrl) console.log(`  Git:   ${tagInfo.project.gitRepoUrl}`);
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

function cmdStatus(): void {
  const cwd = process.cwd();
  const tagInfo = getTags(cwd);

  const projectCount = countMemories(tagInfo.project.tag);
  const totalCount = countMemories(null);

  console.log("Memo Status:");
  console.log(`  Model:            ${CONFIG.embeddingModel}`);
  console.log(`  Dimensions:       ${CONFIG.embeddingDimensions}`);
  console.log(`  Model loaded:     ${embeddingService.isWarmedUp}`);
  console.log(`  DB path:          ${CONFIG.storagePath}/memo.db`);
  console.log(`  Project memories: ${projectCount}`);
  console.log(`  Total memories:   ${totalCount}`);
  console.log(`  Similarity threshold: ${CONFIG.similarityThreshold}`);
  console.log(`  Deduplication:    ${CONFIG.deduplicationEnabled ? "on" : "off"} (threshold: ${CONFIG.deduplicationSimilarityThreshold})`);
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
    global,
    all,
    container,
    chunkTokens,
    overlapTokens,
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
        await cmdAdd(text, global, container);
        break;
      case "import":
        await cmdImport(positionals, global, container, chunkTokens, overlapTokens);
        break;
      case "search":
        await cmdSearch(text, limit, global, container, threshold);
        break;
      case "list":
        cmdList(limit, global, all, container);
        break;
      case "forget":
        cmdForget(text);
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
