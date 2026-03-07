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
  getCodexContextWindowSize,
  getHostnameKey,
  type ImageAttachment,
  normalizeCodexReasoningEffort,
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

function normalizeDelta(previous: string, next: string): string {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

export function buildCodexPermissionArgs(permissionMode: string, explicitSandbox: string): string[] {
  if (permissionMode === 'yolo') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }

  return ['--ask-for-approval', 'on-request', '--sandbox', explicitSandbox || 'workspace-write'];
}

export function buildCodexUsageInfo(
  usage: Record<string, unknown>,
  model: string,
  customContextLimits?: Record<string, number>,
): UsageInfo {
  const inputTokensTotal = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const cachedInputTokens = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const nonCachedInputTokens = Math.max(0, inputTokensTotal - cachedInputTokens);
  const contextTokens =
    typeof usage.total_tokens === 'number' && usage.total_tokens > 0
      ? usage.total_tokens
      : inputTokensTotal;
  const totalTokens = inputTokensTotal + Math.max(0, outputTokens);
  const contextWindow = getCodexContextWindowSize(model, customContextLimits);
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

export class CodexCliService implements ChatService {
  readonly flavor = 'codex' as const;

  private plugin: ClianPlugin;
  private ready = true;
  private readyListeners = new Set<(ready: boolean) => void>();

  private sessionId: string | null = null;
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private activeAbortController: AbortController | null = null;
  private activeReadline: ReadlineInterface | null = null;

  // Claude-only callbacks (no-op for Codex)
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
    // Not supported in Codex CLI mode.
  }

  applyForkState(conversation: Conversation): string | null {
    // Fork semantics are Claude-specific; for Codex, just restore resume token if present.
    return conversation.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    // MCP server config is handled by the Codex CLI itself.
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
      yield { type: 'error', content: 'Codex CLI does not support image attachments in this view.' };
      return;
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const hostnameKey = getHostnameKey();
    const commandFromSettings = (this.plugin.settings.codexCliCommandsByHost?.[hostnameKey] ?? '').trim();
    const codexCommandRaw = (commandFromSettings || customEnv.CODEX_COMMAND || 'codex').trim();
    const { cmd: codexCommand, args: codexCommandArgs } = parseCommand(codexCommandRaw || 'codex');

    const enhancedPath = getEnhancedPath(customEnv.PATH);
    const resolvedCodexCommand = resolveWindowsShim(codexCommand) ?? codexCommand;

    // Keep Codex state in the conventional vault-local folder name.
    const codexHome = path.join(vaultPath, '.codex');
    try {
      fs.mkdirSync(codexHome, { recursive: true });
    } catch {
      // Best-effort; codex can still run without the folder being pre-created.
    }

    const args: string[] = ['exec', '--json', '--skip-git-repo-check', '-C', vaultPath];

    const sandbox = typeof customEnv.CODEX_SANDBOX === 'string' ? customEnv.CODEX_SANDBOX.trim() : '';
    args.push(...buildCodexPermissionArgs(this.plugin.settings.permissionMode, sandbox));

    const modelFromSettings = typeof this.plugin.settings.codexModel === 'string'
      ? this.plugin.settings.codexModel.trim()
      : '';
    const modelFromEnv = typeof customEnv.CODEX_MODEL === 'string' ? customEnv.CODEX_MODEL.trim() : '';
    const model = modelFromSettings || modelFromEnv;
    if (model) {
      args.push('-m', model);
    }

    const effortFromSettings = normalizeCodexReasoningEffort(this.plugin.settings.codexReasoningEffort);
    const effortFromEnvRaw = typeof customEnv.CODEX_REASONING_EFFORT === 'string'
      ? customEnv.CODEX_REASONING_EFFORT.trim()
      : '';
    const effort = effortFromEnvRaw ? normalizeCodexReasoningEffort(effortFromEnvRaw) : effortFromSettings;
    args.push('--config', `model_reasoning_effort="${effort}"`);

    if (this.sessionId) {
      args.push('resume', this.sessionId);
    }

    // Read prompt from stdin to avoid command line length limits.
    args.push('-');

    const abortController = new AbortController();
    this.activeAbortController = abortController;

    let stderrText = '';

    let sawAnyOutput = false;
    const agentMessageTextById = new Map<string, string>();
    const reasoningTextById = new Map<string, string>();
    const toolUseStarted = new Set<string>();

    this.setReady(true);

    let child: ChildProcessWithoutNullStreams;
    try {
      const useShell = process.platform === 'win32' && (() => {
        const ext = path.extname(resolvedCodexCommand).toLowerCase();
        return ext === '.cmd' || ext === '.bat' || ext === '.ps1' || ext === '';
      })();

      child = spawn(resolvedCodexCommand, [...codexCommandArgs, ...args], {
        cwd: vaultPath,
        env: {
          ...process.env,
          ...customEnv,
          PATH: enhancedPath,
          // Some Windows environments key PATH as "Path"
          ...(process.platform === 'win32' ? { Path: enhancedPath } : {}),
          CODEX_HOME: codexHome,
        },
        // On Windows, some CLIs are distributed as `.cmd` shims (not directly spawnable).
        // `shell: true` lets cmd.exe resolve and execute them correctly.
        shell: useShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: abortController.signal,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to spawn codex';
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
      child.stdin.write(prompt);
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
        sawAnyOutput = true;

        if (type === 'thread.started') {
          const threadId = typeof evt.thread_id === 'string' ? evt.thread_id : null;
          if (threadId) {
            this.sessionId = threadId;
          }
          continue;
        }

        if (type === 'turn.completed' && isRecord(evt.usage)) {
          yield {
            type: 'usage',
            sessionId: this.sessionId,
            usage: buildCodexUsageInfo(evt.usage as Record<string, unknown>, model, this.plugin.settings.customContextLimits),
          };
          continue;
        }

        if (type === 'turn.failed') {
          const err = isRecord(evt.error) && typeof evt.error.message === 'string' ? evt.error.message : '';
          yield { type: 'error', content: err || 'Codex turn failed.' };
          continue;
        }

        if (type === 'error') {
          const message = typeof evt.message === 'string' ? evt.message : '';
          yield { type: 'error', content: message || 'Codex error.' };
          continue;
        }

        if (
          (type === 'item.started' || type === 'item.updated' || type === 'item.completed') &&
          isRecord(evt.item)
        ) {
          const item = evt.item;
          const itemId = typeof item.id === 'string' ? item.id : '';
          const itemType = typeof item.type === 'string' ? item.type : '';

          if (!itemId || !itemType) continue;

          if (itemType === 'agent_message') {
            const nextText = typeof item.text === 'string' ? item.text : '';
            const prevText = agentMessageTextById.get(itemId) ?? '';
            const delta = normalizeDelta(prevText, nextText);
            agentMessageTextById.set(itemId, nextText);
            if (delta) {
              yield { type: 'text', content: delta };
            }
            continue;
          }

          if (itemType === 'reasoning') {
            const nextText = typeof item.text === 'string' ? item.text : '';
            const prevText = reasoningTextById.get(itemId) ?? '';
            const delta = normalizeDelta(prevText, nextText);
            reasoningTextById.set(itemId, nextText);
            if (delta) {
              yield { type: 'thinking', content: delta };
            }
            continue;
          }

          if (itemType === 'command_execution') {
            const command = typeof item.command === 'string' ? item.command : '';
            if (!toolUseStarted.has(itemId)) {
              toolUseStarted.add(itemId);
              yield {
                type: 'tool_use',
                id: itemId,
                name: 'codex.command',
                input: command ? { command } : {},
              };
            }

            const status = typeof item.status === 'string' ? item.status : '';
            if (type === 'item.completed' || status === 'completed' || status === 'failed' || status === 'declined') {
              const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
              const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
              const isError = status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0);
              const footer = exitCode === null ? '' : `\n\n(exit code: ${exitCode})`;
              yield {
                type: 'tool_result',
                id: itemId,
                content: `${output || ''}${footer}`.trim(),
                isError,
              };
            }
            continue;
          }

          if (itemType === 'file_change') {
            if (!toolUseStarted.has(itemId)) {
              toolUseStarted.add(itemId);
              yield {
                type: 'tool_use',
                id: itemId,
                name: 'codex.file_change',
                input: {
                  changes: Array.isArray(item.changes) ? item.changes : [],
                },
              };
            }

            const status = typeof item.status === 'string' ? item.status : '';
            if (type === 'item.completed' || status === 'completed' || status === 'failed') {
              const isError = status === 'failed';
              yield {
                type: 'tool_result',
                id: itemId,
                content: isError ? 'File change failed.' : 'File change applied.',
                isError,
              };
            }
            continue;
          }

          if (itemType === 'mcp_tool_call') {
            const server = typeof item.server === 'string' ? item.server : '';
            const tool = typeof item.tool === 'string' ? item.tool : '';
            const toolName = server && tool ? `mcp__${server}__${tool}` : 'mcp_tool';
            const argsValue = item.arguments;
            const input = isRecord(argsValue) ? argsValue : (argsValue === undefined ? {} : { arguments: argsValue });

            if (!toolUseStarted.has(itemId)) {
              toolUseStarted.add(itemId);
              yield {
                type: 'tool_use',
                id: itemId,
                name: toolName,
                input,
              };
            }

            const status = typeof item.status === 'string' ? item.status : '';
            if (type === 'item.completed' || status === 'completed' || status === 'failed') {
              const isError = status === 'failed';
              const errorMessage =
                isRecord(item.error) && typeof item.error.message === 'string'
                  ? item.error.message
                  : '';
              const result = isRecord(item.result) ? item.result : null;
              const content = isError
                ? (errorMessage || 'MCP tool failed.')
                : (result ? JSON.stringify(result, null, 2) : 'MCP tool completed.');
              yield {
                type: 'tool_result',
                id: itemId,
                content,
                isError,
              };
            }
            continue;
          }
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
        ? `\n\nCodex CLI not found. If you're on Windows, Obsidian may not inherit your terminal PATH.\n- Try setting CODEX_COMMAND to a full path (e.g. "${npmBin ? `${npmBin}\\codex.cmd` : '%APPDATA%\\\\npm\\\\codex.cmd'}").\n- Or add your npm global bin to PATH (often "%APPDATA%\\npm").`
        : '';
      yield { type: 'error', content: `${spawnError.message}${suffix}`.trim() };
      yield { type: 'done' };
      return;
    }

    if (exitCode !== 0) {
      const details = stderrText.trim();
      if (!sawAnyOutput && details) {
        yield { type: 'error', content: details };
      } else if (!sawAnyOutput && exitCode !== null) {
        yield { type: 'error', content: `Codex exited with code ${exitCode}.` };
      }
    } else if (!sawAnyOutput && (stderrText.trim() || unparsedStdout.length > 0)) {
      const details = stderrText.trim();
      const sample = unparsedStdout.length > 0 ? `\n\nFirst stdout lines:\n${unparsedStdout.join('\n')}` : '';
      yield {
        type: 'error',
        content: details
          ? `Codex produced no JSON events.\n\nStderr:\n${details}${sample}`
          : `Codex produced no JSON events.${sample}`,
      };
    }

    yield { type: 'done' };
  }
}
