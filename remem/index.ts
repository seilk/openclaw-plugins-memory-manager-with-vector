import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface PluginConfig {
  enabled: boolean;
  embeddingModel: string;
  embeddingProvider: string;
}

interface PluginApi {
  id: string;
  name: string;
  config: unknown;
  pluginConfig: Record<string, unknown>;
  runtime: {
    config: { loadConfig: () => unknown };
    state: { resolveStateDir: () => string };
  };
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  registerCommand?: (command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: Record<string, unknown>) => { text: string } | Promise<{ text: string }>;
  }) => void;
}

const DEFAULTS: PluginConfig = {
  enabled: true,
  embeddingModel: "text-embedding-3-small",
  embeddingProvider: "letsur",
};

function parseConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") return DEFAULTS;
  const c = raw as Record<string, unknown>;
  return {
    enabled: typeof c.enabled === "boolean" ? c.enabled : DEFAULTS.enabled,
    embeddingModel:
      typeof c.embeddingModel === "string" ? c.embeddingModel : DEFAULTS.embeddingModel,
    embeddingProvider:
      typeof c.embeddingProvider === "string" ? c.embeddingProvider : DEFAULTS.embeddingProvider,
  };
}

function resolveDefaultAgentId(cfg: unknown): string {
  const ocfg = cfg as Record<string, unknown> | null;
  const agents = (ocfg?.agents as Record<string, unknown> | undefined)?.list;
  if (Array.isArray(agents)) {
    const defaultAgent = agents.find(
      (a: unknown) => a && typeof a === "object" && (a as Record<string, unknown>).default === true,
    ) as Record<string, unknown> | undefined;
    const defaultId = typeof defaultAgent?.id === "string" ? defaultAgent.id.trim() : "";
    if (defaultId) return defaultId;

    const firstAgent = agents.find(
      (a: unknown) => a && typeof a === "object" && typeof (a as Record<string, unknown>).id === "string",
    ) as Record<string, unknown> | undefined;
    const firstId = typeof firstAgent?.id === "string" ? firstAgent.id.trim() : "";
    if (firstId) return firstId;
  }
  return "main";
}

function resolveWorkspaceDir(cfg: unknown, agentId: string): string {
  const ocfg = cfg as Record<string, unknown> | null;
  const agents = (ocfg?.agents as Record<string, unknown> | undefined)?.list;
  if (Array.isArray(agents)) {
    const agent = agents.find((a: unknown) => (a as Record<string, unknown>).id === agentId);
    const workspace = (agent as Record<string, unknown> | undefined)?.workspace;
    if (typeof workspace === "string") return workspace;
  }
  return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

function normalizeTitle(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed || "Untitled memory";
}

function normalizeContent(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, "");
}

function buildMarkdown(title: string, content: string): string {
  return `# ${title}\n\n${content.endsWith("\n") ? content : `${content}\n`}`;
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
    if (splitIdx < maxChars * 0.3) splitIdx = remaining.lastIndexOf("\n", maxChars);
    if (splitIdx < maxChars * 0.3) splitIdx = maxChars;
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  return chunks.filter((c) => c.length > 20);
}

