# memo

Persistent memory for LLM agent sessions. Local embeddings, **hybrid semantic + keyword search**, project-scoped.

## Install

Requires [Bun](https://bun.sh) and SQLite (`brew install sqlite` on macOS).

```bash
bun install -g github:ykaratkou/memo
```

### Agent skills

```bash
memo install skills --opencode   # OpenCode
memo install skills --claude     # Claude Code
memo install skills --codex      # Codex CLI
```

## Commands

```bash
memo add <text>                   # store a memory (--container N to target a container)
memo import --markdown <path>     # import markdown file/folder
memo import --repo-map <file.json>
                                  # import tree-sitter project map (JSON)
memo search <query> [--limit N] [--container NAME]
                                  # hybrid semantic + keyword search
memo list [--limit N] [--all] [--container NAME]
                                  # list recent memories (--all for no limit)
memo forget <id>                  # delete by id
memo reset                        # reset project memories (irreversible)
memo tags                         # show project info
memo status                       # system status
```

All data is stored **per project** in `.memo/memo.db` (shared across git worktrees of the same repo). Add `.memo/` to your `.gitignore`.

## Examples

```bash
# store
memo add "Auth uses JWT with 24h expiry"
memo add "User prefers strict TypeScript"

# search
memo search "authentication"
memo search "coding style" --limit 5
memo search "router loader" --container react-router

# import docs
memo import --markdown ./docs
memo import --markdown ./vendor/react-router/docs --container react-router

# import tree-sitter project map
memo import --repo-map repo-map.json
memo import --repo-map repo-map.json --container my-project

# manage
memo list
memo list --container react-router
memo forget mem_1771355620142_y259isiqp
memo reset
```

Search returns results ranked by similarity (0-1 scale):

```
[1.000] (mem_...) 2026-02-21
  weather in barcelona is 19 today
```

## How It Works

### Hybrid Search (BM25 + Vectors)

Memo uses **two search mechanisms** that work together:

1. **Vector search** — semantic similarity using local embeddings (understands meaning, synonyms, concepts)
2. **BM25 keyword search** — precise term matching via SQLite FTS5 (finds exact words and phrases)

Results are combined using **Reciprocal Rank Fusion (RRF)** — a standard technique that:
- Ranks items higher when they appear in both semantic and keyword results
- Automatically balances the two without hardcoded weights
- Produces intuitive scores (0-1 scale)

### Symmetric Embeddings

Unlike typical search systems that use asymmetric prefixes (`search_query:` vs `search_document:`), memo uses symmetric embeddings (`clustering:` prefix). This means:
- Identical text produces identical vectors → **1.0 score**
- Better deduplication (same prefix for both sides)
- More intuitive scores for exact matches

## Configuration

`~/.config/memo/config.jsonc` (auto-created on first run):

```jsonc
{
  // "similarityThreshold": 0.7,
  // "maxMemories": 10,
  // "embeddingModel": "Xenova/nomic-embed-text-v1",
  // "deduplicationEnabled": true,
  // "customSqlitePath": "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
}
```

## Markdown Import

`memo import --markdown` chunks markdown files and stores each chunk as searchable memory.

- Supported inputs: single file or directory (recursive)
- Supported extensions: `.md`, `.markdown`, `.mdx`
- Default chunking: `--chunk-tokens 400` and `--overlap-tokens 80`
- Re-import behavior: previously imported chunks from the same file are replaced (sync, not append)

Examples:

```bash
# import into current project container
memo import --markdown ./docs

# import into a named container
memo import --markdown ./docs --container react-router

# search imported docs
memo search "loader API" --container react-router
```

## Repo Map Import

`memo import --repo-map` imports a tree-sitter project map — a JSON file describing the codebase structure (files, languages, symbols, code skeletons). This gives LLM agents a way to find relevant files via semantic search instead of grepping the entire project.

Input format (JSON array):

```json
[
  {
    "path": "handlers/users.go",
    "language": "go",
    "symbols": ["UserHandler", "HandleUsers", "handle", "list", "create"],
    "content": "type UserHandler struct {\n\tuserService *services.UserService\n}\n..."
  }
]
```

Each entry is stored as one record. The searchable content combines the file path, language, symbol names, and code skeleton — so queries match on both symbol names (keyword) and code semantics (vector).

- One record per file (no chunking needed — entries are already semantically meaningful units)
- Re-import replaces all previous entries from the same JSON file
- Only `path` is required; `language`, `symbols`, and `content` are optional

Examples:

```bash
# generate with your tree-sitter tool, then import
treesitter-tool parse ./src > repo-map.json
memo import --repo-map repo-map.json

# import into a named container
memo import --repo-map repo-map.json --container my-project

# search for files related to user creation
memo search "create user" --threshold 0.5
```

## Agent Skills

Prompt-based workflows that any LLM agent can run. Installed via `memo install skills`.

| Skill | Description |
|-------|-------------|
| `memo-add` | Save a new memory, with duplicate checking before insert |
| `memo-search` | Semantic search across stored memories, with proactive context lookup |
| `memo-resolve-contradictions` | Detect memories that make opposing claims about the same thing, resolve with confirmation |
| `memo-resolve-duplicates` | Find paraphrases, subsets, and redundant memories that slip past built-in dedup |

## Data

- **Project data**: `.memo/memo.db` in the project root (per-project, shared across git worktrees)
- **Model cache**: `~/.config/memo/data/.cache/` (~130MB on first run, shared globally)
- **Config**: `~/.config/memo/config.jsonc`
- **Logs**: `~/.config/memo/data/memo.log`

## Development

### Setup

```bash
git clone https://github.com/ykaratkou/memo.git
cd memo
bun install
```

### Running locally

```bash
# Run commands directly from source
bun ./src/cli.ts add "test memory"
bun ./src/cli.ts search "test"
bun ./src/cli.ts list

# Or use the npm script
bun run memo add "test memory"
```

### Testing changes

```bash
# Reset database for clean testing
bun ./src/cli.ts reset

# Add test memories
bun ./src/cli.ts add "weather in barcelona is 19 today"
bun ./src/cli.ts add "temperature in madrid is 22 degrees"

# Test search
bun ./src/cli.ts search "barcelona weather"
```

### Building

No build step required — runs directly as TypeScript via Bun.
