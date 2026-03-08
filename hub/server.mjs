#!/usr/bin/env node
/**
 * Clian Remote Hub
 *
 * Minimal HTTP hub that can run multiple agent flavors on a remote machine:
 * - Claude Code via @anthropic-ai/claude-agent-sdk
 * - Codex via `codex exec --json`
 * - Gemini via `gemini --output-format stream-json`
 *
 * Exposes a small API compatible with Clian mobile's RemoteHubClient.
 *
 * This is intentionally simple: in-memory state with a small JSON persistence layer.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

// ============================================
// Config
// ============================================

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseSettingSources(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  const parts = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(['user', 'project']);
  const out = [];
  for (const part of parts) {
    if (!allowed.has(part)) continue;
    if (!out.includes(part)) out.push(part);
  }
  return out.length > 0 ? out : null;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  const trimmed = String(value || '').trim().toLowerCase();
  if (trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'y') return true;
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'no' || trimmed === 'n') return false;
  return null;
}

function formatHostForUrl(host) {
  const value = String(host || '').trim();
  if (!value) return 'localhost';
  if (value.includes(':') && !value.startsWith('[')) {
    return `[${value}]`;
  }
  return value;
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function getAddressPriority(address) {
  const normalized = String(address || '').trim();
  if (normalized.startsWith('192.168.')) return 0;
  if (normalized.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return 2;
  return 3;
}

function getAdapterPriority(interfaceName) {
  const normalized = String(interfaceName || '').trim().toLowerCase();
  if (!normalized) return 50;

  const highPriority = ['wlan', 'wi-fi', 'wifi', 'wireless'];
  if (highPriority.some((keyword) => normalized.includes(keyword))) return 0;

  const mediumPriority = ['ethernet', 'eth', 'lan'];
  if (mediumPriority.some((keyword) => normalized.includes(keyword))) return 1;

  const lowPriority = [
    'singbox',
    'tailscale',
    'tun',
    'tap',
    'vpn',
    'vethernet',
    'vmware',
    'virtualbox',
    'vbox',
    'hyper-v',
    'default switch',
    'docker',
    'wsl',
    'loopback',
    'bridge',
  ];
  if (lowPriority.some((keyword) => normalized.includes(keyword))) return 20;

  return 5;
}

function getHubDisplayUrls(host, port) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== '0.0.0.0' && normalizedHost !== '::') {
    return {
      directUrl: `http://${formatHostForUrl(host)}:${port}`,
      localUrl: `http://localhost:${port}`,
      lanUrls: [],
    };
  }

  const seen = new Set();
  const preferred = [];
  const fallback = [];
  const interfaces = os.networkInterfaces();

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : (entry.family === 4 ? 'IPv4' : '');
      if (family !== 'IPv4' || entry.internal || !entry.address) continue;
      if (entry.address.startsWith('169.254.')) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);

      const candidate = {
        address: entry.address,
        interfaceName,
        adapterPriority: getAdapterPriority(interfaceName),
        addressPriority: getAddressPriority(entry.address),
      };

      if (isPrivateIpv4(entry.address)) {
        preferred.push(candidate);
      } else {
        fallback.push(candidate);
      }
    }
  }

  const sortCandidates = (left, right) => (
    left.adapterPriority - right.adapterPriority ||
    left.addressPriority - right.addressPriority ||
    left.interfaceName.localeCompare(right.interfaceName) ||
    left.address.localeCompare(right.address)
  );

  const lanUrls = [...preferred.sort(sortCandidates), ...fallback.sort(sortCandidates)]
    .map((candidate) => `http://${candidate.address}:${port}`);
  return {
    directUrl: lanUrls[0] || `http://localhost:${port}`,
    localUrl: `http://localhost:${port}`,
    lanUrls,
  };
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function generateToken() {
  try {
    return randomBytes(32).toString('base64url');
  } catch {
    return `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  }
}

function loadExampleHubConfigTemplate() {
  try {
    const url = new URL('./config.example.json', import.meta.url);
    const text = fs.readFileSync(url, 'utf8');
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function bootstrapHubConfigFile(filePath) {
  if (!filePath) return { written: false, token: null };

  try {
    if (fs.existsSync(filePath)) return { written: false, token: null };
  } catch {
    // ignore
  }

  const envToken = trimString(process.env.CLIAN_HUB_TOKEN);
  if (envToken) return { written: false, token: null };

  try {
    const template = loadExampleHubConfigTemplate() || {};
    const token = generateToken();

    const host = trimString(process.env.CLIAN_HUB_HOST) || template.host || '0.0.0.0';
    const port = parseNumber(process.env.CLIAN_HUB_PORT, Number(template.port) || 3006);

    const cwdRaw = trimString(process.env.CLIAN_HUB_CWD);
    const cwd = cwdRaw ? path.resolve(cwdRaw) : process.cwd();

    const debug = (() => {
      const envValue = trimString(process.env.CLIAN_HUB_DEBUG);
      if (envValue) return envValue === '1';
      if (typeof template.debug === 'boolean') return template.debug;
      return false;
    })();

    const config = {
      ...template,
      token,
      host,
      port,
      cwd,
      debug,
    };

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));

    return { written: true, token, error: null };
  } catch (err) {
    return { written: false, token: null, error: err };
  }
}

function normalizeSettingSources(value) {
  if (Array.isArray(value)) {
    const allowed = new Set(['user', 'project']);
    const out = [];
    for (const item of value) {
      const part = String(item || '').trim().toLowerCase();
      if (!allowed.has(part)) continue;
      if (!out.includes(part)) out.push(part);
    }
    return out.length > 0 ? out : null;
  }
  return parseSettingSources(value);
}

function loadHubConfigFile(filePath) {
  if (!filePath) return { exists: false, config: null, error: null };
  try {
    if (!fs.existsSync(filePath)) {
      return { exists: false, config: null, error: null };
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        exists: true,
        config: null,
        error: new Error('Hub config must be a JSON object.'),
      };
    }
    return { exists: true, config: parsed, error: null };
  } catch (err) {
    return { exists: true, config: null, error: err };
  }
}

function normalizeHubConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') return {};

  const baseToken = trimString(rawConfig.baseToken) || trimString(rawConfig.token);
  const host = trimString(rawConfig.host);
  const port = parseOptionalNumber(rawConfig.port);
  const debug = parseBoolean(rawConfig.debug);

  const dataDir = trimString(rawConfig.dataDir);
  const defaultCwd = trimString(rawConfig.defaultCwd) || trimString(rawConfig.cwd);

  const claudeCodePath = trimString(rawConfig.claudeCodePath);
  const model = trimString(rawConfig.model);
  const claudeApprovalMode = trimString(rawConfig.claudeApprovalMode);

  const codexCommand = trimString(rawConfig.codexCommand);
  const codexApprovalMode = trimString(rawConfig.codexApprovalMode);
  const codexSandbox = trimString(rawConfig.codexSandbox);

  const geminiCommand = trimString(rawConfig.geminiCommand);
  const geminiApprovalMode = trimString(rawConfig.geminiApprovalMode);
  const geminiSandbox = parseBoolean(rawConfig.geminiSandbox);

  const sseFlushMs = parseOptionalNumber(rawConfig.sseFlushMs);
  const ssePatchFlushMs = parseOptionalNumber(rawConfig.ssePatchFlushMs);
  const sseMaxBufferBytes = parseOptionalNumber(rawConfig.sseMaxBufferBytes);

  const claudeSettingSources =
    normalizeSettingSources(rawConfig.claudeSettingSources) ||
    normalizeSettingSources(rawConfig.settingSources);

  return {
    ...(host ? { host } : {}),
    ...(port !== null ? { port } : {}),
    ...(baseToken ? { baseToken } : {}),
    ...(debug !== null ? { debug } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(defaultCwd ? { defaultCwd } : {}),
    ...(claudeCodePath ? { claudeCodePath } : {}),
    ...(model ? { model } : {}),
    ...(claudeApprovalMode ? { claudeApprovalMode } : {}),
    ...(codexCommand ? { codexCommand } : {}),
    ...(codexApprovalMode ? { codexApprovalMode } : {}),
    ...(codexSandbox ? { codexSandbox } : {}),
    ...(geminiCommand ? { geminiCommand } : {}),
    ...(geminiApprovalMode ? { geminiApprovalMode } : {}),
    ...(geminiSandbox !== null ? { geminiSandbox } : {}),
    ...(sseFlushMs !== null ? { sseFlushMs } : {}),
    ...(ssePatchFlushMs !== null ? { ssePatchFlushMs } : {}),
    ...(sseMaxBufferBytes !== null ? { sseMaxBufferBytes } : {}),
    ...(claudeSettingSources ? { claudeSettingSources } : {}),
  };
}

function isBareCommand(cmd) {
  if (!cmd) return false;
  // If the user provided a path, don't treat it as a bare command.
  if (cmd.includes('/') || cmd.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(cmd)) return false;
  return true;
}

function resolveWindowsShim(command) {
  if (process.platform !== 'win32') return null;
  const cmd = String(command || '').trim();
  if (!isBareCommand(cmd)) return null;

  const homeDir = os.homedir();
  const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');

  const candidates = [];

  // Prefer `.exe` if present, else `.cmd` / `.bat` (npm/pnpm shims).
  if (appData) {
    candidates.push(
      path.join(appData, 'npm', `${cmd}.exe`),
      path.join(appData, 'npm', `${cmd}.cmd`),
      path.join(appData, 'npm', `${cmd}.bat`)
    );
  }

  const pnpmHome = process.env.PNPM_HOME || (localAppData ? path.join(localAppData, 'pnpm') : null);
  if (pnpmHome) {
    candidates.push(
      path.join(pnpmHome, `${cmd}.exe`),
      path.join(pnpmHome, `${cmd}.cmd`),
      path.join(pnpmHome, `${cmd}.bat`)
    );
  }

  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Yarn', 'bin', `${cmd}.cmd`),
      path.join(localAppData, 'Yarn', 'bin', `${cmd}.bat`)
    );
  }

  if (homeDir) {
    candidates.push(path.join(homeDir, '.volta', 'bin', `${cmd}.cmd`));
  }

  for (const candidate of candidates) {
    if (isExistingFile(candidate)) return candidate;
  }

  return null;
}

function isExistingFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveClaudeCodePath(rawPath) {
  const trimmed = String(rawPath || '').trim();
  const candidates = [];

  const addCandidate = (p) => {
    if (!p || typeof p !== 'string') return;
    const normalized = p.trim();
    if (!normalized) return;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  if (trimmed) {
    addCandidate(trimmed);
    try { addCandidate(path.resolve(trimmed)); } catch { /* ignore */ }

    // If a user points at an npm shim (.cmd/.ps1 or bare "claude"),
    // prefer resolving its real JS entrypoint to keep spawn stdio-compatible.
    const lower = trimmed.toLowerCase();
    const base = path.basename(lower);
    const looksLikeShim = base === 'claude' || base === 'claude.cmd' || base === 'claude.ps1';
    if (looksLikeShim) {
      try {
        const dir = path.dirname(path.resolve(trimmed));
        addCandidate(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
      } catch { /* ignore */ }
    }
  }

  const homeDir = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    addCandidate(path.join(homeDir, '.claude', 'local', 'claude.exe'));
    addCandidate(path.join(homeDir, '.local', 'bin', 'claude.exe'));
    addCandidate(path.join(localAppData, 'Claude', 'claude.exe'));
    addCandidate(path.join(programFiles, 'Claude', 'claude.exe'));
    addCandidate(path.join(programFilesX86, 'Claude', 'claude.exe'));
    addCandidate(path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  } else {
    addCandidate(path.join(homeDir, '.claude', 'local', 'claude'));
    addCandidate(path.join(homeDir, '.local', 'bin', 'claude'));
    addCandidate('/usr/local/bin/claude');
    addCandidate('/opt/homebrew/bin/claude');
    addCandidate(path.join(homeDir, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
    addCandidate('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
    addCandidate('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js');
  }

  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

const CONFIG_FILE_PATH = (() => {
  const raw = trimString(process.env.CLIAN_HUB_CONFIG);
  if (raw) return path.resolve(raw);

  const dataDir = trimString(process.env.CLIAN_HUB_DATA_DIR);
  const resolvedDataDir = dataDir ? path.resolve(dataDir) : path.resolve(process.cwd(), '.clian-hub');
  return path.join(resolvedDataDir, 'config.json');
})();

let loadedConfig = loadHubConfigFile(CONFIG_FILE_PATH);
if (!loadedConfig.exists) {
  const bootstrapped = bootstrapHubConfigFile(CONFIG_FILE_PATH);
  if (bootstrapped.written) {
    // eslint-disable-next-line no-console
    console.log(`Created default hub config: ${CONFIG_FILE_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`Generated hub token: ${bootstrapped.token}`);
    // eslint-disable-next-line no-console
    console.log('Set this token in Obsidian mobile: Settings → Clian → Hub access token');
    loadedConfig = loadHubConfigFile(CONFIG_FILE_PATH);
  } else if (bootstrapped.error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to create default hub config: ${CONFIG_FILE_PATH}`);
    // eslint-disable-next-line no-console
    console.error(bootstrapped.error?.message || String(bootstrapped.error));
  }
}
if (loadedConfig.error) {
  // eslint-disable-next-line no-console
  console.error(`Failed to load hub config: ${CONFIG_FILE_PATH}`);
  // eslint-disable-next-line no-console
  console.error(loadedConfig.error?.message || String(loadedConfig.error));
  process.exit(1);
}

const FILE_CONFIG = normalizeHubConfig(loadedConfig.config);

const RESOLVED_CLAUDE_CODE_PATH = resolveClaudeCodePath(
  process.env.CLIAN_HUB_CLAUDE_CODE_PATH ||
  process.env.CLAUDE_CODE_PATH ||
  FILE_CONFIG.claudeCodePath ||
  ''
);

const CONFIG = {
  configPath: CONFIG_FILE_PATH,
  configLoaded: loadedConfig.exists,
  host: trimString(process.env.CLIAN_HUB_HOST) || FILE_CONFIG.host || '0.0.0.0',
  port: parseNumber(process.env.CLIAN_HUB_PORT, FILE_CONFIG.port ?? 3006),
  baseToken: trimString(process.env.CLIAN_HUB_TOKEN) || FILE_CONFIG.baseToken || '',
  debug: (() => {
    const envValue = trimString(process.env.CLIAN_HUB_DEBUG);
    if (envValue) return envValue === '1';
    return FILE_CONFIG.debug ?? false;
  })(),
  dataDir: (() => {
    const dataDir = process.env.CLIAN_HUB_DATA_DIR || '';
    if (dataDir) {
      return path.resolve(dataDir);
    }
    if (FILE_CONFIG.dataDir) {
      return path.resolve(FILE_CONFIG.dataDir);
    }
    return path.resolve(process.cwd(), '.clian-hub');
  })(),
  defaultCwd: process.env.CLIAN_HUB_CWD
    ? path.resolve(process.env.CLIAN_HUB_CWD)
    : (FILE_CONFIG.defaultCwd ? path.resolve(FILE_CONFIG.defaultCwd) : process.cwd()),
  claudeCodePath: RESOLVED_CLAUDE_CODE_PATH,
  model: trimString(process.env.CLIAN_HUB_MODEL) || FILE_CONFIG.model || null,
  claudeApprovalMode:
    normalizePermissionMode(process.env.CLIAN_HUB_CLAUDE_APPROVAL_MODE) ||
    normalizePermissionMode(FILE_CONFIG.claudeApprovalMode) ||
    'yolo',
  codexCommand: (
    trimString(process.env.CLIAN_HUB_CODEX_COMMAND) ||
    trimString(process.env.CODEX_COMMAND) ||
    FILE_CONFIG.codexCommand ||
    'codex'
  ).trim() || 'codex',
  codexApprovalMode:
    normalizePermissionMode(process.env.CLIAN_HUB_CODEX_APPROVAL_MODE) ||
    normalizePermissionMode(FILE_CONFIG.codexApprovalMode) ||
    'yolo',
  codexSandbox: trimString(process.env.CLIAN_HUB_CODEX_SANDBOX) || FILE_CONFIG.codexSandbox || null,
  geminiCommand: (
    trimString(process.env.CLIAN_HUB_GEMINI_COMMAND) ||
    trimString(process.env.GEMINI_COMMAND) ||
    FILE_CONFIG.geminiCommand ||
    'gemini'
  ).trim() || 'gemini',
  geminiApprovalMode: trimString(process.env.CLIAN_HUB_GEMINI_APPROVAL_MODE) || FILE_CONFIG.geminiApprovalMode || 'yolo',
  geminiSandbox: (() => {
    const envValue = trimString(process.env.CLIAN_HUB_GEMINI_SANDBOX);
    if (envValue) return envValue === '1';
    return FILE_CONFIG.geminiSandbox ?? false;
  })(),
  sseFlushMs: (() => {
    const envValue = trimString(process.env.CLIAN_HUB_SSE_FLUSH_MS);
    if (envValue) return parseNumber(envValue, 0);
    return FILE_CONFIG.sseFlushMs ?? 0;
  })(),
  ssePatchFlushMs: (() => {
    const envValue = trimString(process.env.CLIAN_HUB_SSE_PATCH_FLUSH_MS);
    if (envValue) return parseNumber(envValue, 25);
    return FILE_CONFIG.ssePatchFlushMs ?? 25;
  })(),
  sseMaxBufferBytes: (() => {
    const envValue = trimString(process.env.CLIAN_HUB_SSE_MAX_BUFFER_BYTES);
    if (envValue) return parseNumber(envValue, 2 * 1024 * 1024);
    return FILE_CONFIG.sseMaxBufferBytes ?? 2 * 1024 * 1024;
  })(),
  claudeSettingSources:
    parseSettingSources(process.env.CLIAN_HUB_CLAUDE_SETTING_SOURCES) ||
    FILE_CONFIG.claudeSettingSources ||
    ['user', 'project'],
};

if (!CONFIG.baseToken) {
  // eslint-disable-next-line no-console
  console.error('Missing hub access token.');
  // eslint-disable-next-line no-console
  console.error('Set CLIAN_HUB_TOKEN or add { \"token\": \"...\" } to hub config.');
  // eslint-disable-next-line no-console
  console.error(`Config file: ${CONFIG_FILE_PATH}`);
  process.exit(1);
}

// ============================================
// Utilities
// ============================================

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += String(chunk); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ============================================
// SSE (Server-Sent Events)
// ============================================

const sseSubscribers = new Map();

const SSE_KEEP_ALIVE_LINE = ': keep-alive\n\n';

function serializeSseData(payload) {
  try {
    const json = JSON.stringify(payload);
    return `data: ${json}\n\n`;
  } catch {
    return null;
  }
}

function scheduleSseFlush(id) {
  const sub = sseSubscribers.get(id);
  if (!sub || sub.closed) return;
  if (sub.flushScheduled || sub.draining) return;
  sub.flushScheduled = true;

  const delayMs = Number.isFinite(CONFIG.sseFlushMs) ? Math.max(0, CONFIG.sseFlushMs) : 0;
  sub.flushTimer = setTimeout(() => {
    const current = sseSubscribers.get(id);
    if (!current || current.closed) return;
    current.flushTimer = null;
    current.flushScheduled = false;
    flushSseSubscriber(id);
  }, delayMs);
}

function flushSseSubscriber(id) {
  const sub = sseSubscribers.get(id);
  if (!sub || sub.closed) return;
  if (sub.draining) return;

  const res = sub.res;
  if (!res || res.writableEnded || res.destroyed) {
    closeSseSubscriber(id);
    return;
  }

  if (!Array.isArray(sub.buffer) || sub.buffer.length === 0) return;

  const chunk = sub.buffer.join('');
  sub.buffer.length = 0;
  sub.bufferBytes = 0;

  try {
    const ok = res.write(chunk);
    if (!ok) {
      sub.draining = true;
      res.once('drain', () => {
        const current = sseSubscribers.get(id);
        if (!current || current.closed) return;
        current.draining = false;
        flushSseSubscriber(id);
      });
    }
  } catch {
    closeSseSubscriber(id);
  }
}

function enqueueSseLine(id, line) {
  const sub = sseSubscribers.get(id);
  if (!sub || sub.closed) return;
  if (!line) return;

  if (!Array.isArray(sub.buffer)) sub.buffer = [];
  if (!Number.isFinite(sub.bufferBytes)) sub.bufferBytes = 0;

  sub.buffer.push(line);
  sub.bufferBytes += Buffer.byteLength(line);

  const maxBytes = Number.isFinite(CONFIG.sseMaxBufferBytes)
    ? Math.max(32 * 1024, CONFIG.sseMaxBufferBytes)
    : 2 * 1024 * 1024;

  if (sub.bufferBytes > maxBytes) {
    closeSseSubscriber(id);
    return;
  }

  scheduleSseFlush(id);
}

function closeSseSubscriber(id) {
  const sub = sseSubscribers.get(id);
  if (!sub) return;
  sseSubscribers.delete(id);
  sub.closed = true;
  try { sub.buffer = []; } catch { /* ignore */ }
  try { sub.bufferBytes = 0; } catch { /* ignore */ }
  try { clearInterval(sub.keepAliveTimer); } catch { /* ignore */ }
  try { clearTimeout(sub.flushTimer); } catch { /* ignore */ }
  try { sub.res.end(); } catch { /* ignore */ }
}

function shouldSendSse(sub, evt) {
  if (!evt || typeof evt !== 'object') return false;
  const type = typeof evt.type === 'string' ? evt.type : '';
  if (!type) return false;

  if (type === 'session_added' || type === 'session_removed') {
    return sub.all === true;
  }

  if (type === 'session_updated') {
    const sessionId = typeof evt.sessionId === 'string' ? evt.sessionId : null;
    return sub.all === true || (!!sessionId && sub.sessionId === sessionId);
  }

  if (type === 'message_added' || type === 'message_updated' || type === 'message_patch') {
    const sessionId = typeof evt.sessionId === 'string' ? evt.sessionId : null;
    return !!sessionId && sub.sessionId === sessionId;
  }

  return false;
}

function publishSseEvent(namespace, evt) {
  if (!namespace) return;
  let line = null;
  for (const [id, sub] of sseSubscribers.entries()) {
    if (!sub || sub.namespace !== namespace) continue;
    if (!shouldSendSse(sub, evt)) continue;
    if (!line) line = serializeSseData(evt);
    if (!line) return;
    enqueueSseLine(id, line);
  }
}

function listCommandNamesForCwd(cwd) {
  const root = findVaultRootFromCwd(cwd);
  const candidates = [
    path.join(root, '.clian', 'commands'),
    path.join(root, '.claude', 'commands'),
  ];

  const names = [];
  for (const dirPath of candidates) {
    names.push(...listCommandNamesFromDir(dirPath));
  }

  return dedupeAndSortCommandNames(names);
}

const FILTERED_CLAUDE_SDK_COMMANDS = new Set([
  'context',
  'cost',
  'init',
  'keybindings-help',
  'release-notes',
  'security-review',
]);

function normalizeSlashCommandName(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.startsWith('/') ? raw.slice(1).trim() : raw;
}

function dedupeAndSortCommandNames(names, options = {}) {
  const filter = options.filter instanceof Set ? options.filter : null;
  const seen = new Set();
  const out = [];

  for (const name of Array.isArray(names) ? names : []) {
    const normalized = normalizeSlashCommandName(name);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (filter && filter.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(normalized);
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function normalizeSupportedSlashCommands(names) {
  return dedupeAndSortCommandNames(names, { filter: FILTERED_CLAUDE_SDK_COMMANDS });
}

function areStringArraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function getCachedClaudeCommandNames(excludeRunner = null) {
  for (const nsMap of sessionsByNamespace.values()) {
    for (const runner of nsMap.values()) {
      if (!runner || runner === excludeRunner || runner.flavor !== 'claude') continue;
      const cached = normalizeSupportedSlashCommands(runner.supportedSlashCommands);
      if (cached.length > 0) {
        return cached;
      }
    }
  }

  return [];
}

function getCommandNamesForSessionRunner(runner) {
  const fromCwd = listCommandNamesForCwd(runner?.cwd || '');
  let fromSdk = [];

  if (runner?.flavor === 'claude') {
    fromSdk = normalizeSupportedSlashCommands(runner.supportedSlashCommands);
    if (fromSdk.length === 0) {
      fromSdk = getCachedClaudeCommandNames(runner);
    }
  }

  return dedupeAndSortCommandNames([...fromSdk, ...fromCwd]);
}

function findVaultRootFromCwd(cwd) {
  let current = cwd;
  try {
    current = path.resolve(cwd);
  } catch {
    return cwd;
  }

  for (let i = 0; i < 40; i++) {
    try {
      if (
        fs.existsSync(path.join(current, '.clian')) ||
        fs.existsSync(path.join(current, '.obsidian'))
      ) {
        return current;
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(current);
    if (!parent || parent === current) {
      return current;
    }
    current = parent;
  }

  return current;
}

function hasWorkspaceMarkers(dirPath) {
  const dir = trimString(dirPath);
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, '.clian')) || fs.existsSync(path.join(dir, '.obsidian'));
  } catch {
    return false;
  }
}

function isWorkspaceCwd(cwd) {
  const resolved = trimString(cwd);
  if (!resolved) return false;
  return hasWorkspaceMarkers(findVaultRootFromCwd(resolved));
}

function getPreferredSessionCwd(nsMap, requestedCwd = '') {
  const requested = trimString(requestedCwd);
  if (requested && isWorkspaceCwd(requested)) {
    return requested;
  }

  const runners = Array.from(nsMap.values())
    .filter((runner) => runner && typeof runner.cwd === 'string' && runner.cwd.trim())
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));

  for (const runner of runners) {
    if (isWorkspaceCwd(runner.cwd)) {
      return runner.cwd;
    }
  }

  return requested || '';
}

function repairRunnerCwdIfNeeded(nsMap, runner) {
  if (!runner || isWorkspaceCwd(runner.cwd)) {
    return false;
  }

  const preferredCwd = getPreferredSessionCwd(nsMap, '');
  if (!preferredCwd || preferredCwd === runner.cwd) {
    return false;
  }

  runner.cwd = preferredCwd;
  runner.updatedAt = Date.now();
  persistSessionsFromMemory();
  return true;
}

function listCommandNamesFromDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
  } catch {
    return [];
  }

  const out = [];
  const stack = [{ abs: dirPath, rel: '' }];

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) continue;

    let entries;
    try {
      entries = fs.readdirSync(next.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry) continue;
      const name = entry.name || '';
      if (!name) continue;

      const abs = path.join(next.abs, name);
      if (entry.isDirectory()) {
        const rel = next.rel ? `${next.rel}/${name}` : name;
        stack.push({ abs, rel });
        continue;
      }

      if (!entry.isFile()) continue;
      if (!name.toLowerCase().endsWith('.md')) continue;

      const base = name.slice(0, -3);
      if (!base) continue;

      const relName = next.rel ? `${next.rel}/${base}` : base;
      out.push(relName);
    }
  }

  return out;
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function parseAccessToken(value) {
  const trimmed = String(value || '').trim();
  const idx = trimmed.indexOf(':');
  if (idx === -1) {
    return { baseToken: trimmed, namespace: 'default' };
  }
  return {
    baseToken: trimmed.slice(0, idx),
    namespace: trimmed.slice(idx + 1) || 'default',
  };
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToString(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signJwtHs256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const sig = createHmac('sha256', secret).update(data).digest();
  const sigB64 = base64UrlEncode(sig);
  return `${data}.${sigB64}`;
}

function verifyJwtHs256(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;
  const expected = base64UrlEncode(createHmac('sha256', secret).update(data).digest());
  if (expected !== sigB64) return null;

  const payloadText = base64UrlDecodeToString(payloadB64);
  const payload = safeJsonParse(payloadText);
  if (!payload || typeof payload !== 'object') return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= nowSec) return null;

  return payload;
}

