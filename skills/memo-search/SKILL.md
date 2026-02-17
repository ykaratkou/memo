---
name: memo-search
description: Search the current project's memo database for relevant memories. Use it before processing any question from user
---

# Memo Search

Search the current project's memo database for relevant memories.

## Workflow

### Step 1: Determine What to Search For

Extract the key topic or question from the user's request. If the request is broad (e.g., "what do we know about the API?"), you may need to run multiple searches with different terms.

### Step 2: Search

Run a semantic search:

```bash
memo search "<query>" --limit 10
```

Adjust `--limit` based on how broad the search is. Use a higher limit for broad topics, lower for specific lookups.

If the search is broad or might span multiple topics, run several targeted searches:

```bash
memo search "<term 1>"
memo search "<term 2>"
```

## Scope

- By default, search is scoped to the **current project**.
- Only use `--global` if the user explicitly asks to search across all projects.

## Listing All Memories

If the user asks to "show everything" or "list all memories", use:

```bash
memo list --all
```

This returns all memories without semantic ranking. Use it for browsing rather than targeted lookup.

## Important Notes

- **Semantic search is fuzzy.** Results are ranked by relevance, not exact match. A query for "database" will also surface memories about "PostgreSQL" or "schema".
- **No results doesn't mean no information.** The user may simply not have stored that information yet — suggest adding it.
- **Be proactive but not noisy.** When using search to inform a task, integrate the knowledge quietly. Only call out memories explicitly when they're directly relevant to the user's question.
