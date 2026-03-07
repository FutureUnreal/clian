import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

import type ClianPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { parseCommand } from '../../utils/mcp';
import { getVaultPath } from '../../utils/path';
import { resolveWindowsShim } from '../../utils/windowsCli';
import {
  type ChatMessage,
  type Conversation,
  getGeminiContextWindowSize,
  getHostnameKey,
  type ImageAttachment,
  normalizeGeminiThinkingMode,
  resolveGeminiThinkingBudget,
  type SlashCommand,
  type StreamChunk,
  type UsageInfo,
} from '../types';
import type { AskUserQuestionCallback, ChatService, EnsureReadyOptionsLike } from './ChatService';
import type { ApprovalCallback, QueryOptions } from './ClianService';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function safeJsonParse(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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

function normalizeDelta(previous: string, next: string): string {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

export function buildGeminiApprovalMode(permissionMode: string): string {
  if (permissionMode === 'yolo') {
    return 'yolo';
  }

  if (permissionMode === 'plan') {
    return 'plan';
  }

  return 'default';
}

export function buildGeminiUsageInfo(
  stats: Record<string, unknown>,
  model: string,
  customContextLimits?: Record<string, number>,
): UsageInfo {
  const inputTokensTotal = typeof stats.input_tokens === 'number' ? stats.input_tokens : 0;
  const cachedInputTokens = typeof stats.cached === 'number' ? stats.cached : 0;
  const nonCachedInputTokens =
    typeof stats.input === 'number'
      ? stats.input
      : Math.max(0, inputTokensTotal - cachedInputTokens);
  const outputTokens = typeof stats.output_tokens === 'number' ? stats.output_tokens : 0;
  const totalTokens =
    typeof stats.total_tokens === 'number' && stats.total_tokens > 0
      ? stats.total_tokens
      : inputTokensTotal + Math.max(0, outputTokens);
  const contextTokens = inputTokensTotal > 0 ? inputTokensTotal : (nonCachedInputTokens + cachedInputTokens);
  const contextWindow = getGeminiContextWindowSize(model, customContextLimits);
  const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

  return {
    model: model || undefined,
    inputTokens: nonCachedInputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cachedInputTokens,
    outputTokens,
    totalTokens,
    contextWindow,
    contextTokens,
    percentage,
  };
}

function upsertGeminiThinkingBudgetOverride(
  settings: Record<string, unknown>,
  budget: number,
  createIfMissing: boolean
): boolean {
  let changed = false;

  const existingModelConfigs = isRecord(settings.modelConfigs)
    ? (settings.modelConfigs as Record<string, unknown>)
    : null;

  if (!existingModelConfigs && !createIfMissing) {
    return false;
  }

  const modelConfigs: Record<string, unknown> = existingModelConfigs ?? {};
  if (!existingModelConfigs) {
    settings.modelConfigs = modelConfigs;
    changed = true;
  }

  const existingOverrides = Array.isArray(modelConfigs.customOverrides)
    ? (modelConfigs.customOverrides as unknown[])
    : null;

  if (!existingOverrides && !createIfMissing) {
    return false;
  }

  const overrides: unknown[] = existingOverrides ?? [];
  if (!existingOverrides) {
    modelConfigs.customOverrides = overrides;
    changed = true;
  }

  let target: Record<string, unknown> | null = null;
  for (const entry of overrides) {
    if (!isRecord(entry)) continue;
    const match = (entry as any).match;
    if (isRecord(match) && match.model === 'chat-base-2.5') {
      target = entry as Record<string, unknown>;
      break;
    }
  }

  if (!target) {
    if (!createIfMissing) {
      return false;
    }

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

  const modelConfig: Record<string, unknown> =
    isRecord((target as any).modelConfig) ? ((target as any).modelConfig as Record<string, unknown>) : {};
  if (!isRecord((target as any).modelConfig)) {
    (target as any).modelConfig = modelConfig;
    changed = true;
  }

  const generateContentConfig: Record<string, unknown> =
    isRecord(modelConfig.generateContentConfig) ? (modelConfig.generateContentConfig as Record<string, unknown>) : {};
  if (!isRecord(modelConfig.generateContentConfig)) {
    modelConfig.generateContentConfig = generateContentConfig;
    changed = true;
  }

  const thinkingConfig: Record<string, unknown> =
    isRecord(generateContentConfig.thinkingConfig) ? (generateContentConfig.thinkingConfig as Record<string, unknown>) : {};
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

export class GeminiCliService implements ChatService {
  readonly flavor = 'gemini' as const;

  private plugin: ClianPlugin;
  private ready = true;
  private readyListeners = new Set<(ready: boolean) => void>();

  private sessionId: string | null = null;
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private activeAbortController: AbortController | null = null;
  private activeReadline: ReadlineInterface | null = null;

  // Claude-only callbacks (no-op for Gemini)
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private exitPlanModeCallback: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private permissionModeSyncCallback: any = null;

  constructor(plugin: ClianPlugin) {
    this.plugin = plugin;
  }

  isReady(): boolean {
    return this.ready;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    listener(this.ready);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  private setReady(next: boolean): void {
    if (this.ready === next) return;
    this.ready = next;
    for (const listener of this.readyListeners) {
      try {
        listener(next);
      } catch {
        // ignore
      }
    }
  }

  async ensureReady(_options?: EnsureReadyOptionsLike): Promise<boolean> {
    this.setReady(true);
    return true;
  }

  cancel(): void {
    try { this.activeAbortController?.abort(); } catch { /* ignore */ }
    const rl = this.activeReadline;
    this.activeReadline = null;
    try { rl?.close(); } catch { /* ignore */ }
    const child = this.activeProcess;
    this.activeProcess = null;
    try { child?.kill(); } catch { /* ignore */ }
  }

  cleanup(): void {
    this.cancel();
  }

  closePersistentQuery(_reason: string): void {
    this.cancel();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  setPendingResumeAt(_resumeUuid: string | undefined): void {
    // Not supported in Gemini CLI mode.
  }

  applyForkState(conversation: Conversation): string | null {
    return conversation.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    // MCP server config is handled by the Gemini CLI itself.
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setExitPlanModeCallback(callback: any): void {
    this.exitPlanModeCallback = callback;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setPermissionModeSyncCallback(callback: any): void {
    this.permissionModeSyncCallback = callback;
  }

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    _conversationHistory?: ChatMessage[],
    _queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    if (images && images.length > 0) {
      yield { type: 'error', content: 'Gemini CLI does not support image attachments in this view.' };
      return;
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const hostnameKey = getHostnameKey();
    const commandFromSettings = (this.plugin.settings.geminiCliCommandsByHost?.[hostnameKey] ?? '').trim();
    const geminiCommandRaw = (commandFromSettings || customEnv.GEMINI_COMMAND || 'gemini').trim();
    const { cmd: geminiCommand, args: geminiCommandArgs } = parseCommand(geminiCommandRaw || 'gemini');

    const enhancedPath = getEnhancedPath(customEnv.PATH);
    const resolvedGeminiCommand = resolveWindowsShim(geminiCommand) ?? geminiCommand;

    // Keep Gemini CLI state in the conventional vault-local folder name.
    // Gemini stores its global settings under `${GEMINI_CLI_HOME}/.gemini`.
    const geminiCliHome = vaultPath;
    try {
      fs.mkdirSync(path.join(vaultPath, '.gemini'), { recursive: true });
    } catch {
      // Best-effort; gemini can still run without the folder being pre-created.
    }

    const args: string[] = ['--output-format', 'stream-json'];

    args.push('--approval-mode', buildGeminiApprovalMode(this.plugin.settings.permissionMode));

    const sandboxFlag = typeof customEnv.GEMINI_SANDBOX === 'string'
      ? customEnv.GEMINI_SANDBOX.trim()
      : '';
    if (sandboxFlag === '1' || sandboxFlag.toLowerCase() === 'true') {
      args.push('--sandbox');
    }

    const modelFromSettings = typeof this.plugin.settings.geminiModel === 'string'
      ? this.plugin.settings.geminiModel.trim()
      : '';
    const modelFromEnv = typeof customEnv.GEMINI_MODEL === 'string' ? customEnv.GEMINI_MODEL.trim() : '';
    const model = modelFromSettings || modelFromEnv;
    if (model) {
      args.push('--model', model);
    }

    // Apply a vault-local Gemini thinking budget override via `.gemini/settings.json`.
    // Gemini CLI currently doesn't expose a direct flag for this in headless mode.
    try {
      const modeFromSettings = normalizeGeminiThinkingMode(this.plugin.settings.geminiThinkingMode);
      const modeFromEnv = normalizeGeminiThinkingMode(customEnv.GEMINI_THINKING_MODE);
      const resolvedMode = modeFromSettings !== 'auto' ? modeFromSettings : modeFromEnv;

      const defaultBudget = resolveGeminiThinkingBudget('default') ?? 8192;
      const desiredBudget = resolvedMode === 'auto'
        ? defaultBudget
        : (resolveGeminiThinkingBudget(resolvedMode) ?? defaultBudget);

      const settingsPath = path.join(vaultPath, '.gemini', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const currentText = fs.readFileSync(settingsPath, 'utf8');
        const parsed = safeParseJsonWithComments(currentText);
        if (isRecord(parsed)) {
          const createIfMissing = resolvedMode !== 'auto';
          const changed = upsertGeminiThinkingBudgetOverride(parsed, desiredBudget, createIfMissing);
          if (changed) {
            const nextText = JSON.stringify(parsed, null, 2);
            if (nextText !== stripJsonComments(currentText).trim()) {
              fs.writeFileSync(settingsPath, `${nextText}\n`, 'utf8');
            }
          }
        }
      }
    } catch {
      // Best-effort; ignore settings patch failures.
    }

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    // Prompt (headless). Gemini treats stdin as additional context; keep stdin empty.
    args.push('--prompt', prompt);

    const abortController = new AbortController();
    this.activeAbortController = abortController;

    let stderrText = '';

    const toolUseStarted = new Set<string>();
    let accumulatedAssistantText = '';
    let resolvedModelFromInit: string | null = null;

    this.setReady(true);

    let child: ChildProcessWithoutNullStreams;
    try {
      const useShell = process.platform === 'win32' && (() => {
        const ext = path.extname(resolvedGeminiCommand).toLowerCase();
        return ext === '.cmd' || ext === '.bat' || ext === '.ps1' || ext === '';
      })();

      child = spawn(resolvedGeminiCommand, [...geminiCommandArgs, ...args], {
        cwd: vaultPath,
        env: {
          ...process.env,
          ...customEnv,
          PATH: enhancedPath,
          ...(process.platform === 'win32' ? { Path: enhancedPath } : {}),
          // Gemini resolves config under `${GEMINI_CLI_HOME}/.gemini`
          GEMINI_CLI_HOME: geminiCliHome,
        },
        // On Windows, some CLIs are distributed as `.cmd` shims (not directly spawnable).
        // `shell: true` lets cmd.exe resolve and execute them correctly.
        shell: useShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: abortController.signal,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to spawn gemini';
      yield { type: 'error', content: msg };
      return;
    }

    this.activeProcess = child;

    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(typeof code === 'number' ? code : null));
      child.once('error', () => resolve(null));
    });

    const spawnErrorRef: { current: Error | null } = { current: null };
    child.on('error', (err) => {
      spawnErrorRef.current = err instanceof Error ? err : new Error(String(err));
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });

    try {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.end();
    } catch {
      // ignore
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.activeReadline = rl;

    const onAbort = () => {
      try { rl.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    };
    try { abortController.signal.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }

    const unparsedStdout: string[] = [];

    try {
      for await (const line of rl) {
        if (abortController.signal.aborted) {
          break;
        }
        const trimmed = String(line || '').trim();
        if (!trimmed) continue;

        const evt = safeJsonParse(trimmed);
        if (!isRecord(evt)) {
          if (unparsedStdout.length < 5) {
            unparsedStdout.push(trimmed.slice(0, 500));
          }
          continue;
        }

        const type = typeof evt.type === 'string' ? evt.type : '';
        if (!type) continue;

        if (type === 'init') {
          const id = typeof evt.session_id === 'string' ? evt.session_id : null;
          if (id) {
            this.sessionId = id;
          }
          const initModel = typeof evt.model === 'string' ? evt.model : null;
          if (initModel) {
            resolvedModelFromInit = initModel;
          }
          continue;
        }

        if (type === 'message') {
          const role = typeof evt.role === 'string' ? evt.role : '';
          if (role !== 'assistant') continue;

          const content = typeof evt.content === 'string' ? evt.content : '';
          const isDelta = !!evt.delta;

          if (isDelta) {
            accumulatedAssistantText += content;
            if (content) {
              yield { type: 'text', content };
            }
          } else {
            const delta = normalizeDelta(accumulatedAssistantText, content);
            accumulatedAssistantText = content;
            if (delta) {
              yield { type: 'text', content: delta };
            }
          }

          continue;
        }

        if (type === 'tool_use') {
          const toolName = typeof evt.tool_name === 'string' ? evt.tool_name : '';
          const toolId = typeof evt.tool_id === 'string' ? evt.tool_id : '';
          const params = isRecord(evt.parameters) ? evt.parameters : {};

          if (!toolId) continue;
          if (!toolUseStarted.has(toolId)) {
            toolUseStarted.add(toolId);
            yield {
              type: 'tool_use',
              id: toolId,
              name: toolName || 'tool',
              input: params,
            };
          }
          continue;
        }

        if (type === 'tool_result') {
          const toolId = typeof evt.tool_id === 'string' ? evt.tool_id : '';
          if (!toolId) continue;

          const status = typeof evt.status === 'string' ? evt.status : '';
          const isError = status === 'error';
          const output = typeof evt.output === 'string' ? evt.output : '';
          const errorMessage =
            isRecord(evt.error) && typeof evt.error.message === 'string'
              ? evt.error.message
              : '';

          yield {
            type: 'tool_result',
            id: toolId,
            content: isError ? (errorMessage || 'Tool failed.') : (output || 'Tool completed.'),
            isError,
          };
          continue;
        }

        if (type === 'error') {
          const message = typeof evt.message === 'string' ? evt.message : '';
          yield { type: 'error', content: message || 'Gemini error.' };
          continue;
        }

        if (type === 'result') {
          const status = typeof evt.status === 'string' ? evt.status : '';

          const stats = isRecord(evt.stats) ? (evt.stats as Record<string, unknown>) : null;
          if (stats) {
            const usageModel = resolvedModelFromInit || model || '';

            yield {
              type: 'usage',
              sessionId: this.sessionId,
              usage: buildGeminiUsageInfo(stats, usageModel, this.plugin.settings.customContextLimits),
            };
          }

          if (status === 'error') {
            const errorMessage =
              isRecord(evt.error) && typeof evt.error.message === 'string'
                ? evt.error.message
                : '';
            yield { type: 'error', content: errorMessage || 'Gemini failed.' };
          }
          continue;
        }
      }
    } finally {
      try { abortController.signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      try { rl.close(); } catch { /* ignore */ }
      if (!abortController.signal.aborted && child.exitCode === null) {
        try { child.kill(); } catch { /* ignore */ }
      }
      if (this.activeReadline === rl) this.activeReadline = null;
      if (this.activeProcess === child) this.activeProcess = null;
      if (this.activeAbortController === abortController) this.activeAbortController = null;
    }

    if (abortController.signal.aborted) {
      yield { type: 'done' };
      return;
    }

    const exitCode = await exitPromise;

    const spawnError = spawnErrorRef.current;
    if (spawnError) {
      const npmBin = process.platform === 'win32' && process.env.APPDATA
        ? `${process.env.APPDATA}\\npm`
        : '';
      const suffix = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
        ? `\n\nGemini CLI not found. If you're on Windows, Obsidian may not inherit your terminal PATH.\n- Try setting GEMINI_COMMAND to a full path (e.g. "${npmBin ? `${npmBin}\\gemini.cmd` : '%APPDATA%\\\\npm\\\\gemini.cmd'}").\n- Or add your npm global bin to PATH (often "%APPDATA%\\npm").`
        : '';
      yield { type: 'error', content: `${spawnError.message}${suffix}`.trim() };
      yield { type: 'done' };
      return;
    }

    if (exitCode !== 0) {
      const details = stderrText.trim();
      if (details) {
        yield { type: 'error', content: details };
      } else if (exitCode !== null) {
        yield { type: 'error', content: `Gemini exited with code ${exitCode}.` };
      }
    } else if (unparsedStdout.length > 0) {
      yield {
        type: 'error',
        content: `Gemini produced no JSON events.\n\nFirst stdout lines:\n${unparsedStdout.join('\n')}`,
      };
    }

    yield { type: 'done' };
  }
}
