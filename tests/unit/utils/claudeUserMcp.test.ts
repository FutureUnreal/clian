import {
  type ClaudeUserMcpServerMap,
  getClaudeUserEnvFallback,
  getCodexInheritedEnvVarNames,
  mergeClaudeUserMcpEnvIntoProcessEnv,
} from '@/utils/claudeUserMcp';

describe('claudeUserMcp utils', () => {
  const userServers: ClaudeUserMcpServerMap = {
    'grok-search': {
      command: 'uvx',
      args: ['--from', 'git+https://github.com/GuDaStudio/GrokSearch@grok-with-tavily', 'grok-search'],
      env: {
        FIRECRAWL_API_KEY: 'fc-test',
        GROK_API_KEY: 'grok-test',
        GROK_API_URL: 'https://grok.example/v1',
      },
    },
  };

  const config = {
    command: 'uvx',
    args: ['--from', 'git+https://github.com/GuDaStudio/GrokSearch@grok-with-tavily', 'grok-search'],
  };

  it('matches Claude user MCP env for the same stdio command', () => {
    expect(getClaudeUserEnvFallback('grok-search', config, userServers)).toEqual(userServers['grok-search'].env);
  });

  it('emits Codex env_vars only for values not explicitly set in shared config', () => {
    expect(getCodexInheritedEnvVarNames('grok-search', config, { GROK_API_KEY: 'override' }, userServers)).toEqual([
      'FIRECRAWL_API_KEY',
      'GROK_API_URL',
    ]);
  });

  it('injects Claude user MCP env into the Codex parent process without overwriting explicit values', () => {
    expect(mergeClaudeUserMcpEnvIntoProcessEnv({ GROK_API_KEY: 'keep-me' }, userServers)).toMatchObject({
      FIRECRAWL_API_KEY: 'fc-test',
      GROK_API_KEY: 'keep-me',
      GROK_API_URL: 'https://grok.example/v1',
    });
  });
});
