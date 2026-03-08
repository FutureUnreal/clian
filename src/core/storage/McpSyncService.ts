import * as path from 'path';

import { type ClaudeUserMcpServerMap, getCodexInheritedEnvVarNames, loadClaudeUserMcpServers } from '../../utils/claudeUserMcp';
import type { ClianMcpServer, McpServerConfig } from '../types';
import { getMcpServerType } from '../types';
import { MCP_CONFIG_PATH } from './McpStorage';
import type { VaultFileAdapter } from './VaultFileAdapter';

const CLAUDE_MCP_CONFIG_PATH = '.claude/mcp.json';
const CODEX_CONFIG_PATH = '.codex/config.toml';
const CODEX_MCP_WRAPPER_PATH = '.clian/bin/codex-mcp-wrapper.cjs';
const GEMINI_SETTINGS_PATH = '.gemini/settings.json';

const CODEX_BLOCK_START = '# BEGIN CLIAN MCP SERVERS';
const CODEX_BLOCK_END = '# END CLIAN MCP SERVERS';

const CODEX_WRAPPED_STDIO_SERVER_NAMES = new Set(['grok-search']);

const CODEX_MCP_WRAPPER_SCRIPT = [
  '#!/usr/bin/env node',
  "const { spawn } = require('child_process');",
  "const path = require('path');",
  "const { createInterface } = require('readline');",
  '',
  'function parseArgs(argv) {',
  "  const splitIndex = argv.indexOf('--');",
  '  const values = splitIndex >= 0 ? argv.slice(splitIndex + 1) : argv;',
  '  if (values.length === 0) {',
  "    process.stderr.write('[clian-codex-mcp-wrapper] Missing child command.\\n');",
  '    process.exit(1);',
  '  }',
  '  return { command: values[0], args: values.slice(1) };',
  '}',
  '',
  'function safeParseJson(line) {',
  '  try {',
  '    return JSON.parse(line);',
  '  } catch {',
  '    return null;',
  '  }',
  '}',
  '',
  'function isJsonRpcMessage(message) {',
  "  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;",
  "  if (message.jsonrpc === '2.0') return true;",
  "  return Object.prototype.hasOwnProperty.call(message, 'method')",
  "    || Object.prototype.hasOwnProperty.call(message, 'result')",
  "    || Object.prototype.hasOwnProperty.call(message, 'error')",
  "    || Object.prototype.hasOwnProperty.call(message, 'id');",
  '}',
  '',
  'function idsMatch(left, right) {',
  '  return JSON.stringify(left) === JSON.stringify(right);',
  '}',
  '',
  'function isInitializeResponse(message, requestId) {',
  "  if (!message || typeof message !== 'object') return false;",
  "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return false;",
  '  if (!idsMatch(message.id, requestId)) return false;',
  "  return Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error');",
  '}',
  '',
  'function shouldUseShell(command) {',
  "  if (process.platform !== 'win32') return false;",
  "  const ext = path.extname(String(command || '')).toLowerCase();",
  "  return ext === '.cmd' || ext === '.bat' || ext === '.ps1' || ext === '';",
  '}',
  '',
  'const { command, args } = parseArgs(process.argv.slice(2));',
  'const childEnv = { ...process.env };',
  "if (process.platform === 'win32' && /^uvx(?:\\.exe)?$/i.test(path.basename(command))) {",
  "  if (!childEnv.PYTHONIOENCODING) childEnv.PYTHONIOENCODING = 'utf-8';",
  "  if (!childEnv.PYTHONUTF8) childEnv.PYTHONUTF8 = '1';",
  '}',
  '',
  'const child = spawn(command, args, {',
  '  stdio: [\'pipe\', \'pipe\', \'pipe\'],',
  '  shell: shouldUseShell(command),',
  '  windowsHide: true,',
  '  cwd: process.cwd(),',
  '  env: childEnv,',
  '});',
  '',
  'let initializeRequestId;',
  'let initializeSatisfied = false;',
  '',
  "child.stdin.on('error', () => {});",
  '',
  "const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });",
  "stdinRl.on('line', (line) => {",
  '  const message = safeParseJson(line);',
  "  if (!initializeSatisfied && message && typeof message === 'object' && message.method === 'initialize' && Object.prototype.hasOwnProperty.call(message, 'id')) {",
  '    initializeRequestId = message.id;',
  '  }',
  '  try {',
  "    child.stdin.write(`${line}\\n`);",
  '  } catch {',
  '  }',
  '});',
  "stdinRl.on('close', () => {",
  '  try {',
  '    child.stdin.end();',
  '  } catch {',
  '  }',
  '});',
  '',
  "const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });",
  "stdoutRl.on('line', (line) => {",
  '  const trimmed = line.trim();',
  '  if (!trimmed) return;',
  '  const message = safeParseJson(line);',
  '  if (isJsonRpcMessage(message)) {',
  '    if (!initializeSatisfied && initializeRequestId !== undefined && isInitializeResponse(message, initializeRequestId)) {',
  '      initializeSatisfied = true;',
  '    }',
  "    process.stdout.write(`${line}\\n`);",
  '    return;',
  '  }',
  "  process.stderr.write(`[clian-codex-mcp-wrapper] ${initializeSatisfied ? 'redirected-stdout' : 'suppressed-pre-init'}: ${line}\\n`);",
  '});',
  '',
  "child.stderr.on('data', (chunk) => {",
  '  process.stderr.write(chunk);',
  '});',
  '',
  "child.on('error', (error) => {",
  "  process.stderr.write(`[clian-codex-mcp-wrapper] spawn failed: ${error.message}\\n`);",
  '  process.exit(1);',
  '});',
  '',
  "child.on('close', (code) => {",
  "  process.exit(typeof code === 'number' ? code : 0);",
  '});',
  '',
].join('\n');

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
        continue;
      }
      if (char === '\n') {
        out += char;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    out += char;
    if (char === '"') {
      inString = true;
      escaped = false;
    }
  }

  return out;
}

