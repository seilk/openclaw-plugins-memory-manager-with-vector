import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * session-memory-hook
 *
 * Memory path policy (standardized):
 * - DM session logs:      workspace-{agent}/memory/dm/YYYY-MM-DD-HHMMSS.md
 * - Discord channel logs: workspace-{agent}/memory/dc_{channelId}/YYYY-MM-DD-HHMMSS.md
 * - Session log filename timestamp uses the session start time (KST)
 * - Session log filename timestamp uses the session start time (KST)
 *
 * Command behavior:
 * - /new:    write session log only
 * - /reset:  write session log only
 */

interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
  context: {
    sessionEntry?: SessionEntry;
    previousSessionEntry?: SessionEntry;
    commandSource?: string;
    senderId?: string | number;
    cfg?: any;
  };
  timestamp: Date;
  messages: string[];
}

interface SessionEntry {
  sessionId?: string;
  sessionFile?: string;
  transcriptPath?: string;
  groupId?: string | number;
  chatType?: string;
  channel?: string;
  displayName?: string;
  updatedAt?: number;
  compactionCount?: number;
  [key: string]: any;
}

interface TranscriptLine {
  type: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; thinking?: string }>;
    timestamp?: number;
  };
  timestamp?: string;
  [key: string]: any;
}

interface PluginApi {
  id: string;
  name: string;
  config: any;
  pluginConfig: { enabled?: boolean; maxMessages?: number; minMessages?: number };
  runtime: {
    config: { loadConfig: () => any };
    state: { resolveStateDir: () => string };
  };
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  registerHook: (
    events: string | string[],
    handler: (event: HookEvent) => Promise<void>,
    opts?: { name?: string; description?: string; priority?: number }
  ) => void;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatKstDateTime(date: Date): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} KST`;
}

function formatKstFileTimestamp(date: Date): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

function toDateFromUnknownTs(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value);
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}

function resolveWorkspaceDir(cfg: any, agentId: string): string {
  const agents = cfg?.agents?.list;
  if (Array.isArray(agents)) {
    const agent = agents.find((a: any) => a.id === agentId);
    if (agent?.workspace) return agent.workspace;
  }
  return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`);
}

function resolveAgentSessionsDir(cfg: any, agentId: string): string | null {
  const agents = cfg?.agents?.list;
  if (!Array.isArray(agents)) return null;
  const agent = agents.find((a: any) => a.id === agentId);
  const agentDir = agent?.agentDir;
  if (!agentDir) return null;
  return path.join(path.dirname(agentDir), "sessions");
}

function parseAgentId(sessionKey: string): string | null {
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match ? match[1] : null;
}

function parseTelegramGroupIdFromSessionKey(_sessionKey: string): string | null {
  return null; // telegram not used in this deployment
}

function parseDiscordChannelIdFromSessionKey(sessionKey: string): string | null {
  // Example: agent:capybara:discord:channel:1473926074835665081
  const m = sessionKey.match(/:discord:channel:(\d+)$/);
  return m ? m[1] : null;
}

function parseGroupIdFromSessionKey(sessionKey: string): string | null {
  return (
    parseDiscordChannelIdFromSessionKey(sessionKey) ??
    parseTelegramGroupIdFromSessionKey(sessionKey)
  );
}

function parseChannelFromSessionKey(sessionKey: string): string | undefined {
  if (sessionKey.includes(":discord:channel:")) {
    return "discord";
  }
  // telegram not used in this deployment
  return undefined;
}

type IndexedSessionRecord = {
  key: string;
  entry: SessionEntry;
};

function buildSessionEntryFromIndexRecord(raw: any, sessionsDir: string): SessionEntry | null {
  if (!raw || typeof raw !== "object") return null;

  const sessionFile = raw.sessionFile
    ? String(raw.sessionFile)
    : raw.transcriptPath
      ? path.join(sessionsDir, String(raw.transcriptPath))
      : undefined;

  return {
    ...raw,
    sessionFile,
    sessionId: raw.sessionId,
    groupId: raw.groupId
  } as SessionEntry;
}

function listIndexedSessionRecords(parsed: any, sessionsDir: string): IndexedSessionRecord[] {
  const out: IndexedSessionRecord[] = [];

  const push = (key: unknown, raw: any) => {
    if (typeof key !== "string" || !key) return;
    const entry = buildSessionEntryFromIndexRecord(raw, sessionsDir);
    if (!entry) return;
    out.push({ key, entry });
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) push(item?.key, item);
    return out;
  }

  if (!parsed || typeof parsed !== "object") return out;

  const sessionsArray = (parsed as any).sessions;
  if (Array.isArray(sessionsArray)) {
    for (const item of sessionsArray) push(item?.key, item);
  }

  for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
    if (key === "sessions" || key === "meta") continue;
    if (!key.startsWith("agent:")) continue;
    push(key, value);
  }

  return out;
}