function getJwtSecretForBaseToken(baseToken) {
  // Derive a stable secret from the shared base token. (This is not meant to be cryptographically fancy.)
  return createHmac('sha256', 'clian-hub').update(baseToken).digest();
}

function buildStreamedBlockKey(parentToolUseId, contentBlockIndex, kind) {
  return `${parentToolUseId || 'main'}:${contentBlockIndex}:${kind}`;
}

function computePrefixDelta(previousText, nextText) {
  const prev = String(previousText || '');
  const next = String(nextText || '');
  if (!next) return '';
  if (!prev) return next;
  return next.startsWith(prev) ? next.slice(prev.length) : next;
}

function extractTextFromAssistantMessage(sdkAssistantMessage) {
  const message = sdkAssistantMessage?.message;
  const content = message?.content;
  if (!Array.isArray(content)) return { text: '', thinking: '' };

  let text = '';
  let thinking = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinking += block.thinking;
    }
  }
  return { text, thinking };
}

function isAllowedFlavor(value) {
  return value === 'claude' || value === 'codex' || value === 'gemini';
}

function tailText(value, maxLen) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return text.slice(text.length - maxLen);
}

function normalizeDelta(prevText, nextText) {
  return computePrefixDelta(prevText, nextText);
}

function resolveClaudeThinkingTokens(thinkingMode) {
  const raw = typeof thinkingMode === 'string' ? thinkingMode.trim().toLowerCase() : '';
  if (!raw || raw === 'default' || raw === 'auto') return null;
  if (raw === 'off' || raw === 'none' || raw === '0') return null;
  const mapping = {
    low: 4000,
    medium: 8000,
    med: 8000,
    high: 16000,
    xhigh: 32000,
    ultra: 32000,
  };
  return mapping[raw] ?? null;
}

function normalizeCodexThinkingMode(thinkingMode) {
  const raw = typeof thinkingMode === 'string' ? thinkingMode.trim().toLowerCase() : '';
  if (!raw || raw === 'default' || raw === 'auto') return null;
  const allowed = new Set(['low', 'medium', 'high', 'xhigh']);
  return allowed.has(raw) ? raw : null;
}

function normalizePermissionMode(permissionMode) {
  const raw = typeof permissionMode === 'string' ? permissionMode.trim().toLowerCase() : '';
  if (!raw) return null;
  if (raw === 'yolo' || raw === 'bypasspermissions' || raw === 'dontask') return 'yolo';
  if (raw === 'plan') return 'plan';
  if (raw === 'normal' || raw === 'safe' || raw === 'acceptedits' || raw === 'default') return 'normal';
  return null;
}

function resolveClaudeApprovalMode(permissionMode, fallbackMode) {
  return normalizePermissionMode(permissionMode) || normalizePermissionMode(fallbackMode) || 'yolo';
}

function buildCodexPermissionArgs(permissionMode, explicitSandbox) {
  if (normalizePermissionMode(permissionMode) === 'yolo') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }

  return ['--ask-for-approval', 'on-request', '--sandbox', explicitSandbox || 'workspace-write'];
}

