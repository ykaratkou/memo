import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
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

  // FTS5 table for BM25 keyword search
  // UNINDEXED columns store data without indexing (metadata only)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
      content,
      memory_id UNINDEXED,
      container_tag UNINDEXED,
      tokenize='unicode61'
    )
  `);

  // Persistent embedding cache — keyed by content hash + model.
  // Survives process restarts, avoids re-running ONNX inference for
  // previously seen text. Invalidated naturally on model change.
  db.run(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (content_hash, model)
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
  containerTag: string;
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

  // Insert into main memories table
  db.run(
    `INSERT INTO memories (
      id, content, vector, container_tag, type,
      created_at, updated_at, metadata,
      display_name, user_name, user_email,
      project_path, project_name, git_repo_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.content,
      vectorBuffer,
      record.containerTag,
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

  // Insert into vector search table
  db.run(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`, [
    record.id,
    vectorBuffer,
  ]);

  // Insert into FTS5 table for BM25 keyword search
  db.run(
    `INSERT INTO fts_memories (content, memory_id, container_tag) VALUES (?, ?, ?)`,
    [record.content, record.id, record.containerTag],
  );
}

export function deleteMemory(memoryId: string): boolean {
  const db = getDb();
  const existing = db
    .query("SELECT id FROM memories WHERE id = ?")
    .get(memoryId) as any;

  if (!existing) return false;

  db.run("DELETE FROM vec_memories WHERE memory_id = ?", [memoryId]);
  db.run("DELETE FROM fts_memories WHERE memory_id = ?", [memoryId]);
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
          `SELECT id, content, type, created_at, updated_at,
                  display_name, project_name, git_repo_url
           FROM memories WHERE container_tag = ?
           ORDER BY created_at DESC`,
        )
        .all(containerTag) as any[];
    }
    return db
      .query(
        `SELECT id, content, type, created_at, updated_at,
                display_name, project_name, git_repo_url
         FROM memories WHERE container_tag = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(containerTag, limit) as any[];
  }

  if (limit < 0) {
    return db
      .query(
        `SELECT id, content, type, created_at, updated_at,
                display_name, project_name, git_repo_url
         FROM memories ORDER BY created_at DESC`,
      )
      .all() as any[];
  }

  return db
    .query(
      `SELECT id, content, type, created_at, updated_at,
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

export function getCachedEmbedding(
  contentHash: string,
  model: string,
): Float32Array | null {
  const db = getDb();
  const row = db
    .query(
      "SELECT embedding FROM embedding_cache WHERE content_hash = ? AND model = ?",
    )
    .get(contentHash, model) as { embedding: Uint8Array } | null;

  if (!row) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}

export function setCachedEmbedding(
  contentHash: string,
  model: string,
  vector: Float32Array,
): void {
  const db = getDb();
  const vectorBuffer = new Uint8Array(vector.buffer);
  db.run(
    `INSERT OR REPLACE INTO embedding_cache (content_hash, model, embedding, created_at)
     VALUES (?, ?, ?, ?)`,
    [contentHash, model, vectorBuffer, Date.now()],
  );
}

export function reindexFts(): { added: number; removed: number } {
  const db = getDb();

  // Remove orphaned FTS entries (memory was deleted but FTS row remains)
  const orphaned = db
    .query(
      "SELECT memory_id FROM fts_memories WHERE memory_id NOT IN (SELECT id FROM memories)",
    )
    .all() as { memory_id: string }[];
  for (const row of orphaned) {
    db.run("DELETE FROM fts_memories WHERE memory_id = ?", [row.memory_id]);
  }

  // Add missing FTS entries
  const missing = db
    .query(
      "SELECT id, content, container_tag FROM memories WHERE id NOT IN (SELECT memory_id FROM fts_memories)",
    )
    .all() as { id: string; content: string; container_tag: string }[];
  for (const row of missing) {
    db.run(
      "INSERT INTO fts_memories (content, memory_id, container_tag) VALUES (?, ?, ?)",
      [row.content, row.id, row.container_tag],
    );
  }

  return { added: missing.length, removed: orphaned.length };
}

export function resetDb(): void {
  closeDb();
  try {
    unlinkSync(DB_PATH);
    log("Database reset", { path: DB_PATH });
  } catch (error) {
    // File might not exist, that's fine
    if ((error as any).code !== "ENOENT") {
      throw error;
    }
  }
}