function parseResetSuffixToEpochMs(suffix: string): number | null {
  // Example suffix: 2026-02-14T07-12-34.270Z
  const m = suffix.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)$/);
  if (!m) {
    const t = Date.parse(suffix);
    return Number.isNaN(t) ? null : t;
  }

  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function resolveResetVariantForSessionEntry(
  cfg: any,
  agentId: string,
  entry?: SessionEntry | null
): SessionEntry | null {
  const baseSessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
  if (!baseSessionId || baseSessionId.includes(".reset.")) return null;

  const sessionsDir = resolveAgentSessionsDir(cfg, agentId);
  if (!sessionsDir) return null;

  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }

  const marker = `${baseSessionId}.jsonl.reset.`;
  const candidates: Array<{ name: string; updatedAt: number }> = [];

  for (const name of files) {
    if (!name.startsWith(marker)) continue;
    const suffix = name.slice(marker.length);
    if (!suffix) continue;

    const fullPath = path.join(sessionsDir, name);
    if (!fs.existsSync(fullPath)) continue;

    let updatedAt = parseResetSuffixToEpochMs(suffix);
    if (updatedAt == null) {
      try {
        updatedAt = fs.statSync(fullPath).mtimeMs;
      } catch {
        updatedAt = Date.now();
      }
    }

    candidates.push({ name, updatedAt });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  const picked = candidates[0];
  const suffix = picked.name.slice(marker.length);

  return {
    ...(entry ?? {}),
    sessionId: `${baseSessionId}.reset.${suffix}`,
    sessionFile: path.join(sessionsDir, picked.name),
    transcriptPath: picked.name,
    updatedAt: picked.updatedAt,
    resetOfSessionId: baseSessionId,
    isResetTranscript: true
  };
}

function findResetTranscriptNear(
  cfg: any,
  agentId: string,
  around: Date,
  opts?: { windowMs?: number; excludeSessionId?: string }
): SessionEntry | null {
  const sessionsDir = resolveAgentSessionsDir(cfg, agentId);
  if (!sessionsDir) return null;

  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }

  const marker = ".jsonl.reset.";
  const windowMs = opts?.windowMs ?? 2 * 60 * 1000;
  const aroundMs = around.getTime();

  let best: { entry: SessionEntry; delta: number } | null = null;

  for (const name of files) {
    const idx = name.indexOf(marker);
    if (idx <= 0) continue;

    const baseSessionId = name.slice(0, idx);
    const suffix = name.slice(idx + marker.length);
    if (!baseSessionId || !suffix) continue;

    if (opts?.excludeSessionId && baseSessionId === opts.excludeSessionId) continue;

    const fullPath = path.join(sessionsDir, name);
    if (!fs.existsSync(fullPath)) continue;

    let updatedAt = parseResetSuffixToEpochMs(suffix);
    if (updatedAt == null) {
      try {
        updatedAt = fs.statSync(fullPath).mtimeMs;
      } catch {
        updatedAt = Date.now();
      }
    }

    const delta = Math.abs(updatedAt - aroundMs);
    if (delta > windowMs) continue;

    const entry: SessionEntry = {
      sessionId: `${baseSessionId}.reset.${suffix}`,
      sessionFile: fullPath,
      transcriptPath: name,
      updatedAt,
      resetOfSessionId: baseSessionId,
      isResetTranscript: true
    };

    if (!best || delta < best.delta) best = { entry, delta };
  }

  return best?.entry ?? null;
}

function listResetSessionRecords(
  sessionsDir: string,
  agentId: string,
  indexed: IndexedSessionRecord[]
): IndexedSessionRecord[] { 
  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const bySessionId = new Map<string, IndexedSessionRecord>();
  for (const rec of indexed) {
    const sid = rec.entry?.sessionId;
    if (typeof sid === "string" && sid && !bySessionId.has(sid)) {
      bySessionId.set(sid, rec);
    }
  }

  const out: IndexedSessionRecord[] = [];
  const marker = ".jsonl.reset.";

  for (const name of files) {
    const idx = name.indexOf(marker);
    if (idx <= 0) continue;

    const baseSessionId = name.slice(0, idx);
    const suffix = name.slice(idx + marker.length);
    if (!baseSessionId || !suffix) continue;

    const fullPath = path.join(sessionsDir, name);
    if (!fs.existsSync(fullPath)) continue;

    const base = bySessionId.get(baseSessionId);

    let updatedAt = parseResetSuffixToEpochMs(suffix);
    if (updatedAt == null) {
      try {
        updatedAt = fs.statSync(fullPath).mtimeMs;
      } catch {
        updatedAt = Date.now();
      }
    }

    const keyBase = base?.key ?? `agent:${agentId}:reset:${baseSessionId}`;
    const key = `${keyBase}:reset:${suffix}`;

    const entry: SessionEntry = {
      ...(base?.entry ?? {}),
      sessionId: `${baseSessionId}.reset.${suffix}`,
      sessionFile: fullPath,
      transcriptPath: name,
      updatedAt,
      resetOfSessionId: baseSessionId,
      isResetTranscript: true
    };

    out.push({ key, entry });
  }

  return out;
}

