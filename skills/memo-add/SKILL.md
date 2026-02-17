---
name: memo-add
description: Save a new memory to the current project's memo database. Use when the user asks to remember, note, or store something for later.
---

# Memo Add

Save a new memory to the current project's memo database.

## Workflow

### Step 1: Determine What to Store

Extract the key information the user wants to remember. A good memory is:

- **Self-contained** — understandable without extra context
- **Specific** — avoids vague statements; includes concrete details
- **Concise** — one clear fact or decision per memory; not a paragraph

If the user's request is vague, ask for clarification before storing.

**Good memories:**
- "Authentication uses JWT with RS256, tokens expire after 1h"
- "All API responses follow the JSON:API spec"
- "User prefers tabs over spaces, 4-wide"

**Bad memories (too vague or too long):**
- "We talked about auth stuff"
- A multi-paragraph dump of an entire conversation

If the user provides a large block of information, break it into multiple focused memories rather than storing one giant blob.

### Step 2: Check for Duplicates

Before adding, run a quick search to see if this information already exists:

```bash
memo search "<key terms from the memory>"
```

If a very similar memory already exists:
- Tell the user it's already stored and show the existing memory
- Ask if they want to update it (forget the old one and add the new one) or skip

### Step 3: Add the Memory

Store the memory using:

```bash
memo add "<memory text>"
```

If the user specified tags, include them:

```bash
memo add "<memory text>" --tags tag1,tag2
```

### Step 4: Confirm

After adding, confirm to the user what was stored. If multiple memories were added, list them all.

## Scope

- By default, memories are scoped to the **current project**.
- Only use `--global` if the user explicitly asks for a global/cross-project memory.

## Important Notes

- **Keep memories atomic.** One fact per memory. If the user wants to store several things, create several memories.
- **Prefer the user's own words** when they're clear and specific. Don't over-paraphrase.
- **Check for duplicates** before adding to avoid bloating the database.
- **Ask before adding proactively.** If you think something is worth remembering but the user didn't ask, suggest it rather than silently storing it.
