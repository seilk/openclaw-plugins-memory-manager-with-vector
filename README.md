# openclaw-plugins-memory-manager-with-vector

Vector search-based memory system for [OpenClaw](https://openclaw.ai) agents. Two plugins work together to give agents persistent, semantically searchable long-term memory.

## Architecture

```
Memory System
├── session-memory-hook              (WRITE)
│   └─ /new, /reset → .md session log + .vec sidecar auto-generated
│
└── memory-auto-recall-local         (READ - automatic)
    └─ Every message → embed query → cosine similarity → top-K context injection
```

### memory-auto-recall-local (Read Path)

Automatically injects relevant memory snippets into agent context before each prompt build.

- **Primary**: Cosine similarity search against pre-computed `.vec` sidecar files (1536-dim embeddings via `text-embedding-3-small`)
- **Fallback**: Keyword + recency scoring when `.vec` files are absent or embedding API fails
- **Cache**: mtime-based `vecCache` prevents repeated disk I/O
- **Hook**: `before_prompt_build` — injects top-K results via `prependContext`

| Config Key | Default | Description |
|---|---|---|
| `maxResults` | 3 | Number of top results to inject |
| `minScore` | 0.15 | Minimum cosine similarity threshold |
| `maxTotalChars` | 2500 | Max total characters injected |
| `maxCharsPerSnippet` | 600 | Max characters per snippet |
| `minPromptLength` | 10 | Skip search for short prompts |
| `embeddingModel` | `text-embedding-3-small` | Embedding model name |
| `embeddingProvider` | `letsur` | Provider key from `openclaw.json` |

Also includes `embed-all.ts` — a batch script to generate `.vec` sidecar files for all existing `.md` memory files.

### session-memory-hook (Write Path)

Saves session transcripts as `.md` files on `/new` or `/reset`, then generates `.vec` sidecar files (fire-and-forget) so new memories are immediately searchable.

- **Scope-aware paths**: `workspace-{agent}/memory/dm/` for DMs, `workspace-{agent}/memory/dc_{channelId}/` for channels
- **Block splitting**: `subSplitBlock()` safely splits blocks exceeding 6000 chars (paragraph → line → hard cut)
- **Timestamp**: Session start time in KST

| Config Key | Default | Description |
|---|---|---|
| `maxMessages` | 50 | Max messages to include in session log |
| `minMessages` | 1 | Min messages required to save |

## .vec Sidecar Format

Each `.md` file can have a companion `.vec` file:

```json
{
  "model": "text-embedding-3-small",
  "blocks": [
    {
      "text": "first 200 chars preview...",
      "embedding": [/* 1536 floats */],
      "fullText": "complete block content"
    }
  ]
}
```

## Installation

1. Copy both plugin directories into your OpenClaw `extensions/` folder:

```bash
cp -r memory-auto-recall-local  ~/.openclaw/extensions/
cp -r session-memory-hook       ~/.openclaw/extensions/
```

2. Add them to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["memory-auto-recall-local", "session-memory-hook"]
  }
}
```

3. Configure an embedding provider in `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "letsur": {
        "apiKey": "your-api-key",
        "baseUrl": "https://api.letsur.ai/v1"
      }
    }
  }
}
```

4. (Optional) Batch-embed existing memory files:

```bash
npx tsx memory-auto-recall-local/embed-all.ts
```

## Requirements

- OpenClaw with plugin support
- An OpenAI-compatible embedding API (default: Letsur with `text-embedding-3-small`)
- Node.js 18+

## License

MIT
