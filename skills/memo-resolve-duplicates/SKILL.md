---
name: memo-resolve-duplicates
description: Detect and clean up duplicate or redundant memories in the current project's memo database. Catches paraphrases and subsets that slip past built-in dedup.
---

# Memo Resolve Duplicates

Detect and clean up duplicate or redundant memories in the current project's memo database.

## When to Use

Run this skill when the knowledge base feels bloated, or periodically to keep it lean. Memo has built-in deduplication at insert time, but it only catches exact matches and very high similarity (>0.9). This skill catches softer duplicates that slip through: paraphrases, subsets, and memories that were added in slightly different wording over time.

## Workflow

### Step 1: Collect All Memories

Run the following command to get every memory for the current project:

```bash
memo list --all
```

If there are no memories, stop and inform the user.

### Step 2: Identify Duplicate Groups

Read through all memories and identify groups where multiple memories convey **essentially the same information**. Duplicates include:

- **Paraphrases** — same fact stated in different words (e.g., "DB uses PostgreSQL 15" vs "The database is Postgres v15")
- **Subsets** — one memory is entirely contained within another, more complete memory (e.g., "Uses React" vs "Frontend uses React 18 with TypeScript and Vite")
- **Redundant overlap** — two memories cover the same ground with minor differences that don't add value

**NOT duplicates** (do not flag these):
- Memories that discuss the same topic but provide genuinely different information
- Memories that complement each other (e.g., one about setup, another about configuration)
- Memories that cover the same concept in different contexts

### Step 3: Report Findings

Present duplicate groups as a numbered list. For each group, show:

1. **All memories in the group** — IDs, dates, and full content
2. **The best candidate to keep** — based on:
   - **Completeness** — the most comprehensive version
   - **Recency** — newer is usually more accurate
   - **Specificity** — more specific and actionable is better
3. **Memories to remove** — the redundant ones

Format example:

```
Duplicate Group 1:
  Keep: (mem_yyy) 2025-02-10
    "Frontend uses React 18 with TypeScript, bundled with Vite, deployed to Vercel"
  Remove: (mem_xxx) 2025-01-15
    "Uses React for the frontend"
  Remove: (mem_zzz) 2025-01-20
    "Frontend is React + TypeScript"
  Reason: mem_yyy is the most complete and recent, the others are subsets.
```

If no duplicates are found, inform the user that the knowledge base is clean.

### Step 4: Resolve with User Confirmation

After presenting all duplicate groups, propose a batch cleanup:

```
Found N duplicate groups with M redundant memories. Recommended actions:
  1. Delete mem_xxx (subset of mem_yyy)
  2. Delete mem_zzz (subset of mem_yyy)
  3. Delete mem_aaa (paraphrase of mem_bbb)
  ...

Proceed with these deletions? (or specify which to skip)
```

For each confirmed deletion, run:

```bash
memo forget <memory-id>
```

Report the results after all deletions are complete.

## Important Notes

- **Never delete without confirmation.** Always show the user what will be removed and what will be kept.
- **Prefer keeping the most complete memory.** When choosing between duplicates, the one with the most useful information wins, even if it's older.
- **Respect scope.** Only analyze memories from the current project (don't use `--global` unless the user explicitly asks).
- **Be conservative.** If two memories are similar but provide genuinely complementary information, keep both.
