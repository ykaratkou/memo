#!/usr/bin/env bun

import { insertMemory, deleteMemory, listMemories, countMemories, closeDb } from "./db.ts";
import type { MemoryRecord } from "./db.ts";
import { searchMemories } from "./search.ts";
import { embeddingService } from "./embed.ts";
import { checkDuplicate } from "./dedup.ts";
import { stripPrivateContent, isFullyPrivate } from "./privacy.ts";
import { getTags } from "./tags.ts";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";
import { existsSync, symlinkSync, readlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const USAGE = `memo - persistent memory for LLM agent sessions

Commands:
  memo add <text> [--tags t1,t2]    Store a memory (scoped to current project)
  memo search <query> [--limit N]   Semantic search (default top ${CONFIG.maxMemories})
  memo list [--limit N] [--all]     List recent memories (--all for no limit)
  memo forget <id>                  Delete a memory by ID
  memo tags                         Show detected project/user info
  memo status                       Show system status
  memo install skills <target>      Install agent skills (--opencode, --claude, --codex)

Flags:
  --global                          Operate across all projects
  --all                             List all memories (no limit)
  --help, -h                        Show this help
`;

function parseArgs(argv: string[]): {
  command: string;
  text: string;
  tags?: string[];
  limit: number;
  global: boolean;
  all: boolean;
  opencode: boolean;
  claude: boolean;
  codex: boolean;
} {
  const args = argv.slice(2);
  let command = "";
  const textParts: string[] = [];
  let tags: string[] | undefined;
  let limit = CONFIG.maxMemories;
  let global = false;
  let all = false;
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
    if (arg === "--tags" && i + 1 < args.length) {
      tags = args[i + 1]!.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
      i += 2;
      continue;
    }
    if (arg === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[i + 1]!, 10) || CONFIG.maxMemories;
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
      textParts.push(arg);
    }
    i++;
  }

  return {
    command: command || "help",
    text: textParts.join(" "),
    tags,
    limit,
    global,
    all,
    opencode,
    claude,
    codex,
  };
}

async function cmdAdd(text: string, tags: string[] | undefined, global: boolean): Promise<void> {
  if (!text) {
    console.error("Error: no text provided.\n\nUsage: memo add <text> [--tags t1,t2]");
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
  const containerTag = global ? tagInfo.user.tag : tagInfo.project.tag;

  // Embed the content
  const vector = await embeddingService.embedForStorage(sanitized);

  // Deduplication check
  const dedup = checkDuplicate(sanitized, vector, containerTag);
  if (dedup.isDuplicate) {
    console.log(
      `Skipped: ${dedup.reason} (existing: ${dedup.existingId}, similarity: ${dedup.similarity?.toFixed(3)})`,
    );
    return;
  }

  // Embed tags separately for tag-weighted search
  let tagsVector: Float32Array | undefined;
  if (tags && tags.length > 0) {
    tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
  }

  const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const now = Date.now();

  const record: MemoryRecord = {
    id,
    content: sanitized,
    vector,
    tagsVector,
    containerTag,
    tags: tags?.join(","),
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
  log("Memory added", { id, containerTag, tags });
  console.log(`Stored: ${id}`);
}

async function cmdSearch(query: string, limit: number, global: boolean): Promise<void> {
  if (!query) {
    console.error("Error: no query provided.\n\nUsage: memo search <query> [--limit N]");
    process.exit(1);
  }

  const cwd = process.cwd();
  const tagInfo = getTags(cwd);
  const containerTag = global ? null : tagInfo.project.tag;

  const queryVector = await embeddingService.embedForSearch(query);
  const results = searchMemories(queryVector, containerTag, query, limit);

  if (results.length === 0) {
    console.log("No memories found.");
    return;
  }

  for (const r of results) {
    const tagsStr = r.tags.length > 0 ? ` [${r.tags.join(",")}]` : "";
    const date = new Date(r.createdAt).toISOString().split("T")[0];
    console.log(`[${r.similarity.toFixed(3)}] (${r.id}) ${date}${tagsStr}`);
    console.log(`  ${r.content}`);
  }
}

function cmdList(limit: number, global: boolean, all: boolean): void {
  const cwd = process.cwd();
  const tagInfo = getTags(cwd);
  const containerTag = global ? null : tagInfo.project.tag;

  const rows = listMemories(containerTag, all ? -1 : limit);

  if (rows.length === 0) {
    console.log("No memories stored yet.");
    return;
  }

  for (const row of rows) {
    const date = new Date(Number(row.created_at)).toISOString().split("T")[0];
    const tagsStr = row.tags ? ` [${row.tags}]` : "";
    console.log(`(${row.id}) ${date}${tagsStr}`);
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
  const { command, text, tags, limit, global, all, opencode, claude, codex } = parseArgs(process.argv);

  // install command doesn't need DB
  if (command === "install") {
    cmdInstall(text, { opencode, claude, codex });
    return;
  }

  try {
    switch (command) {
      case "add":
        await cmdAdd(text, tags, global);
        break;
      case "search":
        await cmdSearch(text, limit, global);
        break;
      case "list":
        cmdList(limit, global, all);
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
