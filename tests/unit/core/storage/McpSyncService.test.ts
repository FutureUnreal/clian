import { buildCodexMcpBlock, McpSyncService } from '@/core/storage/McpSyncService';
import type { ClianMcpServer } from '@/core/types';

function createMockAdapter(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const folders = new Set<string>();

  return {
    files,
    folders,
    adapter: {
      ensureFolder: jest.fn(async (folderPath: string) => {
        folders.add(folderPath);
      }),
      exists: jest.fn(async (filePath: string) => files.has(filePath) || folders.has(filePath)),
      read: jest.fn(async (filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) throw new Error(`Missing file: ${filePath}`);
        return content;
      }),
      write: jest.fn(async (filePath: string, content: string) => {
        files.set(filePath, content);
      }),
      getBasePath: jest.fn(() => 'C:/vault'),
    },
  };
}

function createStdioServer(name: string, overrides: Partial<ClianMcpServer> = {}): ClianMcpServer {
  return {
    id: `${name}-id`,
    name,
    enabled: true,
    type: 'stdio',
    contextSaving: true,
    disabledTools: [],
    description: '',
    config: {
      command: 'uvx',
      args: ['--from', 'git+https://example.com/server', name],
      env: { API_KEY: 'test-key' },
    },
    ...overrides,
  };
}

describe('McpSyncService Codex wrapper sync', () => {
  it('wraps grok-search on Windows to filter noisy stdout', () => {
    const block = buildCodexMcpBlock([createStdioServer('grok-search')], 'win32', {
      'grok-search': {
        command: 'uvx',
        args: ['--from', 'git+https://example.com/server', 'grok-search'],
        env: {
          GROK_API_KEY: 'from-claude-user-config',
          GROK_API_URL: 'https://grok.example/v1',
        },
      },
    }, 'C:/vault');

    expect(block).toContain('[mcp_servers."grok-search"]');
    expect(block).toContain('command = "node"');
    expect(block).toContain('C:/vault/.clian/bin/codex-mcp-wrapper.cjs');
    expect(block).toContain('"--"');
    expect(block).toContain('"uvx"');
    expect(block).toContain('PYTHONIOENCODING = "utf-8"');
    expect(block).toContain('PYTHONUTF8 = "1"');
    expect(block).toContain('API_KEY = "test-key"');
    expect(block).toContain('env_vars = ["GROK_API_KEY","GROK_API_URL"]');
  });

  it('keeps the original command outside Windows', () => {
    const block = buildCodexMcpBlock([createStdioServer('grok-search')], 'linux');

    expect(block).toContain('[mcp_servers."grok-search"]');
    expect(block).toContain('command = "uvx"');
    expect(block).not.toContain('command = "node"');
    expect(block).not.toContain('.clian/bin/codex-mcp-wrapper.cjs');
  });

  it('writes the wrapper script alongside the managed Codex config', async () => {
    const { adapter, files, folders } = createMockAdapter({
      '.clian/mcp.json': JSON.stringify({
        mcpServers: {
          'grok-search': {
            command: 'uvx',
            args: ['--from', 'git+https://example.com/server', 'grok-search'],
          },
        },
        _clian: {
          servers: {
            'grok-search': {
              enabled: true,
              contextSaving: true,
              disabledTools: [],
            },
          },
        },
      }),
    });

    const service = new McpSyncService(adapter as never);
    await service.syncFromSharedLayer([createStdioServer('grok-search')]);

    expect(folders.has('.clian/bin')).toBe(true);
    const codexConfig = files.get('.codex/config.toml') || '';
    expect(codexConfig.includes('C:/vault/.clian/bin/codex-mcp-wrapper.cjs')).toBe(process.platform === 'win32');

    const wrapper = files.get('.clian/bin/codex-mcp-wrapper.cjs');
    expect(wrapper).toBeTruthy();
    expect(wrapper).toContain("function isJsonRpcMessage(message)");
    expect(wrapper).toContain("redirected-stdout");
    expect(wrapper).toContain("suppressed-pre-init");
    expect(wrapper).toContain("message.jsonrpc === '2.0'");
  });

  it('preserves Gemini local stdio MCP env and cwd when syncing shared servers', async () => {
    const { adapter, files } = createMockAdapter({
      '.gemini/settings.json': JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
        mcpServers: {
          'grok-search': {
            command: 'uvx',
            args: ['--from', 'git+https://example.com/server', 'grok-search'],
            cwd: 'C:/Users/test/tools',
            env: {
              GROK_API_KEY: 'from-gemini-settings',
              GROK_API_URL: 'https://grok.example/v1',
            },
            includeTools: ['web_search'],
          },
        },
      }, null, 2),
    });

    const service = new McpSyncService(adapter as never);
    await service.syncFromSharedLayer([createStdioServer('grok-search')]);

    const next = JSON.parse(files.get('.gemini/settings.json') || '{}') as Record<string, any>;
    expect(next.security?.auth?.selectedType).toBe('oauth-personal');
    expect(next.mcpServers?.['grok-search']).toMatchObject({
      command: 'uvx',
      args: ['--from', 'git+https://example.com/server', 'grok-search'],
      cwd: 'C:/Users/test/tools',
      includeTools: ['web_search'],
      env: {
        API_KEY: 'test-key',
        GROK_API_KEY: 'from-gemini-settings',
        GROK_API_URL: 'https://grok.example/v1',
      },
    });
  });

  it('parses commented Gemini settings and preserves local MCP env', async () => {
    const commentedSettings = `{
  // Keep local Gemini auth and MCP secrets
  "security": { "auth": { "selectedType": "oauth-personal" } },
  "mcpServers": {
    "grok-search": {
      "command": "uvx",
      "args": ["--from", "git+https://example.com/server", "grok-search"],
      "env": {
        "GROK_API_KEY": "commented-key"
      }
    }
  }
}`;
    const { adapter, files } = createMockAdapter({
      '.gemini/settings.json': commentedSettings,
    });

    const service = new McpSyncService(adapter as never);
    await service.syncFromSharedLayer([createStdioServer('grok-search')]);

    const next = JSON.parse(files.get('.gemini/settings.json') || '{}') as Record<string, any>;
    expect(next.security?.auth?.selectedType).toBe('oauth-personal');
    expect(next.mcpServers?.['grok-search']?.env).toMatchObject({
      API_KEY: 'test-key',
      GROK_API_KEY: 'commented-key',
    });
  });
});
