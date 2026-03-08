import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  insertMemory,
  replaceChunksForSource,
  getSourceHash,
  setSourceHash,
  deleteSourceHash,
  getSourceKeysWithPrefix,
  countMemories,
  getDb,
} from "./db.ts";
import type { MemoryRecord } from "./db.ts";

/**
 * Integration tests for the stale embed cleanup feature.
 *
 * These tests simulate the exact flow that cmdEmbed uses:
 * 1. Embed files from a directory (insert chunks + set source hashes)
 * 2. Re-run embed after some files are deleted
 * 3. Verify stale chunks and source hashes are cleaned up
 *
 * We test at the DB layer to avoid requiring the ONNX model.
 */

function makeVector(seed: number): Float32Array {
  const vec = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vec[i] = Math.sin(seed * (i + 1) * 0.01);
  }
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) vec[i] = vec[i]! / norm;
  return vec;
}

function makeChunkRecords(
  sourceKey: string,
  count: number,
  seed: number,
): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (let i = 0; i < count; i++) {
    records.push({
      id: `mem_stale_${seed}_${i}_${Date.now()}`,
      content: `Chunk ${i} from ${sourceKey}`,
      vector: makeVector(seed + i),
      createdAt: Date.now(),
      sourceKey,
    });
  }
  return records;
}

/**
 * Simulates what cmdEmbed does for stale cleanup:
 * Given a folder prefix and a set of currently-existing file sourceKeys,
 * find and remove chunks for files no longer present.
 */
function cleanupStaleEmbeddings(
  folderPrefix: string,
  currentSourceKeys: Set<string>,
): { removedFiles: number; removedChunks: number } {
  const prefix = folderPrefix.endsWith("/") ? folderPrefix : folderPrefix + "/";
  const dbSourceKeys = getSourceKeysWithPrefix(prefix);

  let removedFiles = 0;
  let removedChunks = 0;

  for (const staleKey of dbSourceKeys) {
    if (!currentSourceKeys.has(staleKey)) {
      const { deleted } = replaceChunksForSource(staleKey, []);
      deleteSourceHash(staleKey);
      removedChunks += deleted;
      removedFiles += 1;
    }
  }

  return { removedFiles, removedChunks };
}

