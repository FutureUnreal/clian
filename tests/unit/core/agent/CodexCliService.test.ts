import { buildCodexPermissionArgs, buildCodexUsageInfo } from '@/core/agent/CodexCliService';

describe('CodexCliService permissions', () => {
  it('maps yolo mode to Codex full access', () => {
    expect(buildCodexPermissionArgs('yolo', '')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('ignores sandbox overrides when yolo mode is enabled', () => {
    expect(buildCodexPermissionArgs('yolo', 'read-only')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('maps normal mode to on-request with workspace-write sandbox by default', () => {
    expect(buildCodexPermissionArgs('normal', '')).toEqual([
      '--ask-for-approval',
      'on-request',
      '--sandbox',
      'workspace-write',
    ]);
  });

  it('preserves explicit sandbox overrides outside yolo mode', () => {
    expect(buildCodexPermissionArgs('plan', 'read-only')).toEqual([
      '--ask-for-approval',
      'on-request',
      '--sandbox',
      'read-only',
    ]);
  });
});

describe('CodexCliService usage mapping', () => {
  it('uses total_tokens for context usage and keeps turn totals separate', () => {
    expect(buildCodexUsageInfo({
      input_tokens: 12000,
      cached_input_tokens: 3000,
      output_tokens: 6000,
      total_tokens: 15000,
    }, 'gpt-5.4')).toEqual({
      model: 'gpt-5.4',
      inputTokens: 9000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 3000,
      outputTokens: 6000,
      totalTokens: 18000,
      contextWindow: 272000,
      contextTokens: 15000,
      percentage: 6,
    });
  });

  it('falls back to prompt tokens when total_tokens is unavailable', () => {
    expect(buildCodexUsageInfo({
      input_tokens: 12000,
      cached_input_tokens: 3000,
      output_tokens: 6000,
    }, 'gpt-5.4')).toMatchObject({
      inputTokens: 9000,
      cacheReadInputTokens: 3000,
      outputTokens: 6000,
      totalTokens: 18000,
      contextTokens: 12000,
    });
  });

  it('uses the correct 128k context window for gpt-oss models', () => {
    expect(buildCodexUsageInfo({
      input_tokens: 64000,
      total_tokens: 64000,
    }, 'gpt-oss-120b')).toMatchObject({
      contextWindow: 128000,
      contextTokens: 64000,
      percentage: 50,
    });
  });
});
