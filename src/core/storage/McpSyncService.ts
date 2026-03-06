import type { ClianMcpServer, McpServerConfig } from '../types';
import { getMcpServerType } from '../types';
import { MCP_CONFIG_PATH } from './McpStorage';
import type { VaultFileAdapter } from './VaultFileAdapter';

const CLAUDE_MCP_CONFIG_PATH = '.claude/mcp.json';
const CODEX_CONFIG_PATH = '.codex/config.toml';
const GEMINI_SETTINGS_PATH = '.gemini/settings.json';

const CODEX_BLOCK_START = '# BEGIN CLIAN MCP SERVERS';
const CODEX_BLOCK_END = '# END CLIAN MCP SERVERS';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  const isBare = /^[A-Za-z0-9_-]+$/.test(key);
  return isBare ? key : tomlString(key);
}

function tomlInlineTable(record: Record<string, string>): string {
  const entries = Object.entries(record).filter(([, v]) => typeof v === 'string');
  if (entries.length === 0) return '{}';
  const parts = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return `{ ${parts.join(', ')} }`;
}

function tomlArray(values: string[]): string {
  return JSON.stringify(values);
}

function normalizeStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildCodexMcpBlock(servers: ClianMcpServer[]): string {
  const lines: string[] = [];
  lines.push(CODEX_BLOCK_START);
  lines.push('# Managed by Clian. Edit `.clian/mcp.json` instead.');

  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  for (const server of sorted) {
    const name = server.name.trim();
    if (!name) continue;

    const config = server.config;
    lines.push('');
    lines.push(`[mcp_servers.${tomlString(name)}]`);
    lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`);

    if ('command' in config) {
      const stdio = config as Extract<McpServerConfig, { command: string }>;
      lines.push(`command = ${tomlString(stdio.command)}`);
      if (Array.isArray(stdio.args) && stdio.args.length > 0) {
        lines.push(`args = ${tomlArray(stdio.args)}`);
      }
      const env = normalizeStringRecord(stdio.env);
      if (env) {
        lines.push(`env = ${tomlInlineTable(env)}`);
      }
    } else if ('url' in config) {
      const url = String((config as { url: string }).url || '');
      if (url) {
        lines.push(`url = ${tomlString(url)}`);
      }
      const headers = normalizeStringRecord((config as { headers?: unknown }).headers);
      if (headers) {
        lines.push(`http_headers = ${tomlInlineTable(headers)}`);
      }
    }

    const disabledTools = Array.isArray(server.disabledTools)
      ? server.disabledTools.map((t) => t.trim()).filter(Boolean)
      : [];
    if (disabledTools.length > 0) {
      lines.push(`disabled_tools = ${tomlArray(disabledTools)}`);
    }
  }

  lines.push('');
  lines.push(CODEX_BLOCK_END);
  return lines.join('\n');
}

function replaceOrAppendManagedBlock(existing: string, block: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(CODEX_BLOCK_START)}[\\s\\S]*?${escapeRegExp(CODEX_BLOCK_END)}`,
    'm'
  );

  if (pattern.test(existing)) {
    const replaced = existing.replace(pattern, block);
    return replaced.trimEnd() + '\n';
  }

  if (!existing.trim()) {
    return block.trimEnd() + '\n';
  }

  return existing.trimEnd() + '\n\n' + block.trimEnd() + '\n';
}

function buildGeminiMcpServers(servers: ClianMcpServer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  for (const server of sorted) {
    if (!server.enabled) continue;

    const name = server.name.trim();
    if (!name) continue;

    const config = server.config;
    const type = getMcpServerType(config);
    const disabledTools = Array.isArray(server.disabledTools)
      ? server.disabledTools.map((t) => t.trim()).filter(Boolean)
      : [];

    if ('command' in config) {
      const stdio = config as Extract<McpServerConfig, { command: string }>;
      const entry: Record<string, unknown> = {
        command: stdio.command,
      };
      if (Array.isArray(stdio.args) && stdio.args.length > 0) {
        entry.args = stdio.args;
      }
      if (stdio.env && typeof stdio.env === 'object') {
        entry.env = stdio.env;
      }
      if (disabledTools.length > 0) {
        entry.excludeTools = disabledTools;
      }
      out[name] = entry;
      continue;
    }

    const url = String((config as { url: string }).url || '');
    if (!url) continue;

    const headers = normalizeStringRecord((config as { headers?: unknown }).headers);
    const entry: Record<string, unknown> = {
      ...(type === 'sse' ? { url } : { httpUrl: url }),
      ...(headers ? { headers } : {}),
      ...(disabledTools.length > 0 ? { excludeTools: disabledTools } : {}),
    };

    out[name] = entry;
  }

  return out;
}

export class McpSyncService {
  constructor(private adapter: VaultFileAdapter) {}

  async syncFromSharedLayer(servers: ClianMcpServer[]): Promise<void> {
    await this.syncClaudeConfigFile();
    await this.syncCodexConfigToml(servers);
    await this.syncGeminiSettingsJson(servers);
  }

  private async syncClaudeConfigFile(): Promise<void> {
    try {
      if (!(await this.adapter.exists(MCP_CONFIG_PATH))) {
        return;
      }

      const content = await this.adapter.read(MCP_CONFIG_PATH);
      await this.writeIfChanged(CLAUDE_MCP_CONFIG_PATH, content);
    } catch {
      // Best-effort sync.
    }
  }

  private async syncCodexConfigToml(servers: ClianMcpServer[]): Promise<void> {
    try {
      await this.adapter.ensureFolder('.codex');
      const existing = (await this.adapter.exists(CODEX_CONFIG_PATH))
        ? await this.adapter.read(CODEX_CONFIG_PATH)
        : '';
      const block = buildCodexMcpBlock(servers);
      const next = replaceOrAppendManagedBlock(existing, block);
      await this.writeIfChanged(CODEX_CONFIG_PATH, next);
    } catch {
      // Best-effort sync.
    }
  }

  private async syncGeminiSettingsJson(servers: ClianMcpServer[]): Promise<void> {
    try {
      await this.adapter.ensureFolder('.gemini');

      const existingText = (await this.adapter.exists(GEMINI_SETTINGS_PATH))
        ? await this.adapter.read(GEMINI_SETTINGS_PATH)
        : '';

      let parsed: Record<string, unknown> = {};
      if (existingText.trim()) {
        try {
          const raw = JSON.parse(existingText) as unknown;
          if (raw && typeof raw === 'object') {
            parsed = raw as Record<string, unknown>;
          }
        } catch {
          // Ignore invalid JSON; overwrite with a minimal settings file.
          parsed = {};
        }
      }

      const next: Record<string, unknown> = {
        ...parsed,
        mcpServers: buildGeminiMcpServers(servers),
      };

      const content = JSON.stringify(next, null, 2);
      await this.writeIfChanged(GEMINI_SETTINGS_PATH, content);
    } catch {
      // Best-effort sync.
    }
  }

  private async writeIfChanged(filePath: string, nextContent: string): Promise<void> {
    const normalizedNext = nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`;
    const exists = await this.adapter.exists(filePath);
    if (!exists) {
      await this.adapter.write(filePath, normalizedNext);
      return;
    }

    try {
      const current = await this.adapter.read(filePath);
      if (current === normalizedNext) {
        return;
      }
    } catch {
      // If read fails, still try to write.
    }

    await this.adapter.write(filePath, normalizedNext);
  }
}
