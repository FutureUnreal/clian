import { createMockEl } from '@test/helpers/mockElement';

import type { UsageInfo } from '@/core/types';
import {
  ContextUsageMeter,
  createInputToolbar,
  McpServerSelector,
  ModelSelector,
  PermissionToggle,
  ThinkingBudgetSelector,
} from '@/features/chat/ui/InputToolbar';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextWindow: 200000,
    contextTokens: 0,
    percentage: 0,
    ...overrides,
  };
}

function createMockCallbacks(overrides: Record<string, any> = {}) {
  return {
    onModelChange: jest.fn().mockResolvedValue(undefined),
    onThinkingBudgetChange: jest.fn().mockResolvedValue(undefined),
    onPermissionModeChange: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockReturnValue({
      model: 'claude-sonnet-4-6',
      thinkingBudget: 'low',
      permissionMode: 'normal',
    }),
    getEnvironmentVariables: jest.fn().mockReturnValue(''),
    ...overrides,
  };
}

describe('ModelSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ModelSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ModelSelector(parentEl, callbacks);
  });

  it('should create a container with model-selector class', () => {
    const container = parentEl.querySelector('.clian-model-selector');
    expect(container).not.toBeNull();
  });

  it('should display current model label', () => {
    // Default model is 'claude-sonnet-4-6' which maps to 'Sonnet 4.6'
    const btn = parentEl.querySelector('.clian-model-btn');
    expect(btn).not.toBeNull();
    const label = btn?.querySelector('.clian-model-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('Sonnet 4.6');
  });

  it('should display first model when current model not found', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'nonexistent',
      thinkingBudget: 'low',
      permissionMode: 'normal',
    });
    selector.updateDisplay();
    const label = parentEl.querySelector('.clian-model-label');
    expect(label?.textContent).toBe('Haiku 4.5');
  });

  it('should render model options in reverse order', () => {
    const dropdown = parentEl.querySelector('.clian-model-dropdown');
    expect(dropdown).not.toBeNull();
    // DEFAULT_CLAUDE_MODELS is rendered in reverse order (newest/most specific last in the list).
    const options = dropdown?.children || [];
    expect(options.length).toBe(5);
    // Text is in child span, check first child's textContent
    expect(options[0]?.children[0]?.textContent).toBe('Opus 4.6');
    expect(options[1]?.children[0]?.textContent).toBe('Sonnet 4.6');
    expect(options[2]?.children[0]?.textContent).toBe('Opus 4.5');
    expect(options[3]?.children[0]?.textContent).toBe('Sonnet 4.5');
    expect(options[4]?.children[0]?.textContent).toBe('Haiku 4.5');
  });

  it('should mark current model as selected', () => {
    const dropdown = parentEl.querySelector('.clian-model-dropdown');
    const options = dropdown?.children || [];
    const sonnetOption = options.find((o: any) => o.children[0]?.textContent === 'Sonnet 4.6');
    expect(sonnetOption?.hasClass('selected')).toBe(true);
  });

  it('should call onModelChange when option clicked', async () => {
    const dropdown = parentEl.querySelector('.clian-model-dropdown');
    const options = dropdown?.children || [];
    const opusOption = options.find((o: any) => o.children[0]?.textContent === 'Opus 4.6');

    await opusOption?.dispatchEvent('click', { stopPropagation: () => {} });
    expect(callbacks.onModelChange).toHaveBeenCalledWith('claude-opus-4-6');
  });

  it('should update display when setReady is called', () => {
    selector.setReady(true);
    const btn = parentEl.querySelector('.clian-model-btn');
    expect(btn?.hasClass('ready')).toBe(true);

    selector.setReady(false);
    expect(btn?.hasClass('ready')).toBe(false);
  });

  it('should show Sonnet (1M) when show1MModel is enabled', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'claude-sonnet-4-6',
      thinkingBudget: 'low',
      permissionMode: 'normal',
      show1MModel: true,
    });
    selector.updateDisplay();
    const label = parentEl.querySelector('.clian-model-label');
    expect(label?.textContent).toBe('Sonnet 4.6 (1M)');
  });

  it('should use custom models from environment variables', () => {
    callbacks.getEnvironmentVariables.mockReturnValue(
      'CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-20250514-v1:0'
    );
    callbacks.getSettings.mockReturnValue({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      thinkingBudget: 'low',
      permissionMode: 'normal',
    });
    selector.renderOptions();
    selector.updateDisplay();
    // Custom models should be available in dropdown
    const label = parentEl.querySelector('.clian-model-label');
    expect(label?.textContent).toBeDefined();
  });
});

