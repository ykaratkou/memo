import { pipeline, env } from "@xenova/transformers";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { getCachedEmbedding, setCachedEmbedding } from "./db.ts";
import { log } from "./log.ts";

env.allowLocalModels = true;
env.allowRemoteModels = true;
env.cacheDir = join(CONFIG.storagePath, ".cache");

const TIMEOUT_MS = 30_000;
const MAX_CACHE_SIZE = 100;
const GLOBAL_KEY = Symbol.for("memo.embedding.instance");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Embedding timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export class EmbeddingService {
  private pipe: any = null;
  private initPromise: Promise<void> | null = null;
  public isWarmedUp = false;
  private cache = new Map<string, Float32Array>();

  static getInstance(): EmbeddingService {
    const g = globalThis as any;
    if (!g[GLOBAL_KEY]) {
      g[GLOBAL_KEY] = new EmbeddingService();
    }
    return g[GLOBAL_KEY];
  }

  async warmup(): Promise<void> {
    if (this.isWarmedUp) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initializeModel();
    return this.initPromise;
  }

  private async initializeModel(): Promise<void> {
    try {
      // Check if model is already cached
      const modelCachePath = join(env.cacheDir, CONFIG.embeddingModel, "onnx");
      const isAlreadyCached = existsSync(modelCachePath);

      if (!isAlreadyCached) {
        console.error(
          `Loading embedding model ${CONFIG.embeddingModel} (first run downloads ~130MB)...`,
        );
      }

      this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, {
        quantized: true,
      });
      this.isWarmedUp = true;

      if (!isAlreadyCached) {
        console.error("Model loaded.");
      }
    } catch (error) {
      this.initPromise = null;
      log("Failed to initialize embedding model", { error: String(error) });
      throw error;
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.isWarmedUp && !this.initPromise) {
      await this.warmup();
    }
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    // L1: in-memory LRU cache (hot path, no DB access)
    const memoryCached = this.cache.get(text);
    if (memoryCached) return memoryCached;

    // L2: persistent SQLite cache (survives restarts, skips ONNX inference)
    const contentHash = createHash("sha256").update(text).digest("hex");
    try {
      const dbCached = getCachedEmbedding(contentHash, CONFIG.embeddingModel);
      if (dbCached) {
        this.setMemoryCache(text, dbCached);
        return dbCached;
      }
    } catch {
      // DB not available (e.g., during isolated embedding use) — skip
    }

    await this.ensureReady();

    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    const result = new Float32Array(output.data);

    this.setMemoryCache(text, result);

    // Persist to DB cache for future process restarts
    try {
      setCachedEmbedding(contentHash, CONFIG.embeddingModel, result);
    } catch {
      // DB write failed — not critical, inference result is still returned
    }

    return result;
  }

  private setMemoryCache(text: string, vector: Float32Array): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(text, vector);
  }

  async embedWithTimeout(text: string): Promise<Float32Array> {
    return withTimeout(this.embed(text), TIMEOUT_MS);
  }

  async embedText(text: string): Promise<Float32Array> {
    // Use clustering: prefix for symmetric embeddings
    // This ensures identical text produces identical vectors
    // (unlike search_query:/search_document: which are asymmetric)
    return this.embedWithTimeout(`clustering: ${text}`);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const embeddingService = EmbeddingService.getInstance();
