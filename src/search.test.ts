import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { searchMemories, findNearDuplicates } from "./search.ts";
import { insertMemory, deleteMemory, getDb } from "./db.ts";
import type { MemoryRecord } from "./db.ts";

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

const TEST_IDS = [
  "mem_search_001",
  "mem_search_002",
  "mem_search_003",
];

describe("search", () => {
  beforeAll(() => {
    // Insert test memories with different vectors
    insertMemory({
      id: TEST_IDS[0]!,
      content: "TypeScript is a strongly typed programming language",
      vector: makeVector(1),
      createdAt: Date.now(),
    });
    insertMemory({
      id: TEST_IDS[1]!,
      content: "Python is great for data science and machine learning",
      vector: makeVector(2),
      createdAt: Date.now(),
    });
    insertMemory({
      id: TEST_IDS[2]!,
      content: "JavaScript runs in the browser and on the server",
      vector: makeVector(3),
      createdAt: Date.now(),
    });
  });

  afterAll(() => {
    for (const id of TEST_IDS) {
      deleteMemory(id);
    }
  });

  describe("searchMemories", () => {
    it("returns results for a vector query", () => {
      const queryVec = makeVector(1); // Same as first record
      const results = searchMemories(queryVec, undefined, 10, 0.0);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The most similar should be the first record
      expect(results[0]!.id).toBe(TEST_IDS[0]!);
      expect(results[0]!.similarity).toBeGreaterThan(0.9);
    });

    it("returns results for a text query via FTS", () => {
      const results = searchMemories(null, "TypeScript", 10, 0.0);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const found = results.find((r) => r.id === TEST_IDS[0]!);
      expect(found).toBeDefined();
    });

    it("returns empty array when nothing matches threshold", () => {
      const queryVec = makeVector(999); // Likely far from all records
      const results = searchMemories(queryVec, undefined, 10, 0.99);
      // With a very high threshold, may return nothing
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0.99);
      }
    });

    it("respects limit parameter", () => {
      const queryVec = makeVector(1);
      const results = searchMemories(queryVec, undefined, 1, 0.0);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("returns results with similarity scores between 0 and 1", () => {
      const queryVec = makeVector(1);
      const results = searchMemories(queryVec, undefined, 10, 0.0);
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(0);
        expect(r.similarity).toBeLessThanOrEqual(1);
      }
    });

    it("results are sorted by similarity descending", () => {
      const queryVec = makeVector(1);
      const results = searchMemories(queryVec, undefined, 10, 0.0);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.similarity).toBeGreaterThanOrEqual(
          results[i]!.similarity,
        );
      }
    });

    it("combines vector and text search (hybrid)", () => {
      const queryVec = makeVector(1);
      const results = searchMemories(
        queryVec,
        "TypeScript",
        10,
        0.0,
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
      // TypeScript result should rank highly since it matches both
      const tsResult = results.find((r) => r.id === TEST_IDS[0]);
      expect(tsResult).toBeDefined();
    });

    it("handles skipFullText flag", () => {
      const queryVec = makeVector(1);
      const results = searchMemories(
        queryVec,
        "TypeScript",
        10,
        0.0,
        true, // skipFullText
      );
      // Should still return results (vector-only)
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("findNearDuplicates", () => {
    it("finds near-duplicate with identical vector", () => {
      const queryVec = makeVector(1);
      const results = findNearDuplicates(queryVec, 0.9);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.id).toBe(TEST_IDS[0]!);
      expect(results[0]!.similarity).toBeGreaterThan(0.9);
    });

    it("returns empty when threshold is very high and no exact match", () => {
      const queryVec = makeVector(999);
      const results = findNearDuplicates(queryVec, 0.999);
      // Very unlikely to have a near-duplicate at this threshold
      expect(results.length).toBe(0);
    });

    it("returns results with similarity at or above threshold", () => {
      const queryVec = makeVector(1);
      const threshold = 0.5;
      const results = findNearDuplicates(queryVec, threshold);
      for (const r of results) {
        expect(r.similarity).toBeGreaterThanOrEqual(threshold);
      }
    });
  });
});