function safeParseJsonWithComments(text: string): unknown | null {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

type GeminiLocalMcpServerMap = Record<string, Record<string, unknown>>;

const GEMINI_COMMON_LOCAL_FALLBACK_KEYS = [
  'timeout',
  'trust',
  'description',
  'includeTools',
  'excludeTools',
  'oauth',
  'authProviderType',
  'targetAudience',
  'targetServiceAccount',
] as const;

const GEMINI_STDIO_LOCAL_FALLBACK_KEYS = [
  'cwd',
  ...GEMINI_COMMON_LOCAL_FALLBACK_KEYS,
] as const;

function cloneJsonLike<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as T;
  }
  if (value && typeof value === 'object') {
    return JSON.parse(JSON.stringify(value)) as T;
  }
  return value;
}

function copyGeminiLocalFallbackFields(
  target: Record<string, unknown>,
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): void {
  if (!source) return;

  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;

    if (typeof value === 'string') {
      if (value.trim()) {
        target[key] = value;
      }
      continue;
    }

    if (Array.isArray(value)) {
      target[key] = cloneJsonLike(value.filter((entry) => typeof entry === 'string'));
      continue;
    }

    target[key] = cloneJsonLike(value);
  }
}

function getGeminiLocalMcpServers(parsed: Record<string, unknown>): GeminiLocalMcpServerMap {
  const raw = isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
  if (!raw) return {};

  const out: GeminiLocalMcpServerMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (isRecord(value)) {
      out[name] = value;
    }
  }
  return out;
}

function mergeGeminiStringRecord(
  existingValue: unknown,
  explicitValue: unknown,
): Record<string, string> | null {
  const existing = normalizeStringRecord(existingValue) || {};
  const explicit = normalizeStringRecord(explicitValue) || {};
  const merged = { ...existing, ...explicit };
  return Object.keys(merged).length > 0 ? merged : null;
}

function shouldUseCodexMcpWrapper(server: ClianMcpServer, platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const name = server.name.trim().toLowerCase();
  if (CODEX_WRAPPED_STDIO_SERVER_NAMES.has(name)) return true;
  const config = server.config;
  if (!('command' in config)) return false;
  const command = String(config.command || '').trim().toLowerCase();
  return command === 'uvx' || command.endsWith('/uvx.exe') || command.endsWith('\\uvx.exe');
}

function getCodexWrapperEnv(server: ClianMcpServer): Record<string, string> | null {
  const config = server.config;
  if (!('command' in config)) return normalizeStringRecord(null);
  const base = normalizeStringRecord(config.env) || {};
  const command = String(config.command || '').trim().toLowerCase();
  if (process.platform === 'win32' && (command === 'uvx' || command.endsWith('/uvx.exe') || command.endsWith('\\uvx.exe'))) {
    if (!base.PYTHONIOENCODING) base.PYTHONIOENCODING = 'utf-8';
    if (!base.PYTHONUTF8) base.PYTHONUTF8 = '1';
  }
  return Object.keys(base).length > 0 ? base : null;
}

