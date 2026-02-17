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

const USAGE = `memo - persistent memory for LLM agent sessions

Commands:
  memo add <text> [--tags t1,t2]    Store a memory (scoped to current project)
  memo search <query> [--limit N]   Semantic search (default top ${CONFIG.maxMemories})
  memo list [--limit N]             List recent memories
  memo forget <id>                  Delete a memory by ID
  memo tags                         Show detected project/user info
  memo status                       Show system status

Flags:
  --global                          Operate across all projects
  --help, -h                        Show this help
`;

function parseArgs(argv: string[]): {
  command: string;
  text: string;
  tags?: string[];
  limit: number;
  global: boolean;
} {
  const args = argv.slice(2);
  let command = "";
  const textParts: string[] = [];
  let tags: string[] | undefined;
  let limit = CONFIG.maxMemories;
  let global = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--global") {
      global = true;
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

function cmdList(limit: number, global: boolean): void {
  const cwd = process.cwd();
  const tagInfo = getTags(cwd);
  const containerTag = global ? null : tagInfo.project.tag;

  const rows = listMemories(containerTag, limit);

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

async function main(): Promise<void> {
  const { command, text, tags, limit, global } = parseArgs(process.argv);

  try {
    switch (command) {
      case "add":
        await cmdAdd(text, tags, global);
        break;
      case "search":
        await cmdSearch(text, limit, global);
        break;
      case "list":
        cmdList(limit, global);
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
