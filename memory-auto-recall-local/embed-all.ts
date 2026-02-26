// embed-all.ts — run with: npx tsx embed-all.ts
/**
 * embed-all.ts
 *
 * Batch embedding script for memory-auto-recall-local.
 * Scans all workspace agent memory directories and creates .vec sidecar files
 * for any .md files that don't yet have one (or where .md is newer than .vec).
 *
 * Usage:
 *   npx tsx embed-all.ts
 *
 * Run from the extensions/memory-auto-recall-local/ directory (or anywhere,
 * it always reads config from ~/.openclaw.discord/openclaw.json).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENCLAW_CONFIG_PATH = path.join(
  os.homedir(),
  ".openclaw.discord",
  "openclaw.json",
);

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_PROVIDER = "letsur";
const MAX_BATCH_SIZE = 20;       // texts per API call
const RATE_LIMIT_DELAY_MS = 200; // delay between API calls
const MAX_BLOCK_CHARS = 6000;    // sub-split blocks exceeding this (~2K tokens safety margin under 8191)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VecBlock {
  text: string;       // first 200 chars for display
  embedding: number[]; // 1536 floats
  fullText: string;   // complete block text
}

interface VecFile {
  model: string;
  blocks: VecBlock[];
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadOpenClawConfig(): Record<string, unknown> {
  const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function resolveEmbeddingConfig(
  ocConfig: Record<string, unknown>,
  providerName: string,
): { baseUrl: string; apiKey: string } {
  const models = ocConfig.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  const provider = providers?.[providerName] as Record<string, unknown> | undefined;

  if (!provider) {
    throw new Error(`Provider '${providerName}' not found in openclaw.json models.providers`);
  }

  const baseUrl = provider.baseUrl;
  const apiKey = provider.apiKey;

  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new Error(`Provider '${providerName}' missing baseUrl`);
  }
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error(`Provider '${providerName}' missing apiKey`);
  }

  return { baseUrl, apiKey };
}

// ---------------------------------------------------------------------------
// Block splitting — no file size limit; sub-splits oversized blocks
// ---------------------------------------------------------------------------

function subSplitBlock(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph boundary (double newline)
    let splitIdx = remaining.lastIndexOf("\n\n", maxChars);
    if (splitIdx < maxChars * 0.3) {
      // No good paragraph break — try single newline
      splitIdx = remaining.lastIndexOf("\n", maxChars);
    }
    if (splitIdx < maxChars * 0.3) {
      // No good line break — hard cut at maxChars
      splitIdx = maxChars;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  return chunks.filter(c => c.length > 20);
}

function splitIntoBlocks(filePath: string): Array<{ text: string }> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const rawBlocks = raw.split(/\n(?=---\n|## )/).filter(b => b.trim().length > 20);

  // Sub-split any block that exceeds the API token limit
  const result: Array<{ text: string }> = [];
  for (const block of rawBlocks) {
    const trimmed = block.trim();
    const subBlocks = subSplitBlock(trimmed, MAX_BLOCK_CHARS);
    for (const sb of subBlocks) {
      result.push({ text: sb });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Embedding API
// ---------------------------------------------------------------------------

async function embedBatch(
  texts: string[],
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<number[][] | null> {
  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`  API error ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const json = await response.json() as EmbeddingResponse;

    // Sort by index to match input order
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map(d => d.embedding);
  } catch (err) {
    console.error(`  Fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function findMdFiles(workspacesDir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(workspacesDir)) return results;

  const entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("workspace-")) continue;

    const memoryBase = path.join(workspacesDir, entry.name, "memory");
    if (!fs.existsSync(memoryBase)) continue;

    // Scan dm/ and dc_*/ subdirectories
    const scopeDirs = fs.readdirSync(memoryBase, { withFileTypes: true })
      .filter(d => d.isDirectory() && (d.name === "dm" || d.name.startsWith("dc_")))
      .map(d => path.join(memoryBase, d.name));

    for (const scopeDir of scopeDirs) {
      const files = fs.readdirSync(scopeDir)
        .filter(f => f.endsWith(".md") && !f.startsWith("."))
        .map(f => path.join(scopeDir, f));
      results.push(...files);
    }
  }

  return results;
}