describe("stale embed cleanup", () => {
  const FOLDER = "/test/stale-cleanup/docs";
  const FILE_A = `${FOLDER}/a.md`;
  const FILE_B = `${FOLDER}/b.md`;
  const FILE_C = `${FOLDER}/sub/c.md`;

  afterEach(() => {
    // Thorough cleanup
    for (const key of [FILE_A, FILE_B, FILE_C]) {
      replaceChunksForSource(key, []);
      deleteSourceHash(key);
    }
  });

  it("does not remove anything when all files still exist", () => {
    // Simulate initial embed of 3 files
    replaceChunksForSource(FILE_A, makeChunkRecords(FILE_A, 2, 100));
    setSourceHash(FILE_A, "hash_a");
    replaceChunksForSource(FILE_B, makeChunkRecords(FILE_B, 3, 200));
    setSourceHash(FILE_B, "hash_b");
    replaceChunksForSource(FILE_C, makeChunkRecords(FILE_C, 1, 300));
    setSourceHash(FILE_C, "hash_c");

    // All files still exist
    const currentFiles = new Set([FILE_A, FILE_B, FILE_C]);
    const result = cleanupStaleEmbeddings(FOLDER, currentFiles);

    expect(result.removedFiles).toBe(0);
    expect(result.removedChunks).toBe(0);

    // All source hashes should still exist
    expect(getSourceHash(FILE_A)).toBe("hash_a");
    expect(getSourceHash(FILE_B)).toBe("hash_b");
    expect(getSourceHash(FILE_C)).toBe("hash_c");
  });

  it("removes chunks and hash for deleted files", () => {
    // Simulate initial embed of 3 files
    replaceChunksForSource(FILE_A, makeChunkRecords(FILE_A, 2, 100));
    setSourceHash(FILE_A, "hash_a");
    replaceChunksForSource(FILE_B, makeChunkRecords(FILE_B, 3, 200));
    setSourceHash(FILE_B, "hash_b");
    replaceChunksForSource(FILE_C, makeChunkRecords(FILE_C, 1, 300));
    setSourceHash(FILE_C, "hash_c");

    // FILE_B was deleted from disk
    const currentFiles = new Set([FILE_A, FILE_C]);
    const result = cleanupStaleEmbeddings(FOLDER, currentFiles);

    expect(result.removedFiles).toBe(1);
    expect(result.removedChunks).toBe(3); // FILE_B had 3 chunks

    // FILE_B's hash should be gone
    expect(getSourceHash(FILE_B)).toBeNull();

    // FILE_B's chunks should be gone from all tables
    const db = getDb();
    const remaining = db
      .query("SELECT COUNT(*) as count FROM memories WHERE source_key = ?")
      .get(FILE_B) as { count: number };
    expect(remaining.count).toBe(0);

    // FILE_A and FILE_C should still exist
    expect(getSourceHash(FILE_A)).toBe("hash_a");
    expect(getSourceHash(FILE_C)).toBe("hash_c");
  });

  it("removes all files when directory is emptied", () => {
    replaceChunksForSource(FILE_A, makeChunkRecords(FILE_A, 2, 100));
    setSourceHash(FILE_A, "hash_a");
    replaceChunksForSource(FILE_B, makeChunkRecords(FILE_B, 3, 200));
    setSourceHash(FILE_B, "hash_b");

    // All files deleted
    const currentFiles = new Set<string>();
    const result = cleanupStaleEmbeddings(FOLDER, currentFiles);

    expect(result.removedFiles).toBe(2);
    expect(result.removedChunks).toBe(5); // 2 + 3

    expect(getSourceHash(FILE_A)).toBeNull();
    expect(getSourceHash(FILE_B)).toBeNull();
  });

  it("does not affect files outside the folder prefix", () => {
    const OTHER_FILE = "/test/other-folder/x.md";

    replaceChunksForSource(FILE_A, makeChunkRecords(FILE_A, 2, 100));
    setSourceHash(FILE_A, "hash_a");
    replaceChunksForSource(OTHER_FILE, makeChunkRecords(OTHER_FILE, 1, 400));
    setSourceHash(OTHER_FILE, "hash_other");

    // Only FILE_A is in the folder; it got deleted
    const currentFiles = new Set<string>();
    const result = cleanupStaleEmbeddings(FOLDER, currentFiles);

    expect(result.removedFiles).toBe(1);
    expect(result.removedChunks).toBe(2);

    // Other folder's file should be untouched
    expect(getSourceHash(OTHER_FILE)).toBe("hash_other");

    // Cleanup
    replaceChunksForSource(OTHER_FILE, []);
    deleteSourceHash(OTHER_FILE);
  });

  it("does not match similar prefix names (trailing slash safety)", () => {
    const SIMILAR_FOLDER_FILE = "/test/stale-cleanup/docs-archive/x.md";

    replaceChunksForSource(FILE_A, makeChunkRecords(FILE_A, 1, 100));
    setSourceHash(FILE_A, "hash_a");
    replaceChunksForSource(
      SIMILAR_FOLDER_FILE,
      makeChunkRecords(SIMILAR_FOLDER_FILE, 1, 500),
    );
    setSourceHash(SIMILAR_FOLDER_FILE, "hash_sim");

    // FILE_A deleted, similar folder file should NOT be touched
    const currentFiles = new Set<string>();
    const result = cleanupStaleEmbeddings(FOLDER, currentFiles);

    expect(result.removedFiles).toBe(1); // Only FILE_A
    expect(getSourceHash(SIMILAR_FOLDER_FILE)).toBe("hash_sim");

    // Cleanup
    replaceChunksForSource(SIMILAR_FOLDER_FILE, []);
    deleteSourceHash(SIMILAR_FOLDER_FILE);
  });

  it("handles first-time embed (no previous entries)", () => {
    const currentFiles = new Set([FILE_A, FILE_B]);
    const result = cleanupStaleEmbeddings(FOLDER, currentFiles);

    expect(result.removedFiles).toBe(0);
    expect(result.removedChunks).toBe(0);
  });

  it("cleans up from all three tables (memories, vec_memories, fts_memories)", () => {
    replaceChunksForSource(FILE_A, makeChunkRecords(FILE_A, 2, 100));
    setSourceHash(FILE_A, "hash_a");

    // Before cleanup: verify data exists in all tables
    const db = getDb();
    const memsBefore = db
      .query("SELECT COUNT(*) as count FROM memories WHERE source_key = ?")
      .get(FILE_A) as { count: number };
    expect(memsBefore.count).toBe(2);

    // Delete FILE_A
    const result = cleanupStaleEmbeddings(FOLDER, new Set<string>());
    expect(result.removedChunks).toBe(2);

    // After cleanup: verify all tables are clean
    const memsAfter = db
      .query("SELECT COUNT(*) as count FROM memories WHERE source_key = ?")
      .get(FILE_A) as { count: number };
    expect(memsAfter.count).toBe(0);

    // Source hash should be removed too
    expect(getSourceHash(FILE_A)).toBeNull();
  });
});
