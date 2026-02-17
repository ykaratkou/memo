import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";

const DB_PATH = join(CONFIG.storagePath, "memo.db");

let _db: Database | null = null;
let sqliteConfigured = false;

function configureSqlite(): void {
  if (sqliteConfigured) return;

  if (process.platform === "darwin") {
    const customPath = CONFIG.customSqlitePath;

    if (customPath) {
      if (!existsSync(customPath)) {
        throw new Error(
          `Custom SQLite library not found at: ${customPath}\n` +
            `Verify the path or install Homebrew SQLite:\n` +
            `  brew install sqlite\n` +
            `  brew --prefix sqlite`,
        );
      }
      try {
        Database.setCustomSQLite(customPath);
      } catch (error) {
        if (!String(error).includes("SQLite already loaded")) throw error;
      }
    } else {
      const commonPaths = [
        "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
      ];

      let foundPath: string | null = null;
      for (const p of commonPaths) {
        if (existsSync(p)) {
          foundPath = p;
          break;
        }
      }

      if (foundPath) {
        try {
          Database.setCustomSQLite(foundPath);
        } catch (error) {
          if (!String(error).includes("SQLite already loaded")) throw error;
        }
      } else {
        throw new Error(
          `macOS detected but no compatible SQLite library found.\n\n` +
            `Apple's default SQLite does not support extension loading.\n` +
            `Install Homebrew SQLite:\n\n` +
            `  brew install sqlite\n\n` +
            `Then either:\n` +
            `  a) It will be auto-detected, or\n` +
            `  b) Set "customSqlitePath" in ~/.config/memo/config.jsonc\n\n` +
            `Common paths:\n` +
            `  Apple Silicon: /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib\n` +
            `  Intel Mac:     /usr/local/opt/sqlite/lib/libsqlite3.dylib`,
        );
      }
    }
  }

  sqliteConfigured = true;
}

function initSchema(db: Database): void {
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = -64000");
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA foreign_keys = ON");

  try {
    sqliteVec.load(db);
  } catch (error) {
    throw new Error(
      `Failed to load sqlite-vec extension: ${error}\n\n` +
        `On macOS, you must use Homebrew SQLite.\n` +
        `  brew install sqlite\n` +
        `  Then set "customSqlitePath" in ~/.config/memo/config.jsonc`,
    );
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      vector BLOB NOT NULL,
      container_tag TEXT NOT NULL,
      tags TEXT,
      type TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      display_name TEXT,
      user_name TEXT,
      user_email TEXT,
      project_path TEXT,
      project_name TEXT,
      git_repo_url TEXT
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_container_tag ON memories(container_tag)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC)`);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float32[${CONFIG.embeddingDimensions}] distance_metric=cosine
    )
  `);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_tags USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float32[${CONFIG.embeddingDimensions}] distance_metric=cosine
    )
  `);
}

export function getDb(): Database {
  if (_db) return _db;

  configureSqlite();

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  initSchema(_db);
  log("Database opened", { path: DB_PATH });

  return _db;
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      _db.close();
    } catch (error) {
      log("Error closing database", { error: String(error) });
    }
    _db = null;
  }
}

export interface MemoryRecord {
  id: string;
  content: string;
  vector: Float32Array;
  tagsVector?: Float32Array;
  containerTag: string;
  tags?: string;
  type?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

export function insertMemory(record: MemoryRecord): void {
  const db = getDb();
  const vectorBuffer = new Uint8Array(record.vector.buffer);

  db.run(
    `INSERT INTO memories (
      id, content, vector, container_tag, tags, type,
      created_at, updated_at, metadata,
      display_name, user_name, user_email,
      project_path, project_name, git_repo_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.content,
      vectorBuffer,
      record.containerTag,
      record.tags || null,
      record.type || null,
      record.createdAt,
      record.updatedAt,
      record.metadata || null,
      record.displayName || null,
      record.userName || null,
      record.userEmail || null,
      record.projectPath || null,
      record.projectName || null,
      record.gitRepoUrl || null,
    ],
  );

  db.run(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`, [
    record.id,
    vectorBuffer,
  ]);

  if (record.tagsVector) {
    const tagsBuffer = new Uint8Array(record.tagsVector.buffer);
    db.run(`INSERT INTO vec_tags (memory_id, embedding) VALUES (?, ?)`, [
      record.id,
      tagsBuffer,
    ]);
  }
}

export function deleteMemory(memoryId: string): boolean {
  const db = getDb();
  const existing = db
    .query("SELECT id FROM memories WHERE id = ?")
    .get(memoryId) as any;

  if (!existing) return false;

  db.run("DELETE FROM vec_memories WHERE memory_id = ?", [memoryId]);
  db.run("DELETE FROM vec_tags WHERE memory_id = ?", [memoryId]);
  db.run("DELETE FROM memories WHERE id = ?", [memoryId]);
  return true;
}

export function listMemories(
  containerTag: string | null,
  limit: number,
): any[] {
  const db = getDb();

  if (containerTag) {
    if (limit < 0) {
      return db
        .query(
          `SELECT id, content, tags, type, created_at, updated_at,
                  display_name, project_name, git_repo_url
           FROM memories WHERE container_tag = ?
           ORDER BY created_at DESC`,
        )
        .all(containerTag) as any[];
    }
    return db
      .query(
        `SELECT id, content, tags, type, created_at, updated_at,
                display_name, project_name, git_repo_url
         FROM memories WHERE container_tag = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(containerTag, limit) as any[];
  }

  if (limit < 0) {
    return db
      .query(
        `SELECT id, content, tags, type, created_at, updated_at,
                display_name, project_name, git_repo_url
         FROM memories ORDER BY created_at DESC`,
      )
      .all() as any[];
  }

  return db
    .query(
      `SELECT id, content, tags, type, created_at, updated_at,
              display_name, project_name, git_repo_url
       FROM memories ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
}

export function countMemories(containerTag: string | null): number {
  const db = getDb();

  if (containerTag) {
    const result = db
      .query("SELECT COUNT(*) as count FROM memories WHERE container_tag = ?")
      .get(containerTag) as any;
    return result.count;
  }

  const result = db
    .query("SELECT COUNT(*) as count FROM memories")
    .get() as any;
  return result.count;
}

export function findExactDuplicate(
  content: string,
  containerTag: string,
): string | null {
  const db = getDb();
  const row = db
    .query(
      "SELECT id FROM memories WHERE content = ? AND container_tag = ? LIMIT 1",
    )
    .get(content, containerTag) as any;
  return row ? row.id : null;
}
