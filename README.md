# memo

Persistent memory for LLM agent sessions. Local embeddings, semantic search, project-scoped.

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
memo add <text> [--tags t1,t2]   # store a memory
memo search <query> [--limit N]  # semantic search
memo list [--limit N] [--all]    # list recent memories (--all for no limit)
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

## Agent Skills

Prompt-based workflows that any LLM agent can run. Installed via `memo install skills`.

| Skill | Description |
|-------|-------------|
| `memo-add` | Save a new memory, with duplicate checking before insert |
| `memo-search` | Semantic search across stored memories, with proactive context lookup |
| `memo-resolve-contradictions` | Detect memories that make opposing claims about the same thing, resolve with confirmation |
| `memo-resolve-duplicates` | Find paraphrases, subsets, and redundant memories that slip past built-in dedup |

## Data

Stored in `~/.config/memo/` — database, model cache (~130MB on first run), logs.
