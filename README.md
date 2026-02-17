# memo

Persistent memory for LLM agent sessions. Local embeddings, semantic search, project-scoped.

## Install

Requires [Bun](https://bun.sh) and Homebrew SQLite (macOS):

```bash
brew install sqlite
bun install
bun link
```

## Commands

```bash
memo add <text> [--tags t1,t2]   # store a memory
memo search <query> [--limit N]  # semantic search
memo list [--limit N]            # list recent memories
memo forget <id>                 # delete by id
memo tags                        # show project/user info
memo status                      # system status
```

All commands are **project-scoped by default**. Add `--global` to operate across all projects.

## Examples

```bash
# store
memo add "Auth uses JWT with 24h expiry" --tags auth,jwt
memo add "User prefers strict TypeScript" --tags style --global

# search
memo search "authentication"
memo search "coding style" --global --limit 5

# manage
memo list
memo forget mem_1771355620142_y259isiqp
```

Search returns results ranked by similarity:

```
[0.670] (mem_...) 2026-02-17 [auth,jwt]
  Auth uses JWT with 24h expiry
```

## Project scoping

Memories are isolated by working directory. `memo search` in project A won't return memories from project B. Use `--global` to cross projects.

## Privacy

Content in `<private>...</private>` tags is redacted before storage. Exact and near-duplicates are automatically skipped.

## Configuration

`~/.config/memo/config.jsonc` (auto-created on first run):

```jsonc
{
  // "similarityThreshold": 0.3,
  // "maxMemories": 10,
  // "embeddingModel": "Xenova/nomic-embed-text-v1",
  // "deduplicationEnabled": true,
  // "customSqlitePath": "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
}
```

## Data

Stored in `~/.config/memo/` — database, model cache (~130MB on first run), logs.
