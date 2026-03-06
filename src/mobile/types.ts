export interface MobileSettings {
  /** Remote hub base URL, e.g. http://192.168.1.10:3006 */
  hubUrl: string;
  /** Hub access token: shared secret (e.g. CLI_API_TOKEN[:namespace]) */
  accessToken: string;
  /** Last selected hub session id (for convenience). */
  lastSessionId: string | null;
  /** Whether to auto-refresh sessions/messages. */
  autoRefresh: boolean;
  /** Refresh interval for messages (ms). */
  messageRefreshMs: number;
  /** Refresh interval for sessions list (ms). */
  sessionsRefreshMs: number;
}

export const DEFAULT_MOBILE_SETTINGS: MobileSettings = {
  hubUrl: '',
  accessToken: '',
  lastSessionId: null,
  autoRefresh: true,
  messageRefreshMs: 2500,
  sessionsRefreshMs: 10_000,
};

export type RemoteAuthResponse = {
  token: string;
  user: {
    id: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
};

export type RemoteSessionSummary = {
  id: string;
  active: boolean;
  thinking: boolean;
  activeAt: number;
  updatedAt: number;
  metadata: {
    name?: string;
    path: string;
    machineId?: string;
    summary?: { text: string };
    flavor?: string | null;
  } | null;
  todoProgress: { completed: number; total: number } | null;
  pendingRequestsCount: number;
  modelMode?: string;
  thinkingMode?: string;
};

export type RemoteSessionsResponse = { sessions: RemoteSessionSummary[] };

export type RemoteCreateSessionBody = {
  id?: string;
  cwd?: string;
  name?: string;
  flavor?: 'claude' | 'codex' | 'gemini' | string;
  model?: string;
  thinkingMode?: string;
  resumeToken?: string;
};

export type RemoteCreateSessionResponse = {
  ok: true;
  sessionId: string;
};

export type RemoteUpdateSessionBody = {
  name?: string;
  model?: string;
  thinkingMode?: string;
};

export type RemoteAgentStateRequest = {
  tool: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments: any;
  createdAt?: number | null;
};

export type RemoteAgentState = {
  controlledByUser?: boolean | null;
  requests?: Record<string, RemoteAgentStateRequest> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completedRequests?: Record<string, any> | null;
} | null;

export type RemoteSession = {
  id: string;
  active: boolean;
  thinking?: boolean;
  updatedAt: number;
  agentState: RemoteAgentState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any;
  modelMode?: string;
  thinkingMode?: string;
};

export type RemoteSessionResponse = { session: RemoteSession };

export type RemoteMessageStatus = 'sending' | 'sent' | 'failed';

export type RemoteDecryptedMessage = {
  id: string;
  seq: number | null;
  localId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
  createdAt: number;
  status?: RemoteMessageStatus;
  originalText?: string;
};

export type RemoteMessagesResponse = {
  messages: RemoteDecryptedMessage[];
  page: {
    limit: number;
    beforeSeq: number | null;
    nextBeforeSeq: number | null;
    hasMore: boolean;
  };
};

export type RemoteCommandsResponse = {
  commands: string[];
};

export type RemoteApprovePermissionBody = {
  mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowTools?: string[];
  decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
  // Flat or nested answers formats supported by the hub.
  answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

export type RemoteDenyPermissionBody = {
  decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
};

export type RemoteInterruptResponse = {
  ok: true;
  interrupted?: boolean;
};

export type RemoteMcpServer = {
  name: string;
  type?: string;
  enabled: boolean;
  contextSaving: boolean;
  description?: string;
};

export type RemoteMcpServersResponse = {
  exists: boolean;
  servers: RemoteMcpServer[];
};

export type RemoteUpdateMcpServersBody = {
  servers: Record<string, { enabled?: boolean; contextSaving?: boolean }>;
};

export type RemoteUpdateMcpServersResponse = {
  ok: true;
  exists: boolean;
  servers: RemoteMcpServer[];
};

export type RemoteUploadFileBody = {
  /** Relative path to store under `.clian/hub_uploads/<ns>/<sessionId>/...` */
  path?: string;
  /** Optional alias for path (fallback). */
  name?: string;
  /** Base64 file content (can be data URL). */
  contentBase64: string;
  overwrite?: boolean;
};

export type RemoteUploadFileResponse = {
  ok: true;
  /** Path relative to session cwd on the hub. */
  path: string;
  size: number;
};
