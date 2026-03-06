import type { Conversation, ExitPlanModeCallback, ImageAttachment, SlashCommand, StreamChunk } from '../types';
import type { ChatFlavor, ChatMessage } from '../types/chat';
import type { ApprovalCallback, QueryOptions } from './ClianService';

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export interface EnsureReadyOptionsLike {
  sessionId?: string;
  externalContextPaths?: string[];
  force?: boolean;
  preserveHandlers?: boolean;
}

export interface ClosePersistentQueryOptionsLike {
  preserveHandlers?: boolean;
}

/**
 * Minimal agent interface consumed by the chat UI.
 *
 * This intentionally matches ClianService's public surface area, but is
 * implemented by other backends (Codex, Gemini) on desktop.
 */
export interface ChatService {
  readonly flavor: ChatFlavor;

  query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk>;

  ensureReady(options?: EnsureReadyOptionsLike): Promise<boolean>;
  isReady(): boolean;
  onReadyStateChange(listener: (ready: boolean) => void): () => void;

  cancel(): void;
  cleanup(): void | Promise<void>;
  closePersistentQuery(reason: string, options?: ClosePersistentQueryOptionsLike): void;

  getSessionId(): string | null;
  setSessionId(sessionId: string | null, externalContextPaths?: string[]): void;

  setPendingResumeAt(resumeUuid: string | undefined): void;
  applyForkState(conversation: Conversation): string | null;

  /** Reload MCP config if supported by this backend. */
  reloadMcpServers(): Promise<void>;

  getSupportedCommands(): Promise<SlashCommand[]>;

  setApprovalCallback(callback: ApprovalCallback | null): void;
  setApprovalDismisser(dismisser: (() => void) | null): void;
  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void;
  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void;
  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void;
}