describe('ThinkingBudgetSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ThinkingBudgetSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ThinkingBudgetSelector(parentEl, callbacks);
  });

  it('should create a container with thinking-selector class', () => {
    const container = parentEl.querySelector('.clian-thinking-selector');
    expect(container).not.toBeNull();
  });

  it('should display Thinking: label', () => {
    const label = parentEl.querySelector('.clian-thinking-label-text');
    expect(label?.textContent).toBe('Thinking:');
  });

  it('should display current budget label', () => {
    const current = parentEl.querySelector('.clian-thinking-current');
    expect(current?.textContent).toBe('Low');
  });

  it('should display Off when budget is off', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'off',
      permissionMode: 'normal',
    });
    selector.updateDisplay();
    const current = parentEl.querySelector('.clian-thinking-current');
    expect(current?.textContent).toBe('Off');
  });

  it('should render budget options in reverse order', () => {
    const options = parentEl.querySelector('.clian-thinking-options');
    expect(options).not.toBeNull();
    // THINKING_BUDGETS reversed: [xhigh, high, medium, low, off]
    const gears = options?.children || [];
    expect(gears.length).toBe(5);
    expect(gears[0]?.textContent).toBe('Ultra');
    expect(gears[4]?.textContent).toBe('Off');
  });

  it('should mark current budget as selected', () => {
    const options = parentEl.querySelector('.clian-thinking-options');
    const gears = options?.children || [];
    const lowGear = gears.find((g: any) => g.textContent === 'Low');
    expect(lowGear?.hasClass('selected')).toBe(true);
  });

  it('should call onThinkingBudgetChange when gear clicked', async () => {
    const options = parentEl.querySelector('.clian-thinking-options');
    const gears = options?.children || [];
    const highGear = gears.find((g: any) => g.textContent === 'High');

    await highGear?.dispatchEvent('click', { stopPropagation: () => {} });
    expect(callbacks.onThinkingBudgetChange).toHaveBeenCalledWith('high');
  });

  it('should set title with token count for non-off budgets', () => {
    const options = parentEl.querySelector('.clian-thinking-options');
    const gears = options?.children || [];
    const highGear = gears.find((g: any) => g.textContent === 'High');
    expect(highGear?.getAttribute('title')).toContain('16,000 tokens');
  });

  it('should set title as Disabled for off budget', () => {
    const options = parentEl.querySelector('.clian-thinking-options');
    const gears = options?.children || [];
    const offGear = gears.find((g: any) => g.textContent === 'Off');
    expect(offGear?.getAttribute('title')).toBe('Disabled');
  });
});