export function buildCodexMcpBlock(
  servers: ClianMcpServer[],
  platform = process.platform,
  claudeUserServers: ClaudeUserMcpServerMap = loadClaudeUserMcpServers(),
  vaultPath?: string | null,
): string {
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
      const useWrapper = shouldUseCodexMcpWrapper(server, platform);
      if (useWrapper) {
        const wrapperPath = (vaultPath ? path.join(vaultPath, CODEX_MCP_WRAPPER_PATH) : CODEX_MCP_WRAPPER_PATH).replace(/\\/g, '/');
        lines.push('command = "node"');
        lines.push(`args = ${tomlArray([wrapperPath, '--', stdio.command, ...(Array.isArray(stdio.args) ? stdio.args : [])])}`);
      } else {
        lines.push(`command = ${tomlString(stdio.command)}`);
        if (Array.isArray(stdio.args) && stdio.args.length > 0) {
          lines.push(`args = ${tomlArray(stdio.args)}`);
        }
      }
      const env = useWrapper ? getCodexWrapperEnv(server) : normalizeStringRecord(stdio.env);
      if (env) {
        lines.push(`env = ${tomlInlineTable(env)}`);
      }
      const envVars = getCodexInheritedEnvVarNames(name, config, env, claudeUserServers);
      if (envVars.length > 0) {
        lines.push(`env_vars = ${tomlArray(envVars)}`);
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

function buildGeminiMcpServers(
  servers: ClianMcpServer[],
  existingServers: GeminiLocalMcpServerMap = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  for (const server of sorted) {
    if (!server.enabled) continue;

    const name = server.name.trim();
    if (!name) continue;

    const config = server.config;
    const type = getMcpServerType(config);
    const existing = existingServers[name];
    const disabledTools = Array.isArray(server.disabledTools)
      ? server.disabledTools.map((t) => t.trim()).filter(Boolean)
      : [];

    if ('command' in config) {
      const stdio = config as Extract<McpServerConfig, { command: string }>;
      const entry: Record<string, unknown> = {};
      copyGeminiLocalFallbackFields(entry, existing, GEMINI_STDIO_LOCAL_FALLBACK_KEYS);
      entry.command = stdio.command;
      if (Array.isArray(stdio.args) && stdio.args.length > 0) {
        entry.args = stdio.args;
      }
      const env = mergeGeminiStringRecord(existing?.env, stdio.env);
      if (env) {
        entry.env = env;
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
    const entry: Record<string, unknown> = {};
    copyGeminiLocalFallbackFields(entry, existing, GEMINI_COMMON_LOCAL_FALLBACK_KEYS);
    const mergedHeaders = mergeGeminiStringRecord(existing?.headers, headers);
    Object.assign(entry, {
      ...(type === 'sse' ? { url } : { httpUrl: url }),
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      ...(disabledTools.length > 0 ? { excludeTools: disabledTools } : {}),
    });

    out[name] = entry;
  }

  return out;
}

export class McpSyncService {
  constructor(private adapter: VaultFileAdapter) {}

  async syncFromSharedLayer(servers: ClianMcpServer[]): Promise<void> {
    await this.syncClaudeConfigFile();
    await this.syncCodexWrapperScript();
    await this.syncCodexConfigToml(servers);
    await this.syncGeminiSettingsJson(servers);
  }

  private async syncCodexWrapperScript(): Promise<void> {
    try {
      await this.adapter.ensureFolder('.clian/bin');
      await this.writeIfChanged(CODEX_MCP_WRAPPER_PATH, CODEX_MCP_WRAPPER_SCRIPT);
    } catch {
      // Best-effort sync.
    }
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
      const block = buildCodexMcpBlock(servers, process.platform, loadClaudeUserMcpServers(), this.adapter.getBasePath());
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
          const raw = safeParseJsonWithComments(existingText) ?? JSON.parse(existingText);
          if (raw && typeof raw === 'object') {
            parsed = raw as Record<string, unknown>;
          }
        } catch {
          // Ignore invalid JSON; overwrite with a minimal settings file.
          parsed = {};
        }
      }

      const existingGeminiServers = getGeminiLocalMcpServers(parsed);

      const next: Record<string, unknown> = {
        ...parsed,
        mcpServers: buildGeminiMcpServers(servers, existingGeminiServers),
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
