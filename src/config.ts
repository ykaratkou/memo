import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "./jsonc.ts";

const CONFIG_DIR = join(homedir(), ".config", "memo");
const CONFIG_FILES = [
  join(CONFIG_DIR, "config.jsonc"),
  join(CONFIG_DIR, "config.json"),
];

if (!existsSync(CONFIG_DIR)) {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

interface MemoConfig {
  storagePath?: string;
  customSqlitePath?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  similarityThreshold?: number;
  minVectorSimilarity?: number;
  maxMemories?: number;
  deduplicationEnabled?: boolean;
  deduplicationSimilarityThreshold?: number;
}

const DEFAULTS = {
  storagePath: join(CONFIG_DIR, "data"),
  embeddingModel: "Xenova/nomic-embed-text-v1",
  embeddingDimensions: 768,
  similarityThreshold: 0.5,
  minVectorSimilarity: 0.6,
  maxMemories: 10,
  deduplicationEnabled: true,
  deduplicationSimilarityThreshold: 0.9,
} as const;

function expandPath(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

function getEmbeddingDimensions(model: string): number {
  const dimensionMap: Record<string, number> = {
    "Xenova/nomic-embed-text-v1": 768,
    "Xenova/nomic-embed-text-v1-unsupervised": 768,
    "Xenova/jina-embeddings-v2-base-en": 768,
    "Xenova/jina-embeddings-v2-small-en": 512,
    "Xenova/all-MiniLM-L6-v2": 384,
    "Xenova/all-MiniLM-L12-v2": 384,
    "Xenova/all-mpnet-base-v2": 768,
    "Xenova/bge-base-en-v1.5": 768,
    "Xenova/bge-small-en-v1.5": 384,
    "Xenova/gte-small": 384,
  };
  return dimensionMap[model] || 768;
}

function loadConfig(): MemoConfig {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const json = stripJsoncComments(content);
        return JSON.parse(json) as MemoConfig;
      } catch {
        // ignore parse errors, use defaults
      }
    }
  }
  return {};
}

const fileConfig = loadConfig();

const CONFIG_TEMPLATE = `{
  // ============================================
  // Memo CLI Configuration
  // ============================================

  // Storage location for the database
  // "storagePath": "~/.config/memo/data",

  // ============================================
  // macOS SQLite Extension Loading
  // ============================================
  // macOS users MUST use Homebrew SQLite (Apple's disables extension loading)
  // Install: brew install sqlite
  // Common paths:
  //   Apple Silicon: "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"
  //   Intel Mac:     "/usr/local/opt/sqlite/lib/libsqlite3.dylib"
  // "customSqlitePath": "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",

  // ============================================
  // Embedding Model
  // ============================================
  // "embeddingModel": "Xenova/nomic-embed-text-v1",
  // Other options:
  //   "Xenova/all-MiniLM-L6-v2"           (384 dims, very fast, 512 context)
  //   "Xenova/all-mpnet-base-v2"          (768 dims, good quality, 512 context)
  //   "Xenova/jina-embeddings-v2-base-en" (768 dims, English-only, 8192 context)

  // ============================================
  // Search Settings
  // ============================================
  // Minimum final score (0-1) to include a result
  // "similarityThreshold": 0.5,

  // Minimum cosine similarity for vector results to enter hybrid scoring
  // Prevents unrelated memories from appearing via KNN alone
  // "minVectorSimilarity": 0.6,

  // Maximum number of results to return
  // "maxMemories": 10,

  // ============================================
  // Deduplication
  // ============================================
  // "deduplicationEnabled": true,
  // "deduplicationSimilarityThreshold": 0.9,
}
`;

function ensureConfigExists(): void {
  const configPath = join(CONFIG_DIR, "config.jsonc");
  if (!existsSync(configPath)) {
    try {
      writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
    } catch {
      // ignore write errors
    }
  }
}

ensureConfigExists();

const embeddingModel = fileConfig.embeddingModel ?? DEFAULTS.embeddingModel;

export const CONFIG = {
  storagePath: expandPath(fileConfig.storagePath ?? DEFAULTS.storagePath),
  customSqlitePath: fileConfig.customSqlitePath
    ? expandPath(fileConfig.customSqlitePath)
    : undefined,
  embeddingModel,
  embeddingDimensions:
    fileConfig.embeddingDimensions ?? getEmbeddingDimensions(embeddingModel),
  similarityThreshold:
    fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
  minVectorSimilarity:
    fileConfig.minVectorSimilarity ?? DEFAULTS.minVectorSimilarity,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  deduplicationEnabled:
    fileConfig.deduplicationEnabled ?? DEFAULTS.deduplicationEnabled,
  deduplicationSimilarityThreshold:
    fileConfig.deduplicationSimilarityThreshold ??
    DEFAULTS.deduplicationSimilarityThreshold,
};
