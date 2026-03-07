#!/usr/bin/env bun

import {
  insertMemory,
  deleteMemory,
  listMemories,
  countMemories,
  closeDb,
  resetDb,
  reindexFts,
  replaceChunksForSource,
  getSourceHash,
  setSourceHash,
} from "./db.ts";
import type { MemoryRecord } from "./db.ts";
import { searchMemories } from "./search.ts";
import { embeddingService } from "./embed.ts";
import { checkDuplicate } from "./dedup.ts";
import { stripPrivateContent, isFullyPrivate } from "./privacy.ts";
import { getProjectInfo } from "./tags.ts";
import { getDbPath } from "./db.ts";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";
import { collectImportChunks } from "./importer.ts";
import { existsSync, symlinkSync, readlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const USAGE = `memo - persistent memory for LLM agent sessions

Data is stored per project in .memo/memo.db (shared across git worktrees).

Commands:
  memo add <text>                   Store a memory (scoped to current project)
  memo embed <path>                 Embed markdown file/folder into memory
  memo search <query> [--limit N] [--threshold N] [--skip-vector] [--skip-full-text]
                                    Hybrid semantic + keyword search (default top ${CONFIG.maxMemories})
  memo list [--limit N] [--all]     List recent memories (--all for no limit)
  memo forget <id>                  Delete a memory by ID
  memo reset                        Reset project memories (irreversible)
  memo reindex                      Rebuild search indexes
  memo status                       Show system status
  memo install skills <target>      Install agent skills (--opencode, --claude, --codex)

Flags:
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
    skipVector,
    skipFullText,
    opencode,
    claude,
    codex,
  };
}

async function cmdAdd(text: string): Promise<void> {
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

  // Embed the content with symmetric clustering prefix
  const vector = await embeddingService.embedText(sanitized);

  // Deduplication check
  const dedup = checkDuplicate(sanitized, vector);
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
    createdAt: now,
  };

  insertMemory(record);
  log("Memory added", { id });
  console.log(`Stored: ${id}`);
}

async function cmdEmbed(inputPath: string): Promise<void> {
  if (!inputPath) {
    console.error("Error: no path provided.\n\nUsage: memo embed <path>");
    process.exit(1);
  }

  const cwd = process.cwd();

  let collected: ReturnType<typeof collectImportChunks>;
  try {
    collected = collectImportChunks(inputPath, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  if (collected.files.length === 0) {
    console.log("No markdown files with embeddable content found.");
    return;
  }

  let fileCount = 0;
  let skippedUnchanged = 0;
  let insertedTotal = 0;
  let replacedTotal = 0;

  // Filter out unchanged files before counting chunks to embed
  const filesToEmbed = collected.files.filter((file) => {
    const storedHash = getSourceHash(file.sourceKey);
    if (storedHash === file.contentHash) {
      skippedUnchanged++;
      return false;
    }
    return true;
  });

  const totalChunks = filesToEmbed.reduce((sum, f) => sum + f.chunks.length, 0);
  let chunksDone = 0;

  for (const file of filesToEmbed) {
    const records: MemoryRecord[] = [];

    for (let i = 0; i < file.chunks.length; i++) {
      const chunk = file.chunks[i]!;
      const now = Date.now();
      // Embed only the chunk text (no header) for cleaner vector similarity
      const vector = await embeddingService.embedText(chunk.text);
      // Store with path header so search results show the source location
      const header = `${i + 1}-${file.sourceKey}:${chunk.startLine}`;
      const content = `${header}\n${chunk.text}`;

      records.push({
        id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        content,
        vector,
        createdAt: now,
        sourceKey: file.sourceKey,
      });

      chunksDone++;
      process.stdout.write(`\r  Embedding ${chunksDone}/${totalChunks} chunks...`);
    }

    const { deleted, inserted } = replaceChunksForSource(file.sourceKey, records);
    setSourceHash(file.sourceKey, file.contentHash);

    replacedTotal += deleted;
    insertedTotal += inserted;
    fileCount += 1;
  }

  // Clear the progress line
  if (totalChunks > 0) {
    process.stdout.write("\r" + " ".repeat(50) + "\r");
  }

  log("Embed complete", {
    inputPath: collected.inputPath,
    files: fileCount,
    inserted: insertedTotal,
    replaced: replacedTotal,
    skippedUnchanged,
    skippedEmptyFiles: collected.skippedEmptyFiles,
  });

  if (fileCount > 0) {
    console.log(`Embedded ${insertedTotal} chunks from ${fileCount} file(s).`);
  }
  if (replacedTotal > 0) {
    console.log(`Replaced ${replacedTotal} existing chunks from previously embedded files.`);
  }
  if (skippedUnchanged > 0) {
    console.log(`Skipped ${skippedUnchanged} unchanged file(s).`);
  }
  if (collected.skippedEmptyFiles > 0) {
    console.log(`Skipped ${collected.skippedEmptyFiles} empty markdown file(s).`);
  }
  if (fileCount === 0 && skippedUnchanged > 0) {
    console.log("All files up to date.");
  }
}

async function cmdSearch(
  query: string,
  limit: number,
  threshold?: number,
  skipVector?: boolean,
  skipFullText?: boolean,
): Promise<void> {
  if (!query) {
    console.error("Error: no query provided.\n\nUsage: memo search <query> [--limit N] [--threshold N]");
    process.exit(1);
  }

  if (skipVector && skipFullText) {
    console.error("Error: cannot skip both vector and full-text search.");
    process.exit(1);
  }

  // Embed query with symmetric clustering prefix (same as storage)
  const queryVector = skipVector ? null : await embeddingService.embedText(query);
  const results = searchMemories(queryVector, query, limit, threshold, skipFullText);

  if (results.length === 0) {
    console.log("No memories found.");
    return;
  }

  for (const r of results) {
    const date = new Date(r.createdAt).toISOString().split("T")[0];
    console.log(`\x1b[94m[${r.similarity.toFixed(3)}] (${r.id}) ${date}\x1b[0m`);
    console.log(r.content);
  }
}

function cmdList(limit: number, all: boolean): void {
  const rows = listMemories(all ? -1 : limit);

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

function cmdStatus(): void {
  const cwd = process.cwd();
  const projectInfo = getProjectInfo(cwd);
  const dbPath = getDbPath(cwd);

  const totalCount = countMemories();

  console.log("Memo Status:");
  console.log(`  Model:            ${CONFIG.embeddingModel}`);
  console.log(`  Dimensions:       ${CONFIG.embeddingDimensions}`);
  console.log(`  Model loaded:     ${embeddingService.isWarmedUp}`);
  console.log(`  DB path:          ${dbPath}`);
  console.log(`  Project:          ${projectInfo.projectName} (${projectInfo.projectPath})`);
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
    all,
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
        await cmdAdd(text);
        break;
      case "embed":
        await cmdEmbed(text);
        break;
      case "search":
        await cmdSearch(text, limit, threshold, skipVector, skipFullText);
        break;
      case "list":
        cmdList(limit, all);
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
