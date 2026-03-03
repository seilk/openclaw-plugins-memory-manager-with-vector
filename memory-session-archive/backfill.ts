#!/usr/bin/env npx tsx
/**
 * backfill.ts — Convert legacy memory .md files to <block>-tagged format.
 *
 * Usage:
 *   npx tsx backfill.ts                     # run with defaults (concurrency=4)
 *   npx tsx backfill.ts --dry-run           # preview what would be processed
 *   npx tsx backfill.ts --concurrency 2     # slower but gentler
 *   npx tsx backfill.ts --agent capybara    # single agent only
 *   npx tsx backfill.ts --verify            # check conversion status
 *   npx tsx backfill.ts --cleanup           # delete .bak files after verified
 *
 * Run from: extensions/memory-session-archive/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
    agent: { type: "string" },
    model: { type: "string" },
  },
  strict: false,
});

const DRY_RUN = flags["dry-run"] === true;
const VERIFY_ONLY = flags.verify === true;
const CLEANUP = flags.cleanup === true;
const CONCURRENCY = Math.max(1, parseInt(flags.concurrency ?? "4", 10));
const AGENT_FILTER = flags.agent as string | undefined;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), ".openclaw.discord");
const CONFIG_PATH = path.join(STATE_DIR, "extensions", "memory-session-archive", "config.json");

interface BackfillConfig {
  agent: string;
  model: string;
  dir: string;
}

function loadConfig(): BackfillConfig {
  const defaults: BackfillConfig = {
    agent: "memory-writer-backfill",
    model: "letsur/gemini-3-flash-preview",
    dir: path.join(STATE_DIR, ".memory-writer"),
  };

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const dw = raw?.documentWriter ?? {};
    return {
      agent: "memory-writer-backfill",
      model: typeof dw.model === "string" ? dw.model : defaults.model,
      dir: typeof dw.dir === "string"
        ? dw.dir.startsWith("~") ? path.join(os.homedir(), dw.dir.slice(1)) : dw.dir
        : defaults.dir,
    };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discoverFiles(): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(STATE_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("workspace-")) continue;

    if (AGENT_FILTER) {
      const agentName = entry.name.replace("workspace-", "");
      if (agentName !== AGENT_FILTER) continue;
    }

    const memoryBase = path.join(STATE_DIR, entry.name, "memory");
    if (!fs.existsSync(memoryBase)) continue;

    const scopeDirs = fs.readdirSync(memoryBase, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === "dm" || d.name.startsWith("dc_") || d.name === "daily"))
      .map((d) => path.join(memoryBase, d.name));

    for (const scopeDir of scopeDirs) {
      try {
        const files = fs.readdirSync(scopeDir)
          .filter((f) => f.endsWith(".md") && !f.startsWith("."))
          .map((f) => path.join(scopeDir, f));
        results.push(...files);
      } catch {}
    }

    // Also check nested daily/ dirs inside dc_* dirs
    for (const scopeDir of scopeDirs) {
      if (scopeDir.endsWith("/daily")) continue;
      const dailyDir = path.join(scopeDir, "daily");
      if (!fs.existsSync(dailyDir)) continue;
      try {
        const files = fs.readdirSync(dailyDir)
          .filter((f) => f.endsWith(".md") && !f.startsWith("."))
          .map((f) => path.join(dailyDir, f));
        results.push(...files);
      } catch {}
    }
  }

  return results.sort();
}

function isConverted(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return /<block\s/.test(content);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function runMemoryWriter(
  inputPath: string,
  outputPath: string,
  cfg: BackfillConfig,
): Promise<{ ok: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `backfill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    fs.copyFileSync(inputPath, tmpFile);

    const args = [
      "run",
      `Write the output to: ${outputPath}`,
      "--file", tmpFile,
      "--agent", cfg.agent,
      "--model", flags.model ?? cfg.model,
      "--dir", cfg.dir,
    ];

    try {
      const child = spawn("opencode", args, {
        stdio: "ignore",
      });

      const cleanup = () => {
        try { fs.unlinkSync(tmpFile); } catch {}
      };

      child.on("close", (code) => {
        cleanup();
        const fileExists = fs.existsSync(outputPath) && isConverted(outputPath);
        resolve({ ok: code === 0 && fileExists, code });
      });

      child.on("error", (err) => {
        cleanup();
        resolve({ ok: false, code: null });
      });
    } catch {
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve({ ok: false, code: null });
    }
  });
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = items.map((item, i) => ({ item, index: i }));
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      await fn(entry.item, entry.index);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdVerify(files: string[]): void {
  let converted = 0;
  let pending = 0;
  let hasBak = 0;
  const pendingFiles: string[] = [];

  for (const f of files) {
    if (isConverted(f)) {
      converted++;
    } else {
      pending++;
      pendingFiles.push(f);
    }
    if (fs.existsSync(f + ".bak")) hasBak++;
  }

  console.log(`\n=== Backfill Verification ===`);
  console.log(`Total files  : ${files.length}`);
  console.log(`Converted    : ${converted}`);
  console.log(`Pending      : ${pending}`);
  console.log(`Backup files : ${hasBak}`);

  if (pending > 0 && pending <= 20) {
    console.log(`\nPending files:`);
    for (const f of pendingFiles) {
      console.log(`  ${path.relative(STATE_DIR, f)}`);
    }
  }

  if (pending === 0 && hasBak > 0) {
    console.log(`\nAll files converted. Run --cleanup to remove ${hasBak} .bak files.`);
  } else if (pending === 0) {
    console.log(`\nAll files converted. No cleanup needed.`);
  }
}

function cmdCleanup(files: string[]): void {
  let pending = 0;
  for (const f of files) {
    if (!isConverted(f)) pending++;
  }

  if (pending > 0) {
    console.error(`\nCannot cleanup: ${pending} files not yet converted. Run backfill first.`);
    process.exit(1);
  }

  let cleaned = 0;
  for (const f of files) {
    const bakPath = f + ".bak";
    if (fs.existsSync(bakPath)) {
      fs.unlinkSync(bakPath);
      cleaned++;
    }
  }

  console.log(`\n=== Cleanup Complete ===`);
  console.log(`Deleted ${cleaned} .bak files.`);
}

async function cmdBackfill(files: string[], cfg: BackfillConfig): Promise<void> {
  const toProcess = files.filter((f) => !isConverted(f));

  console.log(`\n=== Memory Backfill ===`);
  console.log(`Agent        : ${cfg.agent}`);
  console.log(`Model        : ${flags.model ?? cfg.model}`);
  console.log(`Dir          : ${cfg.dir}`);
  console.log(`Concurrency  : ${CONCURRENCY}`);
  console.log(`Total files  : ${files.length}`);
  console.log(`Already done : ${files.length - toProcess.length}`);
  console.log(`To process   : ${toProcess.length}`);
  if (DRY_RUN) console.log(`Mode         : DRY RUN`);
  console.log();

  if (toProcess.length === 0) {
    console.log("Nothing to do. All files already converted.");
    return;
  }

  if (DRY_RUN) {
    for (const f of toProcess.slice(0, 20)) {
      console.log(`  would process: ${path.relative(STATE_DIR, f)}`);
    }
    if (toProcess.length > 20) {
      console.log(`  ... and ${toProcess.length - 20} more`);
    }
    return;
  }

  let success = 0;
  let failed = 0;
  let restored = 0;
  const failedFiles: string[] = [];
  const startTime = Date.now();

  await withConcurrency(toProcess, CONCURRENCY, async (filePath, index) => {
    const rel = path.relative(STATE_DIR, filePath);
    const bakPath = filePath + ".bak";

    // Backup original (skip if .bak already exists from previous run)
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(filePath, bakPath);
    }

    const result = await runMemoryWriter(bakPath, filePath, cfg);

    if (result.ok) {
      success++;
      console.log(`[${success + failed}/${toProcess.length}] OK    ${rel}`);
    } else {
      // Restore from backup
      try {
        fs.copyFileSync(bakPath, filePath);
        restored++;
      } catch {}
      failed++;
      failedFiles.push(rel);
      console.log(`[${success + failed}/${toProcess.length}] FAIL  ${rel} (code=${result.code})`);
    }
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n=== Backfill Complete (${elapsed}s) ===`);
  console.log(`Success  : ${success}`);
  console.log(`Failed   : ${failed} (${restored} restored from backup)`);

  if (failedFiles.length > 0 && failedFiles.length <= 30) {
    console.log(`\nFailed files:`);
    for (const f of failedFiles) {
      console.log(`  ${f}`);
    }
  }

  if (failed > 0) {
    console.log(`\nRe-run to retry failed files. Already-converted files will be skipped.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const files = discoverFiles();

  if (files.length === 0) {
    console.log("No memory .md files found.");
    return;
  }

  if (VERIFY_ONLY) {
    cmdVerify(files);
    return;
  }

  if (CLEANUP) {
    cmdCleanup(files);
    return;
  }

  const cfg = loadConfig();
  await cmdBackfill(files, cfg);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