function normalizeGeminiApprovalMode(approvalMode) {
  const raw = typeof approvalMode === 'string' ? approvalMode.trim().toLowerCase() : '';
  if (!raw) return null;
  if (raw === 'auto_edit' || raw === 'autoedit') return 'auto_edit';
  if (raw === 'default' || raw === 'plan' || raw === 'yolo') return raw;
  return null;
}

function resolveGeminiApprovalMode(permissionMode, fallbackApprovalMode) {
  const normalizedPermissionMode = normalizePermissionMode(permissionMode);
  if (normalizedPermissionMode === 'yolo') {
    return 'yolo';
  }

  if (normalizedPermissionMode === 'plan') {
    return 'plan';
  }

  if (normalizedPermissionMode === 'normal') {
    return 'default';
  }

  return normalizeGeminiApprovalMode(fallbackApprovalMode) || 'yolo';
}

function normalizeGeminiThinkingMode(thinkingMode) {
  const raw = typeof thinkingMode === 'string' ? thinkingMode.trim().toLowerCase() : '';
  if (!raw) return null;
  const allowed = new Set(['auto', 'off', 'lite', 'default', 'high', 'unlimited']);
  return allowed.has(raw) ? raw : null;
}

function resolveGeminiThinkingBudget(mode) {
  switch (mode) {
    case 'off':
      return 0;
    case 'lite':
      return 512;
    case 'default':
      return 8192;
    case 'high':
      return 16384;
    case 'unlimited':
      return -1;
    default:
      return null;
  }
}

function stripJsonComments(text) {
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

function safeParseJsonWithComments(text) {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function upsertGeminiThinkingBudgetOverride(settings, budget, createIfMissing) {
  if (!isRecord(settings)) return false;

  let changed = false;
  const existingModelConfigs = isRecord(settings.modelConfigs) ? settings.modelConfigs : null;
  if (!existingModelConfigs && !createIfMissing) return false;

  const modelConfigs = existingModelConfigs ?? {};
  if (!existingModelConfigs) {
    settings.modelConfigs = modelConfigs;
    changed = true;
  }

  const existingOverrides = Array.isArray(modelConfigs.customOverrides) ? modelConfigs.customOverrides : null;
  if (!existingOverrides && !createIfMissing) return false;

  const overrides = existingOverrides ?? [];
  if (!existingOverrides) {
    modelConfigs.customOverrides = overrides;
    changed = true;
  }

  let target = null;
  for (const entry of overrides) {
    if (!isRecord(entry)) continue;
    const match = entry.match;
    if (isRecord(match) && match.model === 'chat-base-2.5') {
      target = entry;
      break;
    }
  }

  if (!target) {
    if (!createIfMissing) return false;

    overrides.push({
      match: { model: 'chat-base-2.5' },
      modelConfig: {
        generateContentConfig: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: budget,
          },
        },
      },
    });

    return true;
  }

  const modelConfig = isRecord(target.modelConfig) ? target.modelConfig : {};
  if (!isRecord(target.modelConfig)) {
    target.modelConfig = modelConfig;
    changed = true;
  }

  const generateContentConfig = isRecord(modelConfig.generateContentConfig) ? modelConfig.generateContentConfig : {};
  if (!isRecord(modelConfig.generateContentConfig)) {
    modelConfig.generateContentConfig = generateContentConfig;
    changed = true;
  }

  const thinkingConfig = isRecord(generateContentConfig.thinkingConfig) ? generateContentConfig.thinkingConfig : {};
  if (!isRecord(generateContentConfig.thinkingConfig)) {
    generateContentConfig.thinkingConfig = thinkingConfig;
    changed = true;
  }

  if (thinkingConfig.includeThoughts !== true) {
    thinkingConfig.includeThoughts = true;
    changed = true;
  }

  if (thinkingConfig.thinkingBudget !== budget) {
    thinkingConfig.thinkingBudget = budget;
    changed = true;
  }

  return changed;
}

function applyGeminiThinkingOverride(cwd, thinkingMode) {
  const normalizedMode = normalizeGeminiThinkingMode(thinkingMode);
  if (!normalizedMode) return;

  const desiredBudget = resolveGeminiThinkingBudget(normalizedMode);
  if (desiredBudget === null) return;

  const settingsPath = path.join(cwd, '.gemini', 'settings.json');
  let existingText = '';
  let existing = null;

  try {
    if (fs.existsSync(settingsPath)) {
      existingText = fs.readFileSync(settingsPath, 'utf8');
      existing = safeParseJsonWithComments(existingText);
    }
  } catch {
    // ignore read failures
  }

  const createIfMissing = normalizedMode !== 'auto';
  const root = isRecord(existing) ? existing : {};
  const changed = upsertGeminiThinkingBudgetOverride(root, desiredBudget, createIfMissing);
  if (!changed) return;

  try {
    ensureDir(path.dirname(settingsPath));
    fs.writeFileSync(settingsPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  } catch {
    // ignore write failures
  }
}

function splitCommandString(cmdStr) {
  const parts = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
      continue;
    }

    if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
      continue;
    }

    if (/\s/.test(char) && !inQuote) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function parseCommand(command) {
  const parts = splitCommandString(String(command || '').trim());
  if (parts.length === 0) return { cmd: '', args: [] };
  return { cmd: parts[0], args: parts.slice(1) };
}

function runJsonlProcess({ command, args, cwd, stdinText, env, signal, onChild, onJson }) {
  return new Promise((resolve) => {
    let stderrText = '';
    let wasAborted = false;

    const parsed = parseCommand(command);
    const rawCmd = parsed.cmd || String(command || '').trim();
    const cmd = resolveWindowsShim(rawCmd) || rawCmd;
    const cmdArgs = parsed.args || [];

    const child = spawn(cmd, [...cmdArgs, ...args], {
      cwd,
      env: env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    try { onChild?.(child); } catch { /* ignore */ }

    const onAbort = () => {
      wasAborted = true;
      try { child.kill(); } catch { /* ignore */ }
    };

    if (signal?.aborted) {
      onAbort();
    } else {
      try { signal?.addEventListener?.('abort', onAbort, { once: true }); } catch { /* ignore */ }
    }

    const cleanup = () => {
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    };

    child.on('error', (err) => {
      cleanup();
      resolve({
        ok: false,
        exitCode: null,
        errorMessage: err?.message || 'Failed to spawn process',
        stderrText,
        aborted: wasAborted,
      });
    });

    child.stderr.on('data', (chunk) => {
      stderrText = tailText(stderrText + String(chunk), 8_000);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const evt = safeJsonParse(String(line));
      if (!evt || typeof evt !== 'object') return;
      try {
        onJson(evt);
      } catch {
        // ignore handler errors
      }
    });

    child.on('close', (code) => {
      cleanup();
      try { rl.close(); } catch { /* ignore */ }
      resolve({
        ok: code === 0,
        exitCode: typeof code === 'number' ? code : null,
        errorMessage: code === 0 ? null : `Process exited with code ${code}`,
        stderrText,
        aborted: wasAborted,
      });
    });

    try {
      if (stdinText !== undefined && stdinText !== null) {
        child.stdin.write(String(stdinText));
      }
    } catch {
      // ignore
    } finally {
      try { child.stdin.end(); } catch { /* ignore */ }
    }
  });
}

// ============================================
// MCP (shared .clian/mcp.json)
// ============================================

const MCP_CONFIG_REL_PATH = path.join('.clian', 'mcp.json');
const CLAUDE_MCP_CONFIG_REL_PATH = path.join('.claude', 'mcp.json');
const CODEX_CONFIG_REL_PATH = path.join('.codex', 'config.toml');
const CODEX_MCP_WRAPPER_REL_PATH = path.join('.clian', 'bin', 'codex-mcp-wrapper.cjs');
const GEMINI_SETTINGS_REL_PATH = path.join('.gemini', 'settings.json');

const CODEX_MCP_BLOCK_START = '# BEGIN CLIAN MCP SERVERS';
const CODEX_MCP_BLOCK_END = '# END CLIAN MCP SERVERS';
const CODEX_WRAPPED_STDIO_SERVER_NAMES = new Set(['grok-search']);
const CLAUDE_USER_SETTINGS_PATH = path.join(os.homedir(), '.claude.json');

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

function isValidMcpServerConfig(config) {
  if (!isRecord(config)) return false;
  if (typeof config.command === 'string' && config.command.trim()) return true;
  if (typeof config.url === 'string' && config.url.trim()) return true;
  return false;
}

function getMcpServerType(config) {
  if (!isRecord(config)) return 'stdio';
  if (config.type === 'sse') return 'sse';
  if (config.type === 'http') return 'http';
  if ('url' in config) return 'http';
  return 'stdio';
}

function sanitizeFsSegment(segment) {
  const s = String(segment || '').trim();
  if (!s) return '';
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function normalizeRelativePosixPath(inputPath) {
  const raw = String(inputPath || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('/')) return '';
  if (/^[a-zA-Z]:/.test(raw)) return '';

  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  for (const part of parts) {
    if (part === '.' || part === '..') return '';
  }

  const sanitized = parts.map(sanitizeFsSegment).filter(Boolean);
  return sanitized.join('/');
}

function loadClianMcpConfigFromCwd(cwd) {
  const filePath = path.join(cwd, MCP_CONFIG_REL_PATH);
  try {
    if (!fs.existsSync(filePath)) {
      return { exists: false, filePath, raw: null, text: '', servers: [] };
    }

    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = safeJsonParse(text);
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      return { exists: true, filePath, raw: null, text, servers: [] };
    }

    const mcpServers = parsed.mcpServers;
    const clianMeta = isRecord(parsed._clian) && isRecord(parsed._clian.servers) ? parsed._clian.servers : {};
    const servers = [];

    for (const [nameRaw, config] of Object.entries(mcpServers)) {
      const name = String(nameRaw || '').trim();
      if (!name) continue;
      if (!isValidMcpServerConfig(config)) continue;

      const meta = isRecord(clianMeta[name]) ? clianMeta[name] : {};
      const enabled = typeof meta.enabled === 'boolean' ? meta.enabled : true;
      const contextSaving = typeof meta.contextSaving === 'boolean' ? meta.contextSaving : true;
      const disabledTools = Array.isArray(meta.disabledTools)
        ? meta.disabledTools
          .filter((tool) => typeof tool === 'string')
          .map((tool) => tool.trim())
          .filter(Boolean)
        : [];
      const description = typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : null;

      servers.push({
        name,
        config,
        type: getMcpServerType(config),
        enabled,
        contextSaving,
        disabledTools,
        description,
      });
    }

    servers.sort((a, b) => a.name.localeCompare(b.name));
    return { exists: true, filePath, raw: parsed, text, servers };
  } catch {
    return { exists: false, filePath, raw: null, text: '', servers: [] };
  }
}

function extractMcpMentions(text, validNames) {
  const mentions = new Set();
  const regex = /@([a-zA-Z0-9._-]+)(?!\/)/g;
  let match;

  while ((match = regex.exec(String(text || ''))) !== null) {
    const name = match[1];
    if (validNames.has(name)) {
      mentions.add(name);
    }
  }

  return mentions;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function transformMcpMentions(text, validNames) {
  const input = String(text || '');
  if (!validNames || validNames.size === 0) return input;

  const sortedNames = Array.from(validNames).sort((a, b) => b.length - a.length);
  const escapedNames = sortedNames.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `@(${escapedNames})(?! MCP)(?!/)(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`,
    'g'
  );

  return input.replace(pattern, '@$1 MCP');
}

function buildActiveMcpServersForPrompt(servers, prompt) {
  const enabled = servers.filter((s) => s && s.enabled);
  const contextSavingNames = new Set(enabled.filter((s) => s.contextSaving).map((s) => s.name));
  const mentions = extractMcpMentions(prompt, contextSavingNames);
  const transformedPrompt = transformMcpMentions(prompt, contextSavingNames);

  const activeServers = {};
  for (const server of enabled) {
    if (server.contextSaving && !mentions.has(server.name)) continue;
    activeServers[server.name] = server.config;
  }

  return { activeServers, transformedPrompt };
}

function writeFileIfChanged(absPath, nextContent) {
  try {
    const normalized = nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`;
    if (fs.existsSync(absPath)) {
      try {
        const current = fs.readFileSync(absPath, 'utf8');
        if (current === normalized) {
          return;
        }
      } catch {
        // ignore read failures
      }
    } else {
      try { ensureDir(path.dirname(absPath)); } catch { /* ignore */ }
    }

    fs.writeFileSync(absPath, normalized, 'utf8');
  } catch {
    // ignore write failures
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlKey(key) {
  const isBare = /^[A-Za-z0-9_-]+$/.test(key);
  return isBare ? key : tomlString(key);
}

function tomlInlineTable(record) {
  const entries = Object.entries(record).filter(([, v]) => typeof v === 'string');
  if (entries.length === 0) return '{}';
  const parts = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return `{ ${parts.join(', ')} }`;
}

function tomlArray(values) {
  return JSON.stringify(values);
}

function normalizeStringRecord(value) {
  if (!isRecord(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

let cachedClaudeUserMcpServers = null;

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string');
}

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
];

const GEMINI_STDIO_LOCAL_FALLBACK_KEYS = [
  'cwd',
  ...GEMINI_COMMON_LOCAL_FALLBACK_KEYS,
];

function cloneJsonLike(value) {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (value && typeof value === 'object') {
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}

function copyGeminiLocalFallbackFields(target, source, keys) {
  if (!isRecord(source)) return;

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

function getGeminiLocalMcpServers(parsed) {
  const raw = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
  if (!raw) return {};

  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (isRecord(value)) {
      out[name] = value;
    }
  }
  return out;
}

function mergeGeminiStringRecord(existingValue, explicitValue) {
  const existing = normalizeStringRecord(existingValue) || {};
  const explicit = normalizeStringRecord(explicitValue) || {};
  const merged = { ...existing, ...explicit };
  return Object.keys(merged).length > 0 ? merged : null;
}

function sameStringArrays(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function loadClaudeUserMcpServers() {
  if (cachedClaudeUserMcpServers) {
    return cachedClaudeUserMcpServers;
  }

  try {
    if (!fs.existsSync(CLAUDE_USER_SETTINGS_PATH)) {
      cachedClaudeUserMcpServers = {};
      return cachedClaudeUserMcpServers;
    }

    const raw = safeJsonParse(fs.readFileSync(CLAUDE_USER_SETTINGS_PATH, 'utf8'));
    const mcpServers = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : null;
    if (!mcpServers) {
      cachedClaudeUserMcpServers = {};
      return cachedClaudeUserMcpServers;
    }

    const out = {};
    for (const [name, value] of Object.entries(mcpServers)) {
      if (!isRecord(value) || typeof value.command !== 'string' || !value.command.trim()) continue;
      const env = normalizeStringRecord(value.env);
      if (!env) continue;

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

function getClaudeUserEnvFallback(server) {
  const name = String(server.name || '').trim();
  const config = server.config;
  if (!name || !isRecord(config) || typeof config.command !== 'string') return null;

  const candidate = loadClaudeUserMcpServers()[name];
  if (!candidate || candidate.command !== config.command) return null;

  const args = Array.isArray(config.args)
    ? config.args.filter((entry) => typeof entry === 'string')
    : [];
  if (!sameStringArrays(args, candidate.args)) return null;

  return candidate.env;
}

function getCodexInheritedEnvVarNames(server, explicitEnv) {
  const fallbackEnv = getClaudeUserEnvFallback(server);
  if (!fallbackEnv) return [];

  const existing = explicitEnv || {};
  return Object.keys(fallbackEnv)
    .filter((key) => !Object.prototype.hasOwnProperty.call(existing, key))
    .sort((a, b) => a.localeCompare(b));
}

function withClaudeUserMcpEnv(baseEnv) {
  const out = { ...baseEnv };
  const userServers = loadClaudeUserMcpServers();

  for (const server of Object.values(userServers)) {
    for (const [key, value] of Object.entries(server.env || {})) {
      if (typeof out[key] !== 'string' || !out[key]) {
        out[key] = value;
      }
    }
  }

  return out;
}

function shouldUseCodexMcpWrapper(server, platform = process.platform) {
  if (platform !== 'win32') return false;
  const name = String(server.name || '').trim().toLowerCase();
  if (CODEX_WRAPPED_STDIO_SERVER_NAMES.has(name)) return true;
  const config = server.config;
  if (!isRecord(config) || typeof config.command !== 'string') return false;
  const command = config.command.trim().toLowerCase();
  return command === 'uvx' || command.endsWith('/uvx.exe') || command.endsWith('\\uvx.exe');
}

function getCodexWrapperEnv(server) {
  const config = server.config;
  const base = normalizeStringRecord(isRecord(config) ? config.env : null) || {};
  if (!isRecord(config) || typeof config.command !== 'string') {
    return Object.keys(base).length > 0 ? base : null;
  }

  const command = config.command.trim().toLowerCase();
  if (process.platform === 'win32' && (command === 'uvx' || command.endsWith('/uvx.exe') || command.endsWith('\\uvx.exe'))) {
    if (!base.PYTHONIOENCODING) base.PYTHONIOENCODING = 'utf-8';
    if (!base.PYTHONUTF8) base.PYTHONUTF8 = '1';
  }

  return Object.keys(base).length > 0 ? base : null;
}

function buildCodexMcpBlock(servers, cwd) {
  const lines = [];
  lines.push(CODEX_MCP_BLOCK_START);
  lines.push('# Managed by Clian. Edit `.clian/mcp.json` instead.');

  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  for (const server of sorted) {
    const name = String(server.name || '').trim();
    if (!name) continue;

    const config = server.config;
    lines.push('');
    lines.push(`[mcp_servers.${tomlString(name)}]`);
    lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`);

    if (isRecord(config) && typeof config.command === 'string') {
      const useWrapper = shouldUseCodexMcpWrapper(server);
      if (useWrapper) {
        const wrapperPath = path.join(cwd, CODEX_MCP_WRAPPER_REL_PATH).replace(/\\/g, '/');
        lines.push('command = "node"');
        lines.push(`args = ${tomlArray([wrapperPath, '--', config.command, ...(Array.isArray(config.args) ? config.args : [])])}`);
      } else {
        lines.push(`command = ${tomlString(config.command)}`);
        if (Array.isArray(config.args) && config.args.length > 0) {
          lines.push(`args = ${tomlArray(config.args)}`);
        }
      }
      const env = useWrapper ? getCodexWrapperEnv(server) : normalizeStringRecord(config.env);
      if (env) {
        lines.push(`env = ${tomlInlineTable(env)}`);
      }
      const envVars = getCodexInheritedEnvVarNames(server, env);
      if (envVars.length > 0) {
        lines.push(`env_vars = ${tomlArray(envVars)}`);
      }
    } else if (isRecord(config) && typeof config.url === 'string') {
      lines.push(`url = ${tomlString(config.url)}`);
      const headers = normalizeStringRecord(config.headers);
      if (headers) {
        lines.push(`http_headers = ${tomlInlineTable(headers)}`);
      }
    }

    const disabledTools = Array.isArray(server.disabledTools)
      ? server.disabledTools.map((t) => String(t).trim()).filter(Boolean)
      : [];
    if (disabledTools.length > 0) {
      lines.push(`disabled_tools = ${tomlArray(disabledTools)}`);
    }
  }

  lines.push('');
  lines.push(CODEX_MCP_BLOCK_END);
  return lines.join('\n');
}

function replaceOrAppendManagedBlock(existing, block) {
  const pattern = new RegExp(
    `${escapeRegExp(CODEX_MCP_BLOCK_START)}[\\s\\S]*?${escapeRegExp(CODEX_MCP_BLOCK_END)}`,
    'm'
  );

  if (pattern.test(existing)) {
    const replaced = existing.replace(pattern, block);
    return replaced.trimEnd() + '\n';
  }

  if (!String(existing || '').trim()) {
    return block.trimEnd() + '\n';
  }

  return String(existing || '').trimEnd() + '\n\n' + block.trimEnd() + '\n';
}

function buildGeminiMcpServers(servers, existingServers = {}) {
  const out = {};

  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  for (const server of sorted) {
    if (!server.enabled) continue;

    const name = String(server.name || '').trim();
    if (!name) continue;

    const config = server.config;
    const type = getMcpServerType(config);
    const existing = existingServers[name];
    const disabledTools = Array.isArray(server.disabledTools)
      ? server.disabledTools.map((t) => String(t).trim()).filter(Boolean)
      : [];

    if (isRecord(config) && typeof config.command === 'string') {
      const entry = {};
      copyGeminiLocalFallbackFields(entry, existing, GEMINI_STDIO_LOCAL_FALLBACK_KEYS);
      entry.command = config.command;
      if (Array.isArray(config.args) && config.args.length > 0) {
        entry.args = config.args;
      }
      const env = mergeGeminiStringRecord(existing && existing.env, config.env);
      if (env) {
        entry.env = env;
      }
      if (disabledTools.length > 0) {
        entry.excludeTools = disabledTools;
      }
      out[name] = entry;
      continue;
    }

    if (!isRecord(config) || typeof config.url !== 'string' || !config.url) continue;
    const headers = normalizeStringRecord(config.headers);
    const mergedHeaders = mergeGeminiStringRecord(existing && existing.headers, headers);
    const entry = {};
    copyGeminiLocalFallbackFields(entry, existing, GEMINI_COMMON_LOCAL_FALLBACK_KEYS);
    Object.assign(entry, {
      ...(type === 'sse' ? { url: config.url } : { httpUrl: config.url }),
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      ...(disabledTools.length > 0 ? { excludeTools: disabledTools } : {}),
    });

    out[name] = entry;
  }

  return out;
}

function syncMcpFromCwd(cwd, loaded) {
  const config = loaded || loadClianMcpConfigFromCwd(cwd);
  if (!config.exists || !config.text || !Array.isArray(config.servers) || config.servers.length === 0) {
    return;
  }

  // Claude Code: keep a copy for CLI consumers (best-effort; ignore if not needed).
  writeFileIfChanged(path.join(cwd, CLAUDE_MCP_CONFIG_REL_PATH), config.text);

  // Codex wrapper: filter noisy stdout from certain stdio MCP servers.
  writeFileIfChanged(path.join(cwd, CODEX_MCP_WRAPPER_REL_PATH), CODEX_MCP_WRAPPER_SCRIPT);

  // Codex: managed TOML block
  try {
    const absPath = path.join(cwd, CODEX_CONFIG_REL_PATH);
    const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    const block = buildCodexMcpBlock(config.servers, cwd);
    const next = replaceOrAppendManagedBlock(existing, block);
    writeFileIfChanged(absPath, next);
  } catch {
    // ignore
  }

  // Gemini: write settings.json mcpServers
  try {
    const absPath = path.join(cwd, GEMINI_SETTINGS_REL_PATH);
    const existingText = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    let parsed = {};
    if (String(existingText || '').trim()) {
      const raw = safeParseJsonWithComments(existingText) || safeJsonParse(existingText);
      if (isRecord(raw)) {
        parsed = raw;
      }
    }

    const existingGeminiServers = getGeminiLocalMcpServers(parsed);

    const next = {
      ...parsed,
      mcpServers: buildGeminiMcpServers(config.servers, existingGeminiServers),
    };

    writeFileIfChanged(absPath, JSON.stringify(next, null, 2));
  } catch {
    // ignore
  }
}

// ============================================
// Persistence
// ============================================

const STATE_PATH = path.join(CONFIG.dataDir, 'state.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return { sessions: {} };
    }
    const text = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object') return { sessions: {} };
    if (!parsed.sessions || typeof parsed.sessions !== 'object') return { sessions: {} };
    return parsed;
  } catch {
    return { sessions: {} };
  }
}

