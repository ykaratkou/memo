import { pipeline, env } from "@xenova/transformers";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
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
      console.error(
        `Loading embedding model ${CONFIG.embeddingModel} (first run downloads ~130MB)...`,
      );
      this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, {
        quantized: true,
      });
      this.isWarmedUp = true;
      console.error("Model loaded.");
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
    const cached = this.cache.get(text);
    if (cached) return cached;

    await this.ensureReady();

    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    const result = new Float32Array(output.data);

    // LRU eviction
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(text, result);

    return result;
  }

  async embedWithTimeout(text: string): Promise<Float32Array> {
    return withTimeout(this.embed(text), TIMEOUT_MS);
  }

  async embedForSearch(text: string): Promise<Float32Array> {
    return this.embedWithTimeout(`search_query: ${text}`);
  }

  async embedForStorage(text: string): Promise<Float32Array> {
    return this.embedWithTimeout(`search_document: ${text}`);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const embeddingService = EmbeddingService.getInstance();