function listIndexedSessionRecordsWithResetFiles(parsed: any, sessionsDir: string, agentId: string): IndexedSessionRecord[] {
  const indexed = listIndexedSessionRecords(parsed, sessionsDir);
  const resetIndexed = listResetSessionRecords(sessionsDir, agentId, indexed);
  return [...indexed, ...resetIndexed];
}

function isLikelyCronSessionKey(key: string): boolean {
  return key.includes(":cron:");
}

function isLikelySystemSessionKey(key: string): boolean {
  return isLikelyCronSessionKey(key) || key.includes(":heartbeat");
}

function resolveSessionEntryByKey(cfg: any, agentId: string, sessionKey: string): SessionEntry | null {
  const sessionsDir = resolveAgentSessionsDir(cfg, agentId);
  if (!sessionsDir) return null;

  const sessionsIndex = path.join(sessionsDir, "sessions.json");
  if (!fs.existsSync(sessionsIndex)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsIndex, "utf-8"));
    const indexed = listIndexedSessionRecordsWithResetFiles(parsed, sessionsDir, agentId);
    const hit = indexed.find((r) => r.key === sessionKey);
    return hit?.entry ?? null;
  } catch {
    return null;
  }
}

function resolvePreviousSessionFallback(
  cfg: any,
  agentId: string,
  currentSessionId?: string,
  currentSessionKey?: string,
  currentSessionEntry?: SessionEntry,
  senderId?: string | number
): SessionEntry | null {
  const sessionsDir = resolveAgentSessionsDir(cfg, agentId);
  if (!sessionsDir) return null;

  const sessionsIndex = path.join(sessionsDir, "sessions.json");
  if (!fs.existsSync(sessionsIndex)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsIndex, "utf-8"));
    const indexed = listIndexedSessionRecordsWithResetFiles(parsed, sessionsDir, agentId);

    const candidates = indexed
      .filter((r) => r.key.startsWith(`agent:${agentId}:`))
      .filter((r) => r.entry?.sessionId && r.entry.sessionId !== currentSessionId)
      .filter((r) => r.entry?.transcriptPath || r.entry?.sessionFile)
      .sort((a, b) => (Number(b.entry?.updatedAt) || 0) - (Number(a.entry?.updatedAt) || 0));

    if (candidates.length === 0) return null;

    // Best case: find prior entry for the exact same session key (same chat scope)
    if (currentSessionKey) {
      const exact = candidates.find((r) => r.key === currentSessionKey);
      if (exact) return exact.entry;
    }

    // Scope-safe fallback: group sessions can fall back within the same group only.
    if (currentSessionEntry?.groupId != null) {
      const gid = String(currentSessionEntry.groupId);
      const sameGroup = candidates.find((r) => String(r.entry.groupId ?? "") === gid);
      return sameGroup?.entry ?? null;
    }

    // DM/direct fallback: if key lookup misses (common right after /new rotation),
    // recover from nearest direct-session candidates instead of dropping the save.
    if (currentSessionEntry && currentSessionKey) {
      const dmCandidates = candidates.filter((r) => r.entry?.groupId == null);
      if (dmCandidates.length === 0) return null;

      // 1) Prefer same chat-id when metadata exists.
      const currentChatId = resolveChatId(currentSessionEntry, senderId);
      if (currentChatId && currentChatId !== "unknown") {
        const sameChat = dmCandidates.find((r) => {
          if (isLikelySystemSessionKey(r.key)) return false;
          const cid = resolveChatId(r.entry, senderId);
          return cid !== "unknown" && cid === currentChatId;
        });
        if (sameChat) return sameChat.entry;
      }

      // 2) If metadata is missing, prefer the newest reset transcript.
      const resetDm = dmCandidates.find((r) => (r.entry as any).isResetTranscript && !isLikelySystemSessionKey(r.key));
      if (resetDm) return resetDm.entry;

      // 3) Final fallback: newest non-system direct transcript.
      const nonSystemDm = dmCandidates.find((r) => !isLikelySystemSessionKey(r.key));
      return nonSystemDm?.entry ?? null;
    }

    // Legacy fallback (no scope context available): prefer non-system entries.
    const nonSystem = candidates.find((r) => !isLikelySystemSessionKey(r.key));
    return (nonSystem ?? candidates[0])?.entry ?? null;
  } catch {
    return null;
  }
}

