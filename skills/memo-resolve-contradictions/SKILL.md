---
name: memo-resolve-contradictions
description: Detect and resolve contradictory memories in the current project's memo database. Run periodically to keep the knowledge base consistent.
---

# Memo Resolve Contradictions

Detect and resolve contradictory memories stored in the current project's memo database.

## When to Use

Run this skill periodically (e.g., at session start or after intensive work) to keep the knowledge base consistent. Contradictions naturally arise when decisions change, approaches evolve, or earlier assumptions are corrected.

## Workflow

### Step 1: Collect All Memories

Run the following command to get every memory for the current project:

```bash
memo list --all
```

If there are no memories, stop and inform the user.

### Step 2: Group by Topic

Read through all the memories and mentally group them by subject/topic. Look for memories that discuss the **same subject** — these are the candidates for contradiction.

You do NOT need to compare every pair. Focus on memories that share:
- The same technical concept (e.g., both mention "authentication", "caching", "database schema")
- The same configuration or setting
- The same architectural decision
- The same behavioral description

### Step 3: Identify Contradictions

For each group of related memories, determine if any pair makes **opposing or incompatible claims** about the same thing. A contradiction exists when:

- One memory asserts X, another asserts NOT X (e.g., "We use JWT tokens" vs "We use session cookies")
- One memory states a value, another states a different value for the same thing (e.g., "Token expiry is 24h" vs "Token expiry is 1h")
- One memory describes a decision, another describes the opposite decision (e.g., "We chose PostgreSQL" vs "We chose MongoDB")
- One memory says something is enabled/required, another says it's disabled/optional

**NOT contradictions** (do not flag these):
- Memories about different contexts or scopes (e.g., "staging uses X" vs "production uses Y")
- A memory that adds detail to another without conflicting
- Memories that describe changes over time when both acknowledge the change
- General vs specific statements that are compatible

### Step 4: Report Findings

Present contradictions as a numbered list. For each contradiction, show:

1. **The two conflicting memories** — include their IDs, dates, and full content
2. **Why they contradict** — a brief explanation of the conflict
3. **Recommendation** — which memory is likely more current/accurate, based on:
   - Date (newer is usually more relevant)
   - Specificity (more specific is usually more accurate)
   - Context clues in the content

Format example:

```
Contradiction 1:
  Memory A: (mem_xxx) 2025-01-15
    "Authentication uses JWT with 24h token expiry"
  Memory B: (mem_yyy) 2025-02-10
    "Auth tokens are set to 1h expiry for security"
  Conflict: Both describe token expiry but state different values.
  Recommendation: Keep Memory B (newer, explicitly mentions security rationale).
```

If no contradictions are found, inform the user that the knowledge base is consistent.

### Step 5: Resolve with User Confirmation

After presenting all contradictions, ask the user for confirmation before making changes. Propose a batch action:

```
Found N contradictions. Recommended actions:
  1. Delete mem_xxx (superseded by mem_yyy)
  2. Delete mem_aaa (superseded by mem_bbb)
  ...

Proceed with these deletions? (or specify which to skip)
```

For each confirmed deletion, run:

```bash
memo forget <memory-id>
```

Report the results after all deletions are complete.

## Important Notes

- **Never delete without confirmation.** Always show the user what will be removed.
- **When in doubt, keep both.** If the contradiction is ambiguous or context-dependent, flag it for the user but do not recommend deletion.
- **Respect scope.** Only analyze memories from the current project (don't use `--global` unless the user explicitly asks).
- **Be conservative.** It's better to miss a subtle contradiction than to incorrectly flag compatible memories as contradictory.