function splitMdIntoBlocks(raw: string): string[] {
  const rawBlocks = raw.split(/\n(?=# )/).filter((b) => b.trim().length > 20);
  const result: string[] = [];
  for (const block of rawBlocks) result.push(...subSplitBlock(block.trim(), 6000));
  return result;
}

function resolveEmbeddingConfig(
  ocConfig: unknown,
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
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const json = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  } catch {
    return null;
  }
}

async function generateVecSidecar(
  mdPath: string,
  logger: PluginApi["logger"],
  cfg: unknown,
  pluginConfig: PluginConfig,
): Promise<boolean> {
  try {
    const embCfg = resolveEmbeddingConfig(cfg, pluginConfig.embeddingProvider);
    if (!embCfg) {
      logger.warn("[remem] No embedding provider config, skipping .vec generation");
      return false;
    }
    const raw = fs.readFileSync(mdPath, "utf-8");
    const blocks = splitMdIntoBlocks(raw);
    if (blocks.length === 0) return false;
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < blocks.length; i += 20) {
      const batch = blocks.slice(i, i + 20);
      const embeddings = await embedBatch(batch, embCfg.baseUrl, embCfg.apiKey, pluginConfig.embeddingModel);
      if (!embeddings) return false;
      allEmbeddings.push(...embeddings);
    }
    const vecData = {
      model: pluginConfig.embeddingModel,
      blocks: blocks.map((fullText, idx) => ({ fullText, embedding: allEmbeddings[idx] })),
    };
    const vecPath = mdPath.replace(/\.md$/, ".vec");
    fs.writeFileSync(vecPath, JSON.stringify(vecData, null, 2), "utf-8");
    logger.info(`[remem] Generated .vec sidecar: ${path.basename(vecPath)} (${blocks.length} blocks)`);
    return true;
  } catch (err) {
    logger.warn(`[remem] .vec generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function parseFrontmatterArgs(raw: string): { title: string; content: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const titleMatch = trimmed.match(/^title\s*:\s*(.+)$/m);
  const contentMatch = trimmed.match(/^content\s*:\s*([\s\S]+)$/m);
  if (!titleMatch || !contentMatch) return null;
  return {
    title: normalizeTitle(titleMatch[1]),
    content: normalizeContent(contentMatch[1]),
  };
}

function parseJsonArgs(raw: string): { title: string; content: string } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? normalizeTitle(parsed.title) : "";
    const content = typeof parsed.content === "string" ? normalizeContent(parsed.content) : "";
    if (!title || !content) return null;
    return { title, content };
  } catch {
    return null;
  }
}

function resolvePayload(raw: string | undefined): { title: string; content: string } | null {
  if (!raw) return null;
  return parseJsonArgs(raw) ?? parseFrontmatterArgs(raw);
}

function scopeDirFromContext(ctx: Record<string, unknown>): string {
  const from = typeof ctx.from === "string" ? ctx.from : "";
  if (from.includes(":channel:")) {
    const m = from.match(/:channel:([^:]+)$/);
    if (m) return `dc_${m[1]}`;
  }
  if (from.includes(":group:")) {
    const m = from.match(/:group:([^:]+)$/);
    if (m) return `dc_${m[1]}`;
  }

  const threadId = ctx.messageThreadId;
  if (threadId != null) {
    return `dc_${String(threadId)}`;
  }

  return "dm";
}

export function register(api: PluginApi): void {
  const pluginConfig = parseConfig(api.pluginConfig);
  if (!pluginConfig.enabled) {
    api.logger.info("[remem] Disabled via config");
    return;
  }

  if (typeof api.registerCommand !== "function") {
    api.logger.warn("[remem] registerCommand unavailable — /remem not registered");
    return;
  }

  api.registerCommand({
    name: "remem",
    description: "Save a manual memory as title + content and generate a .vec sidecar",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const raw = typeof ctx.args === "string" ? ctx.args : "";
      const payload = resolvePayload(raw);
      if (!payload) {
        return {
          text:
            "Usage: /remem with JSON or frontmatter-like args. Example: /remem {\"title\":\"X\",\"content\":\"Y\"}",
        };
      }
      const ocConfig = api.runtime.config.loadConfig();
      const agentId = resolveDefaultAgentId(ocConfig);
      const workspaceDir = resolveWorkspaceDir(ocConfig, agentId);
      const scopeDir = scopeDirFromContext(ctx);
      const baseDir = path.join(workspaceDir, "memory", scopeDir);
      ensureDir(baseDir);
      const targetPath = path.join(baseDir, `${formatKstFileTimestamp(new Date())}.md`);
      fs.writeFileSync(targetPath, buildMarkdown(payload.title, payload.content), "utf-8");
      const vecOk = await generateVecSidecar(targetPath, api.logger, ocConfig, pluginConfig);
      return {
        text: vecOk
          ? `🧠 Saved memory: ${path.relative(workspaceDir, targetPath)} (+ .vec)`
          : `🧠 Saved memory: ${path.relative(workspaceDir, targetPath)} (vec skipped)`,
      };
    },
  });

  api.logger.info("[remem] Registered /remem command");
}
