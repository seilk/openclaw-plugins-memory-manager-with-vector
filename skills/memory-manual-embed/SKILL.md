---
name: memory-manual-embed
description: Save important information into long-lived searchable memory using the /remem command. Use when the user explicitly asks to remember, save to memory, keep this for later, or preserve important content/details with high fidelity. Triggers may include English and Korean phrases like "remember this", "take memory on", "don't forget", "까먹지마", "기억해놔", "메모리에 저장해", and requests to preserve a document, summary, note, or prior material in memory. Prefer preserving the original content in detail rather than aggressively summarizing.
---

# memory-manual-embed

When the user explicitly asks to remember/save something, do this:

1. Determine the target content from the current conversation and referenced files.
2. Preserve the content with high fidelity. Do not over-compress important details.
3. Create a short, specific title.
4. Call `/remem` with either JSON or frontmatter-like args containing only:
   - `title`
   - `content`
5. After saving, briefly confirm what was saved.

## Rules

- Prefer original wording and structure when possible.
- Remove obvious junk only (tool noise, irrelevant boilerplate, accidental duplication).
- Do not save to deprecated files like `MEMORY.md` or `NOTE.md`.
- Use `/remem` instead of manually writing into `memory/` so storage + embedding stay standardized.
- If the target is ambiguous, ask a short clarification question.

## `/remem` payload examples

JSON:
```text
/remem {"title":"OpenClaw cron memory save design","content":"<full content here>"}
```

Frontmatter-like:
```text
/remem title: OpenClaw cron memory save design
content: <full content here>
```