function saveState(state) {
  try {
    ensureDir(CONFIG.dataDir);
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // ignore persistence errors
  }
}

function getMessagesPath(namespace, sessionId) {
  const safeNs = namespace.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(CONFIG.dataDir, 'messages', safeNs, `${safeId}.jsonl`);
}

function loadMessages(namespace, sessionId) {
  const filePath = getMessagesPath(namespace, sessionId);
  try {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const messages = [];
    for (const line of lines) {
      const msg = safeJsonParse(line);
      if (msg && typeof msg === 'object') messages.push(msg);
    }
    return messages;
  } catch {
    return [];
  }
}

function appendMessage(namespace, sessionId, message) {
  const filePath = getMessagesPath(namespace, sessionId);
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(message)}\n`, 'utf8');
  } catch {
    // ignore
  }
}

// ============================================
// Session model
// ============================================

class SessionRunner {
  constructor(options) {
    this.namespace = options.namespace;
    this.id = options.id;
    this.cwd = options.cwd;
    this.name = options.name || null;
    this.flavor = isAllowedFlavor(options.flavor) ? options.flavor : 'claude';
    this.model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : null;
    this.thinkingMode = typeof options.thinkingMode === 'string' && options.thinkingMode.trim()
      ? options.thinkingMode.trim()
      : null;
    this.permissionMode = normalizePermissionMode(options.permissionMode);

    this.supportedSlashCommands = normalizeSupportedSlashCommands(options.supportedSlashCommands);

    this.createdAt = options.createdAt || Date.now();
    this.updatedAt = options.updatedAt || Date.now();

    this.resumeToken = options.resumeToken || options.resumeId || null;
    this.active = true;
    this.thinking = false;

    this.nextSeq = 1;
    this.messages = [];

    this.queue = [];
    this.processing = false;

    this.agentState = {
      controlledByUser: null,
      requests: {},
      completedRequests: {},
    };

    this.pendingResolvers = new Map();

    this.turnAbortController = null;
    this.activeQuery = null;
    this.activeChild = null;
  }

  loadFromDisk() {
    const diskMessages = loadMessages(this.namespace, this.id);
    this.messages = Array.isArray(diskMessages) ? diskMessages : [];
    let maxSeq = 0;
    for (const msg of this.messages) {
      if (msg && typeof msg.seq === 'number') {
        maxSeq = Math.max(maxSeq, msg.seq);
      }
    }
    this.nextSeq = maxSeq + 1;
  }

  toSessionSummary() {
    const pendingRequestsCount = this.agentState?.requests ? Object.keys(this.agentState.requests).length : 0;
    return {
      id: this.id,
      active: this.active,
      thinking: this.thinking,
      activeAt: this.createdAt,
      updatedAt: this.updatedAt,
      metadata: {
        name: this.name || undefined,
        path: this.cwd,
        machineId: undefined,
        summary: undefined,
        flavor: this.flavor,
      },
      todoProgress: null,
      pendingRequestsCount,
      permissionMode: this.permissionMode || undefined,
      modelMode: this.model || undefined,
      thinkingMode: this.thinkingMode || undefined,
    };
  }

  toSessionDetail() {
    return {
      id: this.id,
      namespace: this.namespace,
      seq: this.messages.length,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      active: this.active,
      activeAt: this.createdAt,
      metadata: {
        path: this.cwd,
        name: this.name || undefined,
        flavor: this.flavor,
      },
      metadataVersion: 1,
      agentState: this.agentState,
      agentStateVersion: 1,
      thinking: this.thinking,
      thinkingAt: this.thinking ? Date.now() : 0,
      todos: undefined,
      permissionMode: this.permissionMode || undefined,
      modelMode: this.model || undefined,
      thinkingMode: this.thinkingMode || undefined,
    };
  }

  getMessagesPage(options) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const beforeSeq = options.beforeSeq === null || options.beforeSeq === undefined
      ? null
      : Number(options.beforeSeq);

    const eligible = beforeSeq === null
      ? this.messages
      : this.messages.filter(m => typeof m.seq === 'number' && m.seq < beforeSeq);

    const pageItems = eligible.slice(Math.max(0, eligible.length - limit));
    const oldestSeq = pageItems.length ? pageItems[0].seq : null;
    const hasMore = eligible.length > pageItems.length;

    return {
      messages: pageItems,
      page: {
        limit,
        beforeSeq,
        nextBeforeSeq: hasMore && oldestSeq ? oldestSeq : null,
        hasMore,
      },
    };
  }

  enqueueUserMessage(text, localId) {
    this.queue.push({ text, localId: localId || null });
    this.updatedAt = Date.now();
    if (!this.processing) {
      void this.processQueue();
    }
  }

  addMessage(record, options) {
    const persist = !options || options.persist !== false;
    const msg = {
      id: randomUUID(),
      seq: this.nextSeq++,
      localId: record.localId ?? null,
      content: record.content,
      createdAt: Date.now(),
    };
    this.messages.push(msg);
    this.updatedAt = Date.now();
    if (persist) {
      appendMessage(this.namespace, this.id, msg);
    }

    publishSseEvent(this.namespace, { type: 'message_added', sessionId: this.id, message: msg });
    return msg;
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;

        this.thinking = true;
        publishSseEvent(this.namespace, {
          type: 'session_updated',
          sessionId: this.id,
          summary: this.toSessionSummary(),
          session: this.toSessionDetail(),
        });
        this.addMessage({ localId: item.localId, content: { role: 'user', content: item.text } });

        const assistantMeta = {};
        let assistantLiveText = '…';
        let assistantBlocks = [];

        const assistantMsg = this.addMessage(
          {
            localId: null,
            content: { role: 'agent', content: assistantLiveText, meta: assistantMeta, blocks: assistantBlocks },
          },
          { persist: false }
        );

        let lastSseAssistantText = assistantLiveText;
        let lastSseAssistantThinking = '';

        let pendingPatchOps = [];
        let patchFlushTimer = null;

        const flushPendingPatchOps = () => {
          if (patchFlushTimer) {
            try { clearTimeout(patchFlushTimer); } catch { /* ignore */ }
            patchFlushTimer = null;
          }

          if (pendingPatchOps.length === 0) return;
          const ops = pendingPatchOps;
          pendingPatchOps = [];

          publishSseEvent(this.namespace, {
            type: 'message_patch',
            sessionId: this.id,
            messageId: assistantMsg.id,
            patch: { ops },
          });
        };

        const schedulePendingPatchOpsFlush = () => {
          if (patchFlushTimer) return;
          const delayMs = Number.isFinite(CONFIG.ssePatchFlushMs) ? Math.max(0, CONFIG.ssePatchFlushMs) : 0;
          patchFlushTimer = setTimeout(() => {
            patchFlushTimer = null;
            if (pendingPatchOps.length === 0) return;
            const ops = pendingPatchOps;
            pendingPatchOps = [];
            publishSseEvent(this.namespace, {
              type: 'message_patch',
              sessionId: this.id,
              messageId: assistantMsg.id,
              patch: { ops },
            });
          }, delayMs);
        };

        let assistantText = '';
        try {
          assistantText = await this.runTurn(item.text, (patch) => {
            if (!patch || typeof patch !== 'object') return;
            if (typeof patch.text === 'string') {
              assistantLiveText = patch.text;
            }
            if (typeof patch.thinking === 'string') {
              assistantMeta.thinking = patch.thinking;
              if (CONFIG.debug) {
                // eslint-disable-next-line no-console
                console.log(`[Thinking] Session: ${this.id}, Thinking length: ${patch.thinking.length}`);
              }
            }
            if (Array.isArray(patch.blocks)) {
              assistantBlocks = patch.blocks;
            }

            assistantMsg.content = { role: 'agent', content: assistantLiveText, meta: assistantMeta, blocks: assistantBlocks };
            this.updatedAt = Date.now();

            const ops = Array.isArray(patch.ops) ? patch.ops : [];
            if (ops.length === 0) {
              const nextText = assistantLiveText;
              const nextThinking = typeof assistantMeta.thinking === 'string' ? assistantMeta.thinking : '';

              if (nextText !== lastSseAssistantText) {
                if (nextText.startsWith(lastSseAssistantText)) {
                  ops.push({ type: 'assistant_text_delta', delta: nextText.slice(lastSseAssistantText.length) });
                } else {
                  ops.push({ type: 'assistant_text_set', text: nextText });
                }
                lastSseAssistantText = nextText;
              }

              if (nextThinking !== lastSseAssistantThinking) {
                if (nextThinking.startsWith(lastSseAssistantThinking)) {
                  ops.push({ type: 'assistant_thinking_delta', delta: nextThinking.slice(lastSseAssistantThinking.length) });
                } else {
                  ops.push({ type: 'assistant_thinking_set', thinking: nextThinking });
                }
                lastSseAssistantThinking = nextThinking;
              }
            }

            if (ops.length > 0) {
              pendingPatchOps.push(...ops);
              schedulePendingPatchOpsFlush();
            }
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          assistantText = message ? `Error:\n${message}` : 'Error: agent failed.';
        }

        flushPendingPatchOps();

        assistantLiveText = assistantText || 'Error: empty response.';
        if ((!assistantBlocks || assistantBlocks.length === 0) && assistantLiveText && assistantLiveText !== '…') {
          assistantBlocks = [{ type: 'text', text: assistantLiveText }];
        }
        assistantMsg.content = { role: 'agent', content: assistantLiveText, meta: assistantMeta, blocks: assistantBlocks };
        this.updatedAt = Date.now();
        appendMessage(this.namespace, this.id, assistantMsg);

        if (CONFIG.debug) {
          // eslint-disable-next-line no-console
          console.log(`[Message Final] Session: ${this.id}, Content length: ${assistantLiveText.length}, Has thinking: ${!!assistantMeta.thinking}, Meta keys: ${Object.keys(assistantMeta).join(', ')}`);
        }

        publishSseEvent(this.namespace, {
          type: 'message_updated',
          sessionId: this.id,
          message: assistantMsg,
        });

        this.thinking = false;
        this.updatedAt = Date.now();
        publishSseEvent(this.namespace, {
          type: 'session_updated',
          sessionId: this.id,
          summary: this.toSessionSummary(),
          session: this.toSessionDetail(),
        });
      }
    } finally {
      this.thinking = false;
      this.processing = false;
    }
  }

  async runTurn(prompt, onAssistantUpdate) {
    const session = this;

    const abortController = new AbortController();
    session.turnAbortController = abortController;
    session.activeQuery = null;
    session.activeChild = null;

    try {
      if (session.flavor === 'codex') {
        return await session.runCodexTurn(prompt, onAssistantUpdate);
      }
      if (session.flavor === 'gemini') {
        return await session.runGeminiTurn(prompt, onAssistantUpdate);
      }

      let stderrText = '';
      const onClaudeStderr = (chunk) => {
        stderrText = tailText(`${stderrText}${String(chunk || '')}`, 8000);
      };

      // --- Claude structured streaming state ---
      const streamedTextByKey = new Map();
      const blocksByParentKey = new Map();
      const toolResultsByToolUseId = new Map();
      const toolUseLocationById = new Map();
      const pendingToolUsesById = new Map();

      let blocksVersion = 0;
      const markBlocksChanged = () => { blocksVersion++; };

      const toParentKey = (parentToolUseId) => (parentToolUseId ? String(parentToolUseId) : 'main');

      const getBlocksArrayForParent = (parentToolUseId) => {
        const key = toParentKey(parentToolUseId);
        if (!blocksByParentKey.has(key)) {
          blocksByParentKey.set(key, []);
        }
        return { key, blocks: blocksByParentKey.get(key) };
      };

      const ensureIndex = (arr, index) => {
        while (arr.length <= index) arr.push(null);
      };

      const getOrCreateBlock = (parentToolUseId, index, type) => {
        const { blocks } = getBlocksArrayForParent(parentToolUseId);
        ensureIndex(blocks, index);
        const existing = blocks[index];
        if (existing && typeof existing === 'object' && existing.type === type) {
          return existing;
        }
        const next = { type, ...(parentToolUseId ? { parentToolUseId } : {}) };
        blocks[index] = next;
        markBlocksChanged();
        return next;
      };

      const upsertTextAt = (parentToolUseId, index, nextText, mode) => {
        const key = buildStreamedBlockKey(parentToolUseId, index, 'text');
        const prevFull = streamedTextByKey.get(key) ?? '';
        const nextFull = mode === 'append' ? `${prevFull}${String(nextText || '')}` : String(nextText || '');
        streamedTextByKey.set(key, nextFull);
        const block = getOrCreateBlock(parentToolUseId, index, 'text');
        if (block.text !== nextFull) {
          block.text = nextFull;
          markBlocksChanged();
        }
      };

      const upsertThinkingAt = (parentToolUseId, index, nextThinking, mode) => {
        const key = buildStreamedBlockKey(parentToolUseId, index, 'thinking');
        const prevFull = streamedTextByKey.get(key) ?? '';
        const nextFull = mode === 'append' ? `${prevFull}${String(nextThinking || '')}` : String(nextThinking || '');
        streamedTextByKey.set(key, nextFull);
        const block = getOrCreateBlock(parentToolUseId, index, 'thinking');
        if (block.thinking !== nextFull) {
          block.thinking = nextFull;
          markBlocksChanged();
        }
      };

      const createOrUpdateToolUse = (parentToolUseId, index, toolUse) => {
        const id = typeof toolUse?.id === 'string' && toolUse.id ? toolUse.id : null;
        const name = typeof toolUse?.name === 'string' && toolUse.name ? toolUse.name : 'unknown';
        const input = toolUse && typeof toolUse.input === 'object' && toolUse.input ? toolUse.input : {};

        const { key: parentKey, blocks } = getBlocksArrayForParent(parentToolUseId);
        ensureIndex(blocks, index);

        const pending = id ? pendingToolUsesById.get(id) : null;
        const previousLoc = id ? toolUseLocationById.get(id) : null;

        const existing = blocks[index];
        let block = pending
          ? pending.block
          : (existing && typeof existing === 'object' && existing.type === 'tool_use'
            ? existing
            : { type: 'tool_use', ...(parentToolUseId ? { parentToolUseId } : {}) });

        // If the tool_use was already surfaced (e.g., created by canUseTool), reuse the same block object
        // and move it to the canonical index to avoid duplicate tool_use cards.
        let wasPreviouslySurfaced = false;
        if (!pending && id && previousLoc) {
          const prevBlocks = blocksByParentKey.get(previousLoc.parentKey);
          const prevExisting = prevBlocks && prevBlocks[previousLoc.index];
          if (
            prevExisting &&
            typeof prevExisting === 'object' &&
            prevExisting.type === 'tool_use' &&
            prevExisting.id === id
          ) {
            block = prevExisting;
            wasPreviouslySurfaced = true;
            if (previousLoc.parentKey !== parentKey || previousLoc.index !== index) {
              prevBlocks[previousLoc.index] = null;
            }
          }
        }

        if (id && block.id !== id) block.id = id;
        if (block.name !== name) block.name = name;
        block.input = input;

        if (pending) {
          pending.parentKey = parentKey;
          pending.index = index;
          toolUseLocationById.set(id, { parentKey, index });
          markBlocksChanged();
          return { id, block };
        }

        if (id && wasPreviouslySurfaced) {
          blocks[index] = block;
          toolUseLocationById.set(id, { parentKey, index });
          announceToolUse(block);
          markBlocksChanged();
          return { id, block };
        }

        // Delay surfacing tool_use blocks briefly so permission requests can arrive first.
        if (id && !blocks[index]) {
          const timer = setTimeout(() => {
            try {
              const entry = pendingToolUsesById.get(id);
              if (!entry) return;
              pendingToolUsesById.delete(id);
              try { clearTimeout(entry.timer); } catch { /* ignore */ }

              const releaseBlocks = blocksByParentKey.get(entry.parentKey) ?? [];
              blocksByParentKey.set(entry.parentKey, releaseBlocks);
              ensureIndex(releaseBlocks, entry.index);
              releaseBlocks[entry.index] = entry.block;
              announceToolUse(entry.block);
              markBlocksChanged();
              emitUpdate(false);
            } catch {
              // ignore
            }
          }, 250);

          pendingToolUsesById.set(id, { parentKey, index, block, timer });
          toolUseLocationById.set(id, { parentKey, index });
          markBlocksChanged();
          return { id, block };
        } else {
          blocks[index] = block;
          if (id) {
            toolUseLocationById.set(id, { parentKey, index });
          }
          announceToolUse(block);
          markBlocksChanged();
        }

        return { id, block };
      };

      const releaseToolUseNow = (toolUseId) => {
        const pending = pendingToolUsesById.get(toolUseId);
        if (!pending) return false;
        pendingToolUsesById.delete(toolUseId);
        try { clearTimeout(pending.timer); } catch { /* ignore */ }

        const releaseBlocks = blocksByParentKey.get(pending.parentKey) ?? [];
        blocksByParentKey.set(pending.parentKey, releaseBlocks);
        ensureIndex(releaseBlocks, pending.index);
        releaseBlocks[pending.index] = pending.block;
        announceToolUse(pending.block);
        markBlocksChanged();
        return true;
      };

      const upsertToolUseStatus = (toolUseId, status, extra) => {
        if (!toolUseId) return;
        const pending = pendingToolUsesById.get(toolUseId);
        if (pending) {
          pending.block.status = status;
          if (extra && typeof extra === 'object') {
            Object.assign(pending.block, extra);
          }
          markBlocksChanged();
          return;
        }

        const loc = toolUseLocationById.get(toolUseId);
        if (!loc) return;
        const blocks = blocksByParentKey.get(loc.parentKey);
        if (!blocks) return;
        ensureIndex(blocks, loc.index);
        const existing = blocks[loc.index];
        if (!existing || typeof existing !== 'object' || existing.type !== 'tool_use') return;
        existing.status = status;
        if (extra && typeof extra === 'object') {
          Object.assign(existing, extra);
        }
        markBlocksChanged();
      };

      const addToolResult = (toolUseId, resultContent, isError) => {
        const id = typeof toolUseId === 'string' ? toolUseId : '';
        if (!id) return;
        const arr = toolResultsByToolUseId.get(id) ?? [];
        const block = {
          type: 'tool_result',
          tool_use_id: id,
          content: resultContent,
          ...(isError ? { is_error: true } : {}),
        };
        arr.push(block);
        toolResultsByToolUseId.set(id, arr);
        markBlocksChanged();
      };

      const buildMergedBlocks = () => {
        const out = [];
        const visited = new Set();

        const appendForParentKey = (parentKey, depth) => {
          if (!parentKey) parentKey = 'main';
          if (visited.has(parentKey)) return;
          visited.add(parentKey);
          if (depth > 4) return;

          const arr = blocksByParentKey.get(parentKey) ?? [];
          for (const block of arr) {
            if (!block || typeof block !== 'object') continue;
            out.push(block);
            if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
              const toolUseId = block.id;
              const results = toolResultsByToolUseId.get(toolUseId) ?? [];
              for (const r of results) out.push(r);
              if (blocksByParentKey.has(toolUseId)) {
                appendForParentKey(toolUseId, depth + 1);
              }
            }
          }
        };

        appendForParentKey('main', 0);

        // Orphaned tool results (rare) - append at end.
        for (const [toolUseId, results] of toolResultsByToolUseId.entries()) {
          const alreadyIncluded = out.some((b) => b && typeof b === 'object' && b.type === 'tool_use' && b.id === toolUseId);
          if (alreadyIncluded) continue;
          for (const r of results) out.push(r);
        }

        return out;
      };

      const buildPlainText = (blocks) => {
        let text = '';
        for (const block of Array.isArray(blocks) ? blocks : []) {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          }
        }
        return text;
      };

      const buildThinkingText = (blocks) => {
        let thinking = '';
        for (const block of Array.isArray(blocks) ? blocks : []) {
          if (block && typeof block === 'object' && block.type === 'thinking' && typeof block.thinking === 'string') {
            thinking += block.thinking;
          }
        }
        return thinking;
      };

      let lastSessionId = session.resumeToken;
      let resultText = '';
      let sessionStateChanged = false;

      const pendingOps = [];
      const announcedToolUseIds = new Set();
      const announcedToolUseStatus = new Map();

      function pushOp(op) {
        if (!op || typeof op !== 'object') return;

        const last = pendingOps[pendingOps.length - 1];
        if (
          last &&
          (op.type === 'text_delta' || op.type === 'thinking_delta') &&
          last.type === op.type &&
          typeof last.key === 'string' &&
          last.key === op.key &&
          typeof last.delta === 'string' &&
          typeof op.delta === 'string'
        ) {
          last.delta += op.delta;
          return;
        }

        pendingOps.push(op);
      }

      function announceToolUse(block) {
        const id = typeof block?.id === 'string' ? block.id : '';
        if (!id) return;
        if (!announcedToolUseIds.has(id)) {
          announcedToolUseIds.add(id);
          if (typeof block.status === 'string') {
            announcedToolUseStatus.set(id, block.status);
          }
          pushOp({
            type: 'tool_use',
            id,
            name: typeof block.name === 'string' ? block.name : 'unknown',
            input: block && typeof block.input === 'object' && block.input ? block.input : {},
            ...(typeof block.status === 'string' ? { status: block.status } : {}),
            ...(typeof block.createdAt === 'number' ? { createdAt: block.createdAt } : {}),
          });
          return;
        }

        // Best-effort: surface status changes even if we already announced the tool_use.
        if (typeof block.status === 'string') {
          const prevStatus = announcedToolUseStatus.get(id) ?? null;
          if (prevStatus !== block.status) {
            announcedToolUseStatus.set(id, block.status);
            pushOp({ type: 'tool_use_status', id, status: block.status });
          }
        }
      }

      const ensureToolUseForRequest = (toolUseId, toolName, input, status) => {
        if (!toolUseId) return null;

        const normalizedInput = input && typeof input === 'object' && input ? input : {};
        const normalizedName = typeof toolName === 'string' && toolName.trim() ? toolName : 'unknown';

        const pending = pendingToolUsesById.get(toolUseId);
        if (pending) {
          pending.block.id = toolUseId;
          pending.block.name = normalizedName;
          pending.block.input = normalizedInput;
          pending.block.status = status;
          if (!pending.block.createdAt) pending.block.createdAt = Date.now();
          announceToolUse(pending.block);
          markBlocksChanged();
          return pending.block;
        }

        const loc = toolUseLocationById.get(toolUseId);
        if (loc) {
          const blocks = blocksByParentKey.get(loc.parentKey);
          if (blocks) {
            ensureIndex(blocks, loc.index);
            const existing = blocks[loc.index];
            if (existing && typeof existing === 'object' && existing.type === 'tool_use') {
              existing.id = toolUseId;
              existing.name = normalizedName;
              existing.input = normalizedInput;
              existing.status = status;
              if (!existing.createdAt) existing.createdAt = Date.now();
              announceToolUse(existing);
              markBlocksChanged();
              return existing;
            }
          }
        }

        const { blocks } = getBlocksArrayForParent(null);
        const index = blocks.length;
        const block = {
          type: 'tool_use',
          id: toolUseId,
          name: normalizedName,
          input: normalizedInput,
          status,
          createdAt: Date.now(),
        };
        blocks.push(block);
        toolUseLocationById.set(toolUseId, { parentKey: 'main', index });
        announceToolUse(block);
        markBlocksChanged();
        return block;
      };

      let lastEmitAt = 0;
      let lastEmittedText = '';
      let lastEmittedThinking = '';
      let lastEmittedBlocksVersion = -1;
      const emitUpdate = (force) => {
        if (typeof onAssistantUpdate !== 'function') return;
        const now = Date.now();
        if (!force && now - lastEmitAt < 80) return;

        const blocks = buildMergedBlocks();
        const nextText = buildPlainText(blocks);
        const nextThinking = buildThinkingText(blocks);

        const out = {};
        if (nextText !== lastEmittedText) out.text = nextText;
        if (nextThinking !== lastEmittedThinking) out.thinking = nextThinking;
        if (blocksVersion !== lastEmittedBlocksVersion) out.blocks = blocks;

        if (pendingOps.length > 0) {
          out.ops = pendingOps.splice(0);
        }

        if (!('text' in out) && !('thinking' in out) && !('blocks' in out) && !('ops' in out)) return;

        lastEmitAt = now;
        if ('text' in out) lastEmittedText = out.text;
        if ('thinking' in out) lastEmittedThinking = out.thinking;
        if ('blocks' in out) lastEmittedBlocksVersion = blocksVersion;
        try { onAssistantUpdate(out); } catch { /* ignore */ }
      };

      const canUseTool = async (toolName, input, toolOptions) => {
        const requestId = toolOptions.toolUseID || randomUUID();

        if (resolveClaudeApprovalMode(session.permissionMode, CONFIG.claudeApprovalMode) === 'yolo') {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions.toolUseID };
        }

        releaseToolUseNow(requestId);

        const decisionPromise = session.waitForDecision(requestId, toolOptions.signal);

        // Surface/attach the tool_use block so the UI can approve inline.
        ensureToolUseForRequest(requestId, toolName, input, 'pending');

        if (!session.agentState.requests) {
          session.agentState.requests = {};
        }

        session.agentState.requests[requestId] = {
          tool: toolName,
          arguments: input,
          createdAt: Date.now(),
        };
        session.updatedAt = Date.now();
        publishSseEvent(session.namespace, {
          type: 'session_updated',
          sessionId: session.id,
          summary: session.toSessionSummary(),
          session: session.toSessionDetail(),
        });

        emitUpdate(true);

        const decision = await decisionPromise;

        delete session.agentState.requests[requestId];
        session.agentState.completedRequests[requestId] = {
          tool: toolName,
          arguments: input,
          createdAt: Date.now(),
          completedAt: Date.now(),
          status: decision === 'approved' ? 'approved' : (decision === 'abort' ? 'canceled' : 'denied'),
          decision: decision === 'approved' ? 'approved' : (decision === 'abort' ? 'abort' : 'denied'),
        };
        session.updatedAt = Date.now();
        publishSseEvent(session.namespace, {
          type: 'session_updated',
          sessionId: session.id,
          summary: session.toSessionSummary(),
          session: session.toSessionDetail(),
        });

        const finalStatus = decision === 'approved' ? 'approved' : (decision === 'abort' ? 'canceled' : 'denied');
        const completedAt = Date.now();
        ensureToolUseForRequest(requestId, toolName, input, finalStatus);
        upsertToolUseStatus(requestId, finalStatus, { completedAt, decision });
        pushOp({ type: 'tool_use_status', id: requestId, status: finalStatus, decision, completedAt });
        emitUpdate(true);

        if (decision === 'approved') {
          return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions.toolUseID };
        }
        if (decision === 'abort') {
          return { behavior: 'deny', message: 'Aborted by user.', interrupt: true, toolUseID: toolOptions.toolUseID };
        }
        return { behavior: 'deny', message: 'Denied by user.', interrupt: false, toolUseID: toolOptions.toolUseID };
      };

      const thinkingTokens = resolveClaudeThinkingTokens(session.thinkingMode);

      const queryOptions = {
        cwd: session.cwd,
        abortController,
        canUseTool,
        includePartialMessages: true,
        persistSession: true,
        ...(CONFIG.claudeSettingSources ? { settingSources: CONFIG.claudeSettingSources } : {}),
        ...(thinkingTokens ? { maxThinkingTokens: thinkingTokens } : {}),
        ...(session.model || CONFIG.model ? { model: session.model || CONFIG.model } : {}),
        ...(CONFIG.claudeCodePath ? { pathToClaudeCodeExecutable: CONFIG.claudeCodePath } : {}),
        ...(session.resumeToken ? { resume: session.resumeToken } : {}),
        stderr: onClaudeStderr,
      };

      let effectivePrompt = prompt;
      const mcpConfig = loadClianMcpConfigFromCwd(session.cwd);
      if (mcpConfig.exists && Array.isArray(mcpConfig.servers) && mcpConfig.servers.length > 0) {
        const built = buildActiveMcpServersForPrompt(mcpConfig.servers, effectivePrompt);
        effectivePrompt = built.transformedPrompt;
        if (built.activeServers && Object.keys(built.activeServers).length > 0) {
          queryOptions.mcpServers = built.activeServers;
        }
      }

      try {
        const response = agentQuery({ prompt: effectivePrompt, options: queryOptions });
        session.activeQuery = response;
        for await (const msg of response) {
          if (msg && typeof msg.session_id === 'string' && msg.session_id) {
            lastSessionId = msg.session_id;
          }

          if (msg && msg.type === 'system' && msg.subtype === 'init') {
            const raw = Array.isArray(msg.slash_commands) ? msg.slash_commands : [];
            const filtered = normalizeSupportedSlashCommands(raw);
            if (!areStringArraysEqual(filtered, session.supportedSlashCommands)) {
              session.supportedSlashCommands = filtered;
              sessionStateChanged = true;
            }
          }

          const parentToolUseId = msg && typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id
            ? msg.parent_tool_use_id
            : null;
          const parentKey = toParentKey(parentToolUseId);

          if (msg && msg.type === 'stream_event') {
            const event = msg.event;
            const index = typeof event?.index === 'number' ? event.index : 0;

            if (event && event.type === 'content_block_start') {
              const block = event.content_block;
              if (block && block.type === 'text' && typeof block.text === 'string') {
                pushOp({ type: 'text_delta', key: buildStreamedBlockKey(parentToolUseId, index, 'text'), delta: block.text });
                upsertTextAt(parentToolUseId, index, block.text, 'append');
                emitUpdate(false);
              } else if (block && block.type === 'thinking' && typeof block.thinking === 'string') {
                pushOp({ type: 'thinking_delta', key: buildStreamedBlockKey(parentToolUseId, index, 'thinking'), delta: block.thinking });
                upsertThinkingAt(parentToolUseId, index, block.thinking, 'append');
                emitUpdate(false);
              } else if (block && block.type === 'tool_use') {
                createOrUpdateToolUse(parentToolUseId, index, block);
                emitUpdate(false);
              }
            } else if (event && event.type === 'content_block_delta') {
              const delta = event.delta;
              if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
                pushOp({ type: 'text_delta', key: buildStreamedBlockKey(parentToolUseId, index, 'text'), delta: delta.text });
                upsertTextAt(parentToolUseId, index, delta.text, 'append');
                emitUpdate(false);
              } else if (delta && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                pushOp({ type: 'thinking_delta', key: buildStreamedBlockKey(parentToolUseId, index, 'thinking'), delta: delta.thinking });
                upsertThinkingAt(parentToolUseId, index, delta.thinking, 'append');
                emitUpdate(false);
              }
            }
          }

          if (msg && msg.type === 'assistant') {
            const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
            for (let index = 0; index < content.length; index++) {
              const block = content[index];
              if (!block || typeof block !== 'object') continue;

              if (block.type === 'text' && typeof block.text === 'string') {
                const key = buildStreamedBlockKey(parentToolUseId, index, 'text');
                const prev = streamedTextByKey.get(key) ?? '';
                const next = block.text;
                const isPrefix = next.startsWith(prev);
                const delta = computePrefixDelta(prev, next);
                streamedTextByKey.set(key, next);
                if (delta) {
                  if (isPrefix) {
                    pushOp({ type: 'text_delta', key, delta });
                  } else {
                    pushOp({ type: 'text_set', key, text: next });
                  }
                  upsertTextAt(parentToolUseId, index, next, 'set');
                }
              } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                const key = buildStreamedBlockKey(parentToolUseId, index, 'thinking');
                const prev = streamedTextByKey.get(key) ?? '';
                const next = block.thinking;
                const isPrefix = next.startsWith(prev);
                const delta = computePrefixDelta(prev, next);
                streamedTextByKey.set(key, next);
                if (delta) {
                  if (isPrefix) {
                    pushOp({ type: 'thinking_delta', key, delta });
                  } else {
                    pushOp({ type: 'thinking_set', key, thinking: next });
                  }
                  upsertThinkingAt(parentToolUseId, index, next, 'set');
                }
              } else if (block.type === 'tool_use') {
                createOrUpdateToolUse(parentToolUseId, index, block);
              }
            }
            emitUpdate(false);
          }

          if (msg && msg.type === 'user') {
            const toolUseId = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : '';
            if (toolUseId && msg.tool_use_result !== undefined) {
              addToolResult(toolUseId, msg.tool_use_result, false);
              pushOp({ type: 'tool_result', tool_use_id: toolUseId, content: msg.tool_use_result });
              releaseToolUseNow(toolUseId);
              emitUpdate(false);
            }

            const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
            for (const block of content) {
              if (!block || typeof block !== 'object') continue;
              if (block.type !== 'tool_result') continue;
              const id = typeof block.tool_use_id === 'string' && block.tool_use_id
                ? block.tool_use_id
                : toolUseId;
              if (!id) continue;
              addToolResult(id, block.content, !!block.is_error);
              pushOp({ type: 'tool_result', tool_use_id: id, content: block.content, ...(block.is_error ? { is_error: true } : {}) });
              releaseToolUseNow(id);
            }
            emitUpdate(false);
          }

          if (msg && msg.type === 'result' && msg.subtype === 'success' && typeof msg.result === 'string') {
            resultText = msg.result;
          }

          // Touch the parent blocks array so parentKey stays in the map if we saw anything.
          if (!blocksByParentKey.has(parentKey)) {
            blocksByParentKey.set(parentKey, []);
          }
        }

        // Ensure any delayed tool_use blocks are released before returning.
        for (const toolUseId of Array.from(pendingToolUsesById.keys())) {
          try { releaseToolUseNow(toolUseId); } catch { /* ignore */ }
        }

        emitUpdate(true);
      } catch (err) {
        // Best-effort: return whatever we streamed so far.
        for (const toolUseId of Array.from(pendingToolUsesById.keys())) {
          try { releaseToolUseNow(toolUseId); } catch { /* ignore */ }
        }

        const blocks = buildMergedBlocks();
        const recovered = buildPlainText(blocks).trim() || String(resultText || '').trim();
        const recoveredThinking = buildThinkingText(blocks).trim();
        if (recoveredThinking && typeof onAssistantUpdate === 'function') {
          try { onAssistantUpdate({ thinking: recoveredThinking, blocks }); } catch { /* ignore */ }
        }
        if (recovered) return recovered;

        if (abortController.signal.aborted) {
          return 'Interrupted.';
        }

        const message = err instanceof Error ? err.message : String(err);
        const stderrTail = tailText(stderrText, 2000).trim();
        const details = [message, stderrTail].filter(Boolean).join('\n\n');
        return details ? `Error:\n${details}` : 'Error: Claude failed.';
      } finally {
        for (const pending of pendingToolUsesById.values()) {
          try { clearTimeout(pending.timer); } catch { /* ignore */ }
        }
        pendingToolUsesById.clear();
      }

      if (lastSessionId && lastSessionId !== session.resumeToken) {
        session.resumeToken = lastSessionId;
        sessionStateChanged = true;
      }

      if (sessionStateChanged) {
        persistSessionsFromMemory();
      }

      const blocks = buildMergedBlocks();
      const assistantText = buildPlainText(blocks).trim();
      const trimmedResult = String(resultText || '').trim();
      let best = assistantText;
      if (trimmedResult.length > best.length) best = trimmedResult;

      const bestThinking = buildThinkingText(blocks).trim();
      if (bestThinking && typeof onAssistantUpdate === 'function') {
        try { onAssistantUpdate({ thinking: bestThinking, blocks }); } catch { /* ignore */ }
      }

      if (abortController.signal.aborted && !best) {
        return 'Interrupted.';
      }

      return best || '';
    } finally {
      session.activeQuery = null;
      session.activeChild = null;
      session.turnAbortController = null;
    }
  }

  async runCodexTurn(prompt, onAssistantUpdate) {
    const session = this;

    try { syncMcpFromCwd(session.cwd); } catch { /* ignore */ }

    const args = ['exec', '--json', '--skip-git-repo-check', '-C', session.cwd];
    args.push(...buildCodexPermissionArgs(session.permissionMode || CONFIG.codexApprovalMode, CONFIG.codexSandbox));

    if (session.model) {
      args.push('-m', session.model);
    }

    const effort = normalizeCodexThinkingMode(session.thinkingMode);
    if (effort) {
      args.push('--config', `model_reasoning_effort="${effort}"`);
    }

    if (session.resumeToken) {
      args.push('resume', String(session.resumeToken));
    }

    // Read prompt from stdin to avoid command line length limits.
    args.push('-');

    let threadId = null;
    const agentMessageById = new Map();
    const reasoningById = new Map();
    let streamError = null;

    let lastEmitAt = 0;
    let lastEmittedText = '';
    let lastEmittedThinking = '';
    const maybeEmit = () => {
      if (typeof onAssistantUpdate !== 'function') return;
      const combinedText = Array.from(agentMessageById.values()).join('\n\n');
      const combinedThinking = Array.from(reasoningById.values()).join('\n\n');
      if (!combinedText && !combinedThinking) return;
      if (combinedText === lastEmittedText && combinedThinking === lastEmittedThinking) return;
      const now = Date.now();
      if (now - lastEmitAt < 80) return;
      lastEmitAt = now;
      lastEmittedText = combinedText;
      lastEmittedThinking = combinedThinking;
      try {
        const patch = {};
        if (combinedText) patch.text = combinedText;
        if (combinedThinking) patch.thinking = combinedThinking;
        onAssistantUpdate(patch);
      } catch { /* ignore */ }
    };

    const result = await runJsonlProcess({
      command: CONFIG.codexCommand,
      args,
      cwd: session.cwd,
      stdinText: prompt,
      env: withClaudeUserMcpEnv({ ...process.env }),
      signal: session.turnAbortController?.signal,
      onChild: (child) => {
        session.activeChild = child;
      },
      onJson: (evt) => {
        if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
          threadId = evt.thread_id;
        }

        if (
          (evt.type === 'item.started' || evt.type === 'item.updated' || evt.type === 'item.completed') &&
          evt.item &&
          typeof evt.item === 'object'
        ) {
          const item = evt.item;
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            const id = typeof item.id === 'string' && item.id ? item.id : `agent-${agentMessageById.size + 1}`;
            agentMessageById.set(id, item.text);
            maybeEmit();
          }
          if (item.type === 'reasoning' && typeof item.text === 'string') {
            const id = typeof item.id === 'string' && item.id ? item.id : `reasoning-${reasoningById.size + 1}`;
            reasoningById.set(id, item.text);
            maybeEmit();
          }
          if (item.type === 'error' && typeof item.message === 'string') {
            streamError = item.message;
          }
        }

        if (evt.type === 'error' && typeof evt.message === 'string') {
          streamError = evt.message;
        }
      },
    });

    if (threadId && threadId !== session.resumeToken) {
      session.resumeToken = threadId;
    }

    const finalThinking = Array.from(reasoningById.values()).join('\n\n').trim();
    if (finalThinking && typeof onAssistantUpdate === 'function') {
      try { onAssistantUpdate({ thinking: finalThinking }); } catch { /* ignore */ }
    }

    const assistantText = Array.from(agentMessageById.values()).join('\n\n').trim();
    if (assistantText) {
      return assistantText;
    }

    if (result.aborted || session.turnAbortController?.signal.aborted) {
      return 'Interrupted.';
    }

    if (!result.ok) {
      const details = [streamError, result.errorMessage, result.stderrText].filter(Boolean).join('\n');
      return details ? `Error:\n${details}` : 'Error: codex failed.';
    }

    return streamError ? `Error:\n${streamError}` : '';
  }

  async runGeminiTurn(prompt, onAssistantUpdate) {
    const session = this;

    applyGeminiThinkingOverride(session.cwd, session.thinkingMode);
    try { syncMcpFromCwd(session.cwd); } catch { /* ignore */ }

    const args = [
      '--output-format', 'stream-json',
      '--approval-mode', resolveGeminiApprovalMode(session.permissionMode, CONFIG.geminiApprovalMode),
    ];

    if (CONFIG.geminiSandbox) {
      args.push('--sandbox');
    }

    if (session.model) {
      args.push('--model', session.model);
    }

    if (session.resumeToken) {
      args.push('--resume', String(session.resumeToken));
    }

    // Prompt (positional). Gemini treats stdin as additional context.
    args.push(prompt);

    let newSessionId = null;
    let assistantText = '';
    let sawDelta = false;
    let streamError = null;

    let lastEmitAt = 0;
    let lastEmittedText = '';
    const maybeEmit = () => {
      if (typeof onAssistantUpdate !== 'function') return;
      if (!assistantText) return;
      if (assistantText === lastEmittedText) return;
      const now = Date.now();
      if (now - lastEmitAt < 80) return;
      lastEmitAt = now;
      lastEmittedText = assistantText;
      try { onAssistantUpdate({ text: assistantText }); } catch { /* ignore */ }
    };

    const geminiHome = path.join(session.cwd, '.gemini');
    try { ensureDir(geminiHome); } catch { /* ignore */ }

    const result = await runJsonlProcess({
      command: CONFIG.geminiCommand,
      args,
      cwd: session.cwd,
      stdinText: '',
      env: { ...process.env, GEMINI_CLI_HOME: session.cwd },
      signal: session.turnAbortController?.signal,
      onChild: (child) => {
        session.activeChild = child;
      },
      onJson: (evt) => {
        if (evt.type === 'init' && typeof evt.session_id === 'string') {
          newSessionId = evt.session_id;
        }

        if (evt.type === 'message' && evt.role === 'assistant' && typeof evt.content === 'string') {
          if (evt.delta) {
            sawDelta = true;
            assistantText += evt.content;
          } else {
            assistantText = evt.content;
          }
          maybeEmit();
        }

        if (evt.type === 'error' && typeof evt.message === 'string') {
          streamError = evt.message;
        }

        if (
          evt.type === 'result' &&
          evt.status === 'error' &&
          evt.error &&
          typeof evt.error === 'object' &&
          typeof evt.error.message === 'string'
        ) {
          streamError = evt.error.message;
        }
      },
    });

    if (newSessionId && newSessionId !== session.resumeToken) {
      session.resumeToken = newSessionId;
    }

    const trimmed = assistantText.trim();
    if (trimmed) {
      return trimmed;
    }

    if (result.aborted || session.turnAbortController?.signal.aborted) {
      return 'Interrupted.';
    }

    if (!result.ok) {
      const details = [streamError, result.errorMessage, result.stderrText].filter(Boolean).join('\n');
      return details ? `Error:\n${details}` : 'Error: gemini failed.';
    }

    if (streamError) {
      return `Error:\n${streamError}`;
    }

    if (sawDelta && assistantText) {
      return assistantText;
    }

    return '';
  }

  waitForDecision(requestId, signal) {
    return new Promise((resolve) => {
      const onAbort = () => {
        cleanup();
        resolve('abort');
      };

      const cleanup = () => {
        signal?.removeEventListener?.('abort', onAbort);
        this.pendingResolvers.delete(requestId);
      };

      if (signal?.aborted) {
        resolve('abort');
        return;
      }

      signal?.addEventListener?.('abort', onAbort, { once: true });

      this.pendingResolvers.set(requestId, (decision) => {
        cleanup();
        resolve(decision);
      });
    });
  }

  async interrupt() {
    let didSomething = false;

    const abortController = this.turnAbortController;
    if (abortController && !abortController.signal.aborted) {
      didSomething = true;
      try { abortController.abort(); } catch { /* ignore */ }
    }

    const query = this.activeQuery;
    if (query && typeof query.interrupt === 'function') {
      didSomething = true;
      try { await query.interrupt(); } catch { /* ignore */ }
    } else if (query && typeof query.close === 'function') {
      didSomething = true;
      try { query.close(); } catch { /* ignore */ }
    }

    const child = this.activeChild;
    if (child && !child.killed) {
      didSomething = true;
      try { child.kill(); } catch { /* ignore */ }
    }

    if (this.pendingResolvers && this.pendingResolvers.size > 0) {
      didSomething = true;
      const pendingIds = Array.from(this.pendingResolvers.keys());
      for (const requestId of pendingIds) {
        try { this.resolveDecision(requestId, 'abort'); } catch { /* ignore */ }
      }
    }

    return didSomething;
  }

  resolveDecision(requestId, decision) {
    const resolver = this.pendingResolvers.get(requestId);
    if (!resolver) return false;
    resolver(decision);
    return true;
  }
}

// ============================================
// Hub server
// ============================================

ensureDir(CONFIG.dataDir);

const state = loadState();
const sessionsByNamespace = new Map();

function getOrCreateNamespaceMap(ns) {
  if (!sessionsByNamespace.has(ns)) {
    sessionsByNamespace.set(ns, new Map());
  }
  return sessionsByNamespace.get(ns);
}

function loadSessionsIntoMemory() {
  const sessions = state.sessions || {};
  for (const [ns, nsSessions] of Object.entries(sessions)) {
    const nsMap = getOrCreateNamespaceMap(ns);
    if (!nsSessions || typeof nsSessions !== 'object') continue;
    for (const [id, s] of Object.entries(nsSessions)) {
      if (!s || typeof s !== 'object') continue;
      const runner = new SessionRunner({
        namespace: ns,
        id,
        cwd: s.cwd || CONFIG.defaultCwd,
        name: s.name || null,
        flavor: s.flavor || 'claude',
        model: s.model || null,
        permissionMode: s.permissionMode || null,
        thinkingMode: s.thinkingMode || null,
        supportedSlashCommands: s.supportedSlashCommands,
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || Date.now(),
        resumeToken: s.resumeToken || s.resumeId || null,
      });
      runner.loadFromDisk();
      nsMap.set(id, runner);
    }
  }
}

function persistSessionsFromMemory() {
  const out = { sessions: {} };
  for (const [ns, nsMap] of sessionsByNamespace.entries()) {
    out.sessions[ns] = {};
    for (const [id, runner] of nsMap.entries()) {
      out.sessions[ns][id] = {
        cwd: runner.cwd,
        name: runner.name,
        flavor: runner.flavor,
        model: runner.model,
        permissionMode: runner.permissionMode,
        thinkingMode: runner.thinkingMode,
        supportedSlashCommands: normalizeSupportedSlashCommands(runner.supportedSlashCommands),
        createdAt: runner.createdAt,
        updatedAt: runner.updatedAt,
        resumeToken: runner.resumeToken,
      };
    }
  }
  saveState(out);
}

loadSessionsIntoMemory();

// Ensure a default session exists for "default" namespace
const defaultNs = 'default';
const defaultId = 'default';
const defaultMap = getOrCreateNamespaceMap(defaultNs);
if (!defaultMap.has(defaultId)) {
  const runner = new SessionRunner({
    namespace: defaultNs,
    id: defaultId,
    cwd: CONFIG.defaultCwd,
    name: 'Default',
    flavor: 'claude',
  });
  runner.loadFromDisk();
  defaultMap.set(defaultId, runner);
  persistSessionsFromMemory();
}

function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const a = patternParts[i];
    const b = pathParts[i];
    if (a.startsWith(':')) {
      params[a.slice(1)] = decodeURIComponent(b);
    } else if (a !== b) {
      return null;
    }
  }
  return params;
}

function requireAuth(req, res) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const secret = getJwtSecretForBaseToken(CONFIG.baseToken);
  const payload = verifyJwtHs256(token, secret);
  if (!payload || typeof payload.ns !== 'string') {
    sendJson(res, 401, { error: 'Invalid token' });
    return null;
  }
  return { namespace: payload.ns };
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    notFound(res);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (CONFIG.debug) {
    // eslint-disable-next-line no-console
    console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);
  }

  // Health check
  if (req.method === 'GET' && pathname === '/') {
    sendText(res, 200, 'ok');
    return;
  }

  // Auth
  if (req.method === 'POST' && pathname === '/api/auth') {
    const bodyText = await readRequestBody(req);
    const body = safeJsonParse(bodyText) || {};
    const accessToken = body && typeof body.accessToken === 'string' ? body.accessToken : '';
    const parsed = parseAccessToken(accessToken);
    if (!parsed.baseToken || parsed.baseToken !== CONFIG.baseToken) {
      sendJson(res, 401, { error: 'Invalid access token' });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = { uid: 1, ns: parsed.namespace, iat: nowSec, exp: nowSec + 15 * 60 };
    const secret = getJwtSecretForBaseToken(CONFIG.baseToken);
    const token = signJwtHs256(payload, secret);
    sendJson(res, 200, { token, user: { id: 1, firstName: 'Remote', lastName: 'User' } });
    return;
  }

  // SSE event stream (uses query token; cannot send Authorization headers from EventSource)
  if (req.method === 'GET' && pathname === '/api/events') {
    const rawToken = url.searchParams.get('token') || url.searchParams.get('accessToken') || '';
    const token = String(rawToken || '').trim();
    if (!token) {
      sendJson(res, 401, { error: 'Missing token' });
      return;
    }

    let namespace = 'default';
    const looksLikeJwt = token.split('.').length === 3;
    if (looksLikeJwt) {
      const secret = getJwtSecretForBaseToken(CONFIG.baseToken);
      const payload = verifyJwtHs256(token, secret);
      if (!payload || typeof payload.ns !== 'string') {
        sendJson(res, 401, { error: 'Invalid token' });
        return;
      }
      namespace = payload.ns;
    } else {
      const parsed = parseAccessToken(token);
      if (!parsed.baseToken || parsed.baseToken !== CONFIG.baseToken) {
        sendJson(res, 401, { error: 'Invalid token' });
        return;
      }
      namespace = parsed.namespace;
    }

    const allParam = String(url.searchParams.get('all') || '').trim().toLowerCase();
    const all = allParam === '1' || allParam === 'true' || allParam === 'yes';

    const sessionIdRaw = String(url.searchParams.get('sessionId') || '').trim();
    const sessionId = sessionIdRaw ? sessionIdRaw : null;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Allow cross-origin EventSource from Obsidian mobile webview.
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });

    try { res.flushHeaders?.(); } catch { /* ignore */ }
    try { req.socket?.setTimeout?.(0); } catch { /* ignore */ }
    try { req.socket?.setNoDelay?.(true); } catch { /* ignore */ }

    res.write('retry: 1000\n\n');

    const subId = randomUUID();
    const keepAliveTimer = setInterval(() => {
      const sub = sseSubscribers.get(subId);
      if (!sub || sub.closed) return;
      if (sub.draining) return;
      if (Array.isArray(sub.buffer) && sub.buffer.length > 0) return;
      enqueueSseLine(subId, SSE_KEEP_ALIVE_LINE);
    }, 15_000);

    sseSubscribers.set(subId, {
      id: subId,
      namespace,
      all,
      sessionId,
      res,
      keepAliveTimer,
      buffer: [],
      bufferBytes: 0,
      flushScheduled: false,
      flushTimer: null,
      draining: false,
      closed: false,
    });

    req.on('close', () => closeSseSubscriber(subId));
    req.on('aborted', () => closeSseSubscriber(subId));

    const nsMap = getOrCreateNamespaceMap(namespace);
    const sessions = Array.from(nsMap.values())
      .map(s => s.toSessionSummary())
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const snapshot = { type: 'snapshot' };
    if (all) {
      snapshot.sessions = sessions;
    }

    if (sessionId) {
      const runner = nsMap.get(sessionId);
      snapshot.sessionId = sessionId;
      if (runner) {
        snapshot.session = runner.toSessionDetail();
        snapshot.messages = runner.getMessagesPage({ limit: 80, beforeSeq: null });
      } else {
        snapshot.error = 'Session not found';
      }
    }

    const snapshotLine = serializeSseData(snapshot);
    if (!snapshotLine) {
      closeSseSubscriber(subId);
      return;
    }
    enqueueSseLine(subId, snapshotLine);
    flushSseSubscriber(subId);
    return;
  }

  // Everything else requires auth
  const auth = requireAuth(req, res);
  if (!auth) return;
  const namespace = auth.namespace;

  const nsMap = getOrCreateNamespaceMap(namespace);

  // Sessions list
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const sessions = Array.from(nsMap.values())
      .map(s => s.toSessionSummary())
      .sort((a, b) => b.updatedAt - a.updatedAt);
    sendJson(res, 200, { sessions });
    return;
  }

  // Create session (optional)
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const bodyText = await readRequestBody(req);
    const body = safeJsonParse(bodyText) || {};
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : `session-${randomUUID()}`;
    const requestedCwd = typeof body.cwd === 'string' && body.cwd.trim() ? path.resolve(body.cwd.trim()) : '';
    const preferredCwd = getPreferredSessionCwd(nsMap, requestedCwd);
    const cwd = preferredCwd || requestedCwd || CONFIG.defaultCwd;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    const flavor = typeof body.flavor === 'string' ? body.flavor.trim() : 'claude';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const permissionMode = normalizePermissionMode(body.permissionMode);
    const thinkingMode = typeof body.thinkingMode === 'string' && body.thinkingMode.trim() ? body.thinkingMode.trim() : null;
    const resumeToken = typeof body.resumeToken === 'string' && body.resumeToken.trim()
      ? body.resumeToken.trim()
      : (typeof body.resumeId === 'string' && body.resumeId.trim() ? body.resumeId.trim() : null);

    if (CONFIG.debug) {
      // eslint-disable-next-line no-console
      console.log(`[Session Create] ID: ${id}, Flavor: ${flavor}, Model: ${model || 'default'}, Requested CWD: ${requestedCwd || '<none>'}, Effective CWD: ${cwd}`);
    }

    if (!isAllowedFlavor(flavor)) {
      sendJson(res, 400, { error: 'Invalid flavor. Use claude, codex, or gemini.' });
      return;
    }

    if (nsMap.has(id)) {
      sendJson(res, 409, { error: 'Session already exists' });
      return;
    }

    const runner = new SessionRunner({ namespace, id, cwd, name, flavor, model, permissionMode, resumeToken });
    if (thinkingMode) {
      runner.thinkingMode = thinkingMode;
    }
    runner.loadFromDisk();
    nsMap.set(id, runner);
    persistSessionsFromMemory();
    publishSseEvent(namespace, {
      type: 'session_added',
      sessionId: id,
      summary: runner.toSessionSummary(),
      session: runner.toSessionDetail(),
    });
    sendJson(res, 200, { ok: true, sessionId: id });
    return;
  }

  // Session commands (best-effort list)
  const commandsParams = matchRoute('/api/sessions/:id/commands', pathname);
  if (req.method === 'GET' && commandsParams) {
    const runner = nsMap.get(commandsParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    repairRunnerCwdIfNeeded(nsMap, runner);
    const commands = getCommandNamesForSessionRunner(runner);
    sendJson(res, 200, { commands });
    return;
  }

  // Session detail
  const sessionParams = matchRoute('/api/sessions/:id', pathname);
  if (req.method === 'DELETE' && sessionParams) {
    const runner = nsMap.get(sessionParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    try {
      const msgPath = getMessagesPath(namespace, sessionParams.id);
      fs.rmSync(msgPath, { force: true });
    } catch {
      // ignore
    }

    nsMap.delete(sessionParams.id);
    persistSessionsFromMemory();
    publishSseEvent(namespace, { type: 'session_removed', sessionId: sessionParams.id });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'PATCH' && sessionParams) {
    const runner = nsMap.get(sessionParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const bodyText = await readRequestBody(req);
    const body = safeJsonParse(bodyText) || {};

    const hasName = typeof body.name === 'string';
    const hasModel = typeof body.model === 'string';
    const hasPermissionMode = typeof body.permissionMode === 'string';
    const hasThinkingMode = typeof body.thinkingMode === 'string';

    if (!hasName && !hasModel && !hasPermissionMode && !hasThinkingMode) {
      sendJson(res, 400, { error: 'Invalid body. Provide name, model, permissionMode, and/or thinkingMode.' });
      return;
    }

    if (hasName) {
      const nextName = body.name.trim();
      runner.name = nextName ? nextName : null;
    }

    if (hasModel) {
      const nextModel = body.model.trim();
      runner.model = nextModel ? nextModel : null;
    }

    if (hasPermissionMode) {
      runner.permissionMode = normalizePermissionMode(body.permissionMode);
    }

    if (hasThinkingMode) {
      const nextThinking = body.thinkingMode.trim();
      runner.thinkingMode = nextThinking ? nextThinking : null;
    }

    runner.updatedAt = Date.now();
    persistSessionsFromMemory();
    publishSseEvent(namespace, {
      type: 'session_updated',
      sessionId: runner.id,
      summary: runner.toSessionSummary(),
      session: runner.toSessionDetail(),
    });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && sessionParams) {
    const runner = nsMap.get(sessionParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    repairRunnerCwdIfNeeded(nsMap, runner);
    sendJson(res, 200, { session: runner.toSessionDetail() });
    return;
  }

  // Session interrupt (best-effort)
  const interruptParams = matchRoute('/api/sessions/:id/interrupt', pathname);
  if (req.method === 'POST' && interruptParams) {
    const runner = nsMap.get(interruptParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const interrupted = await runner.interrupt();
    sendJson(res, 200, { ok: true, interrupted });
    return;
  }

  // MCP servers (shared .clian/mcp.json under session cwd)
  const mcpParams = matchRoute('/api/sessions/:id/mcp', pathname);
  if (mcpParams) {
    const runner = nsMap.get(mcpParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    repairRunnerCwdIfNeeded(nsMap, runner);

    if (req.method === 'GET') {
      const loaded = loadClianMcpConfigFromCwd(runner.cwd);
      const servers = loaded.exists
        ? loaded.servers.map((s) => ({
          name: s.name,
          type: s.type,
          enabled: !!s.enabled,
          contextSaving: !!s.contextSaving,
          ...(s.description ? { description: s.description } : {}),
        }))
        : [];

      sendJson(res, 200, { exists: loaded.exists, servers });
      return;
    }

    if (req.method === 'PATCH') {
      const bodyText = await readRequestBody(req);
      const body = safeJsonParse(bodyText) || {};
      const updates = isRecord(body.servers) ? body.servers : null;

      if (!updates) {
        sendJson(res, 400, { error: 'Invalid body. Provide { servers: { [name]: { enabled?: boolean, contextSaving?: boolean } } }' });
        return;
      }

      const mcpPath = path.join(runner.cwd, MCP_CONFIG_REL_PATH);
      if (!fs.existsSync(mcpPath)) {
        sendJson(res, 404, { error: 'MCP config not found. Create .clian/mcp.json on the hub machine first.' });
        return;
      }

      let parsed = null;
      try {
        const currentText = fs.readFileSync(mcpPath, 'utf8');
        parsed = safeJsonParse(currentText);
      } catch {
        parsed = null;
      }

      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
        sendJson(res, 400, { error: 'Invalid MCP config file. Expected { "mcpServers": { ... } }' });
        return;
      }

      const mcpServers = parsed.mcpServers;
      const existingClian = isRecord(parsed._clian) ? parsed._clian : {};
      const metaServers = isRecord(existingClian.servers) ? existingClian.servers : {};

      for (const [nameRaw, patch] of Object.entries(updates)) {
        const name = String(nameRaw || '').trim();
        if (!name) continue;
        if (!isRecord(patch)) continue;
        if (!(name in mcpServers)) continue;

        const meta = isRecord(metaServers[name]) ? metaServers[name] : {};

        if ('enabled' in patch) {
          const enabled = !!patch.enabled;
          if (enabled) {
            delete meta.enabled;
          } else {
            meta.enabled = false;
          }
        }

        if ('contextSaving' in patch) {
          const contextSaving = !!patch.contextSaving;
          if (contextSaving) {
            delete meta.contextSaving;
          } else {
            meta.contextSaving = false;
          }
        }

        if (Object.keys(meta).length === 0) {
          delete metaServers[name];
        } else {
          metaServers[name] = meta;
        }
      }

      if (Object.keys(metaServers).length > 0) {
        parsed._clian = { ...existingClian, servers: metaServers };
      } else if (Object.keys(existingClian).length > 0) {
        const { servers: _servers, ...rest } = existingClian;
        if (Object.keys(rest).length > 0) {
          parsed._clian = rest;
        } else {
          delete parsed._clian;
        }
      } else {
        delete parsed._clian;
      }

      const nextText = JSON.stringify(parsed, null, 2);
      writeFileIfChanged(mcpPath, nextText);

      const loaded = loadClianMcpConfigFromCwd(runner.cwd);
      try { syncMcpFromCwd(runner.cwd, loaded); } catch { /* ignore */ }

      const servers = loaded.exists
        ? loaded.servers.map((s) => ({
          name: s.name,
          type: s.type,
          enabled: !!s.enabled,
          contextSaving: !!s.contextSaving,
          ...(s.description ? { description: s.description } : {}),
        }))
        : [];

      sendJson(res, 200, { ok: true, exists: loaded.exists, servers });
      return;
    }
  }

  // Upload a file from mobile vault into the hub session cwd
  const filesParams = matchRoute('/api/sessions/:id/files', pathname);
  if (req.method === 'POST' && filesParams) {
    const runner = nsMap.get(filesParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const bodyText = await readRequestBody(req);
    const body = safeJsonParse(bodyText) || {};
    const relPath = normalizeRelativePosixPath(body.path || body.name);
    const contentBase64Raw = typeof body.contentBase64 === 'string' ? body.contentBase64 : '';
    const overwrite = body && body.overwrite === true;

    if (!relPath) {
      sendJson(res, 400, { error: 'Invalid file path.' });
      return;
    }

    let contentBase64 = contentBase64Raw.trim();
    if (!contentBase64) {
      sendJson(res, 400, { error: 'Missing contentBase64.' });
      return;
    }

    // Strip data URL prefix if present.
    if (contentBase64.includes(',') && /;base64/i.test(contentBase64.split(',')[0] || '')) {
      contentBase64 = contentBase64.split(',').slice(1).join(',');
    }

    let buffer = null;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch {
      buffer = null;
    }

    if (!buffer) {
      sendJson(res, 400, { error: 'Invalid base64 payload.' });
      return;
    }

    const maxBytes = parseNumber(process.env.CLIAN_HUB_MAX_UPLOAD_BYTES, 20 * 1024 * 1024);
    if (buffer.length > maxBytes) {
      sendJson(res, 413, { error: `File too large. Max is ${maxBytes} bytes.` });
      return;
    }

    const safeNs = namespace.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeId = runner.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadRootAbs = path.join(runner.cwd, '.clian', 'hub_uploads', safeNs, safeId);
    const uploadRootRel = path.posix.join('.clian', 'hub_uploads', safeNs, safeId);

    const parts = relPath.split('/').filter(Boolean);
    const destAbsBase = path.join(uploadRootAbs, ...parts);
    const ext = path.posix.extname(relPath);
    const baseName = path.posix.basename(relPath, ext);
    const dirName = path.posix.dirname(relPath);

    let finalRel = path.posix.join(uploadRootRel, relPath);
    let finalAbs = destAbsBase;

    if (!overwrite && fs.existsSync(finalAbs)) {
      const unique = `${baseName}-${Date.now()}${ext}`;
      const uniqueRel = dirName && dirName !== '.' ? `${dirName}/${unique}` : unique;
      finalRel = path.posix.join(uploadRootRel, uniqueRel);
      finalAbs = path.join(uploadRootAbs, ...uniqueRel.split('/').filter(Boolean));
    }

    try {
      ensureDir(path.dirname(finalAbs));
      fs.writeFileSync(finalAbs, buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to write file: ${message}` });
      return;
    }

    sendJson(res, 200, { ok: true, path: finalRel, size: buffer.length });
    return;
  }

  // Messages
  const messagesParams = matchRoute('/api/sessions/:id/messages', pathname);
  if (messagesParams) {
    const runner = nsMap.get(messagesParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    if (req.method === 'POST') {
      repairRunnerCwdIfNeeded(nsMap, runner);
    }

    if (req.method === 'GET') {
      const limit = url.searchParams.get('limit');
      const beforeSeq = url.searchParams.get('beforeSeq');
      const page = runner.getMessagesPage({
        limit: limit ? Number(limit) : 50,
        beforeSeq: beforeSeq ? Number(beforeSeq) : null,
      });
      sendJson(res, 200, page);
      return;
    }

    if (req.method === 'POST') {
      const bodyText = await readRequestBody(req);
      const body = safeJsonParse(bodyText) || {};
      const text = body && typeof body.text === 'string' ? body.text : '';
      const localId = body && typeof body.localId === 'string' ? body.localId : null;
      if (!text.trim()) {
        sendJson(res, 400, { error: 'Message requires text' });
        return;
      }

      if (CONFIG.debug) {
        // eslint-disable-next-line no-console
        console.log(`[Message] Session: ${messagesParams.id}, Text length: ${text.length}, LocalId: ${localId || 'none'}`);
      }

      runner.enqueueUserMessage(text, localId);
      persistSessionsFromMemory();
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // Permission approve/deny
  const approveParams = matchRoute('/api/sessions/:id/permissions/:requestId/approve', pathname);
  if (req.method === 'POST' && approveParams) {
    const runner = nsMap.get(approveParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const bodyText = await readRequestBody(req);
    const body = safeJsonParse(bodyText) || {};
    const decision = body && typeof body.decision === 'string' ? body.decision : 'approved';

    const resolved = runner.resolveDecision(
      approveParams.requestId,
      decision === 'abort' ? 'abort' : (decision === 'denied' ? 'denied' : 'approved')
    );
    if (!resolved) {
      sendJson(res, 404, { error: 'Request not found' });
      return;
    }

    persistSessionsFromMemory();
    sendJson(res, 200, { ok: true });
    return;
  }

  const denyParams = matchRoute('/api/sessions/:id/permissions/:requestId/deny', pathname);
  if (req.method === 'POST' && denyParams) {
    const runner = nsMap.get(denyParams.id);
    if (!runner) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const bodyText = await readRequestBody(req);
    const body = safeJsonParse(bodyText) || {};
    const decision = body && typeof body.decision === 'string' ? body.decision : 'denied';

    const resolved = runner.resolveDecision(
      denyParams.requestId,
      decision === 'abort' ? 'abort' : 'denied'
    );
    if (!resolved) {
      sendJson(res, 404, { error: 'Request not found' });
      return;
    }

    persistSessionsFromMemory();
    sendJson(res, 200, { ok: true });
    return;
  }

  notFound(res);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('='.repeat(60));
  // eslint-disable-next-line no-console
  console.log(`Clian Remote Hub`);
  // eslint-disable-next-line no-console
  console.log('='.repeat(60));
  // eslint-disable-next-line no-console
  console.log(`Server: http://${formatHostForUrl(CONFIG.host)}:${CONFIG.port}`);
  // eslint-disable-next-line no-console
  console.log(`Data directory: ${CONFIG.dataDir}`);
  // eslint-disable-next-line no-console
  console.log(`Config file: ${CONFIG.configPath}${CONFIG.configLoaded ? '' : ' (not found)'}`);
  // eslint-disable-next-line no-console
  console.log(`Default working directory: ${CONFIG.defaultCwd}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Supported engines:');
  // eslint-disable-next-line no-console
  console.log(`  - Claude Code: ${CONFIG.claudeCodePath || 'not found'}`);
  // eslint-disable-next-line no-console
  console.log(`  - Codex: ${CONFIG.codexCommand}`);
  // eslint-disable-next-line no-console
  console.log(`  - Gemini: ${CONFIG.geminiCommand}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Mobile app configuration:');
  const displayUrls = getHubDisplayUrls(CONFIG.host, CONFIG.port)
  // eslint-disable-next-line no-console
  console.log(`  Hub URL: ${displayUrls.directUrl}`);
  if (displayUrls.lanUrls.length > 1) {
    // eslint-disable-next-line no-console
    console.log('  Other LAN URLs:');
    for (const lanUrl of displayUrls.lanUrls.slice(1)) {
      // eslint-disable-next-line no-console
      console.log(`    - ${lanUrl}`);
    }
  }
  if (displayUrls.lanUrls.length === 0 && CONFIG.host !== '127.0.0.1' && CONFIG.host !== 'localhost') {
    // eslint-disable-next-line no-console
    console.log(`  Local only: ${displayUrls.localUrl}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  Access Token: ${CONFIG.baseToken}`);
  // eslint-disable-next-line no-console
  console.log('  Keep this token private.');
  // eslint-disable-next-line no-console
  console.log('');
  if (CONFIG.debug) {
    // eslint-disable-next-line no-console
    console.log('Debug mode: ENABLED');
    // eslint-disable-next-line no-console
    console.log('  Set CLIAN_HUB_DEBUG=0 to disable debug logging');
    // eslint-disable-next-line no-console
    console.log('');
  } else {
    // eslint-disable-next-line no-console
    console.log('Debug mode: disabled (set CLIAN_HUB_DEBUG=1 to enable)');
    // eslint-disable-next-line no-console
    console.log('');
  }
  // eslint-disable-next-line no-console
  console.log('Press Ctrl+C to stop');
  // eslint-disable-next-line no-console
  console.log('='.repeat(60));
  // eslint-disable-next-line no-console
  console.log('');
});
