import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";

let _db: Database | null = null;
let _dbPath: string | null = null;
let sqliteConfigured = false;

/**
 * Resolve the project root directory for the per-project DB.
 * Uses git-common-dir so worktrees of the same repo share one DB.
 * Falls back to cwd for non-git directories.
 */
function resolveProjectRoot(cwd: string): string {
  try {
    const gitCommonDir = execSync(
      "git rev-parse --path-format=absolute --git-common-dir",
      { encoding: "utf-8", cwd, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (gitCommonDir) {
      // git-common-dir returns e.g. /path/to/project/.git
      // Strip trailing /.git to get the project root
      return resolve(gitCommonDir, "..");
    }
  } catch {
    // Not a git repo
  }
  return cwd;
}

/**
 * Get the per-project DB path: <project-root>/.memo/memo.db
 */
export function getDbPath(cwd?: string): string {
  if (_dbPath) return _dbPath;
  const projectRoot = resolveProjectRoot(cwd || process.cwd());
  _dbPath = join(projectRoot, ".memo", "memo.db");
  return _dbPath;
}

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
      created_at INTEGER NOT NULL,
      source_key TEXT
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC)`);

  // Migration: add source_key column to existing databases
  try {
    db.run("ALTER TABLE memories ADD COLUMN source_key TEXT");
  } catch {
    // Column already exists — expected on non-first run
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_source_key ON memories(source_key)`);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float32[${CONFIG.embeddingDimensions}] distance_metric=cosine
    )
  `);

  // FTS5 table for BM25 keyword search
  // UNINDEXED columns are stored but not searchable
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
      content,
      memory_id UNINDEXED,
      tokenize='unicode61'
    )
  `);

  // Tracks content hash per embedded source file.
  // Used to skip re-embedding unchanged files.
  db.run(`
    CREATE TABLE IF NOT EXISTS embed_sources (
      source_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
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

  const dbPath = getDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  initSchema(_db);
  log("Database opened", { path: dbPath });

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
  createdAt: number;
  sourceKey?: string;
}

export function insertMemory(record: MemoryRecord): void {
  const db = getDb();
  const vectorBuffer = new Uint8Array(record.vector.buffer);

  // Insert into main memories table
  db.run(
    `INSERT INTO memories (id, content, vector, created_at, source_key)
     VALUES (?, ?, ?, ?, ?)`,
    [record.id, record.content, vectorBuffer, record.createdAt, record.sourceKey || null],
  );

  // Insert into vector search table
  db.run(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`, [
    record.id,
    vectorBuffer,
  ]);

  // Insert into FTS5 table for BM25 keyword search
  db.run(
    `INSERT INTO fts_memories (content, memory_id) VALUES (?, ?)`,
    [record.content, record.id],
  );
}

/**
 * Atomically replace all chunks previously imported from a given source.
 * Deletes old memories with the same source_key, then inserts the new records.
 */
export function replaceChunksForSource(
  sourceKey: string,
  records: MemoryRecord[],
): { deleted: number; inserted: number } {
  const db = getDb();

  db.run("BEGIN");

  try {
    const row = db
      .query("SELECT COUNT(*) as count FROM memories WHERE source_key = ?")
      .get(sourceKey) as { count: number } | null;

    const deleted = Number(row?.count || 0);

    if (deleted > 0) {
      db.run(
        `DELETE FROM vec_memories WHERE memory_id IN (
          SELECT id FROM memories WHERE source_key = ?
        )`,
        [sourceKey],
      );

      db.run(
        `DELETE FROM fts_memories WHERE memory_id IN (
          SELECT id FROM memories WHERE source_key = ?
        )`,
        [sourceKey],
      );

      db.run("DELETE FROM memories WHERE source_key = ?", [sourceKey]);
    }

    for (const record of records) {
      insertMemory(record);
    }

    db.run("COMMIT");

    return { deleted, inserted: records.length };
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export function getSourceHash(sourceKey: string): string | null {
  const db = getDb();
  const row = db
    .query("SELECT content_hash FROM embed_sources WHERE source_key = ?")
    .get(sourceKey) as { content_hash: string } | null;
  return row?.content_hash ?? null;
}

export function setSourceHash(sourceKey: string, contentHash: string): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO embed_sources (source_key, content_hash, updated_at)
     VALUES (?, ?, ?)`,
    [sourceKey, contentHash, Date.now()],
  );
}

export function deleteSourceHash(sourceKey: string): void {
  const db = getDb();
  db.run("DELETE FROM embed_sources WHERE source_key = ?", [sourceKey]);
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

export function listMemories(limit: number): any[] {
  const db = getDb();

  const limitClause = limit >= 0 ? "LIMIT ?" : "";
  const params: any[] = [];
  if (limit >= 0) params.push(limit);

  return db
    .query(
      `SELECT id, content, created_at
       FROM memories
       ORDER BY created_at DESC ${limitClause}`,
    )
    .all(...params) as any[];
}

export function countMemories(): number {
  const db = getDb();
  const result = db
    .query("SELECT COUNT(*) as count FROM memories")
    .get() as any;
  return result.count;
}

export function findExactDuplicate(content: string): string | null {
  const db = getDb();
  const row = db
    .query("SELECT id FROM memories WHERE content = ? LIMIT 1")
    .get(content) as any;
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
      "SELECT id, content FROM memories WHERE id NOT IN (SELECT memory_id FROM fts_memories)",
    )
    .all() as { id: string; content: string }[];
  for (const row of missing) {
    db.run(
      "INSERT INTO fts_memories (content, memory_id) VALUES (?, ?)",
      [row.content, row.id],
    );
  }

  return { added: missing.length, removed: orphaned.length };
}

export function resetDb(): void {
  const dbPath = getDbPath();
  closeDb();
  try {
    unlinkSync(dbPath);
    log("Database reset", { path: dbPath });
  } catch (error) {
    // File might not exist, that's fine
    if ((error as any).code !== "ENOENT") {
      throw error;
    }
  }
}
