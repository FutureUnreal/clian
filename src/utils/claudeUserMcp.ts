import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { McpServerConfig } from '../core/types';

export interface ClaudeUserMcpServer {
  args: string[];
  command: string;
  env: Record<string, string>;
}

export type ClaudeUserMcpServerMap = Record<string, ClaudeUserMcpServer>;

let cachedClaudeUserMcpServers: ClaudeUserMcpServerMap | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }

  return out;
}

function sameStringArrays(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function matchesClaudeUserMcpServer(config: McpServerConfig, candidate: ClaudeUserMcpServer): boolean {
  if (!('command' in config)) return false;

  const command = typeof config.command === 'string' ? config.command.trim() : '';
  if (!command || command !== candidate.command) return false;

  const args = Array.isArray(config.args)
    ? config.args.filter((value): value is string => typeof value === 'string')
    : [];

  return sameStringArrays(args, candidate.args);
}

export function loadClaudeUserMcpServers(homeDir = os.homedir()): ClaudeUserMcpServerMap {
  if (cachedClaudeUserMcpServers) {
    return cachedClaudeUserMcpServers;
  }

  if (!homeDir || process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    cachedClaudeUserMcpServers = {};
    return cachedClaudeUserMcpServers;
  }

  const configPath = path.join(homeDir, '.claude.json');
  try {
    if (!fs.existsSync(configPath)) {
      cachedClaudeUserMcpServers = {};
      return cachedClaudeUserMcpServers;
    }

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    const mcpServers = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : null;
    if (!mcpServers) {
      cachedClaudeUserMcpServers = {};
      return cachedClaudeUserMcpServers;
    }

    const out: ClaudeUserMcpServerMap = {};
    for (const [name, value] of Object.entries(mcpServers)) {
      if (!isRecord(value) || typeof value.command !== 'string' || !value.command.trim()) continue;

      const env = normalizeStringRecord(value.env);
      if (Object.keys(env).length === 0) continue;

      out[name] = {
        command: value.command.trim(),
        args: normalizeStringArray(value.args),
        env,
      };
    }

    cachedClaudeUserMcpServers = out;
    return cachedClaudeUserMcpServers;
  } catch {
    cachedClaudeUserMcpServers = {};
    return cachedClaudeUserMcpServers;
  }
}

export function getClaudeUserEnvFallback(
  serverName: string,
  config: McpServerConfig,
  userServers = loadClaudeUserMcpServers(),
): Record<string, string> | null {
  const name = serverName.trim();
  if (!name) return null;

  const candidate = userServers[name];
  if (!candidate || !matchesClaudeUserMcpServer(config, candidate)) {
    return null;
  }

  return candidate.env;
}

export function getCodexInheritedEnvVarNames(
  serverName: string,
  config: McpServerConfig,
  explicitEnv?: Record<string, string> | null,
  userServers = loadClaudeUserMcpServers(),
): string[] {
  const fallbackEnv = getClaudeUserEnvFallback(serverName, config, userServers);
  if (!fallbackEnv) return [];

  const existing = explicitEnv || {};
  return Object.keys(fallbackEnv)
    .filter((key) => !Object.prototype.hasOwnProperty.call(existing, key))
    .sort((a, b) => a.localeCompare(b));
}

export function mergeClaudeUserMcpEnvIntoProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  userServers = loadClaudeUserMcpServers(),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...baseEnv };

  for (const server of Object.values(userServers)) {
    for (const [key, value] of Object.entries(server.env)) {
      if (typeof out[key] !== 'string' || !out[key]) {
        out[key] = value;
      }
    }
  }

  return out;
}
