import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dirname, "..", "memo.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  _db = new Database(DB_PATH, { create: true });
  _db.run("PRAGMA journal_mode = WAL");

  _db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return _db;
}

export function insertMemory(content: string, embedding: Float32Array): void {
  const db = getDb();
  const buf = Buffer.from(embedding.buffer);
  db.run("INSERT INTO memories (content, embedding) VALUES (?, ?)", [
    content,
    buf,
  ]);
}

export interface MemoryResult {
  id: number;
  content: string;
  score: number;
  created_at: string;
}

export function searchMemories(
  queryEmbedding: Float32Array,
  limit = 5,
): MemoryResult[] {
  const db = getDb();
  const rows = db
    .query("SELECT id, content, embedding, created_at FROM memories")
    .all() as { id: number; content: string; embedding: Buffer; created_at: string }[];

  const results: MemoryResult[] = rows.map((row) => {
    const stored = new Float32Array(
      new Uint8Array(row.embedding).buffer,
    );
    const score = cosineSimilarity(queryEmbedding, stored);
    return { id: row.id, content: row.content, score, created_at: row.created_at };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
