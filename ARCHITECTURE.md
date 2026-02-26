# Memo Architecture

Comprehensive technical documentation covering the internals, algorithms, and design decisions of memo — a persistent memory system for LLM agent sessions.

For usage and installation, see [README.md](README.md).

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Source Files](#source-files)
- [Database Schema](#database-schema)
- [Embedding Pipeline](#embedding-pipeline)
- [Search Algorithm](#search-algorithm)
  - [Stage 1: Vector KNN Search](#stage-1-vector-knn-search)
  - [Stage 2: BM25 Keyword Search](#stage-2-bm25-keyword-search)
  - [Stage 3: Reciprocal Rank Fusion](#stage-3-reciprocal-rank-fusion)
  - [Stage 4: Score Normalization](#stage-4-score-normalization)
  - [Stage 5: Threshold Filtering](#stage-5-threshold-filtering)
- [Import System](#import-system)
  - [Markdown Import](#markdown-import)
  - [Repo Map Import](#repo-map-import)
- [Deduplication](#deduplication)
- [Project Scoping](#project-scoping)
- [Privacy Filtering](#privacy-filtering)
- [Configuration](#configuration)
- [Agent Skills](#agent-skills)
- [Data Flow Diagrams](#data-flow-diagrams)
- [Design Decisions](#design-decisions)

## Overview

Memo stores text memories in a local SQLite database with vector embeddings and full-text search indexes. When a memory is added, it is embedded into a 768-dimensional vector using a local ONNX transformer model, then inserted into three synchronized tables. When searching, memo runs both a vector similarity search and a BM25 keyword search, combines the results using Reciprocal Rank Fusion (RRF), normalizes the scores to a 0–1 scale, and returns the top matches.

Everything runs locally. No cloud APIs, no network calls after the initial model download (~130MB on first run).

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | [Bun](https://bun.sh) | TypeScript execution, built-in SQLite driver |
| Database | SQLite (WAL mode) | Storage, via Bun's native `bun:sqlite` |
| Vector search | [sqlite-vec](https://github.com/asg017/sqlite-vec) | KNN cosine similarity search (SQLite extension) |
| Full-text search | SQLite FTS5 | BM25 keyword ranking |
| Embeddings | [@xenova/transformers](https://github.com/xenova/transformers.js) | Local ONNX model inference |
| Default model | `Xenova/nomic-embed-text-v1` | 768 dimensions, quantized ONNX, ~130MB |

## Source Files

```
src/
├── cli.ts        Entry point. Argument parsing, command routing, process lifecycle.
├── config.ts     Configuration loading from ~/.config/memo/config.jsonc, defaults.
├── db.ts         SQLite schema, CRUD operations, extension loading.
├── search.ts     Hybrid search: vector KNN + BM25 + RRF fusion.
├── embed.ts      Embedding service. Model loading, inference, LRU cache.
├── importer.ts   Markdown import + repo-map import. File discovery, chunking, JSON parsing.
├── dedup.ts      Two-tier deduplication (exact match + cosine similarity).
├── tags.ts       Project identity via SHA-256 hashed tags.
├── privacy.ts    Strip <private> tags before storage.
├── log.ts        Append-only file logger with 5MB rotation.
└── jsonc.ts      JSONC comment stripper (state machine parser).
```

### File Dependency Graph

```
cli.ts (entry point)
  ├── config.ts ─── jsonc.ts
  ├── embed.ts ──── config.ts, db.ts, log.ts
  ├── db.ts ─────── config.ts, log.ts
  ├── search.ts ─── db.ts, config.ts, log.ts
  ├── importer.ts ─ privacy.ts
  ├── dedup.ts ──── db.ts, search.ts, config.ts
  ├── privacy.ts    (no dependencies)
  ├── tags.ts       (no dependencies)
  └── log.ts        (no dependencies)
```

## Database Schema

The database lives at `<project-root>/.memo/memo.db` — one database per project, shared across git worktrees of the same repository. It uses WAL journal mode for concurrent read performance. Three tables are kept in sync for every insert and delete, plus one cache table for embeddings:

### `memories` — Main Table

Stores the full memory record with all metadata.

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,           -- "mem_{timestamp}_{random9chars}"
  content TEXT NOT NULL,          -- the memory text
  vector BLOB NOT NULL,           -- Float32Array as raw bytes
  container_tag TEXT NOT NULL,    -- project or named container scope hash
  tags TEXT,                      -- source key for imports (file path or "repo-map:<path>")
  type TEXT,                      -- "doc_chunk" for imports, NULL for memo add
  created_at INTEGER NOT NULL,    -- epoch ms
  updated_at INTEGER NOT NULL,    -- epoch ms
  metadata TEXT,                  -- JSON: source path, line range, language, symbols, etc.
  display_name TEXT,
  user_name TEXT,
  user_email TEXT,
  project_path TEXT,
  project_name TEXT,
  git_repo_url TEXT
);

CREATE INDEX idx_container_tag ON memories(container_tag);
CREATE INDEX idx_created_at ON memories(created_at DESC);
```

### `vec_memories` — Vector Search (sqlite-vec)

A virtual table powered by the sqlite-vec extension. Provides exact KNN (k-nearest-neighbor) search using cosine distance.

```sql
CREATE VIRTUAL TABLE vec_memories USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float32[768] distance_metric=cosine
);
```

Queried with `WHERE embedding MATCH ? AND k = N ORDER BY distance`, which returns the N nearest neighbors by cosine distance. The `distance` value is the cosine distance (0 = identical, 2 = opposite), converted to similarity as `1 - distance`.

### `fts_memories` — Full-Text Search (FTS5)

A virtual table for BM25 keyword ranking. Only `content` is indexed; the other columns are metadata stored alongside but not searchable.

```sql
CREATE VIRTUAL TABLE fts_memories USING fts5(
  content,                        -- indexed for keyword search
  memory_id UNINDEXED,           -- stored but not searchable
  container_tag UNINDEXED,       -- stored but not searchable
  tokenize='unicode61'           -- Unicode-aware tokenization
);
```

Queried with `WHERE fts_memories MATCH ?`, which performs BM25 ranking. The `rank` column returned by FTS5 is a negative BM25 score (lower = more relevant).

### `embedding_cache` — Persistent Embedding Cache

Stores computed embeddings keyed by content hash and model name. Prevents re-running ONNX inference for previously embedded text across process restarts.

```sql
CREATE TABLE embedding_cache (
  content_hash TEXT NOT NULL,    -- SHA-256 of the full prefixed text
  model TEXT NOT NULL,            -- e.g. "Xenova/nomic-embed-text-v1"
  embedding BLOB NOT NULL,        -- Float32Array as raw bytes
  created_at INTEGER NOT NULL,    -- epoch ms
  PRIMARY KEY (content_hash, model)
);
```

The composite primary key `(content_hash, model)` ensures that switching embedding models naturally invalidates the cache — vectors from the old model won't be returned for queries using the new model.

This table is not cleaned up by `memo forget`. It is dropped along with everything else on `memo reset`. No eviction policy is needed — each entry is ~3KB (768 × 4 bytes embedding + metadata), so even 10,000 entries occupy only ~30MB.

### SQLite Pragmas

```sql
PRAGMA busy_timeout = 5000;     -- wait up to 5s for locks
PRAGMA journal_mode = WAL;      -- write-ahead logging for concurrency
PRAGMA synchronous = NORMAL;    -- balance durability vs speed
PRAGMA cache_size = -64000;     -- 64MB page cache
PRAGMA temp_store = MEMORY;     -- temporary tables in RAM
PRAGMA foreign_keys = ON;
```

### macOS SQLite Requirement

Apple's system SQLite disables extension loading at compile time. On macOS, memo requires Homebrew SQLite (`brew install sqlite`). The library path is either auto-detected from common Homebrew locations or configured explicitly via `customSqlitePath`. This is handled at database initialization time by calling `Database.setCustomSQLite()` before opening any connection.

## Embedding Pipeline

Defined in `src/embed.ts`.

### Model

The default model is `Xenova/nomic-embed-text-v1` — a quantized ONNX model that runs locally via `@xenova/transformers`. It produces 768-dimensional vectors. Other models can be configured (see [Configuration](#configuration)).

The model is downloaded on first use (~130MB) and cached globally at `~/.config/memo/data/.cache/` (shared across all projects). Subsequent runs load from cache.

### Inference

```
Input text
  → Prepend "clustering: " prefix
  → Tokenize
  → Run through ONNX model
  → Mean pooling over token embeddings
  → L2 normalization
  → Float32Array (768 dimensions)
```

The pipeline uses `{ pooling: "mean", normalize: true }`:

- **Mean pooling**: Averages all token-level embeddings into a single vector. This is the standard pooling strategy for sentence embeddings — it captures the overall meaning rather than being dominated by any single token.
- **L2 normalization**: Scales the vector to unit length. This ensures cosine similarity equals the dot product, which simplifies and speeds up comparisons.

### Symmetric Embedding Prefix

Memo uses the prefix `"clustering: "` for both stored memories and search queries. This is a deliberate choice:

The nomic-embed model supports task-specific prefixes (`search_query:`, `search_document:`, `clustering:`, `classification:`). Most search systems use **asymmetric** prefixes — `search_query:` for queries and `search_document:` for documents — which optimizes the embedding space for retrieval where queries and documents are inherently different.

Memo uses a **symmetric** prefix (`clustering:` for both sides) because:

1. **Deduplication accuracy**: When checking for duplicates, both the stored memory and the new candidate use the same prefix, so identical text produces identical vectors (similarity = 1.0). With asymmetric prefixes, identical text would produce different vectors, making exact-match detection unreliable.
2. **Intuitive scores**: A search for "JWT authentication" against a stored memory "JWT authentication" returns 1.0, not some arbitrary lower value.
3. **Memories are not documents**: Memo stores short, declarative statements — not long documents. The query/document distinction doesn't apply well here.

### Two-Level Embedding Cache

The embedding service uses a two-level cache to avoid redundant ONNX inference:

**L1 — In-memory LRU cache** (Map, 100 entries max): The hot path. Avoids any I/O for recently embedded text within the same process. On overflow, the oldest entry is evicted (FIFO via Map insertion order).

**L2 — Persistent SQLite cache** (`embedding_cache` table): Survives process restarts. Keyed by `(sha256(text), model)`. When L1 misses, the embedding service checks L2 before loading the ONNX model. On L2 hit, the vector is promoted into L1 and returned without running inference.

On a full miss (both L1 and L2), ONNX inference runs, and the result is written to both caches.

```
embed("clustering: Auth uses JWT")
  → L1 check (in-memory Map)     → hit? return immediately
  → L2 check (SQLite by hash)    → hit? promote to L1, return
  → ONNX inference                → write to L1 + L2, return
```

This means the ONNX model is only loaded when genuinely new text is encountered. For `memo search` on previously searched queries, or `memo add` with dedup checks against existing content, the persistent cache eliminates cold-start inference entirely.

A 30-second timeout wraps each embedding call to prevent hangs during model inference. L2 cache operations are wrapped in try/catch — if the database isn't available, the service falls back to inference-only mode gracefully.

### Global Singleton

The `EmbeddingService` uses `Symbol.for("memo.embedding.instance")` on `globalThis` to ensure exactly one model instance exists, even if the module is imported multiple times (which can happen with Bun's module resolution). Loading the model is expensive (~1–2 seconds cold), so avoiding double-initialization matters.

## Search Algorithm

Defined in `src/search.ts`. The core function is `searchMemories()`.

The search combines two fundamentally different retrieval strategies and fuses their results:

### Stage 1: Vector KNN Search

```sql
SELECT memory_id, distance FROM vec_memories
WHERE embedding MATCH ? AND k = {limit * 4}
ORDER BY distance
```

This queries the sqlite-vec virtual table for the `k` nearest neighbors by cosine distance. The `k` is set to 4× the requested result limit to provide enough candidates for filtering and fusion.

**Important**: KNN always returns exactly `k` results regardless of actual similarity. If you ask for 40 nearest neighbors and only 5 are genuinely related, you still get 40 results — the other 35 are just the least-distant vectors in the database, which may be completely unrelated.

To prevent these irrelevant results from polluting the final output, memo applies a **minimum vector similarity gate** (`minVectorSimilarity`, default 0.6). After converting cosine distance to similarity (`1 - distance`), any result below 0.6 is discarded before entering the fusion stage.

### Stage 2: BM25 Keyword Search

```sql
SELECT memory_id, rank FROM fts_memories
WHERE fts_memories MATCH ? AND container_tag = ?
ORDER BY rank
LIMIT {limit * 4}
```

This queries the FTS5 virtual table using SQLite's built-in BM25 ranking. BM25 (Best Matching 25) is a probabilistic relevance function that scores documents based on:

- **Term frequency (TF)**: How often query terms appear in the document, with diminishing returns for repeated occurrences.
- **Inverse document frequency (IDF)**: Rare terms across the corpus are weighted higher than common terms.
- **Document length normalization**: Shorter documents with the same term count score higher.

FTS5 can fail on special characters in the query. If this happens, memo logs the error and falls back to vector-only search.

### Stage 3: Reciprocal Rank Fusion

After both search stages produce their ranked lists, memo combines them using **Reciprocal Rank Fusion (RRF)**.

RRF is a rank-based fusion method. It does not look at raw scores — only at the position (rank) of each item in each list. The formula for each item:

```
RRF_score = Σ 1 / (k + rank_i)  for each list i where the item appears
```

Where:
- `k` = 60 (the standard RRF constant)
- `rank_i` = the 0-based position in list `i`

For an item at rank 0 in both lists:
```
score = 1/(60+0) + 1/(60+0) = 1/60 + 1/60 = 2/60 ≈ 0.0333
```

For an item at rank 0 in one list only:
```
score = 1/(60+0) = 1/60 ≈ 0.0167
```

**Why RRF over weighted score combination?**

The naive approach to hybrid search is to normalize both scores to 0–1 and compute `α * vector_score + (1-α) * bm25_score`. This requires choosing `α` and correctly normalizing two fundamentally different score distributions. BM25 scores are unbounded and distribution-dependent; cosine similarities are bounded but not uniformly distributed.

RRF avoids all of this. It only looks at rank positions, which are naturally comparable. Items that rank highly in both lists rise to the top. Items that rank highly in only one list get a moderate score. The constant `k = 60` dampens the effect of low rankings — being at position 100 vs 200 makes almost no difference, while being at position 0 vs 5 makes a large difference. This matches intuition: the top results from each method are informative; the tail is noise.

### Stage 4: Score Normalization

Raw RRF scores are small numbers (max ≈ 0.033). Memo normalizes them to a 0–1 scale, but uses **three different formulas** depending on which lists an item appeared in:

**Case 1: Item appeared in both vector and BM25 results**

```
similarity = min(rrfScore / maxRrfScore, 1.0)
```

Where `maxRrfScore = 2/k = 2/60`. This normalizes against the theoretical maximum (rank 0 in both lists). An item ranked first in both lists gets a score of 1.0.

**Case 2: Item appeared in BM25 results only**

```
similarity = min(rrfScore / (1/k), 1.0)
```

Where `1/k = 1/60` is the maximum single-list RRF contribution. A BM25-only result at rank 0 gets 1.0; at higher ranks, progressively less.

**Case 3: Item appeared in vector results only**

```
similarity = cosineSimilarity  (raw, from KNN)
```

This is a critical design choice. For vector-only results, memo uses the raw cosine similarity instead of the normalized RRF score. Without this, every vector-only result would get `rrfScore / (1/k)`, which produces a **0.5 floor** — an item at rank 0 in one list with a single-list normalization maximum of `1/k` scores `(1/k) / (1/k) = 1.0`, but the score drops off quickly and most vector-only results cluster around 0.5 regardless of their actual semantic similarity. Using raw cosine similarity directly produces scores that reflect how semantically related the memory actually is.

### Stage 5: Threshold Filtering

After normalization, results are sorted by similarity (descending) and filtered:

1. Remove any result with `similarity < similarityThreshold` (default 0.7)
2. Keep only the top `limit` results (default 10)

The threshold can be overridden per-search via the `--threshold` CLI flag, or globally via the `similarityThreshold` config option.

### Worked Example

Suppose we search for "JWT authentication" with 3 memories in the database:

| Memory | Vector Rank | Cosine Sim | BM25 Rank |
|--------|-------------|------------|-----------|
| "Auth uses JWT tokens with 24h expiry" | 0 | 0.85 | 0 |
| "We use PostgreSQL for the database" | 1 | 0.62 | — |
| "Login endpoint requires JWT header" | — | 0.55 (below 0.6 gate) | 1 |

After minVectorSimilarity gate (0.6), the "Login endpoint" is removed from vector results (0.55 < 0.6), but it remains in BM25 results.

RRF scores:
- "Auth uses JWT...": `1/(60+0) + 1/(60+0) = 0.0333` → Both lists → `0.0333 / 0.0333 = 1.0`
- "We use PostgreSQL...": Vector only → raw cosine = `0.62`
- "Login endpoint...": BM25 only → `1/(60+1) / (1/60) = 60/61 = 0.984`

After threshold (0.7): "We use PostgreSQL..." (0.62) is filtered out. Final results:
1. `[1.000]` "Auth uses JWT tokens with 24h expiry"
2. `[0.984]` "Login endpoint requires JWT header"

## Deduplication

Defined in `src/dedup.ts`. Runs before every `memo add` to prevent storing redundant memories.

### Two-Tier Check

**Tier 1 — Exact string match:**

```sql
SELECT id FROM memories WHERE content = ? AND container_tag = ? LIMIT 1
```

Fast exact comparison. If the identical string already exists in the same project scope, the insert is skipped with `similarity: 1.0`.

**Tier 2 — Near-duplicate via cosine similarity:**

Uses `findNearDuplicates()` from `search.ts`, which queries the top 5 nearest vectors and filters by the deduplication threshold (default 0.9). This catches paraphrases and minor rewording.

For example, if the database contains "Auth uses JWT with 24h expiry" and you try to add "Authentication uses JWT tokens with 24-hour expiry", the cosine similarity between these two (with symmetric `clustering:` prefix) will likely exceed 0.9, and the insert is skipped.

The threshold of 0.9 is intentionally high — only very similar content is blocked. Lower values would risk false positives (blocking genuinely different memories that happen to be about the same topic).

Deduplication can be disabled via `"deduplicationEnabled": false` in config.

## Import System

Defined in `src/importer.ts` and wired through `memo import` in `src/cli.ts`.

Memo supports two import modes that share the same storage layer (`type = "doc_chunk"`) but differ in how content is sourced and chunked.

### Markdown Import

`memo import --markdown <path>` imports a single markdown file or recursively imports a directory of markdown files (`.md`, `.markdown`, `.mdx`). Each file is chunked and stored as multiple `memories` rows with:

- `type = "doc_chunk"`
- `tags = <source file key>` (absolute normalized path)
- `metadata` containing source path, line range, chunk index, and chunk hash

#### Chunking Algorithm

Chunking uses a line-aware sliding window:

- `maxChars = chunkTokens * 4` (default `400 * 4 = 1600` chars)
- `overlapChars = overlapTokens * 4` (default `80 * 4 = 320` chars)
- line-preserving segmentation, including long-line splitting when needed
- overlap carry from the tail of the previous chunk

This preserves local context across chunk boundaries and makes search output attributable back to source files and line ranges.

#### Replace/Sync Behavior

Imports are synchronized per source file (not append-only):

1. Build new embeddings for all chunks in a source file
2. Delete existing `doc_chunk` rows for the same `(container_tag, source file key)`
3. Insert the fresh chunk set

This means re-running `memo import --markdown` after docs change will replace stale chunks from those files while leaving other files in the same container untouched.

### Repo Map Import

`memo import --repo-map <file.json>` imports a tree-sitter project map — a JSON array where each entry describes one source file's structure (path, language, symbols, code skeleton). This gives LLM agents a way to find relevant files via semantic search instead of repeatedly grepping the entire project.

Each entry is stored as **one record** (no chunking) with:

- `type = "doc_chunk"`
- `tags = "repo-map:<absolute path of JSON file>"` (distinct from markdown imports)
- `metadata` containing source path, language, symbols array, and `importType: "repo-map"`

#### Input Format

A JSON array of objects. Only `path` is required:

```json
[
  {
    "path": "handlers/users.go",
    "language": "go",
    "symbols": ["UserHandler", "HandleUsers", "handle"],
    "content": "type UserHandler struct { ... }"
  }
]
```

#### Content Construction

The searchable content stored for each entry combines structured metadata with the code skeleton:

```
{path} [{language}] {symbols joined by space}
{content}
```

For example:

```
handlers/users.go [go] UserHandler HandleUsers handle list create
type UserHandler struct {
	userService *services.UserService
}
func HandleUsers() http.HandlerFunc { ... }
```

This means queries match via:
- **BM25 keyword search**: exact symbol names, file paths, language names
- **Vector semantic search**: conceptual similarity to the code structure

#### Replace/Sync Behavior

All entries from a given JSON file share the same `tags` value (`repo-map:<realpath>`). On re-import, all previous entries from that JSON file are deleted in a single transaction and replaced with fresh ones. This is a full-snapshot replacement — the tree-sitter output always represents the complete project state.

#### Validation

- The JSON file must contain an array
- Each entry must have a `path` field (string)
- Missing `language` defaults to `"unknown"`, missing `symbols` to `[]`, missing `content` to `""`
- Invalid JSON or missing file produces a clear error

## Project Scoping

Defined in `src/tags.ts` and `src/db.ts`.

Memo uses **per-project databases** — each project gets its own `.memo/memo.db` file at the project root. This provides complete isolation: no cross-project vector search contamination, no shared FTS5 indexes, no accidental data leakage between projects.

### Per-Project Database Location

The database path is resolved by `getDbPath()` in `src/db.ts`:

```
<project-root>/.memo/memo.db
```

The project root is determined by `resolveProjectRoot()`:
1. If inside a git repo: `resolve(git rev-parse --path-format=absolute --git-common-dir, "..")` — this resolves to the parent of the shared `.git` directory, ensuring all worktrees share one DB.
2. If not a git repo: the current working directory.

The `.memo/` directory is created automatically on first use. Users should add `.memo/` to their `.gitignore`.

### Worktree Sharing

Git worktrees of the same repository share a single `.memo/memo.db` because `--git-common-dir` resolves to the same `.git` directory for all worktrees:

- `/home/user/project` and `/home/user/project-worktree` (both worktrees of the same repo) → both use `/home/user/project/.memo/memo.db`
- `/home/user/project-a` and `/home/user/project-b` (different repos) → separate databases

### Container Tags

Within each project database, memories are scoped by a `container_tag`. By default, this is the project tag. With `--container <name>`, a named container tag is used instead.

#### Project Tags (default)

```
tag = "memo_project_" + sha256(gitCommonDir || cwd).slice(0, 16)
```

This is the default container for all memories added without `--container`. The hash input is the same path used to resolve the project root, ensuring consistency.

#### Named Container Tags

When `--container <name>` is provided:

```
normalized = trim(name).toLowerCase()
normalized = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
tag = "memo_container_" + normalized
```

Named containers provide sub-scopes within the project DB — useful for imported documentation sets (e.g., `--container react-router`) and ad-hoc memory groups.

### Why Hashes for Project Tags?

Using SHA-256 hashes instead of raw paths prevents leaking filesystem paths in the database tags. The tags are stored alongside every memory and visible in queries, so hashing preserves privacy while maintaining uniqueness.

## Privacy Filtering

Defined in `src/privacy.ts`.

Content wrapped in `<private>` tags is redacted before storage:

```
Input:  "API key is <private>sk-abc123</private>, uses JWT auth"
Stored: "API key is [REDACTED], uses JWT auth"
```

The regex `/<private>[\s\S]*?<\/private>/gi` handles:
- Case-insensitive tags (`<Private>`, `<PRIVATE>`)
- Multiline content (lazy `*?` matching)
- Multiple private blocks in the same text

If the entire content is private (nothing left after stripping), the `memo add` command rejects the input with an error.

This is designed for LLM agents that may include sensitive information in their memory operations. The `<private>` convention gives agents a way to mark secrets for automatic redaction.

## Configuration

Defined in `src/config.ts`.

Configuration is loaded from `~/.config/memo/config.jsonc` (or `config.json`). The file supports JSONC format (JSON with `//` and `/* */` comments, trailing commas). A default config template with all options commented out is auto-created on first run.

### JSONC Parser

The JSONC parser (`src/jsonc.ts`) is a hand-written character-by-character state machine that:

1. Tracks three states: `inString`, `inSingleLineComment`, `inMultiLineComment`
2. Handles escaped quotes inside strings by counting preceding backslashes
3. Preserves newlines within comments (maintains line numbers for error reporting)
4. Strips trailing commas after comment removal (`/,\s*([}\]])/g` → `$1`)

This avoids the need for a JSONC parsing library while correctly handling edge cases like URLs in strings (e.g., `"https://example.com"` — the `//` is inside a string, not a comment).

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `storagePath` | `~/.config/memo/data` | Global model cache and log location |
| `customSqlitePath` | (auto-detect) | Path to Homebrew SQLite library (macOS) |
| `embeddingModel` | `Xenova/nomic-embed-text-v1` | ONNX model for embeddings |
| `embeddingDimensions` | (from model) | Auto-detected from model name |
| `similarityThreshold` | `0.7` | Minimum score (0–1) to include in search results |
| `minVectorSimilarity` | `0.6` | Minimum cosine similarity for vector results to enter RRF |
| `maxMemories` | `10` | Default number of search results |
| `deduplicationEnabled` | `true` | Enable/disable duplicate detection on add |
| `deduplicationSimilarityThreshold` | `0.9` | Cosine similarity threshold for near-duplicate detection |

### Supported Embedding Models

Any model compatible with `@xenova/transformers` `feature-extraction` pipeline works. The config includes a dimension lookup table for known models:

| Model | Dimensions |
|-------|-----------|
| `Xenova/nomic-embed-text-v1` | 768 |
| `Xenova/all-MiniLM-L6-v2` | 384 |
| `Xenova/all-MiniLM-L12-v2` | 384 |
| `Xenova/all-mpnet-base-v2` | 768 |
| `Xenova/jina-embeddings-v2-base-en` | 768 |
| `Xenova/jina-embeddings-v2-small-en` | 512 |
| `Xenova/bge-base-en-v1.5` | 768 |
| `Xenova/bge-small-en-v1.5` | 384 |
| `Xenova/gte-small` | 384 |

Unknown models default to 768 dimensions.

## Agent Skills

Located in the `skills/` directory. Skills are Markdown files containing prompt-based workflows for LLM agents. They are not code — they are instructions that agents follow when invoked.

| Skill | Description |
|-------|-------------|
| `memo-add` | Guides the agent through storing a memory: extract key info, check for duplicates via `memo search`, then `memo add`. Emphasizes atomic, self-contained memories. |
| `memo-search` | Guides the agent through searching: extract query terms, run `memo search`, interpret hybrid scores. Suggests `memo list --all` for browsing. |
| `memo-resolve-duplicates` | Workflow: `memo list --all`, identify paraphrases/subsets, present groups with keep/remove recommendations, batch delete with confirmation. |
| `memo-resolve-contradictions` | Workflow: `memo list --all`, group by topic, identify opposing claims, present with recommendations, batch delete with confirmation. |

Skills are installed as **symlinks** into agent tool directories via `memo install skills`. This means updates to skill files in the memo repo are immediately reflected in all installed agents.

Supported targets:
- `--opencode` → `~/.config/opencode/skills/`
- `--claude` → `~/.claude/skills/`
- `--codex` → `~/.agents/skills/`

## Data Flow Diagrams

### Adding a Memory

```
User: memo add "Auth uses JWT with 24h expiry"
  │
  ├─ stripPrivateContent()        Remove <private> blocks
  ├─ isFullyPrivate()             Reject if nothing left
  ├─ getProjectInfo(cwd)          Compute project tag + metadata
  │   └─ git rev-parse            Get git common dir for stable project ID
  ├─ getDbPath(cwd)               Resolve .memo/memo.db path
  ├─ embedText()                  Generate vector embedding
  │   ├─ Prepend "clustering: "   Symmetric prefix
  │   ├─ L1: in-memory LRU cache  Fast path (no I/O)
  │   ├─ L2: SQLite hash cache    Persistent (survives restarts)
  │   └─ L3: ONNX inference       Mean pooling + L2 normalize
  ├─ checkDuplicate()             Two-tier dedup
  │   ├─ findExactDuplicate()     Exact string match in DB
  │   └─ findNearDuplicates()     Cosine similarity ≥ 0.9
  └─ insertMemory()               Write to 3 tables
      ├─ INSERT memories           Main record
      ├─ INSERT vec_memories       Vector for KNN
      └─ INSERT fts_memories       Text for BM25
```

### Searching Memories

```
User: memo search "authentication" --threshold 0.5
  │
  ├─ getProjectInfo(cwd)          Determine project scope
  ├─ getDbPath(cwd)               Resolve .memo/memo.db path
  ├─ embedText("authentication")  Embed query (L1 → L2 → ONNX)
  └─ searchMemories()             Hybrid search
      │
      ├─ Vector KNN               sqlite-vec, k = limit × 4
      │   └─ Filter               Drop cosine similarity < 0.6
      │
      ├─ BM25 Keyword             FTS5, limit × 4
      │   └─ Fallback             Vector-only if FTS5 errors
      │
      ├─ Reciprocal Rank Fusion   Combine rank lists (k=60)
      │
      ├─ Score Normalization      3 cases: both/BM25-only/vector-only
      │
      ├─ Sort by similarity       Descending
      │
      └─ Filter + Limit           Drop below threshold, keep top N
```

### Importing a Repo Map

```
User: memo import --repo-map repo-map.json
  │
  ├─ collectRepoMapEntries()       Read + validate JSON file
  │   ├─ readFileSync()            Load JSON
  │   ├─ JSON.parse()              Parse array
  │   ├─ Validate entries          Require "path" field per entry
  │   └─ sourceKey                 "repo-map:" + realpath of JSON file
  │
  ├─ getProjectInfo(cwd)            Compute project tag + metadata
  │
  ├─ For each entry:
  │   ├─ buildRepoMapContent()     "{path} [{lang}] {symbols}\n{content}"
  │   ├─ embedText(content)        Generate vector (L1 → L2 → ONNX)
  │   └─ Build MemoryRecord        type="doc_chunk", tags=sourceKey
  │
  └─ replaceImportedChunksForSource()  Transactional bulk replace
      ├─ BEGIN                     Start transaction
      ├─ DELETE old entries         All doc_chunks with same sourceKey
      ├─ INSERT new entries         Write to 3 tables per record
      └─ COMMIT
```

### Deleting a Memory

```
User: memo forget mem_123 --container my-project
  │
  ├─ getProjectInfo(cwd)            Compute project tag
  ├─ Resolve container tag          From --container or project default
  ├─ getMemoryContainerTag(id)      Look up the memory's container_tag
  ├─ Verify match                   Error if memory belongs to a different container
  └─ deleteMemory(id)               Remove from all 3 tables
      ├─ DELETE vec_memories         Vector index
      ├─ DELETE fts_memories         FTS index
      └─ DELETE memories             Main record
```

When `--container` is specified, `forget` verifies that the memory belongs to that container before deleting. Without `--container`, any memory in the project DB can be deleted by ID.

## Design Decisions

### Why hybrid search instead of vector-only?

Vector search (semantic similarity) is good at finding conceptually related content — a search for "database" will find memories about "PostgreSQL". But it can miss exact keyword matches that a user expects, and it can return false positives for topically similar but irrelevant content.

BM25 keyword search excels at exact term matching — searching for "JWT" finds all memories containing "JWT" — but misses semantic relationships ("authentication tokens" wouldn't match "JWT").

Combining both via RRF gives the best of both: exact keyword matches score highly (they rank well in both lists), semantic matches are surfaced when keywords don't match, and results that are only tangentially related via either method alone are pushed down.

### Why RRF instead of score interpolation?

Score interpolation (`α * score_a + (1-α) * score_b`) requires:
1. Choosing `α` (how much weight to give each method)
2. Normalizing both score distributions to be comparable

BM25 scores are unbounded negative numbers whose distribution depends on corpus statistics. Cosine similarities are bounded [−1, 1] but not uniformly distributed. Normalizing these to be comparable is fragile and requires tuning.

RRF sidesteps all of this by operating on ranks only. It's parameter-free (the constant `k=60` is a well-studied default from the original 2009 paper by Cormack, Clarke, and Büttcher). It's robust across different score distributions and requires no tuning.

### Why symmetric embeddings?

See [Symmetric Embedding Prefix](#symmetric-embedding-prefix) in the Embedding Pipeline section. The short answer: memo is not a document retrieval system — it stores and retrieves short, declarative statements. The asymmetric query/document distinction doesn't apply, and symmetric embeddings produce more intuitive similarity scores and more reliable deduplication.

### Why two similarity thresholds?

Memo has two distinct thresholds that serve different purposes:

- **`minVectorSimilarity` (0.6)** — Applied during Stage 1 (vector KNN), before fusion. This is a hard gate that prevents genuinely unrelated vectors from entering the RRF pipeline at all. Without this, KNN would always return `k` results even if the database only contains unrelated content.

- **`similarityThreshold` (0.7)** — Applied after Stage 4 (score normalization), as the final quality filter. This controls the minimum relevance of returned results. It operates on the normalized 0–1 score, which incorporates both semantic and keyword relevance.

The first threshold prevents noise from entering the fusion algorithm. The second threshold controls the quality of the final output. They operate at different stages of the pipeline and cannot be collapsed into one.

### Why local embeddings?

Local inference means:
- No API keys or accounts required
- No network latency (after initial model download)
- No per-query costs
- Data never leaves the machine
- Works offline

The tradeoff is a ~130MB model download on first use and ~1–2 seconds cold start for model loading. Subsequent queries within the same process are fast (~10–50ms) due to the ONNX runtime and LRU caching.

### Why SQLite?

SQLite is the only database that provides all three capabilities in a single file:
1. Relational storage (main `memories` table)
2. Vector KNN search (via sqlite-vec extension)
3. Full-text BM25 search (via built-in FTS5)

No server process, no configuration, no network. The WAL journal mode allows concurrent reads from multiple processes (e.g., multiple agent sessions reading memories simultaneously).

### Why worktree-aware project tagging?

Developers using `git worktree` maintain multiple checkouts of the same repository in different directories. Without worktree awareness, each checkout would get a different project tag and its own isolated memory scope — memories added in one worktree would be invisible in another.

By using `git rev-parse --git-common-dir` (which resolves to the shared `.git` directory for all worktrees), memo ensures all worktrees of the same repository share the same project tag and memory pool.