function needsEmbedding(mdPath: string): boolean {
  const vecPath = mdPath.replace(/\.md$/, ".vec");
  if (!fs.existsSync(vecPath)) return true;

  const mdStat = fs.statSync(mdPath);
  const vecStat = fs.statSync(vecPath);

  // Re-embed if .md is newer than .vec
  return mdStat.mtimeMs > vecStat.mtimeMs;
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== memory-auto-recall-local: embed-all ===\n");

  // Load config
  let ocConfig: Record<string, unknown>;
  try {
    ocConfig = loadOpenClawConfig();
  } catch (err) {
    console.error(`Failed to load openclaw.json from ${OPENCLAW_CONFIG_PATH}:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let embeddingConfig: { baseUrl: string; apiKey: string };
  try {
    embeddingConfig = resolveEmbeddingConfig(ocConfig, EMBEDDING_PROVIDER);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Provider : ${EMBEDDING_PROVIDER} (${embeddingConfig.baseUrl})`);
  console.log(`Model    : ${EMBEDDING_MODEL}`);
  console.log(`Batch    : up to ${MAX_BATCH_SIZE} texts/call, ${RATE_LIMIT_DELAY_MS}ms delay\n`);

  // Discover workspace root (same dir as openclaw.json lives in)
  const workspacesRoot = path.dirname(OPENCLAW_CONFIG_PATH);

  const allMdFiles = findMdFiles(workspacesRoot);
  const toEmbed = allMdFiles.filter(needsEmbedding);

  console.log(`Found ${allMdFiles.length} .md files, ${toEmbed.length} need embedding\n`);

  if (toEmbed.length === 0) {
    console.log("All files already embedded. Done.");
    return;
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const mdPath of toEmbed) {
    processed++;
    const relPath = path.relative(workspacesRoot, mdPath);

    // Read blocks
    let blocks: Array<{ text: string }>;
    try {
      blocks = splitIntoBlocks(mdPath);
    } catch (err) {
      console.error(`[${processed}/${toEmbed.length}] SKIP (read error) ${relPath}`);
      skipped++;
      continue;
    }

    if (blocks.length === 0) {
      console.log(`[${processed}/${toEmbed.length}] SKIP (no blocks / too large) ${relPath}`);
      skipped++;
      continue;
    }

    console.log(`[${processed}/${toEmbed.length}] Embedding ${relPath} (${blocks.length} blocks)`);

    // Embed in batches of MAX_BATCH_SIZE
    const allEmbeddings: number[][] = [];
    const texts = blocks.map(b => b.text);
    let batchFailed = false;

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + MAX_BATCH_SIZE);

      if (i > 0) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }

      const embeddings = await embedBatch(
        batchTexts,
        embeddingConfig.baseUrl,
        embeddingConfig.apiKey,
        EMBEDDING_MODEL,
      );

      if (!embeddings) {
        console.error(`  Failed to embed batch ${i / MAX_BATCH_SIZE + 1}`);
        batchFailed = true;
        break;
      }

      allEmbeddings.push(...embeddings);
    }

    if (batchFailed || allEmbeddings.length !== blocks.length) {
      console.error(`  Skipping ${relPath} due to embedding failure`);
      failed++;
      continue;
    }

    // Build .vec file
    const vecData: VecFile = {
      model: EMBEDDING_MODEL,
      blocks: blocks.map((block, idx) => ({
        text: block.text.slice(0, 200),
        embedding: allEmbeddings[idx],
        fullText: block.text,
      })),
    };

    // Write .vec sidecar
    const vecPath = mdPath.replace(/\.md$/, ".vec");
    try {
      fs.writeFileSync(vecPath, JSON.stringify(vecData), "utf-8");
    } catch (err) {
      console.error(`  Failed to write ${vecPath}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      continue;
    }

    // Respect rate limit between files too
    if (processed < toEmbed.length) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Embedded : ${processed - failed - skipped}`);
  console.log(`Skipped  : ${skipped}`);
  console.log(`Failed   : ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