function ensureSessionFile(entry: SessionEntry, cfg: any, agentId: string): SessionEntry {
  if (entry.sessionFile) return entry;
  const sessionsDir = resolveAgentSessionsDir(cfg, agentId);
  const transcriptPath = entry.transcriptPath as string | undefined;
  if (sessionsDir && transcriptPath) {
    return { ...entry, sessionFile: path.join(sessionsDir, transcriptPath) };
  }
  return entry;
}

function readTranscript(sessionFile: string): TranscriptLine[] {
  if (!sessionFile || !fs.existsSync(sessionFile)) return [];
  try {
    const raw = fs.readFileSync(sessionFile, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as TranscriptLine[];
  } catch {
    return [];
  }
}

function getSessionStartDate(entry: SessionEntry, transcript: TranscriptLine[]): Date {
  const entryCandidates = [
    (entry as any).createdAt,
    (entry as any).startedAt,
    (entry as any).startAt,
    (entry as any).startTime,
    (entry as any).timestamp
  ];

  for (const c of entryCandidates) {
    const d = toDateFromUnknownTs(c);
    if (d) return d;
  }

  let minTs: number | null = null;
  for (const line of transcript) {
    const msgTs = line?.message?.timestamp;
    if (typeof msgTs === "number" && Number.isFinite(msgTs) && msgTs > 0) {
      minTs = minTs == null ? msgTs : Math.min(minTs, msgTs);
    }

    const lineTs = toDateFromUnknownTs(line?.timestamp)?.getTime();
    if (typeof lineTs === "number" && Number.isFinite(lineTs) && lineTs > 0) {
      minTs = minTs == null ? lineTs : Math.min(minTs, lineTs);
    }
  }

  return minTs != null ? new Date(minTs) : new Date();
}

function stripInjectedMemoryBlocks(text: string): string {
  return text
    .replace(/<observational-memory>[\s\S]*?<\/observational-memory>/gi, " ")
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, " ")
    .replace(/<unobserved-context>[\s\S]*?<\/unobserved-context>/gi, " ")
    .trim();
}

function isLikelySlashCommandText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;

  const firstLine = trimmed.split("\n", 1)[0]?.trim() ?? "";
  const firstToken = firstLine.split(/\s+/, 1)[0] ?? "";
  if (firstToken.length < 2) return false;

  // Paths like /Users/... or /api/v1 should not be treated as slash-commands.
  if (firstToken.slice(1).includes("/")) return false;

  return /^\/[a-z0-9][a-z0-9_-]*$/i.test(firstToken);
}

function extractMessages(
  transcript: TranscriptLine[],
  maxMessages: number
): Array<{ role: string; text: string; timestamp?: number }> {
  const messages: Array<{ role: string; text: string; timestamp?: number }> = [];

  for (const line of transcript) {
    if (line.type !== "message" || !line.message) continue;
    const { role, content, timestamp } = line.message;
    if (role !== "user" && role !== "assistant") continue;

    const texts: string[] = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "thinking") continue;
        if (part.type === "text" && part.text) {
          const t = part.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
          if (t) texts.push(t);
        }
      }
    }

    const mergedText = texts.join("\n").trim();
    if (!mergedText) continue;

    const text = stripInjectedMemoryBlocks(mergedText);
    if (!text) continue;

    if (role === "user" && text.includes("A new session was started via /new or /reset")) continue;
    // Skip actual slash-commands, but keep path-like content (/Users/..., /api/v1, ...).
    if (role === "user" && isLikelySlashCommandText(text)) continue;

    messages.push({ role, text, timestamp });
  }

  if (maxMessages > 0 && messages.length > maxMessages) return messages.slice(-maxMessages);
  return messages;
}

function compactLine(text: string, max = 0): string {
  let oneLine = text.replace(/\s+/g, " ").trim();
  // Strip reply tags (e.g. [[reply_to_current]], [[reply_to: 123]])
  oneLine = oneLine.replace(/\[\[\s*reply_to[^\]]*\]\]/gi, "").trim();
  if (max > 0 && oneLine.length > max) return `${oneLine.slice(0, max)}...`;
  return oneLine;
}

