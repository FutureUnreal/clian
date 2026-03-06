import { requestUrl } from 'obsidian';

import type {
  RemoteApprovePermissionBody,
  RemoteAuthResponse,
  RemoteCommandsResponse,
  RemoteCreateSessionBody,
  RemoteCreateSessionResponse,
  RemoteDenyPermissionBody,
  RemoteInterruptResponse,
  RemoteMcpServersResponse,
  RemoteMessagesResponse,
  RemoteSessionResponse,
  RemoteSessionsResponse,
  RemoteUpdateMcpServersBody,
  RemoteUpdateMcpServersResponse,
  RemoteUpdateSessionBody,
  RemoteUploadFileBody,
  RemoteUploadFileResponse,
} from './types';

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

function buildUrl(baseUrl: string, path: string): string {
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return `${baseUrl}${path}`;
  }
}

function base64UrlToBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return padded;
}

function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;

  if (typeof atob !== 'function') {
    return null;
  }

  try {
    const json = atob(base64UrlToBase64(parts[1]));
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp === 'number') {
      return payload.exp * 1000;
    }
  } catch {
    // ignore
  }

  return null;
}

export class RemoteHubClient {
  private baseUrl: string;
  private accessToken: string;
  private jwt: string | null = null;
  private jwtExpiresAtMs: number | null = null;

  constructor(options: { baseUrl: string; accessToken: string }) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.accessToken = options.accessToken.trim();
  }

  setConfig(options: { baseUrl: string; accessToken: string }): void {
    const nextBaseUrl = normalizeBaseUrl(options.baseUrl);
    const nextAccessToken = options.accessToken.trim();

    const baseChanged = nextBaseUrl !== this.baseUrl;
    const tokenChanged = nextAccessToken !== this.accessToken;

    this.baseUrl = nextBaseUrl;
    this.accessToken = nextAccessToken;

    if (baseChanged || tokenChanged) {
      this.jwt = null;
      this.jwtExpiresAtMs = null;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getJwt(): string | null {
    return this.jwt;
  }

  async authenticate(): Promise<string> {
    if (!this.baseUrl) {
      throw new Error('Missing hub URL.');
    }
    if (!this.accessToken) {
      throw new Error('Missing hub access token.');
    }

    const url = buildUrl(this.baseUrl, '/api/auth');
    const res = await requestUrl({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: this.accessToken }),
    });

    const parsed = res.json as RemoteAuthResponse;
    if (!parsed || typeof parsed.token !== 'string' || !parsed.token) {
      throw new Error('Invalid auth response from hub.');
    }

    this.jwt = parsed.token;
    this.jwtExpiresAtMs = decodeJwtExpMs(parsed.token);
    return parsed.token;
  }

  async ensureJwt(): Promise<string> {
    const now = Date.now();
    const expiresAt = this.jwtExpiresAtMs;

    if (this.jwt && expiresAt && expiresAt > now + 60_000) {
      return this.jwt;
    }

    // If we can't decode exp, treat as short-lived and refresh periodically.
    if (this.jwt && !expiresAt) {
      return this.jwt;
    }

    return await this.authenticate();
  }

  private async authedRequest<T>(
    path: string,
    init?: { method?: string; body?: string }
  ): Promise<T> {
    const token = await this.ensureJwt();
    const url = buildUrl(this.baseUrl, path);

    try {
      const res = await requestUrl({
        url,
        method: init?.method,
        headers: {
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${token}`,
        },
        body: init?.body,
      });
      return res.json as T;
    } catch (error) {
      void error;
      // Best-effort retry once if token is expired/invalid.
      this.jwt = null;
      this.jwtExpiresAtMs = null;
      const refreshed = await this.authenticate();
      const res = await requestUrl({
        url,
        method: init?.method,
        headers: {
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${refreshed}`,
        },
        body: init?.body,
      });
      return res.json as T;
    }
  }

  async getSessions(): Promise<RemoteSessionsResponse> {
    return await this.authedRequest<RemoteSessionsResponse>('/api/sessions');
  }

  async createSession(body: RemoteCreateSessionBody): Promise<RemoteCreateSessionResponse> {
    return await this.authedRequest<RemoteCreateSessionResponse>(
      '/api/sessions',
      {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.authedRequest<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    );
  }

  async getSession(sessionId: string): Promise<RemoteSessionResponse> {
    return await this.authedRequest<RemoteSessionResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  async getCommands(sessionId: string): Promise<RemoteCommandsResponse> {
    return await this.authedRequest<RemoteCommandsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/commands`
    );
  }

  async updateSession(sessionId: string, body: RemoteUpdateSessionBody): Promise<void> {
    await this.authedRequest<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body ?? {}),
      }
    );
  }

  async getMessages(sessionId: string, options?: { limit?: number }): Promise<RemoteMessagesResponse> {
    const limit = options?.limit ?? 50;
    return await this.authedRequest<RemoteMessagesResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${encodeURIComponent(String(limit))}`
    );
  }

  async sendMessage(sessionId: string, text: string, localId?: string): Promise<void> {
    await this.authedRequest<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ text, localId: localId ?? undefined }),
      }
    );
  }

  async approvePermission(sessionId: string, requestId: string, body?: RemoteApprovePermissionBody): Promise<void> {
    await this.authedRequest<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }
    );
  }

  async denyPermission(sessionId: string, requestId: string, body?: RemoteDenyPermissionBody): Promise<void> {
    await this.authedRequest<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`,
      {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }
    );
  }

  async interruptSession(sessionId: string): Promise<RemoteInterruptResponse> {
    return await this.authedRequest<RemoteInterruptResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      { method: 'POST', body: JSON.stringify({}) }
    );
  }

  async getMcpServers(sessionId: string): Promise<RemoteMcpServersResponse> {
    return await this.authedRequest<RemoteMcpServersResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/mcp`
    );
  }

  async updateMcpServers(sessionId: string, body: RemoteUpdateMcpServersBody): Promise<RemoteUpdateMcpServersResponse> {
    return await this.authedRequest<RemoteUpdateMcpServersResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/mcp`,
      { method: 'PATCH', body: JSON.stringify(body ?? {}) }
    );
  }

  async uploadFile(sessionId: string, body: RemoteUploadFileBody): Promise<RemoteUploadFileResponse> {
    return await this.authedRequest<RemoteUploadFileResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/files`,
      { method: 'POST', body: JSON.stringify(body ?? {}) }
    );
  }
}
