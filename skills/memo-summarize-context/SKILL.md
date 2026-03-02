---
name: memo-summarize-context
description: Manually convert files already loaded in this session context into domain-grouped memories and create or update them in the current project's memo database.
---

# Memo Summarize Context

Create or update domain-level memories from files that are already loaded in the current session context.

## When to Use

Run this skill only when the user explicitly asks for it. Do not run it automatically or proactively.

After explicit request, use it when several files have already been read in the session and you want to persist a clean domain map for future agent runs.

## Workflow

### Step 1: Build the Session File Inventory

Collect all files that are already present in the current conversation context (tool outputs, snippets, or previously loaded content). For each file, extract:

- File path
- Key symbols (class, module, function, type)
- Short responsibility summary
- High-signal methods or APIs

Do **not** scan additional files unless the user explicitly asks. If no files are available in context, stop and ask the user to load files first.

### Step 2: Group by Domain

Group extracted symbols by **feature/business domain**, not by technical layer.

Good domain groupings:
- Authentication
- Billing
- Notifications
- User Profile
- Search

Avoid low-signal buckets like "utils" unless that is truly a cohesive subsystem.

### Step 3: Draft Canonical Domain Memory Blocks

For each domain, draft a memory block in this format:

```markdown
## <Feature> Domain
- `<path>`, `<class|module|symbol>` - <short info>; methods: `<method1>`, `<method2>`
- `<path>`, `<class|module|symbol>` - <short info>; methods: `<method1>`, `<method2>`
```

Formatting rules:
- Keep bullets concise and concrete.
- Include relative file paths.
- Use 1 bullet per major symbol/module.
- Keep method lists short (2-5 items).
- If methods do not apply, use `key APIs: ...`.

### Step 4: Check Existing Memories Per Domain

Before writing each domain memory, search for an existing memory:

```bash
memo search "<Feature> Domain" --limit 5
```

Treat a result as the same domain if it contains a matching heading like `## <Feature> Domain`.

Classify each domain as:
- `new` - no existing domain memory
- `update` - existing memory is stale or incomplete
- `skip` - existing memory is already accurate

### Step 5: Create or Update

For `new` domains, add a memory:

```bash
memo add "$(cat <<'EOF'
## <Feature> Domain
- ...
EOF
)"
```

For `update` domains:
1. Present planned replacements (`old memory id -> domain heading`)
2. Ask for one batch confirmation before deletion
3. On confirmation, replace with:

```bash
memo forget <old-memory-id>
memo add "$(cat <<'EOF'
## <Feature> Domain
- ...
EOF
)"
```

If the user does not approve deletions, add the updated domain memory without deleting old entries and mention possible duplicates.

### Step 6: Report Results

Return a concise report with:

- Files processed from session context
- Domains created, updated, skipped
- Memory IDs added and removed
- Any ambiguous domain boundaries that need user input

## Important Notes

- Manual-only workflow: execute only on explicit user request.
- Base this workflow only on files already loaded in the session context.
- Be conservative: split uncertain cases into separate domains.
- Keep headings stable (`## <Feature> Domain`) to make future updates reliable.
