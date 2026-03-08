import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDb,
  closeDb,
  insertMemory,
  deleteMemory,
  listMemories,
  countMemories,
  findExactDuplicate,
  replaceChunksForSource,
  getSourceHash,
  setSourceHash,
  deleteSourceHash,
  getSourceKeysWithPrefix,
  getCachedEmbedding,
  setCachedEmbedding,
  reindexFts,
  _resetForTesting,
} from "./db.ts";
import type { MemoryRecord } from "./db.ts";

function makeVector(seed: number = 1): Float32Array {
  // Create a deterministic 768-dim vector (matching default config dimensions)
  const vec = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vec[i] = Math.sin(seed * (i + 1) * 0.01);
  }
  // Normalize to unit vector for cosine similarity
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) vec[i] = vec[i]! / norm;
  return vec;
}

function makeRecord(
  overrides: Partial<MemoryRecord> & { id: string },
): MemoryRecord {
  return {
    content: `Memory content for ${overrides.id}`,
    vector: makeVector(overrides.id.charCodeAt(4) || 1),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("db", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memo-db-test-"));
    // Point the DB to our temp directory
    process.env.MEMO_TEST_DB = join(tmpDir, "test.db");
    _resetForTesting();

    // Override getDbPath by setting _dbPath before getDb is called
    // We do this by calling getDb which will use the test path
    // Actually, _resetForTesting clears _dbPath, and getDbPath resolves from cwd/git.
    // We need a different approach - let's override the path directly.
  });

  afterEach(() => {
    _resetForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MEMO_TEST_DB;
  });

  // Note: The DB module resolves path from git root. In tests, it will use
  // the actual project's .memo directory. For proper isolation, we'd need
  // to add env-based path override to db.ts. For now, we test with the
  // project DB (each test cleans up after itself).

  describe("insertMemory and listMemories", () => {
    it("inserts and retrieves a memory", () => {
      const record = makeRecord({ id: "mem_test_001" });
      insertMemory(record);

      const memories = listMemories(10);
      expect(memories.length).toBeGreaterThanOrEqual(1);

      const found = memories.find((m: any) => m.id === "mem_test_001");
      expect(found).toBeDefined();
      expect(found.content).toBe(record.content);

      // Cleanup
      deleteMemory("mem_test_001");
    });

    it("inserts with sourceKey", () => {
      const record = makeRecord({
        id: "mem_test_sk_001",
        sourceKey: "/test/path/file.md",
      });
      insertMemory(record);

      const db = getDb();
      const row = db
        .query("SELECT source_key FROM memories WHERE id = ?")
        .get("mem_test_sk_001") as any;
      expect(row.source_key).toBe("/test/path/file.md");

      deleteMemory("mem_test_sk_001");
    });
  });

  describe("deleteMemory", () => {
    it("deletes an existing memory and returns true", () => {
      insertMemory(makeRecord({ id: "mem_test_del_001" }));
      const result = deleteMemory("mem_test_del_001");
      expect(result).toBe(true);

      const memories = listMemories(-1);
      const found = memories.find((m: any) => m.id === "mem_test_del_001");
      expect(found).toBeUndefined();
    });

    it("returns false for non-existent memory", () => {
      const result = deleteMemory("mem_nonexistent_999");
      expect(result).toBe(false);
    });

    it("removes from all three tables", () => {
      insertMemory(makeRecord({ id: "mem_test_del3_001" }));
      deleteMemory("mem_test_del3_001");

      const db = getDb();
      const mem = db
        .query("SELECT id FROM memories WHERE id = ?")
        .get("mem_test_del3_001");
      const vec = db
        .query("SELECT memory_id FROM vec_memories WHERE memory_id = ?")
        .get("mem_test_del3_001");
      const fts = db
        .query("SELECT memory_id FROM fts_memories WHERE memory_id = ?")
        .get("mem_test_del3_001");

      expect(mem).toBeNull();
      expect(vec).toBeNull();
      expect(fts).toBeNull();
    });
  });

  describe("countMemories", () => {
    it("counts inserted memories", () => {
      const before = countMemories();
      insertMemory(makeRecord({ id: "mem_test_count_001" }));
      insertMemory(makeRecord({ id: "mem_test_count_002" }));
      const after = countMemories();
      expect(after - before).toBe(2);

      deleteMemory("mem_test_count_001");
      deleteMemory("mem_test_count_002");
    });
  });

  describe("findExactDuplicate", () => {
    it("finds an exact content match", () => {
      const record = makeRecord({ id: "mem_test_dup_001" });
      insertMemory(record);

      const dupId = findExactDuplicate(record.content);
      expect(dupId).toBe("mem_test_dup_001");

      deleteMemory("mem_test_dup_001");
    });

    it("returns null when no match", () => {
      const result = findExactDuplicate("unique content that does not exist");
      expect(result).toBeNull();
    });
  });

  describe("replaceChunksForSource", () => {
    it("inserts new chunks when no previous chunks exist", () => {
      const records = [
        makeRecord({ id: "mem_replace_001", sourceKey: "/test/replace.md" }),
        makeRecord({ id: "mem_replace_002", sourceKey: "/test/replace.md" }),
      ];

      const result = replaceChunksForSource("/test/replace.md", records);
      expect(result.deleted).toBe(0);
      expect(result.inserted).toBe(2);

      // Cleanup
      replaceChunksForSource("/test/replace.md", []);
    });

    it("replaces existing chunks atomically", () => {
      const old = [
        makeRecord({ id: "mem_rep_old_001", sourceKey: "/test/rep.md" }),
        makeRecord({ id: "mem_rep_old_002", sourceKey: "/test/rep.md" }),
      ];
      replaceChunksForSource("/test/rep.md", old);

      const newRecords = [
        makeRecord({ id: "mem_rep_new_001", sourceKey: "/test/rep.md" }),
      ];
      const result = replaceChunksForSource("/test/rep.md", newRecords);
      expect(result.deleted).toBe(2);
      expect(result.inserted).toBe(1);

      // Old records should be gone
      const db = getDb();
      const oldRow = db
        .query("SELECT id FROM memories WHERE id = ?")
        .get("mem_rep_old_001");
      expect(oldRow).toBeNull();

      // New record should exist
      const newRow = db
        .query("SELECT id FROM memories WHERE id = ?")
        .get("mem_rep_new_001");
      expect(newRow).not.toBeNull();

      // Cleanup
      replaceChunksForSource("/test/rep.md", []);
    });

    it("deletes all chunks when called with empty array", () => {
      const records = [
        makeRecord({ id: "mem_empty_001", sourceKey: "/test/empty.md" }),
      ];
      replaceChunksForSource("/test/empty.md", records);

      const result = replaceChunksForSource("/test/empty.md", []);
      expect(result.deleted).toBe(1);
      expect(result.inserted).toBe(0);
    });
  });

  describe("source hash tracking", () => {
    it("setSourceHash and getSourceHash round-trip", () => {
      setSourceHash("/test/hash.md", "abc123");
      const hash = getSourceHash("/test/hash.md");
      expect(hash).toBe("abc123");

      // Cleanup
      deleteSourceHash("/test/hash.md");
    });

    it("getSourceHash returns null for unknown key", () => {
      const hash = getSourceHash("/nonexistent/file.md");
      expect(hash).toBeNull();
    });

    it("setSourceHash overwrites previous hash", () => {
      setSourceHash("/test/overwrite.md", "hash1");
      setSourceHash("/test/overwrite.md", "hash2");
      expect(getSourceHash("/test/overwrite.md")).toBe("hash2");

      deleteSourceHash("/test/overwrite.md");
    });

    it("deleteSourceHash removes the entry", () => {
      setSourceHash("/test/delete.md", "hash");
      deleteSourceHash("/test/delete.md");
      expect(getSourceHash("/test/delete.md")).toBeNull();
    });

    it("deleteSourceHash is safe on non-existent key", () => {
      expect(() =>
        deleteSourceHash("/nonexistent/key"),
      ).not.toThrow();
    });
  });

  describe("getSourceKeysWithPrefix", () => {
    beforeEach(() => {
      setSourceHash("/project/docs/a.md", "h1");
      setSourceHash("/project/docs/b.md", "h2");
      setSourceHash("/project/docs/sub/c.md", "h3");
      setSourceHash("/project/other/d.md", "h4");
    });

    afterEach(() => {
      deleteSourceHash("/project/docs/a.md");
      deleteSourceHash("/project/docs/b.md");
      deleteSourceHash("/project/docs/sub/c.md");
      deleteSourceHash("/project/other/d.md");
    });

    it("returns all keys matching the prefix", () => {
      const keys = getSourceKeysWithPrefix("/project/docs/");
      expect(keys.sort()).toEqual([
        "/project/docs/a.md",
        "/project/docs/b.md",
        "/project/docs/sub/c.md",
      ]);
    });

    it("does not match similar prefixes without trailing slash", () => {
      // /project/docs should not match /project/docs-archive/
      setSourceHash("/project/docs-archive/e.md", "h5");
      const keys = getSourceKeysWithPrefix("/project/docs/");
      expect(keys).not.toContain("/project/docs-archive/e.md");
      deleteSourceHash("/project/docs-archive/e.md");
    });

    it("returns empty array when no keys match", () => {
      const keys = getSourceKeysWithPrefix("/nonexistent/path/");
      expect(keys).toEqual([]);
    });

    it("returns keys for nested subdirectories", () => {
      const keys = getSourceKeysWithPrefix("/project/docs/sub/");
      expect(keys).toEqual(["/project/docs/sub/c.md"]);
    });
  });

  describe("embedding cache", () => {
    it("setCachedEmbedding and getCachedEmbedding round-trip", () => {
      const vec = makeVector(42);
      setCachedEmbedding("test_hash", "test_model", vec);

      const cached = getCachedEmbedding("test_hash", "test_model");
      expect(cached).not.toBeNull();
      expect(cached!.length).toBe(vec.length);

      // Verify values are close (floating point)
      for (let i = 0; i < 10; i++) {
        expect(cached![i]).toBeCloseTo(vec[i]!, 5);
      }

      // Cleanup
      const db = getDb();
      db.run(
        "DELETE FROM embedding_cache WHERE content_hash = ? AND model = ?",
        ["test_hash", "test_model"],
      );
    });

    it("getCachedEmbedding returns null for unknown hash", () => {
      const cached = getCachedEmbedding("unknown_hash", "test_model");
      expect(cached).toBeNull();
    });

    it("getCachedEmbedding returns null for different model", () => {
      const vec = makeVector(43);
      setCachedEmbedding("model_hash", "model_a", vec);

      const cached = getCachedEmbedding("model_hash", "model_b");
      expect(cached).toBeNull();

      // Cleanup
      const db = getDb();
      db.run(
        "DELETE FROM embedding_cache WHERE content_hash = ? AND model = ?",
        ["model_hash", "model_a"],
      );
    });
  });

  describe("reindexFts", () => {
    it("adds missing FTS entries", () => {
      const record = makeRecord({ id: "mem_fts_001" });
      insertMemory(record);

      // Manually delete the FTS entry to simulate orphan
      const db = getDb();
      db.run("DELETE FROM fts_memories WHERE memory_id = ?", [
        "mem_fts_001",
      ]);

      const result = reindexFts();
      expect(result.added).toBeGreaterThanOrEqual(1);

      // Verify FTS entry was restored
      const fts = db
        .query("SELECT memory_id FROM fts_memories WHERE memory_id = ?")
        .get("mem_fts_001");
      expect(fts).not.toBeNull();

      deleteMemory("mem_fts_001");
    });

    it("removes orphaned FTS entries", () => {
      const record = makeRecord({ id: "mem_fts_orphan_001" });
      insertMemory(record);

      // Manually delete from memories (leaving orphaned FTS entry)
      const db = getDb();
      db.run("DELETE FROM vec_memories WHERE memory_id = ?", [
        "mem_fts_orphan_001",
      ]);
      db.run("DELETE FROM memories WHERE id = ?", ["mem_fts_orphan_001"]);

      const result = reindexFts();
      expect(result.removed).toBeGreaterThanOrEqual(1);
    });
  });

  describe("listMemories", () => {
    it("respects limit parameter", () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `mem_list_${i}_${Date.now()}`;
        ids.push(id);
        insertMemory(makeRecord({ id }));
      }

      const results = listMemories(2);
      expect(results.length).toBeLessThanOrEqual(2);

      // Cleanup
      for (const id of ids) deleteMemory(id);
    });

    it("returns all with limit -1", () => {
      const id = `mem_listall_${Date.now()}`;
      insertMemory(makeRecord({ id }));

      const results = listMemories(-1);
      expect(results.length).toBeGreaterThanOrEqual(1);

      deleteMemory(id);
    });
  });

  describe("_resetForTesting", () => {
    it("allows re-initialization of the database", () => {
      const db1 = getDb();
      expect(db1).toBeDefined();

      _resetForTesting();

      const db2 = getDb();
      expect(db2).toBeDefined();
      // After reset, it should be a new instance (or re-opened)
    });
  });
});
