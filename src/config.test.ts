import { describe, it, expect } from "bun:test";
import { CONFIG } from "./config.ts";

describe("CONFIG", () => {
  it("has all required fields", () => {
    expect(CONFIG.storagePath).toBeDefined();
    expect(typeof CONFIG.storagePath).toBe("string");
    expect(CONFIG.embeddingModel).toBeDefined();
    expect(typeof CONFIG.embeddingModel).toBe("string");
    expect(CONFIG.embeddingDimensions).toBeDefined();
    expect(typeof CONFIG.embeddingDimensions).toBe("number");
    expect(CONFIG.similarityThreshold).toBeDefined();
    expect(typeof CONFIG.similarityThreshold).toBe("number");
    expect(CONFIG.minVectorSimilarity).toBeDefined();
    expect(typeof CONFIG.minVectorSimilarity).toBe("number");
    expect(CONFIG.maxMemories).toBeDefined();
    expect(typeof CONFIG.maxMemories).toBe("number");
    expect(typeof CONFIG.deduplicationEnabled).toBe("boolean");
    expect(typeof CONFIG.deduplicationSimilarityThreshold).toBe("number");
  });

  it("has sensible default values", () => {
    // These should match the defaults in config.ts
    expect(CONFIG.embeddingModel).toBe("Xenova/nomic-embed-text-v1");
    expect(CONFIG.embeddingDimensions).toBe(768);
    expect(CONFIG.similarityThreshold).toBeGreaterThan(0);
    expect(CONFIG.similarityThreshold).toBeLessThanOrEqual(1);
    expect(CONFIG.minVectorSimilarity).toBeGreaterThan(0);
    expect(CONFIG.minVectorSimilarity).toBeLessThanOrEqual(1);
    expect(CONFIG.maxMemories).toBeGreaterThan(0);
  });

  it("deduplication threshold is between 0 and 1", () => {
    expect(CONFIG.deduplicationSimilarityThreshold).toBeGreaterThan(0);
    expect(CONFIG.deduplicationSimilarityThreshold).toBeLessThanOrEqual(1);
  });

  it("storagePath is an absolute path", () => {
    expect(CONFIG.storagePath.startsWith("/")).toBe(true);
  });

  it("customSqlitePath is undefined or a string", () => {
    if (CONFIG.customSqlitePath !== undefined) {
      expect(typeof CONFIG.customSqlitePath).toBe("string");
    }
  });
});
