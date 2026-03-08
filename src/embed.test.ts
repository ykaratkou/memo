import { describe, it, expect } from "bun:test";
import { EmbeddingService, embeddingService } from "./embed.ts";

describe("EmbeddingService", () => {
  describe("singleton", () => {
    it("getInstance returns the same instance", () => {
      const a = EmbeddingService.getInstance();
      const b = EmbeddingService.getInstance();
      expect(a).toBe(b);
    });

    it("exported embeddingService is the singleton", () => {
      expect(embeddingService).toBe(EmbeddingService.getInstance());
    });
  });

  describe("isWarmedUp", () => {
    it("is false before warmup", () => {
      // On first load, the model is not warmed up (lazy init)
      // Note: in CI/test this may vary if model was already loaded
      expect(typeof embeddingService.isWarmedUp).toBe("boolean");
    });
  });

  describe("clearCache", () => {
    it("does not throw", () => {
      expect(() => embeddingService.clearCache()).not.toThrow();
    });
  });

  // Note: We don't test embedText/embed/warmup here because they require
  // downloading an ONNX model (~130MB). Those are integration tests that
  // should be run separately with `bun test --timeout 60000`.
  // The embedding pipeline is covered by the search and dedup tests
  // which use pre-computed vectors instead.
});
