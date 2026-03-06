# openclaw-plugins-memory-manager-with-vector

Vector search-based memory system for [OpenClaw](https://openclaw.ai) agents. Includes automatic session archiving + recall, plus a manual `/remem` memory saver and companion skill for high-fidelity user-directed memory capture.

## Architecture

```
Memory Pipeline v2

WRITE PATH (session end):
  /new or /reset
    -> pre-extract clean transcript -> /tmp/memory-writer-*.transcript.tmp
    -> spawn: opencode run --file *.tmp --agent memory-writer
    -> memory-writer clusters by theme, writes <block title="...">content</block> .md
    -> on close: cleanup tmp -> generateVecSidecar() -> .vec sidecar

MANUAL WRITE PATH:
  user says "remember this" / agent uses memory-manual-embed skill
    -> skill formats title + content
    -> /remem plugin command saves markdown memory file
    -> /remem generates matching .vec sidecar immediately

READ PATH (every message):
  before_prompt_build hook
    -> embedQuery(user_message) -> 1536-dim vector
    -> cosine similarity search against .vec files -> top-K results
    -> fallback: keyword + recency scoring if no .vec or API failure
    -> inject <relevant-memories> into system prompt
```

### memory-context-injector (Read Path)

Automatically injects relevant memory snippets into agent context before each prompt build.

- **Primary**: Cosine similarity search against pre-computed `.vec` sidecar files (1536-dim embeddings via `text-embedding-3-small`)
- **Fallback**: Keyword + bigram + recency scoring when `.vec` files are absent or embedding API fails
- **Cache**: mtime-based `vecCache` prevents repeated disk I/O
- **Hook**: `before_prompt_build` — injects top-K results via `prependContext`
- **Block parsing**: Supports `<block title="...">` format with title preservation for better semantic matching

| Config Key | Default | Description |
|---|---|---|
| `maxResults` | 3 | Number of top results to inject |
| `minEmbeddingScore` | 0.3 | Minimum cosine similarity threshold |
| `maxTotalChars` | 2500 | Max total characters injected |
| `maxCharsPerSnippet` | 600 | Max characters per snippet |
| `minPromptLength` | 10 | Skip search for short prompts |
| `embeddingModel` | `text-embedding-3-small` | Embedding model name |
| `embeddingProvider` | `openai` | Provider key from `openclaw.json` |

Also includes `embed-all.ts` — a batch script to generate `.vec` sidecar files for all existing `.md` memory files. Supports `--limit N` for small-scale testing.

### memory-session-archive (Write Path)

On `/new` or `/reset`, pre-extracts a clean transcript and spawns an AI agent (`memory-writer`) that clusters conversation by theme into `<block>`-tagged markdown files.

- **Pre-extraction**: Converts raw JSONL session data to clean `[role]\ntext` plain text (5-10x token reduction)
- **AI clustering**: `memory-writer` agent groups related messages into thematic blocks with descriptive titles
- **Fire-and-forget**: Spawns `opencode run` as a child process, cleans up temp files on completion
- **Configurable**: Agent name, model, and working directory via `config.json`
- **Scope-aware paths**: `workspace-{agent}/memory/dm/` for DMs, `workspace-{agent}/memory/dc_{channelId}/` for channels

Also includes `backfill.ts` — a CLI tool to convert legacy memory files to `<block>` format:

```bash
npx tsx backfill.ts --dry-run       # Preview what would be converted
npx tsx backfill.ts                 # Run backfill (concurrency 4)
npx tsx backfill.ts --verify        # Check all files have <block> tags
npx tsx backfill.ts --cleanup       # Delete .bak backup files
```

### remem (Manual Write Path)

Registers a `/remem` command that saves a user-directed memory as a markdown file and generates a `.vec` sidecar immediately.

- **Input**: JSON or frontmatter-like payload with only `title` and `content`
- **Scope-aware storage**: writes to `memory/dm/` for DMs, `memory/dc_{channelId}/` for channels/threads
- **Embeddings**: uses the configured embedding provider/model at save time
- **Intended pair**: works with the `skills/memory-manual-embed` skill so the agent can recognize natural-language memory-save requests and call `/remem`

### Agent Prompts

- `agents/memory-writer.md` — Prompt for the hook pipeline (Write tool only, no Read)
- `agents/memory-writer-backfill.md` — Prompt for backfilling old markdown formats

## Skill

- `skills/memory-manual-embed/SKILL.md` — AgentSkill that tells the agent when and how to save user-requested memories via `/remem`

## .vec Sidecar Format

Each `.md` file can have a companion `.vec` file:

```json
{
  "model": "text-embedding-3-small",
  "blocks": [
    {
      "fullText": "complete block content with title prefix",
      "embedding": [1536 floats]
    }
  ]
}
```

Block titles are preserved in `fullText` (prepended as `Title: body`) for better semantic embedding quality.

## Installation

1. Copy plugin directories into your OpenClaw `extensions/` folder:

```bash
cp -r memory-context-injector  ~/.openclaw/extensions/
cp -r memory-session-archive   ~/.openclaw/extensions/
cp -r remem                    ~/.openclaw/extensions/
```

2. Copy the manual-memory skill into your skills directory:

```bash
mkdir -p ~/.openclaw/skills/memory-manual-embed
cp skills/memory-manual-embed/SKILL.md ~/.openclaw/skills/memory-manual-embed/
```

3. Copy agent prompts:

```bash
cp agents/memory-writer.md agents/memory-writer-backfill.md ~/.opencode/agents/
```

4. Add plugins to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["memory-context-injector", "memory-session-archive", "remem"]
  }
}
```

5. Configure an embedding provider in `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "YOUR_EMBEDDING_PROVIDER": {
        "apiKey": "YOUR_API_KEY",
        "baseUrl": "https://your-embedding-api.com/v1"
      }
    }
  }
}
```

6. Configure the memory-writer in `memory-session-archive/config.json`:

```json
{
  "documentWriter": {
    "enabled": true,
    "agent": "memory-writer",
    "model": "your-preferred-model",
    "dir": "~/.openclaw/.memory-writer"
  }
}
```

7. Create a clean workspace directory for the memory-writer (avoids AGENTS.md injection):

```bash
mkdir -p ~/.openclaw/.memory-writer/.opencode/agents
ln -s ~/.opencode/agents/memory-writer.md ~/.openclaw/.memory-writer/.opencode/agents/
```

8. (Optional) Batch-embed existing memory files:

```bash
cd memory-context-injector
npx tsx embed-all.ts              # Full run
npx tsx embed-all.ts --limit 10   # Test with 10 files first
```

## Requirements

- OpenClaw with plugin support
- [OpenCode CLI](https://opencode.ai) (for memory-writer agent spawning)
- An OpenAI-compatible embedding API (`text-embedding-3-small` recommended)
- Node.js 18+

## License

MIT