describe('PermissionToggle', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    new PermissionToggle(parentEl, callbacks);
  });

  it('should create a container with permission-toggle class', () => {
    const container = parentEl.querySelector('.clian-permission-toggle');
    expect(container).not.toBeNull();
  });

  it('should display Safe label when in normal mode', () => {
    const label = parentEl.querySelector('.clian-permission-label');
    expect(label?.textContent).toBe('Safe');
  });

  it('should display YOLO label when in yolo mode', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      permissionMode: 'yolo',
    });
    const parentEl2 = createMockEl();
    new PermissionToggle(parentEl2, callbacks);

    const label = parentEl2.querySelector('.clian-permission-label');
    expect(label?.textContent).toBe('YOLO');
  });

  it('should show PLAN label and hide toggle in plan mode', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      permissionMode: 'plan',
    });
    const parentEl2 = createMockEl();
    new PermissionToggle(parentEl2, callbacks);

    const label = parentEl2.querySelector('.clian-permission-label');
    expect(label?.textContent).toBe('PLAN');
    expect(label?.hasClass('plan-active')).toBe(true);

    const toggle = parentEl2.querySelector('.clian-toggle-switch');
    expect(toggle?.style.display).toBe('none');
  });

  it('should add active class when in yolo mode', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      permissionMode: 'yolo',
    });
    const parentEl2 = createMockEl();
    new PermissionToggle(parentEl2, callbacks);

    const toggle = parentEl2.querySelector('.clian-toggle-switch');
    expect(toggle?.hasClass('active')).toBe(true);
  });

  it('should not have active class in normal mode', () => {
    const toggle = parentEl.querySelector('.clian-toggle-switch');
    expect(toggle?.hasClass('active')).toBe(false);
  });

  it('should toggle from normal to yolo on click', async () => {
    const toggle = parentEl.querySelector('.clian-toggle-switch');
    await toggle?.dispatchEvent('click');
    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('yolo');
  });

  it('should toggle from yolo to normal on click', async () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      permissionMode: 'yolo',
    });
    const parentEl2 = createMockEl();
    new PermissionToggle(parentEl2, callbacks);

    const toggle = parentEl2.querySelector('.clian-toggle-switch');
    await toggle?.dispatchEvent('click');
    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('normal');
  });
});

describe('McpServerSelector', () => {
  let parentEl: any;
  let selector: McpServerSelector;

  function createMockMcpManager(servers: { name: string; enabled: boolean; contextSaving?: boolean }[] = []) {
    return {
      getServers: jest.fn().mockReturnValue(
        servers.map(s => ({
          name: s.name,
          enabled: s.enabled,
          contextSaving: s.contextSaving ?? false,
        }))
      ),
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    selector = new McpServerSelector(parentEl);
  });

  it('should create container with mcp-selector class', () => {
    const container = parentEl.querySelector('.clian-mcp-selector');
    expect(container).not.toBeNull();
  });

  it('should return empty set of enabled servers initially', () => {
    expect(selector.getEnabledServers().size).toBe(0);
  });

  it('should hide container when no servers configured', () => {
    selector.setMcpManager(createMockMcpManager([]));
    const container = parentEl.querySelector('.clian-mcp-selector');
    expect(container?.style.display).toBe('none');
  });

  it('should show container when servers are configured', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'test', enabled: true }]));
    const container = parentEl.querySelector('.clian-mcp-selector');
    expect(container?.style.display).toBe('');
  });

  it('should show empty message when all servers are disabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'test', enabled: false }]));
    const empty = parentEl.querySelector('.clian-mcp-selector-empty');
    expect(empty?.textContent).toBe('All MCP servers disabled');
  });

  it('should show no servers message when no servers configured', () => {
    selector.setMcpManager(createMockMcpManager([]));
    const empty = parentEl.querySelector('.clian-mcp-selector-empty');
    expect(empty?.textContent).toBe('No MCP servers configured');
  });

  it('should add mentioned servers', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.addMentionedServers(new Set(['server1']));
    expect(selector.getEnabledServers().has('server1')).toBe(true);
  });

  it('should not re-render when adding already enabled servers', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.addMentionedServers(new Set(['server1']));
    const enabledBefore = selector.getEnabledServers();

    selector.addMentionedServers(new Set(['server1']));
    expect(selector.getEnabledServers()).toEqual(enabledBefore);
  });

  it('should clear all enabled servers', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.addMentionedServers(new Set(['server1', 'server2']));
    expect(selector.getEnabledServers().size).toBe(2);

    selector.clearEnabled();
    expect(selector.getEnabledServers().size).toBe(0);
  });

  it('should set enabled servers from array', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    expect(selector.getEnabledServers().size).toBe(2);
  });

  it('should prune enabled servers that no longer exist in manager', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);

    // Now update manager to only have server1
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    expect(selector.getEnabledServers().has('server1')).toBe(true);
    expect(selector.getEnabledServers().has('server2')).toBe(false);
  });

  it('should invoke onChange callback when pruning removes servers', () => {
    const onChange = jest.fn();
    selector.setOnChange(onChange);

    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    onChange.mockClear();

    // Prune by removing server2
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    expect(onChange).toHaveBeenCalled();
  });

  it('should show badge when more than 1 server enabled', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    selector.updateDisplay();

    const badge = parentEl.querySelector('.clian-mcp-selector-badge');
    expect(badge?.hasClass('visible')).toBe(true);
    expect(badge?.textContent).toBe('2');
  });

  it('should not show badge when only 1 server enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.setEnabledServers(['server1']);
    selector.updateDisplay();

    const badge = parentEl.querySelector('.clian-mcp-selector-badge');
    expect(badge?.hasClass('visible')).toBe(false);
  });

  it('should add active class to icon when servers are enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.setEnabledServers(['server1']);
    selector.updateDisplay();

    const icon = parentEl.querySelector('.clian-mcp-selector-icon');
    expect(icon?.hasClass('active')).toBe(true);
  });

  it('should remove active class from icon when no servers enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.clearEnabled();
    selector.updateDisplay();

    const icon = parentEl.querySelector('.clian-mcp-selector-icon');
    expect(icon?.hasClass('active')).toBe(false);
  });

  it('should handle null mcpManager', () => {
    selector.setMcpManager(null);
    expect(selector.getEnabledServers().size).toBe(0);
  });
});

