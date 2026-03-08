import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { checkDuplicate } from "./dedup.ts";
import { insertMemory, deleteMemory } from "./db.ts";

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

const TEST_ID = "mem_dedup_test_001";

describe("checkDuplicate", () => {
  beforeAll(() => {
    insertMemory({
      id: TEST_ID,
      content: "Existing memory for dedup testing",
      vector: makeVector(42),
      createdAt: Date.now(),
    });
  });

  afterAll(() => {
    deleteMemory(TEST_ID);
  });

  it("detects exact duplicate content", () => {
    const result = checkDuplicate(
      "Existing memory for dedup testing",
      makeVector(999), // Vector doesn't matter for exact match
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe("exact duplicate");
    expect(result.existingId).toBe(TEST_ID);
    expect(result.similarity).toBe(1.0);
  });

  it("detects near-duplicate via vector similarity", () => {
    const result = checkDuplicate(
      "Completely different text content",
      makeVector(42), // Same vector as existing memory
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe("near duplicate");
    expect(result.existingId).toBe(TEST_ID);
    expect(result.similarity).toBeGreaterThan(0.9);
  });

  it("returns not duplicate for unique content and vector", () => {
    const result = checkDuplicate(
      "Totally unique content here xyz123",
      makeVector(777), // Distant vector
    );
    expect(result.isDuplicate).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.existingId).toBeUndefined();
  });
});