function extractSlug(messages: Array<{ role: string; text: string; timestamp?: number }>): string {
  const corpus = messages
    .filter((m) => m.role === "user")
    .slice(-8)
    .map((m) => compactLine(m.text, 300))
    .join(" ")
    .toLowerCase();

  const tokens = (corpus.match(/[a-z0-9가-힣_\/-]+/g) || [])
    .map((t) => t.replace(/^\/+/, ""))
    .map((t) => t.replace(/[_/]+/g, "-"))
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !/^\d+$/.test(t));

  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "from", "have", "need", "just",
    "은", "는", "이", "가", "을", "를", "에", "의", "좀", "그냥", "지금", "그리고"
  ]);

  const freq = new Map<string, number>();
  for (const t of tokens) {
    if (stop.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  const keywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([k]) => k)
    .slice(0, 4);

  return (keywords.join("-") || "session")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendToFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    const isLongTerm = filePath.endsWith("MEMORY.md");
    const header = isLongTerm ? "# Long-Term Memory\n\n" : "# Session Log\n\n";
    fs.writeFileSync(filePath, header + content, "utf-8");
  } else {
    fs.appendFileSync(filePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Write-time .vec sidecar generation (fire-and-forget)
// ---------------------------------------------------------------------------

const VEC_MAX_BLOCK_CHARS = 6000;

interface VecBlock {
  text: string;
  embedding: number[];
  fullText: string;
}

interface VecFile {
  model: string;
  blocks: VecBlock[];
}

function subSplitBlock(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n\n", maxChars);
    if (splitIdx < maxChars * 0.3) {
      splitIdx = remaining.lastIndexOf("\n", maxChars);
    }
    if (splitIdx < maxChars * 0.3) {
      splitIdx = maxChars;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  return chunks.filter(c => c.length > 20);
}

function splitMdIntoBlocks(raw: string): string[] {
  const rawBlocks = raw.split(/\n(?=---\n|## )/).filter(b => b.trim().length > 20);
  const result: string[] = [];
  for (const block of rawBlocks) {
    const subs = subSplitBlock(block.trim(), VEC_MAX_BLOCK_CHARS);
    result.push(...subs);
  }
  return result;
}

function resolveEmbeddingConfig(
  ocConfig: Record<string, unknown>,
  providerName: string,
): { baseUrl: string; apiKey: string } | null {
  try {
    const providers = (
      (ocConfig as Record<string, unknown>)?.models as Record<string, unknown> | undefined
    )?.providers as Record<string, unknown> | undefined;
    if (!providers) return null;
    const provider = providers[providerName] as Record<string, unknown> | undefined;
    if (!provider) return null;
    const baseUrl = provider.baseUrl;
    const apiKey = provider.apiKey;
    if (typeof baseUrl !== "string" || typeof apiKey !== "string") return null;
    if (!baseUrl || !apiKey) return null;
    return { baseUrl, apiKey };
  } catch {
    return null;
  }
}

async function embedBatch(
  texts: string[],
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<number[][] | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const json = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map(d => d.embedding);
  } catch {
    return null;
  }
}

async function generateVecSidecar(
  mdPath: string,
  logger: PluginApi["logger"],
  cfg: any,
): Promise<void> {
  try {
    if (!mdPath.endsWith(".md")) return;

    // Read embedding config from openclaw.json
    const embCfg = resolveEmbeddingConfig(cfg, "letsur");
    if (!embCfg) {
      logger.debug("[session-memory-hook] No embedding provider config, skipping .vec generation");
      return;
    }

    const model = "text-embedding-3-small";
    const raw = fs.readFileSync(mdPath, "utf-8");
    const blocks = splitMdIntoBlocks(raw);

    if (blocks.length === 0) {
      logger.debug(`[session-memory-hook] No blocks in ${path.basename(mdPath)}, skipping .vec`);
      return;
    }

    // Embed in batches of 20
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < blocks.length; i += 20) {
      const batch = blocks.slice(i, i + 20);
      const embeddings = await embedBatch(batch, embCfg.baseUrl, embCfg.apiKey, model);
      if (!embeddings) {
        logger.warn(`[session-memory-hook] Embedding batch failed for ${path.basename(mdPath)}, skipping .vec`);
        return;
      }
      allEmbeddings.push(...embeddings);
    }

    const vecData: VecFile = {
      model,
      blocks: blocks.map((text, idx) => ({
        text: text.slice(0, 200),
        embedding: allEmbeddings[idx],
        fullText: text,
      })),
    };

    const vecPath = mdPath.replace(/\.md$/, ".vec");
    fs.writeFileSync(vecPath, JSON.stringify(vecData), "utf-8");
    logger.info(`[session-memory-hook] Generated .vec sidecar: ${path.basename(vecPath)} (${blocks.length} blocks)`);
  } catch (err) {
    logger.warn(`[session-memory-hook] .vec generation failed for ${path.basename(mdPath)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildStandardEntry(params: {
  now: Date;
  agentId: string;
  sessionId: string;
  source: "dm" | "group";
  chatId: string;
  messages: Array<{ role: string; text: string; timestamp?: number }>;
}): string {
  const { now, agentId, sessionId, source, chatId, messages } = params;

  // Summary: last user message (most relevant context)
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const summary = compactLine(lastUserMsg?.text ?? "(no user message)", 240);
  const slug = extractSlug(messages);

  // Default hook style reference: role-prefixed conversation summary lines
  const conversationSummary = messages
    .map((m) => `${m.role}: ${compactLine(m.text, 400)}`)
    .slice(-40)
    .join("\n");

  // Full action log (lossless, except whitespace normalization)
  const recent = messages.map((m) => `- ${m.role}: ${compactLine(m.text)}`).join("\n");

  return [
    "---",
    `## ${formatKstDateTime(now)}`,
    `agent: ${agentId}`,
    `session: ${sessionId}`,
    `source: ${source}`,
    `chat_id: ${chatId}`,
    `summary: ${summary}`,
    `slug: ${slug}`,
    "",
    "# Session Snapshot",
    `- **Session ID**: ${sessionId}`,
    `- **Source**: ${source}`,
    `- **Slug**: ${slug}`,
    "",
    "## Conversation Summary",
    conversationSummary || "(no summary lines)",
    "",
    "actions:",
    recent || "- (none)",
    "tags: []",
    ""
  ].join("\n");
}

function resolveTargets(params: {
  workspaceDir: string;
  source: "dm" | "group";
  groupId?: string;
  sessionStart: Date;
  writeLongTerm: boolean;
  channel?: string;
}): { sessionLogFile: string; longTermFile?: string } {
  const { workspaceDir, source, groupId, sessionStart, writeLongTerm, channel } = params;
  const sessionFileName = `${formatKstFileTimestamp(sessionStart)}.md`;

  if (source === "group") {
    const gid = groupId ?? "unknown";
    const prefix = "dc"; // discord-only deployment
    const base = path.join(workspaceDir, "memory", `${prefix}_${gid}`);
    return {
      sessionLogFile: path.join(base, sessionFileName),
      longTermFile: writeLongTerm ? path.join(base, "MEMORY.md") : undefined
    };
  }

  const base = path.join(workspaceDir, "memory", "dm");
  return {
    sessionLogFile: path.join(base, sessionFileName),
    longTermFile: writeLongTerm ? path.join(base, "MEMORY.md") : undefined
  };
}

function extractChatIdToken(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!trimmed.includes(":")) return trimmed;
  const token = trimmed.split(":").pop()?.trim() ?? "";
  return token || null;
}

function resolveChatId(entry: SessionEntry, fallbackChatId?: string | number): string {
  if (entry.groupId != null) return String(entry.groupId);

  const candidates: unknown[] = [
    fallbackChatId,
    (entry as any).chatId,
    (entry as any).origin?.from,
    (entry as any).origin?.to,
    (entry as any).deliveryContext?.to,
    (entry as any).lastTo
  ];

  for (const c of candidates) {
    const parsed = extractChatIdToken(c);
    if (parsed) return parsed;
  }

  return "unknown";
}

function recordSessionToMemory(
  api: PluginApi,
  cfg: any,
  agentId: string,
  entry: SessionEntry,
  maxMessages: number,
  minMessages: number,
  eventLabel: string,
  opts?: {
    writeLongTerm?: boolean;
    chatId?: string | number;
    groupId?: string | number;
    channel?: string;
    sessionKey?: string;
  }
): { ok: boolean; messageCount?: number; sessionLogFile?: string; longTermFile?: string } {
  const hydrated = ensureSessionFile(entry, cfg, agentId);
  const sessionFile = hydrated.sessionFile;
  if (!sessionFile) {
    api.logger.debug(`[session-memory-hook] No session file path (${eventLabel}), skipping`);
    return { ok: false };
  }

  const transcript = readTranscript(sessionFile);
  let messages = extractMessages(transcript, maxMessages);
  if (messages.length < minMessages) {
    // If the session file is missing or unreadable, this will be 0; surface a more helpful clue.
    if (!fs.existsSync(sessionFile)) {
      api.logger.warn(`[session-memory-hook] Missing session transcript file (${eventLabel}): ${sessionFile}`);
    } else {
      api.logger.debug(`[session-memory-hook] Only ${messages.length} messages (min: ${minMessages}) for ${eventLabel}, skipping`);
    }
    return { ok: false };
  }

  const now = new Date();
  const effectiveGroupId = hydrated.groupId ?? opts?.groupId;
  const source: "dm" | "group" = effectiveGroupId != null ? "group" : "dm";
  const chatId = resolveChatId({ ...hydrated, groupId: effectiveGroupId } as SessionEntry, opts?.chatId);
  const sessionStart = getSessionStartDate(hydrated, transcript);

  const workspaceDir = resolveWorkspaceDir(cfg, agentId);
  const resolvedChannel =
    opts?.channel ??
    hydrated.channel ??
    parseChannelFromSessionKey(opts?.sessionKey ?? "");

  const targets = resolveTargets({
    workspaceDir,
    source,
    groupId: effectiveGroupId != null ? String(effectiveGroupId) : undefined,
    sessionStart,
    writeLongTerm: opts?.writeLongTerm === true,
    channel: resolvedChannel
  });

  const sessionId = hydrated.sessionId ?? "unknown";

  const content = buildStandardEntry({
    now,
    agentId,
    sessionId,
    source,
    chatId,
    messages
  });

  appendToFile(targets.sessionLogFile, content);
  if (targets.longTermFile) appendToFile(targets.longTermFile, content);

  // Fire-and-forget: generate .vec sidecar for the session log
  generateVecSidecar(targets.sessionLogFile, api.logger, cfg).catch(() => {});

  api.logger.info(
    `[session-memory-hook] Recorded ${messages.length} messages event=${eventLabel} sessionLog=${targets.sessionLogFile}${targets.longTermFile ? ` long=${targets.longTermFile}` : ""}`
  );

  return {
    ok: true,
    messageCount: messages.length,
    sessionLogFile: targets.sessionLogFile,
    longTermFile: targets.longTermFile
  };
}

export function register(api: PluginApi): void {
  const pluginConfig = api.pluginConfig ?? {};
  if (pluginConfig.enabled === false) {
    api.logger.info("[session-memory-hook] Disabled via config");
    return;
  }

  // 0 means no limit
  const maxMessages = pluginConfig.maxMessages ?? 0;
  // Default to 1 so a just-started session (assistant greeting only) still gets logged.
  const minMessages = pluginConfig.minMessages ?? 1;

  const handleNewReset = async (event: HookEvent) => {
    const cfg = api.runtime.config.loadConfig();
    const agentId = parseAgentId(event.sessionKey);
    if (!agentId) {
      api.logger.warn("[session-memory-hook] Could not determine agent ID from session key");
      return;
    }

    const currentSessionId = event.context.sessionEntry?.sessionId;
    const fallbackPrev = resolvePreviousSessionFallback(
      cfg,
      agentId,
      currentSessionId,
      event.sessionKey,
      event.context.sessionEntry,
      event.context.senderId
    );

    const candidates: SessionEntry[] = [];
    const seen = new Set<string>();
    const enqueue = (candidate?: SessionEntry | null) => {
      if (!candidate) return;
      const hydrated = ensureSessionFile(candidate, cfg, agentId);
      const key = `${hydrated.sessionId ?? "unknown"}|${hydrated.sessionFile ?? hydrated.transcriptPath ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(hydrated);
    };

    const desiredGroupId =
      event.context.sessionEntry?.groupId != null
        ? String(event.context.sessionEntry.groupId)
        : parseGroupIdFromSessionKey(event.sessionKey);

    const desiredScope = desiredGroupId
      ? ({ type: "group", groupId: desiredGroupId } as const)
      : ({ type: "dm", chatId: resolveChatId(event.context.sessionEntry ?? ({} as any), event.context.senderId) } as const);

    enqueue(event.context.previousSessionEntry);
    enqueue(resolveResetVariantForSessionEntry(cfg, agentId, event.context.previousSessionEntry));
    enqueue(fallbackPrev);
    enqueue(resolveResetVariantForSessionEntry(cfg, agentId, fallbackPrev));

    // Robust fallback: if the core /new flow produced a fresh reset transcript file but we don't have
    // a good previousSessionEntry reference, pick the nearest *.jsonl.reset.* by timestamp.
    enqueue(findResetTranscriptNear(cfg, agentId, event.timestamp, { excludeSessionId: String(currentSessionId ?? "") }));

    if (candidates.length === 0) {
      api.logger.debug("[session-memory-hook] No previous session candidate (and fallback miss), skipping");
      return;
    }

    api.logger.info(
      `[session-memory-hook] Handle ${event.action}: sessionKey=${event.sessionKey} desired=${desiredScope.type}:${desiredScope.type === "group" ? (desiredScope as any).groupId : (desiredScope as any).chatId} candidates=${candidates.length}`
    );

    // Prefer candidates that match the current chat scope to avoid DM/group cross-contamination.
    const score = (c: SessionEntry): number => {
      const gid = c.groupId != null ? String(c.groupId) : null;
      if (desiredScope.type === "group") {
        if (gid === desiredScope.groupId) return 0;
        if (gid == null) return 4;
        return 8;
      }

      // desiredScope.type === "dm"
      if (gid != null) return 8;
      const cid = resolveChatId(c, event.context.senderId);
      if (cid === desiredScope.chatId) return 0;
      if (cid === "unknown") return 3;
      return 6;
    };

    const sorted = [...candidates].sort((a, b) => {
      const ds = score(a) - score(b);
      if (ds !== 0) return ds;
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });

    // Hard guard: never record a group session into DM memory (or vice versa).
    // If we can't find any candidate that matches the current scope, prefer skipping over misfiling.
    const scoped = sorted.filter((c) => {
      const gid = c.groupId != null ? String(c.groupId) : null;
      if (desiredScope.type === "group") return gid == null || gid === desiredScope.groupId;
      return gid == null;
    });

    if (scoped.length === 0) {
      api.logger.warn(
        `[session-memory-hook] No scope-matching previous session on ${event.action}: sessionKey=${event.sessionKey} desired=${desiredScope.type}`
      );
      return;
    }

    const groupIdHint = desiredScope.type === "group" ? desiredScope.groupId : undefined;
    const chatIdHint = desiredScope.type === "group" ? desiredScope.groupId : desiredScope.chatId;

    let result: { ok: boolean; messageCount?: number; sessionLogFile?: string; longTermFile?: string } = { ok: false };
    for (const candidate of scoped) {
      const desiredChannel =
        event.context.commandSource === "discord"
          ? "discord"
          : event.context.sessionEntry?.channel
            ? String(event.context.sessionEntry.channel)
            : parseChannelFromSessionKey(event.sessionKey);

      result = recordSessionToMemory(
        api,
        cfg,
        agentId,
        candidate,
        maxMessages,
        minMessages,
        event.action,
        {
          writeLongTerm: false,
          chatId: chatIdHint,
          groupId: groupIdHint,
          channel: desiredChannel,
          sessionKey: event.sessionKey
        }
      );
      if (result.ok) break;
    }

    if (!result.ok) {
      api.logger.warn(
        `[session-memory-hook] No recordable previous session on ${event.action}: sessionKey=${event.sessionKey} candidates=${candidates.length}`
      );
      return;
    }

    if ((result.messageCount ?? 0) > 0) {
      event.messages.push(`📝 Session log saved (${result.messageCount} messages).`);
    }
  };

  const handledFlag = "__sessionMemoryHookHandled";
  const runOnce = async (event: HookEvent) => {
    if ((event as any)[handledFlag]) return;
    (event as any)[handledFlag] = true;
    await handleNewReset(event);
  };

  api.registerHook(["command:new", "command:reset"], async (event: HookEvent) => {
    try {
      await runOnce(event);
    } catch (err) {
      api.logger.error(`[session-memory-hook] Error on ${event.action}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, {
    // IMPORTANT: avoid colliding with OpenClaw's bundled internal hook id "session-memory".
    // If the bundled hook is disabled via config (hooks.internal.entries.session-memory.enabled=false),
    // a name collision can inadvertently disable this plugin hook too.
    name: "session-memory-hook:new-reset",
    description: "Records previous session conversation to memory on /new or /reset"
  });

  // Compatibility hook: some command sources emit only generic `command` events (action=new/reset).
  api.registerHook("command", async (event: HookEvent) => {
    try {
      const action = (event.action || "").toLowerCase();
      if (action === "new" || action === "reset") {
        await runOnce(event);
      }
    } catch (err) {
      api.logger.error(`[session-memory-hook] Error on generic command hook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, {
    name: "session-memory-command-compat",
    description: "Compatibility: placeholder for future generic command handling"
  });

  // Bridge: expose handlers on globalThis so Patch E can call them directly
  // (workaround for handlers$1 module-scope isolation between loader and extensionAPI)
  const bridge: Map<string, Function[]> = (globalThis as any).__openclawPluginHooks ?? new Map();
  const pushBridge = (key: string, fn: Function, handlerId: string) => {
    const existing = bridge.get(key) ?? [];
    // Idempotent registration: remove previous handler with same id.
    const filtered = existing.filter((h: any) => h?.__sessionMemoryHandlerId !== handlerId);
    (fn as any).__sessionMemoryHandlerId = handlerId;
    bridge.set(key, [...filtered, fn]);
  };
  pushBridge("command:new", async (e: HookEvent) => handleNewReset(e), "session-memory:new");
  pushBridge("command:reset", async (e: HookEvent) => handleNewReset(e), "session-memory:reset");
  // No generic "command" bridge — specific hooks above handle all cases.
  (globalThis as any).__openclawPluginHooks = bridge;

  api.logger.info("[session-memory-hook] Registered command:new/reset + command(compat) hook (standardized paths)");
}