describe('ContextUsageMeter', () => {
  let parentEl: any;
  let meter: ContextUsageMeter;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    meter = new ContextUsageMeter(parentEl);
  });

  it('should create a container with context-meter class', () => {
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container).not.toBeNull();
  });

  it('should be hidden initially', () => {
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.style.display).toBe('none');
  });

  it('should remain hidden when update called with null', () => {
    meter.update(null);
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.style.display).toBe('none');
  });

  it('should remain hidden when contextTokens is 0', () => {
    meter.update(makeUsage({ contextTokens: 0, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.style.display).toBe('none');
  });

  it('should become visible when contextTokens > 0', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.style.display).toBe('flex');
  });

  it('should display percentage', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const percent = parentEl.querySelector('.clian-context-meter-percent');
    expect(percent?.textContent).toBe('25%');
  });

  it('should add warning class when usage > 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.hasClass('warning')).toBe(true);
  });

  it('should remove warning class when usage drops below 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.hasClass('warning')).toBe(false);
  });

  it('should set tooltip with formatted token counts', () => {
    meter.update(makeUsage({ inputTokens: 50000, contextTokens: 50000, contextWindow: 200000, percentage: 25, totalTokens: 50000 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('Context: 50k / 200k (25%)\nTurn: 50k in = 50k total');
  });

  it('should format small token counts without k suffix', () => {
    meter.update(makeUsage({ inputTokens: 500, contextTokens: 500, contextWindow: 200000, percentage: 0, totalTokens: 500 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('Context: 500 / 200k (0%)\nTurn: 500 in = 500 total');
  });

  it('should add compact reminder to tooltip when usage > 80%', () => {
    meter.update(makeUsage({ inputTokens: 170000, contextTokens: 170000, contextWindow: 200000, percentage: 85, totalTokens: 170000 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('Context: 170k / 200k (85%)\nTurn: 170k in = 170k total\nApproaching limit, run `/compact` to continue');
  });

  it('should not add compact reminder to tooltip when usage ≤ 80%', () => {
    meter.update(makeUsage({ inputTokens: 160000, contextTokens: 160000, contextWindow: 200000, percentage: 80, totalTokens: 160000 }));
    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('Context: 160k / 200k (80%)\nTurn: 160k in = 160k total');
  });
  it('should show compact total token summary next to the percentage', () => {
    meter.update(makeUsage({
      inputTokens: 12000,
      cacheReadInputTokens: 3000,
      outputTokens: 6000,
      totalTokens: 21000,
      contextTokens: 15000,
      contextWindow: 200000,
      percentage: 8,
    }));

    const summary = parentEl.querySelector('.clian-context-meter-summary');
    expect(summary?.textContent).toBe('21k');
  });

  it('should include input, cache, and output breakdown in tooltip when available', () => {
    meter.update(makeUsage({
      inputTokens: 12000,
      cacheReadInputTokens: 3000,
      outputTokens: 6000,
      totalTokens: 21000,
      contextTokens: 15000,
      contextWindow: 200000,
      percentage: 8,
    }));

    const container = parentEl.querySelector('.clian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('Context: 15k / 200k (8%)\nTurn: 12k in + 3k cache + 6k out = 21k total');
  });
});

describe('McpServerSelector - toggle and badges', () => {
  let parentEl: any;
  let selector: McpServerSelector;

  function createMockMcpManager(servers: { name: string; enabled: boolean; contextSaving?: boolean }[] = []) {
    return {
      getServers: jest.fn().mockReturnValue(
        servers.map(s => ({
          name: s.name,
          enabled: s.enabled,
          contextSaving: s.contextSaving ?? false,
        }))
      ),
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    selector = new McpServerSelector(parentEl);
  });

  it('should render context-saving badge for servers with contextSaving', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true, contextSaving: true },
    ]));

    const csBadge = parentEl.querySelector('.clian-mcp-selector-cs-badge');
    expect(csBadge).not.toBeNull();
    expect(csBadge?.textContent).toBe('@');
  });

  it('should not render context-saving badge for servers without contextSaving', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true, contextSaving: false },
    ]));

    const csBadge = parentEl.querySelector('.clian-mcp-selector-cs-badge');
    expect(csBadge).toBeNull();
  });

  it('should toggle server on mousedown and update display', () => {
    const onChange = jest.fn();
    selector.setOnChange(onChange);

    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
    ]));

    // Find the server item and trigger mousedown
    const item = parentEl.querySelector('.clian-mcp-selector-item');
    expect(item).not.toBeNull();

    // Simulate mousedown to enable
    const mousedownHandlers = item._eventListeners?.get('mousedown');
    expect(mousedownHandlers).toBeDefined();
    mousedownHandlers![0]({ preventDefault: jest.fn(), stopPropagation: jest.fn() });

    expect(selector.getEnabledServers().has('server1')).toBe(true);
    expect(onChange).toHaveBeenCalled();

    // Toggle again to disable
    onChange.mockClear();
    mousedownHandlers![0]({ preventDefault: jest.fn(), stopPropagation: jest.fn() });

    expect(selector.getEnabledServers().has('server1')).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('should re-render dropdown on mouseenter', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
    ]));

    // Get container and trigger mouseenter
    const container = parentEl.querySelector('.clian-mcp-selector');
    const mouseenterHandlers = container?._eventListeners?.get('mouseenter');
    expect(mouseenterHandlers).toBeDefined();

    // Should not throw
    expect(() => mouseenterHandlers![0]()).not.toThrow();
  });
});

describe('createInputToolbar', () => {
  it('should return all toolbar components', () => {
    const parentEl = createMockEl();
    const callbacks = createMockCallbacks();
    const toolbar = createInputToolbar(parentEl, callbacks);

    expect(toolbar.modelSelector).toBeInstanceOf(ModelSelector);
    expect(toolbar.thinkingBudgetSelector).toBeInstanceOf(ThinkingBudgetSelector);
    expect(toolbar.contextUsageMeter).toBeInstanceOf(ContextUsageMeter);
    expect(toolbar.mcpServerSelector).toBeInstanceOf(McpServerSelector);
    expect(toolbar.permissionToggle).toBeInstanceOf(PermissionToggle);
  });
});
