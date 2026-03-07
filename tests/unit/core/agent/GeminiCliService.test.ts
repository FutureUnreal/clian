import { buildGeminiApprovalMode, buildGeminiUsageInfo } from '@/core/agent/GeminiCliService';

describe('GeminiCliService permissions', () => {
  it('maps yolo mode to Gemini yolo approval mode', () => {
    expect(buildGeminiApprovalMode('yolo')).toBe('yolo');
  });

  it('maps plan mode to Gemini plan approval mode', () => {
    expect(buildGeminiApprovalMode('plan')).toBe('plan');
  });

  it('maps normal mode to Gemini default approval mode', () => {
    expect(buildGeminiApprovalMode('normal')).toBe('default');
  });
});

describe('GeminiCliService usage mapping', () => {
  it('keeps context usage and turn totals separate', () => {
    expect(buildGeminiUsageInfo({
      input_tokens: 15000,
      input: 12000,
      cached: 3000,
      output_tokens: 6000,
      total_tokens: 21000,
    }, 'gemini-2.5-pro')).toEqual({
      model: 'gemini-2.5-pro',
      inputTokens: 12000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 3000,
      outputTokens: 6000,
      totalTokens: 21000,
      contextWindow: 1048576,
      contextTokens: 15000,
      percentage: 1,
    });
  });

  it('derives non-cached input when only aggregate prompt stats are available', () => {
    expect(buildGeminiUsageInfo({
      input_tokens: 15000,
      cached: 3000,
      output_tokens: 6000,
    }, 'gemini-2.5-pro')).toMatchObject({
      inputTokens: 12000,
      cacheReadInputTokens: 3000,
      outputTokens: 6000,
      totalTokens: 21000,
      contextTokens: 15000,
    });
  });
});
