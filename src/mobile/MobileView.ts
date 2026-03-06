import { ItemView, MarkdownRenderer, Modal, Notice, Setting, TFolder } from 'obsidian';

import { type ClianViewType, VIEW_TYPE_CLIAN } from '../core/types/chat';
import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_CODEX_MODELS,
  DEFAULT_GEMINI_MODELS,
  GEMINI_THINKING_MODE_OPTIONS,
} from '../core/types/engines';
import { DEFAULT_CLAUDE_MODELS, THINKING_BUDGETS } from '../core/types/models';
import { replaceImageEmbedsWithHtml } from '../utils/imageEmbed';
import type ClianMobilePlugin from './main';
import { RemoteHubClient } from './remoteHubClient';
import type {
  RemoteDecryptedMessage,
  RemoteMcpServer,
  RemoteSession,
  RemoteSessionSummary,
} from './types';
import { MobileMentionDropdown, type MobileMentionItem } from './ui/MobileMentionDropdown';
import { MobileSlashCommandDropdown } from './ui/MobileSlashCommandDropdown';

type RoleWrappedRecord = {
  role: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks?: any;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
  return isObject(value) && typeof (value as { role?: unknown }).role === 'string' && 'content' in value;
}

function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
  if (isRoleWrappedRecord(value)) return value;
  if (!isObject(value)) return null;

  const direct = (value as { message?: unknown }).message;
  if (isRoleWrappedRecord(direct)) return direct;

  const data = (value as { data?: unknown }).data;
  if (isObject(data) && isRoleWrappedRecord((data as { message?: unknown }).message)) {
    return (data as { message: RoleWrappedRecord }).message;
  }

  const payload = (value as { payload?: unknown }).payload;
  if (isObject(payload) && isRoleWrappedRecord((payload as { message?: unknown }).message)) {
    return (payload as { message: RoleWrappedRecord }).message;
  }

  return null;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type HubBlock = {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

function extractHubBlocks(record: RoleWrappedRecord | null): HubBlock[] | null {
  if (!record) return null;
  const blocks = record.blocks;
  if (!Array.isArray(blocks)) return null;
  return blocks.filter((b): b is HubBlock => isObject(b) && typeof (b as { type?: unknown }).type === 'string') as HubBlock[];
}

function extractThinkingFromBlocks(blocks: HubBlock[]): string {
  let thinking = '';
  for (const block of blocks) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinking += block.thinking;
    }
  }
  return thinking;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

function truncateText(value: string, maxLen: number): string {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return '…';
  return `${text.slice(0, maxLen - 1)}…`;
}

function formatSessionLabel(session: RemoteSessionSummary): string {
  const name = session.metadata?.name?.trim();
  const path = session.metadata?.path?.trim();
  let base = name || path || session.id;
  if (!name && path) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (parts.length > 0) {
      base = parts[parts.length - 1];
    }
  }
  base = truncateText(base, 28);
  const flavorRaw = session.metadata?.flavor ?? null;
  const flavor = typeof flavorRaw === 'string' ? flavorRaw.trim() : '';
  const flavorTag = flavor ? ` [${flavor}]` : '';
  const thinking = session.thinking ? ' • thinking' : '';
  return `${base}${flavorTag}${thinking}`;
}

function sortMessages(messages: RemoteDecryptedMessage[]): RemoteDecryptedMessage[] {
  return [...messages].sort((a, b) => {
    const aSeq = a.seq ?? Number.MAX_SAFE_INTEGER;
    const bSeq = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return a.createdAt - b.createdAt;
  });
}

type SessionFlavor = 'claude' | 'codex' | 'gemini';

function normalizeFlavor(value: unknown): SessionFlavor {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'codex') return 'codex';
  if (raw === 'gemini') return 'gemini';
  return 'claude';
}

const CUSTOM_MODEL_VALUE = '__custom__';

function getModelOptionsForFlavor(flavor: SessionFlavor): { value: string; label: string }[] {
  if (flavor === 'claude') {
    return [
      { value: '', label: 'Default' },
      ...DEFAULT_CLAUDE_MODELS.map((m) => ({ value: m.value, label: m.label })),
    ];
  }
  if (flavor === 'codex') {
    return DEFAULT_CODEX_MODELS.map((m) => ({ value: m.value, label: m.label }));
  }
  return DEFAULT_GEMINI_MODELS.map((m) => ({ value: m.value, label: m.label }));
}

function getThinkingOptionsForFlavor(flavor: SessionFlavor): { value: string; label: string }[] {
  if (flavor === 'claude') {
    return [
      { value: '', label: 'Default' },
      ...THINKING_BUDGETS.map((b) => ({ value: b.value, label: b.label })),
    ];
  }
  if (flavor === 'codex') {
    return [
      { value: '', label: 'Default' },
      ...CODEX_REASONING_EFFORT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    ];
  }
  return [
    { value: '', label: 'Default' },
    ...GEMINI_THINKING_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
  ];
}

type SessionModalMode = 'create' | 'edit';

class ConfirmSessionDeleteModal extends Modal {
  private readonly sessionLabel: string;
  private readonly onConfirm: () => Promise<void>;

  constructor(app: any, options: { sessionLabel: string; onConfirm: () => Promise<void> }) {
    super(app);
    this.sessionLabel = options.sessionLabel;
    this.onConfirm = options.onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Delete session?' });
    contentEl.createEl('p', {
      text: `This will permanently delete "${this.sessionLabel}" and its message history from the hub.`,
    }).style.color = 'var(--text-muted)';

    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.marginTop = '12px';
    footer.style.justifyContent = 'flex-end';

    const cancelBtn = footer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const deleteBtn = footer.createEl('button', { text: 'Delete' });
    deleteBtn.style.background = 'var(--background-modifier-error)';
    deleteBtn.style.color = 'var(--text-on-accent)';

    const setBusy = (busy: boolean) => {
      cancelBtn.disabled = busy;
      deleteBtn.disabled = busy;
      deleteBtn.textContent = busy ? 'Deleting…' : 'Delete';
    };

    deleteBtn.addEventListener('click', async () => {
      try {
        setBusy(true);
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setBusy(false);
      }
    });
  }
}

class SessionConfigModal extends Modal {
  private readonly mode: SessionModalMode;
  private readonly client: RemoteHubClient;
  private readonly sessionId: string | null;
  private readonly onSuccess: (result: { sessionId?: string }) => Promise<void>;
  private readonly onDeleted: ((sessionId: string) => Promise<void>) | null;

  private initialName: string;
  private initialFlavor: SessionFlavor;
  private initialModel: string;
  private initialThinkingMode: string;

  constructor(
    view: ClianMobileView,
    options: {
      mode: SessionModalMode;
      client: RemoteHubClient;
      sessionId?: string | null;
      name?: string | null;
      flavor?: string | null;
      model?: string | null;
      thinkingMode?: string | null;
      onSuccess: (result: { sessionId?: string }) => Promise<void>;
      onDeleted?: (sessionId: string) => Promise<void>;
    }
  ) {
    super(view.app);
    this.mode = options.mode;
    this.client = options.client;
    this.sessionId = options.sessionId ?? null;
    this.onSuccess = options.onSuccess;
    this.onDeleted = typeof options.onDeleted === 'function' ? options.onDeleted : null;
    this.initialName = (options.name ?? '').trim();
    this.initialFlavor = normalizeFlavor(options.flavor);
    this.initialModel = (options.model ?? '').trim();
    this.initialThinkingMode = (options.thinkingMode ?? '').trim();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const heading = this.mode === 'create' ? 'New session' : 'Edit session';
    contentEl.createEl('h3', { text: heading });

    let nameValue = this.initialName;
    let flavorValue = this.initialFlavor;
    let modelPresetValue = '';
    let customModelValue = '';
    let thinkingValue = this.initialThinkingMode;

    const presetValues = new Set(getModelOptionsForFlavor(flavorValue).map((o) => o.value));
    if (!this.initialModel) {
      modelPresetValue = '';
    } else if (presetValues.has(this.initialModel)) {
      modelPresetValue = this.initialModel;
    } else {
      modelPresetValue = CUSTOM_MODEL_VALUE;
      customModelValue = this.initialModel;
    }

    new Setting(contentEl)
      .setName('Name')
      .setDesc('Optional')
      .addText((text) => {
        text
          .setPlaceholder('')
          .setValue(nameValue)
          .onChange((value) => {
            nameValue = value;
          });
      });

    const flavorSetting = new Setting(contentEl)
      .setName('Engine')
      .setDesc('Claude / Codex / Gemini');

    flavorSetting.addDropdown((dropdown) => {
      dropdown
        .addOption('claude', 'Claude')
        .addOption('codex', 'Codex')
        .addOption('gemini', 'Gemini')
        .setValue(flavorValue)
        .onChange((value) => {
          flavorValue = normalizeFlavor(value);
          rebuildModelOptions();
          rebuildThinkingOptions();
        });
    });

    const modelSetting = new Setting(contentEl)
      .setName('Model')
      .setDesc('Select a preset or choose Custom');

    let modelDropdownEl: HTMLSelectElement | null = null;

    modelSetting.addDropdown((dropdown) => {
      modelDropdownEl = dropdown.selectEl;
      dropdown.onChange((value) => {
        modelPresetValue = value;
        updateCustomVisibility();
      });
    });

    const customModelSetting = new Setting(contentEl)
      .setName('Custom model')
      .setDesc('Exact model ID')
      .addText((text) => {
        text
          .setPlaceholder('')
          .setValue(customModelValue)
          .onChange((value) => {
            customModelValue = value;
          });
      });

    const thinkingSetting = new Setting(contentEl)
      .setName('Thinking')
      .setDesc('Reasoning/thinking depth for this engine');

    let thinkingDropdownEl: HTMLSelectElement | null = null;

    thinkingSetting.addDropdown((dropdown) => {
      thinkingDropdownEl = dropdown.selectEl;
      dropdown.onChange((value) => {
        thinkingValue = value;
      });
    });

    const rebuildModelOptions = () => {
      if (!modelDropdownEl) return;

      const options = getModelOptionsForFlavor(flavorValue);
      const allowed = new Set(options.map((o) => o.value));

      modelDropdownEl.empty();
      for (const opt of options) {
        modelDropdownEl.createEl('option', { value: opt.value, text: opt.label });
      }
      modelDropdownEl.createEl('option', { value: CUSTOM_MODEL_VALUE, text: 'Custom…' });

      if (modelPresetValue === CUSTOM_MODEL_VALUE) {
        modelDropdownEl.value = CUSTOM_MODEL_VALUE;
      } else if (allowed.has(modelPresetValue)) {
        modelDropdownEl.value = modelPresetValue;
      } else {
        modelPresetValue = '';
        modelDropdownEl.value = '';
      }

      updateCustomVisibility();
    };

    const rebuildThinkingOptions = () => {
      if (!thinkingDropdownEl) return;

      const options = getThinkingOptionsForFlavor(flavorValue);
      const allowed = new Set(options.map((o) => o.value));

      thinkingDropdownEl.empty();
      for (const opt of options) {
        thinkingDropdownEl.createEl('option', { value: opt.value, text: opt.label });
      }

      if (allowed.has(thinkingValue)) {
        thinkingDropdownEl.value = thinkingValue;
      } else {
        thinkingValue = '';
        thinkingDropdownEl.value = '';
      }
    };

    const updateCustomVisibility = () => {
      customModelSetting.settingEl.style.display = modelPresetValue === CUSTOM_MODEL_VALUE ? 'block' : 'none';
    };

    rebuildModelOptions();
    rebuildThinkingOptions();

    if (this.mode === 'edit' && this.sessionId && this.onDeleted) {
      contentEl.createEl('h4', { text: 'Danger zone' });

      new Setting(contentEl)
        .setName('Delete session')
        .setDesc('Permanently remove this session and its message history from the hub.')
        .addButton((btn) => {
          btn.setButtonText('Delete');
          btn.buttonEl.style.background = 'var(--background-modifier-error)';
          btn.buttonEl.style.color = 'var(--text-on-accent)';
          btn.onClick(() => {
            const label = nameValue.trim() || this.sessionId!;
            const modal = new ConfirmSessionDeleteModal(this.app, {
              sessionLabel: label,
              onConfirm: async () => {
                await this.client.deleteSession(this.sessionId!);
                await this.onDeleted!(this.sessionId!);
                this.close();
              },
            });
            modal.open();
          });
        });
    }

    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.marginTop = '12px';
    footer.style.justifyContent = 'flex-end';

    const cancelButton = footer.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => this.close());

    const submitText = this.mode === 'create' ? 'Create' : 'Save';
    const submitButton = footer.createEl('button', { text: submitText });

    const setBusy = (busy: boolean) => {
      cancelButton.disabled = busy;
      submitButton.disabled = busy;
      submitButton.textContent = busy ? `${submitText}…` : submitText;
    };

    submitButton.addEventListener('click', async () => {
      try {
        setBusy(true);

        const name = nameValue.trim();
        const model =
          modelPresetValue === CUSTOM_MODEL_VALUE
            ? customModelValue.trim()
            : modelPresetValue.trim();
        const thinkingMode = thinkingValue.trim();

        if (this.mode === 'create') {
          const resp = await this.client.createSession({
            name: name ? name : undefined,
            flavor: flavorValue,
            model: model ? model : undefined,
            thinkingMode: thinkingMode ? thinkingMode : undefined,
          });
          await this.onSuccess({ sessionId: resp.sessionId });
          this.close();
          return;
        }

        if (!this.sessionId) {
          new Notice('No active session.');
          return;
        }

        if (flavorValue !== this.initialFlavor) {
          const resp = await this.client.createSession({
            name: name ? name : undefined,
            flavor: flavorValue,
            model: model ? model : undefined,
            thinkingMode: thinkingMode ? thinkingMode : undefined,
          });
          await this.onSuccess({ sessionId: resp.sessionId });
        } else {
          await this.client.updateSession(this.sessionId, {
            name,
            model,
            thinkingMode,
          });
          await this.onSuccess({});
        }
        this.close();
      } catch (error) {
        new Notice(`${submitText} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setBusy(false);
      }
    });
  }
}

class CommandPickerModal extends Modal {
  private readonly client: RemoteHubClient;
  private readonly sessionId: string;
  private readonly onPick: (name: string) => void;
  private readonly onClosed?: () => void;

  private commands: string[] = [];
  private query = '';

  constructor(
    view: ClianMobileView,
    options: {
      client: RemoteHubClient;
      sessionId: string;
      onPick: (name: string) => void;
      onClosed?: () => void;
    }
  ) {
    super(view.app);
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.onPick = options.onPick;
    this.onClosed = options.onClosed;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Slash commands' });

    const search = contentEl.createEl('input');
    search.type = 'text';
    search.placeholder = 'Search…';
    search.style.width = '100%';
    search.style.margin = '8px 0';
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });

    const listEl = contentEl.createDiv();
    listEl.addClass('clian-mobile-command-list');
    listEl.style.display = 'flex';
    listEl.style.flexDirection = 'column';
    listEl.style.gap = '6px';
    listEl.style.maxHeight = '55vh';
    listEl.style.overflowY = 'auto';

    const setLoading = (text: string) => {
      listEl.empty();
      listEl.createDiv({ text }).style.color = 'var(--text-muted)';
    };

    const load = async () => {
      try {
        setLoading('Loading…');
        const data = await this.client.getCommands(this.sessionId);
        this.commands = Array.isArray(data.commands) ? data.commands.filter((c) => typeof c === 'string') : [];
        this.commands.sort((a, b) => a.localeCompare(b));
        this.renderList(listEl);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        setLoading(`Failed to load commands: ${msg}`);
      }
    };

    void load();
  }

  onClose(): void {
    this.onClosed?.();
  }

  private renderList(listEl?: HTMLElement): void {
    const container = listEl ?? this.contentEl.querySelector('.clian-mobile-command-list') as HTMLElement | null;
    if (!container) return;

    const query = this.query;
    const items = query
      ? this.commands.filter((name) => name.toLowerCase().includes(query))
      : this.commands;

    container.empty();

    if (items.length === 0) {
      container.createDiv({ text: 'No commands.' }).style.color = 'var(--text-muted)';
      return;
    }

    for (const name of items) {
      const btn = container.createEl('button', { text: `/${name}` });
      btn.style.textAlign = 'left';
      btn.addEventListener('click', () => {
        try {
          this.onPick(name);
        } finally {
          this.close();
        }
      });
    }
  }
}

class McpServersModal extends Modal {
  private readonly client: RemoteHubClient;
  private readonly sessionId: string;
  private readonly onClosed?: () => void;

  private servers: RemoteMcpServer[] = [];
  private enabledByName = new Map<string, boolean>();
  private exists = false;

  constructor(
    view: ClianMobileView,
    options: {
      client: RemoteHubClient;
      sessionId: string;
      onClosed?: () => void;
    }
  ) {
    super(view.app);
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.onClosed = options.onClosed;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'MCP servers' });

    const hint = contentEl.createEl('p', {
      text: 'Tip: context-saving servers only activate when you @mention them in the prompt.',
    });
    hint.style.fontSize = '12px';
    hint.style.color = 'var(--text-muted)';
    hint.style.marginTop = '0';

    const listEl = contentEl.createDiv();
    listEl.style.display = 'flex';
    listEl.style.flexDirection = 'column';
    listEl.style.gap = '10px';
    listEl.style.maxHeight = '55vh';
    listEl.style.overflowY = 'auto';

    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.marginTop = '12px';
    footer.style.justifyContent = 'flex-end';

    const cancelBtn = footer.createEl('button', { text: 'Close' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = footer.createEl('button', { text: 'Save' });

    const setBusy = (busy: boolean) => {
      cancelBtn.disabled = busy;
      saveBtn.disabled = busy || !this.exists || this.servers.length === 0;
      saveBtn.textContent = busy ? 'Saving…' : 'Save';
    };

    const setLoading = (text: string) => {
      listEl.empty();
      const el = listEl.createDiv({ text });
      el.style.color = 'var(--text-muted)';
      saveBtn.disabled = true;
    };

    const renderList = () => {
      listEl.empty();

      if (!this.exists) {
        const el = listEl.createDiv({
          text: 'No MCP config found on hub for this session cwd (.clian/mcp.json).',
        });
        el.style.color = 'var(--text-muted)';
        saveBtn.disabled = true;
        return;
      }

      if (this.servers.length === 0) {
        const el = listEl.createDiv({ text: 'No MCP servers.' });
        el.style.color = 'var(--text-muted)';
        saveBtn.disabled = true;
        return;
      }

      for (const server of this.servers) {
        const row = listEl.createDiv();
        row.style.display = 'flex';
        row.style.alignItems = 'flex-start';
        row.style.gap = '10px';

        const checkbox = row.createEl('input');
        checkbox.type = 'checkbox';
        checkbox.style.marginTop = '3px';
        checkbox.checked = this.enabledByName.get(server.name) ?? server.enabled;
        checkbox.addEventListener('change', () => {
          this.enabledByName.set(server.name, checkbox.checked);
        });

        const meta = row.createDiv();
        meta.style.display = 'flex';
        meta.style.flexDirection = 'column';
        meta.style.gap = '2px';

        const title = meta.createDiv({ text: server.name });
        title.style.fontWeight = '600';

        const details: string[] = [];
        if (server.type) details.push(server.type);
        details.push(server.contextSaving ? '@mention' : 'always');
        const detailLine = meta.createDiv({ text: details.join(' • ') });
        detailLine.style.fontSize = '12px';
        detailLine.style.color = 'var(--text-muted)';

        if (server.description) {
          const desc = meta.createDiv({ text: server.description });
          desc.style.fontSize = '12px';
          desc.style.color = 'var(--text-muted)';
        }
      }

      saveBtn.disabled = false;
    };

    const load = async () => {
      try {
        setLoading('Loading…');
        const data = await this.client.getMcpServers(this.sessionId);
        this.exists = !!data.exists;
        this.servers = Array.isArray(data.servers) ? data.servers : [];
        this.enabledByName = new Map(this.servers.map((s) => [s.name, s.enabled]));
        renderList();
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        setLoading(`Failed to load MCP servers: ${msg}`);
      }
    };

    saveBtn.addEventListener('click', async () => {
      try {
        setBusy(true);
        const updates: Record<string, { enabled: boolean }> = {};
        for (const s of this.servers) {
          updates[s.name] = { enabled: this.enabledByName.get(s.name) ?? s.enabled };
        }
        await this.client.updateMcpServers(this.sessionId, { servers: updates });
        this.close();
        new Notice('MCP servers updated.');
      } catch (error) {
        new Notice(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setBusy(false);
      }
    });

    void load();
  }

  onClose(): void {
    this.onClosed?.();
  }
}

class UploadFileModal extends Modal {
  private readonly client: RemoteHubClient;
  private readonly sessionId: string;
  private readonly onUploaded: (remotePath: string) => void;
  private readonly onClosed?: () => void;

  private busy = false;

  constructor(
    view: ClianMobileView,
    options: {
      client: RemoteHubClient;
      sessionId: string;
      onUploaded: (remotePath: string) => void;
      onClosed?: () => void;
    }
  ) {
    super(view.app);
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.onUploaded = options.onUploaded;
    this.onClosed = options.onClosed;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Upload file to hub' });

    const hint = contentEl.createEl('p', {
      text: 'Choose a file from your device (including your vault) to upload to the hub.',
    });
    hint.style.fontSize = '12px';
    hint.style.color = 'var(--text-muted)';
    hint.style.marginTop = '0';

    const deviceRow = contentEl.createDiv();
    deviceRow.style.display = 'flex';
    deviceRow.style.gap = '8px';
    deviceRow.style.alignItems = 'center';
    deviceRow.style.marginTop = '8px';

    const deviceBtn = deviceRow.createEl('button', { text: 'Choose from device…' });
    deviceBtn.addClass('clian-mobile-button', 'clian-mobile-tappable', 'clian-mobile-device-file-button');

    const deviceInput = deviceRow.createEl('input');
    deviceInput.type = 'file';
    // Some mobile webviews won't open the system picker if the input is `display: none`.
    deviceInput.style.position = 'fixed';
    deviceInput.style.left = '-10000px';
    deviceInput.style.top = '0';
    deviceInput.style.width = '1px';
    deviceInput.style.height = '1px';
    deviceInput.style.opacity = '0';

    deviceBtn.addEventListener('click', () => {
      if (this.busy) return;
      deviceInput.click();
    });

    deviceInput.addEventListener('change', async () => {
      if (this.busy) return;
      const file = deviceInput.files?.[0] ?? null;
      deviceInput.value = '';
      if (!file) return;
      await this.uploadDeviceFile(file);
    });

    const footer = contentEl.createDiv();
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.marginTop = '12px';
    footer.style.justifyContent = 'flex-end';

    const closeBtn = footer.createEl('button', { text: 'Close' });
    closeBtn.addClass('clian-mobile-upload-close-button');
    closeBtn.addEventListener('click', () => {
      if (this.busy) return;
      this.close();
    });
  }

  onClose(): void {
    this.onClosed?.();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    const deviceBtn = this.contentEl.querySelector('.clian-mobile-device-file-button') as HTMLButtonElement | null;
    if (deviceBtn) deviceBtn.disabled = busy;
    const closeBtn = this.contentEl.querySelector('.clian-mobile-upload-close-button') as HTMLButtonElement | null;
    if (closeBtn) closeBtn.disabled = busy;
  }

  private async uploadDeviceFile(file: File): Promise<void> {
    try {
      this.setBusy(true);
      const contentBase64 = await readFileAsDataUrl(file);
      const resp = await this.client.uploadFile(this.sessionId, {
        name: file.name,
        contentBase64,
      });
      this.onUploaded(resp.path);
      new Notice(`Uploaded: ${file.name}`);
      this.close();
    } catch (error) {
      new Notice(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      this.setBusy(false);
    }
  }
}

export class ClianMobileView extends ItemView {
  private plugin: ClianMobilePlugin;
  private viewType: ClianViewType;
  private client: RemoteHubClient;

  private sessions: RemoteSessionSummary[] = [];
  private currentSession: RemoteSession | null = null;
  private messages: RemoteDecryptedMessage[] = [];

  private viewClosed = false;

  private eventSource: EventSource | null = null;
  private eventSourceGeneration = 0;
  private sseConnected = false;
  private messagesRenderQueued = false;
  private messagesRenderInProgress = false;
  private messagesRenderPending = false;
  private openThinkingMessageIds = new Set<string>();
  private renderGeneration = 0;

  // Visual viewport / keyboard layout helpers
  private onViewportChange: (() => void) | null = null;
  private inputRowResizeObserver: ResizeObserver | null = null;
  private inputDockEl: HTMLElement | null = null;

  // DOM
  private headerEl: HTMLElement;
  private statusEl: HTMLElement;
  private sessionsSelectEl: HTMLSelectElement;
  private newButtonEl: HTMLButtonElement;
  private editButtonEl: HTMLButtonElement;
  private refreshButtonEl: HTMLButtonElement;
  private mcpButtonEl: HTMLButtonElement;
  private uploadButtonEl: HTMLButtonElement;
  private stopButtonEl: HTMLButtonElement;
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private inputRowEl: HTMLElement;
  private sendButtonEl: HTMLButtonElement;
  private requestsEl: HTMLElement;

  private commandPickerOpen = false;
  private mcpModalOpen = false;
  private uploadModalOpen = false;
  private slashDropdown: MobileSlashCommandDropdown | null = null;
  private mentionDropdown: MobileMentionDropdown | null = null;
  private inputOnInput: (() => void) | null = null;
  private inputOnKeydown: ((evt: KeyboardEvent) => void) | null = null;

  private getObsidianBottomOverlayHeightPx(): number {
    const viewportHeights = [
      window.visualViewport?.height,
      window.innerHeight,
    ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const clampHeight = (value: number): number => {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(200, Math.round(value)));
    };

    const rootStyle = window.getComputedStyle(document.documentElement);
    const toolbarVar = rootStyle.getPropertyValue('--mobile-toolbar-height').trim();
    if (toolbarVar.endsWith('px')) {
      const parsed = Number.parseFloat(toolbarVar.slice(0, -2));
      if (Number.isFinite(parsed) && parsed > 0) {
        return clampHeight(parsed);
      }
    }

    const mobileToolbarEl = document.querySelector('.mobile-toolbar') as HTMLElement | null;
    if (mobileToolbarEl) {
      const style = window.getComputedStyle(mobileToolbarEl);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        const rect = mobileToolbarEl.getBoundingClientRect();
        const vh = window.visualViewport?.height ?? window.innerHeight;
        const isBottomHalf = rect.top > vh * 0.5;
        const isNearBottom = rect.bottom >= vh - 80;
        if (isBottomHalf && isNearBottom && rect.height > 0) {
          return clampHeight(rect.height);
        }
      }
    }

    const candidates: HTMLElement[] = [];

    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    if (document.elementsFromPoint && viewportWidth > 0 && viewportHeight > 0) {
      const findOverlayRoot = (start: HTMLElement): HTMLElement | null => {
        let el: HTMLElement | null = start;
        let guard = 0;
        while (el && guard++ < 16) {
          if (this.contentEl.contains(el) || el.contains(this.contentEl)) return null;
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const pos = style.position;
            if (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') {
              const rect = el.getBoundingClientRect();
              if (rect.height > 0 && rect.width > 0 && rect.top > viewportHeight * 0.5) {
                return el;
              }
            }
          }
          el = el.parentElement;
        }
        return null;
      };

      const sampleXs = [
        Math.round(viewportWidth * 0.25),
        Math.round(viewportWidth * 0.5),
        Math.round(viewportWidth * 0.75),
      ];
      const y = Math.max(0, Math.round(viewportHeight - 1));
      for (const x of sampleXs) {
        const elements = document.elementsFromPoint(x, y);
        for (const element of elements) {
          if (!(element instanceof HTMLElement)) continue;
          const overlayRoot = findOverlayRoot(element);
          if (overlayRoot) candidates.push(overlayRoot);
        }
      }
    }

    let maxHeight = 0;
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.position !== 'fixed' && style.position !== 'sticky' && style.position !== 'absolute') continue;

      const rect = el.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) continue;

      for (const vh of viewportHeights) {
        if (rect.bottom < vh - 80) continue;
        // Ignore huge containers (app chrome). We only want bottom overlays.
        if (rect.height > vh * 0.4) continue;
        maxHeight = Math.max(maxHeight, clampHeight(rect.height));
      }
    }

    return clampHeight(maxHeight);
  }

  constructor(leaf: any, plugin: ClianMobilePlugin, viewType: ClianViewType = VIEW_TYPE_CLIAN) {
    super(leaf);
    this.plugin = plugin;
    this.viewType = viewType;
    this.client = new RemoteHubClient({
      baseUrl: this.plugin.settings.hubUrl,
      accessToken: this.plugin.settings.accessToken,
    });
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return 'Clian';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    this.viewClosed = false;

    contentEl.addClass('clian-mobile');
    contentEl.style.display = 'flex';
    contentEl.style.flexDirection = 'column';
    contentEl.style.height = '100%';
    contentEl.style.overflow = 'hidden';

    this.headerEl = contentEl.createDiv();
    this.headerEl.style.display = 'flex';
    this.headerEl.style.flexDirection = 'column';
    this.headerEl.style.gap = '8px';
    this.headerEl.style.padding = '8px';

    this.statusEl = this.headerEl.createDiv({ text: 'Not connected.' });
    this.statusEl.style.fontSize = '12px';
    this.statusEl.style.color = 'var(--text-muted)';

    const row = this.headerEl.createDiv();
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.width = '100%';

    this.sessionsSelectEl = row.createEl('select');
    this.sessionsSelectEl.style.flex = '1';
    this.sessionsSelectEl.style.minWidth = '0';
    this.sessionsSelectEl.addClass('clian-mobile-select', 'clian-mobile-tappable');
    this.styleSessionSelect(this.sessionsSelectEl);
    this.sessionsSelectEl.addEventListener('change', async () => {
      const id = this.sessionsSelectEl.value || null;
      await this.setActiveSession(id);
    });

    this.newButtonEl = row.createEl('button', { text: 'New' });
    this.newButtonEl.addClass('clian-mobile-button', 'clian-mobile-tappable');
    this.styleHeaderButton(this.newButtonEl);
    this.newButtonEl.addEventListener('click', async () => {
      this.openCreateSessionModal();
    });

    this.editButtonEl = row.createEl('button', { text: 'Edit' });
    this.editButtonEl.addClass('clian-mobile-button', 'clian-mobile-tappable');
    this.styleHeaderButton(this.editButtonEl);
    this.editButtonEl.addEventListener('click', () => {
      this.openEditSessionModal();
    });

    const actionRow = this.headerEl.createDiv();
    actionRow.style.display = 'flex';
    actionRow.style.gap = '8px';
    actionRow.style.alignItems = 'center';
    actionRow.style.width = '100%';
    actionRow.style.flexWrap = 'wrap';

    this.refreshButtonEl = actionRow.createEl('button', { text: 'Refresh' });
    this.refreshButtonEl.addClass('clian-mobile-button', 'clian-mobile-tappable');
    this.styleHeaderButton(this.refreshButtonEl);
    this.refreshButtonEl.addEventListener('click', () => {
      this.reconnectEventStream();
    });

    this.uploadButtonEl = actionRow.createEl('button', { text: 'File' });
    this.uploadButtonEl.addClass('clian-mobile-button', 'clian-mobile-tappable');
    this.styleHeaderButton(this.uploadButtonEl);
    this.uploadButtonEl.addEventListener('click', () => {
      this.openUploadFileModal();
    });

    this.mcpButtonEl = actionRow.createEl('button', { text: 'MCP' });
    this.mcpButtonEl.addClass('clian-mobile-button', 'clian-mobile-tappable');
    this.styleHeaderButton(this.mcpButtonEl);
    this.mcpButtonEl.addEventListener('click', () => {
      this.openMcpServersModal();
    });

    this.stopButtonEl = actionRow.createEl('button', { text: 'Stop' });
    this.stopButtonEl.addClass('clian-mobile-button', 'clian-mobile-tappable');
    this.styleHeaderButton(this.stopButtonEl);
    this.stopButtonEl.style.background = 'var(--background-modifier-error)';
    this.stopButtonEl.style.color = 'var(--text-on-accent)';
    this.stopButtonEl.addEventListener('click', async () => {
      await this.interruptActiveSession();
    });

    this.messagesEl = contentEl.createDiv();
    this.messagesEl.style.flex = '1';
    this.messagesEl.style.overflowY = 'auto';
    this.messagesEl.style.padding = '8px';
    this.messagesEl.style.borderTop = '1px solid var(--background-modifier-border)';
    this.messagesEl.style.borderBottom = '1px solid var(--background-modifier-border)';

    this.requestsEl = contentEl.createDiv();
    this.requestsEl.style.padding = '8px';
    this.requestsEl.style.display = 'none';

    this.inputDockEl = contentEl.createDiv();
    this.inputDockEl.style.position = 'fixed';
    this.inputDockEl.style.left = '0';
    this.inputDockEl.style.right = '0';
    this.inputDockEl.style.bottom = '0';
    this.inputDockEl.style.zIndex = '10010';
    this.inputDockEl.style.background = 'var(--background-primary)';
    this.inputDockEl.style.borderTop = '1px solid var(--background-modifier-border)';

    this.inputRowEl = this.inputDockEl.createDiv();
    this.inputRowEl.style.display = 'flex';
    this.inputRowEl.style.gap = '8px';
    this.inputRowEl.style.padding = '8px';
    this.inputRowEl.style.alignItems = 'center';
    this.inputRowEl.style.position = 'relative';

    this.inputEl = this.inputRowEl.createEl('textarea');
    this.inputEl.rows = 2;
    this.inputEl.style.flex = '1';
    this.inputEl.style.resize = 'vertical';
    this.inputEl.style.minHeight = '44px';
    this.inputEl.addClass('clian-mobile-textarea');
    this.styleInputTextarea(this.inputEl);

    this.slashDropdown = new MobileSlashCommandDropdown({
      containerEl: this.inputRowEl,
      inputEl: this.inputEl,
      client: this.client,
      getSessionId: () => this.plugin.settings.lastSessionId,
    });

    this.mentionDropdown = new MobileMentionDropdown({
      containerEl: this.inputRowEl,
      inputEl: this.inputEl,
      getItems: () => this.getMentionItems(),
    });

    this.inputOnInput = () => {
      this.slashDropdown?.handleInputChange();
      if (this.slashDropdown?.isVisible()) {
        this.mentionDropdown?.hide();
        return;
      }
      this.mentionDropdown?.handleInputChange();
    };

    this.inputOnKeydown = (evt: KeyboardEvent) => {
      if (this.slashDropdown?.handleKeydown(evt)) return;
      if (this.mentionDropdown?.handleKeydown(evt)) return;
    };

    this.inputEl.addEventListener('input', this.inputOnInput);
    this.inputEl.addEventListener('keydown', this.inputOnKeydown);

    this.sendButtonEl = this.inputRowEl.createEl('button', { text: 'Send' });
    this.sendButtonEl.addClass('clian-mobile-button', 'clian-mobile-tappable');
    this.styleSendButton(this.sendButtonEl);
    this.sendButtonEl.addEventListener('click', async () => {
      this.inputEl.focus();
      await this.sendCurrentMessage();
    });

    this.renderSessionsSelect();
    void this.renderMessages();
    this.installKeyboardLayout();
    this.connectEventStream();
  }

  async onClose(): Promise<void> {
    this.viewClosed = true;
    this.disconnectEventStream();
    this.uninstallKeyboardLayout();

    if (this.inputOnInput) {
      this.inputEl.removeEventListener('input', this.inputOnInput);
      this.inputOnInput = null;
    }

    if (this.inputOnKeydown) {
      this.inputEl.removeEventListener('keydown', this.inputOnKeydown);
      this.inputOnKeydown = null;
    }

    this.slashDropdown?.destroy();
    this.slashDropdown = null;

    this.mentionDropdown?.destroy();
    this.mentionDropdown = null;
  }

  private installKeyboardLayout(): void {
    if (this.onViewportChange) return;
    if (!this.inputDockEl) return;

    const dockEl = this.inputDockEl;
    let rafId: number | null = null;

    const updateLayout = () => {
      if (this.viewClosed) return;

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      rafId = requestAnimationFrame(() => {
        rafId = null;

        const vv = window.visualViewport;
        const keyboardOffset = vv
          ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
          : 0;

        const bottomOverlayHeight = this.getObsidianBottomOverlayHeightPx();
        const overlayPadding = bottomOverlayHeight > 0
          ? `${bottomOverlayHeight}px`
          : 'var(--mobile-toolbar-height, 0px)';

        const messagesEl = this.messagesEl;
        const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 20;

        dockEl.style.bottom = `${keyboardOffset}px`;
        dockEl.style.paddingBottom = overlayPadding;

        const dockHeight = Math.ceil(dockEl.getBoundingClientRect().height);
        const padding = dockHeight + keyboardOffset + 8;

        messagesEl.style.paddingBottom = `${padding}px`;
        this.requestsEl.style.paddingBottom = `${padding}px`;

        if (wasAtBottom) {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      });
    };

    this.onViewportChange = updateLayout;
    window.visualViewport?.addEventListener('resize', updateLayout);
    window.visualViewport?.addEventListener('scroll', updateLayout);
    window.addEventListener('resize', updateLayout);

    this.inputRowResizeObserver = new ResizeObserver(() => updateLayout());
    this.inputRowResizeObserver.observe(dockEl);

    updateLayout();
  }

  private uninstallKeyboardLayout(): void {
    if (this.onViewportChange) {
      window.visualViewport?.removeEventListener('resize', this.onViewportChange);
      window.visualViewport?.removeEventListener('scroll', this.onViewportChange);
      window.removeEventListener('resize', this.onViewportChange);
      this.onViewportChange = null;
    }

    if (this.inputRowResizeObserver) {
      this.inputRowResizeObserver.disconnect();
      this.inputRowResizeObserver = null;
    }

    if (this.inputDockEl) {
      this.inputDockEl.remove();
      this.inputDockEl = null;
    }
  }

  onSettingsChanged(): void {
    this.client.setConfig({
      baseUrl: this.plugin.settings.hubUrl,
      accessToken: this.plugin.settings.accessToken,
    });
    this.reconnectEventStream();
  }

  private connectEventStream(): void {
    this.disconnectEventStream();

    const baseUrl = this.plugin.settings.hubUrl.trim().replace(/\/+$/, '');
    const token = this.plugin.settings.accessToken.trim();
    const sessionId = this.plugin.settings.lastSessionId;

    if (!baseUrl || !token) {
      this.setStatus('Configure hub URL and access token in settings.');
      return;
    }

    const params = new URLSearchParams();
    params.set('token', token);
    params.set('all', 'true');
    if (sessionId) {
      params.set('sessionId', sessionId);
    }

    const url = `${baseUrl}/api/events?${params.toString()}`;
    const generation = ++this.eventSourceGeneration;

    this.sseConnected = false;
    this.setStatus('Connecting (SSE)…');

    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch (error) {
      this.setStatus(`SSE failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
    }

    this.eventSource = es;

    es.onopen = () => {
      if (this.viewClosed) return;
      if (generation !== this.eventSourceGeneration) return;
      this.sseConnected = true;
      // Don't surface hub IP/URL in the UI (privacy / screenshots).
      this.setStatus('Connected (SSE).');
    };

    es.onerror = () => {
      if (this.viewClosed) return;
      if (generation !== this.eventSourceGeneration) return;
      this.sseConnected = false;
      this.setStatus('SSE disconnected. Check hub URL / token.');
    };

    es.onmessage = (evt) => {
      if (this.viewClosed) return;
      if (generation !== this.eventSourceGeneration) return;

      try {
        const parsed = JSON.parse(evt.data);
        this.handleHubEvent(parsed);
      } catch {
        // ignore
      }
    };
  }

  private disconnectEventStream(): void {
    this.eventSourceGeneration++;
    this.sseConnected = false;

    if (this.eventSource) {
      try {
        this.eventSource.close();
      } catch {
        // ignore
      }
      this.eventSource = null;
    }
  }

  private reconnectEventStream(): void {
    this.connectEventStream();
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
  }

  private openCreateSessionModal(): void {
    if (!this.client.getBaseUrl() || !this.plugin.settings.accessToken.trim()) {
      new Notice('Configure hub URL and access token in settings.');
      return;
    }

    const modal = new SessionConfigModal(this, {
      mode: 'create',
      client: this.client,
      onSuccess: async ({ sessionId }) => {
        if (!sessionId) return;
        await this.setActiveSession(sessionId);
        new Notice('Session created.');
      },
    });
    modal.open();
  }

  private openEditSessionModal(): void {
    const sessionId = this.plugin.settings.lastSessionId;
    if (!sessionId) {
      new Notice('Select a session first.');
      return;
    }

    const summary = this.sessions.find(s => s.id === sessionId) ?? null;
    const flavorRaw = summary?.metadata?.flavor ?? null;
    const flavor = typeof flavorRaw === 'string' ? flavorRaw.trim() : null;
    const model = typeof summary?.modelMode === 'string' ? summary!.modelMode : null;
    const thinkingMode = typeof summary?.thinkingMode === 'string' ? summary!.thinkingMode : null;
    const name = summary?.metadata?.name ?? null;

    const modal = new SessionConfigModal(this, {
      mode: 'edit',
      client: this.client,
      sessionId,
      name,
      flavor,
      model,
      thinkingMode,
      onSuccess: async ({ sessionId: nextSessionId }) => {
        if (nextSessionId) {
          await this.setActiveSession(nextSessionId);
          new Notice('Switched session.');
        } else {
          this.reconnectEventStream();
          new Notice('Session updated.');
        }
      },
      onDeleted: async (deletedSessionId) => {
        void deletedSessionId;
        new Notice('Session deleted.');
      },
    });
    modal.open();
  }

  private renderSessionsSelect(): void {
    this.sessionsSelectEl.empty();

    const placeholder = this.sessionsSelectEl.createEl('option', {
      text: this.sessions.length ? 'Select a session…' : 'No sessions',
      value: '',
    });
    placeholder.disabled = true;
    placeholder.selected = !this.plugin.settings.lastSessionId;

    for (const session of this.sessions) {
      const option = this.sessionsSelectEl.createEl('option', {
        value: session.id,
        text: formatSessionLabel(session),
      });
      if (this.plugin.settings.lastSessionId === session.id) {
        option.selected = true;
      }
    }

    this.updateActionButtons();
  }

  private updateActionButtons(): void {
    const sessionId = this.plugin.settings.lastSessionId;
    const hasSession = !!sessionId;

    this.editButtonEl.disabled = !hasSession;
    this.mcpButtonEl.disabled = !hasSession;
    this.uploadButtonEl.disabled = !hasSession;
    this.stopButtonEl.disabled = !hasSession;
  }

  private async setActiveSession(sessionId: string | null): Promise<void> {
    this.slashDropdown?.hide();
    this.mentionDropdown?.hide();
    this.slashDropdown?.resetCache();

    if (!sessionId) {
      this.plugin.settings.lastSessionId = null;
      await this.plugin.saveSettings();
      this.currentSession = null;
      this.messages = [];
      void this.renderMessages();
      this.renderRequests();
      this.connectEventStream();
      this.updateActionButtons();
      return;
    }

    this.plugin.settings.lastSessionId = sessionId;
    await this.plugin.saveSettings();

    this.currentSession = null;
    this.messages = [];
    void this.renderMessages();
    this.renderRequests();
    this.connectEventStream();
    this.updateActionButtons();
  }

  private scheduleRenderMessages(): void {
    this.messagesRenderPending = true;

    if (this.messagesRenderInProgress) return;
    if (this.messagesRenderQueued) return;
    this.messagesRenderQueued = true;

    window.requestAnimationFrame(() => {
      this.messagesRenderQueued = false;
      if (this.viewClosed) return;
      void this.renderMessages();
    });
  }

  private handleHubEvent(value: unknown): void {
    if (!isObject(value)) return;

    const type = typeof (value as { type?: unknown }).type === 'string' ? (value as { type: string }).type : '';
    if (!type) return;

    if (type === 'snapshot') {
      const sessions = (value as { sessions?: unknown }).sessions;
      if (Array.isArray(sessions)) {
        this.sessions = sessions as RemoteSessionSummary[];
        this.renderSessionsSelect();

        const preferred = this.plugin.settings.lastSessionId;
        const hasPreferred = preferred && this.sessions.some(s => s.id === preferred);
        if (!hasPreferred) {
          const fallback = this.sessions[0]?.id ?? null;
          if (fallback !== preferred) {
            void this.setActiveSession(fallback);
            return;
          }
        }
      }

      const session = (value as { session?: unknown }).session;
      if (isObject(session) && typeof (session as { id?: unknown }).id === 'string') {
        const sessionId = (session as { id: string }).id;
        if (sessionId === this.plugin.settings.lastSessionId) {
          this.currentSession = session as RemoteSession;
          this.renderRequests();
          this.updateActionButtons();
        }
      }

      const messages = (value as { messages?: unknown }).messages;
      if (isObject(messages) && Array.isArray((messages as { messages?: unknown }).messages)) {
        this.messages = sortMessages((messages as { messages: RemoteDecryptedMessage[] }).messages);
        this.scheduleRenderMessages();
      }

      return;
    }

    if (type === 'session_added' || type === 'session_updated') {
      const summary = (value as { summary?: unknown }).summary;
      if (isObject(summary) && typeof (summary as { id?: unknown }).id === 'string') {
        this.upsertSessionSummary(summary as RemoteSessionSummary);
        this.renderSessionsSelect();
      }

      const session = (value as { session?: unknown }).session;
      if (isObject(session) && typeof (session as { id?: unknown }).id === 'string') {
        const sessionId = (session as { id: string }).id;
        if (sessionId === this.plugin.settings.lastSessionId) {
          this.currentSession = session as RemoteSession;
          this.renderRequests();
          this.updateActionButtons();
        }
      }

      return;
    }

    if (type === 'session_removed') {
      const removedId = typeof (value as { sessionId?: unknown }).sessionId === 'string'
        ? (value as { sessionId: string }).sessionId
        : '';
      if (!removedId) return;

      this.removeSessionSummary(removedId);
      this.renderSessionsSelect();

      if (this.plugin.settings.lastSessionId === removedId) {
        const next = this.sessions[0]?.id ?? null;
        void this.setActiveSession(next);
      }

      return;
    }

    if (type === 'message_added' || type === 'message_updated') {
      const sessionId = typeof (value as { sessionId?: unknown }).sessionId === 'string'
        ? (value as { sessionId: string }).sessionId
        : null;
      if (!sessionId || sessionId !== this.plugin.settings.lastSessionId) return;

      const message = (value as { message?: unknown }).message;
      if (!isObject(message) || typeof (message as { id?: unknown }).id !== 'string') return;

      this.upsertMessage(message as RemoteDecryptedMessage);
      this.scheduleRenderMessages();
      return;
    }

    if (type === 'message_patch') {
      const sessionId = typeof (value as { sessionId?: unknown }).sessionId === 'string'
        ? (value as { sessionId: string }).sessionId
        : null;
      if (!sessionId || sessionId !== this.plugin.settings.lastSessionId) return;

      const messageId = typeof (value as { messageId?: unknown }).messageId === 'string'
        ? (value as { messageId: string }).messageId
        : '';
      if (!messageId) return;

      const patch = (value as { patch?: unknown }).patch;
      this.applyMessagePatch(messageId, patch);
      this.renderRequests();
      this.scheduleRenderMessages();
      return;
    }
  }

  private upsertSessionSummary(summary: RemoteSessionSummary): void {
    const idx = this.sessions.findIndex(s => s.id === summary.id);
    if (idx === -1) {
      this.sessions.push(summary);
    } else {
      this.sessions[idx] = summary;
    }

    this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private removeSessionSummary(sessionId: string): void {
    this.sessions = this.sessions.filter(s => s.id !== sessionId);
  }

  private upsertMessage(message: RemoteDecryptedMessage): void {
    const idx = this.messages.findIndex(m => m.id === message.id);
    if (idx === -1) {
      this.messages.push(message);
    } else {
      this.messages[idx] = message;
    }

    this.messages = sortMessages(this.messages).slice(-200);
  }

  private applyMessagePatch(messageId: string, patch: unknown): void {
    const idx = this.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;

    const current = this.messages[idx];
    const currentRecord = unwrapRoleWrappedRecordEnvelope(current.content);

    const nextRecord: RoleWrappedRecord = {
      role: currentRecord?.role ?? 'agent',
      content: currentRecord?.content ?? '',
      meta: isObject(currentRecord?.meta) ? { ...(currentRecord!.meta as Record<string, unknown>) } : {},
      blocks: Array.isArray(currentRecord?.blocks) ? [...currentRecord!.blocks] : [],
    };

    const opsRaw = isObject(patch) ? (patch as { ops?: unknown }).ops : null;
    const ops = Array.isArray(opsRaw) ? opsRaw : [];

    const blocks = Array.isArray(nextRecord.blocks) ? nextRecord.blocks : [];

    const findBlockByKey = (key: string) => blocks.find(b =>
      isObject(b) &&
      typeof (b as { key?: unknown }).key === 'string' &&
      (b as { key: string }).key === key
    ) as Record<string, unknown> | undefined;

    const findToolUseBlock = (id: string) => blocks.find(b =>
      isObject(b) &&
      (b as { type?: unknown }).type === 'tool_use' &&
      typeof (b as { id?: unknown }).id === 'string' &&
      (b as { id: string }).id === id
    ) as Record<string, unknown> | undefined;

    for (const opRaw of ops) {
      if (!isObject(opRaw)) continue;
      const op = opRaw as Record<string, unknown>;
      const opType = typeof op.type === 'string' ? op.type : '';
      if (!opType) continue;

      if (opType === 'assistant_text_delta') {
        const delta = typeof op.delta === 'string' ? op.delta : '';
        if (!delta) continue;
        const prev = typeof nextRecord.content === 'string' ? nextRecord.content : safeStringify(nextRecord.content);
        nextRecord.content = prev + delta;
        continue;
      }

      if (opType === 'assistant_text_set') {
        const text = typeof op.text === 'string' ? op.text : '';
        nextRecord.content = text;
        continue;
      }

      if (opType === 'assistant_thinking_delta') {
        const delta = typeof op.delta === 'string' ? op.delta : '';
        if (!delta) continue;
        const prev = typeof (nextRecord.meta as { thinking?: unknown }).thinking === 'string'
          ? (nextRecord.meta as { thinking: string }).thinking
          : '';
        (nextRecord.meta as { thinking: string }).thinking = prev + delta;
        continue;
      }

      if (opType === 'assistant_thinking_set') {
        const thinking = typeof op.thinking === 'string' ? op.thinking : '';
        (nextRecord.meta as { thinking: string }).thinking = thinking;
        continue;
      }

      if (opType === 'text_delta') {
        const key = typeof op.key === 'string' ? op.key : '';
        const delta = typeof op.delta === 'string' ? op.delta : '';
        if (!key || !delta) continue;
        let block = findBlockByKey(key);
        if (!block) {
          block = { type: 'text', key, text: '' };
          blocks.push(block);
        }
        const prev = typeof block.text === 'string' ? block.text : safeStringify(block.text);
        block.text = prev + delta;
        continue;
      }

      if (opType === 'text_set') {
        const key = typeof op.key === 'string' ? op.key : '';
        const text = typeof op.text === 'string' ? op.text : '';
        if (!key) continue;
        let block = findBlockByKey(key);
        if (!block) {
          block = { type: 'text', key, text: '' };
          blocks.push(block);
        }
        block.text = text;
        continue;
      }

      if (opType === 'thinking_delta') {
        const key = typeof op.key === 'string' ? op.key : '';
        const delta = typeof op.delta === 'string' ? op.delta : '';
        if (!key || !delta) continue;
        let block = findBlockByKey(key);
        if (!block) {
          block = { type: 'thinking', key, thinking: '' };
          blocks.push(block);
        }
        const prev = typeof block.thinking === 'string' ? block.thinking : safeStringify(block.thinking);
        block.thinking = prev + delta;
        continue;
      }

      if (opType === 'thinking_set') {
        const key = typeof op.key === 'string' ? op.key : '';
        const thinking = typeof op.thinking === 'string' ? op.thinking : '';
        if (!key) continue;
        let block = findBlockByKey(key);
        if (!block) {
          block = { type: 'thinking', key, thinking: '' };
          blocks.push(block);
        }
        block.thinking = thinking;
        continue;
      }

      if (opType === 'tool_use') {
        const id = typeof op.id === 'string' ? op.id : '';
        if (!id) continue;
        let block = findToolUseBlock(id);
        if (!block) {
          block = { type: 'tool_use', id };
          blocks.push(block);
        }
        if (typeof op.name === 'string') block.name = op.name;
        if ('input' in op) block.input = op.input;
        if (typeof op.status === 'string') block.status = op.status;
        if (typeof op.createdAt === 'number') block.createdAt = op.createdAt;
        continue;
      }

      if (opType === 'tool_use_status') {
        const id = typeof op.id === 'string' ? op.id : '';
        const status = typeof op.status === 'string' ? op.status : '';
        if (!id || !status) continue;
        let block = findToolUseBlock(id);
        if (!block) {
          block = { type: 'tool_use', id };
          blocks.push(block);
        }
        block.status = status;
        if (typeof op.decision === 'string') block.decision = op.decision;
        if (typeof op.completedAt === 'number') block.completedAt = op.completedAt;
        continue;
      }

      if (opType === 'tool_result') {
        const toolUseId = typeof op.tool_use_id === 'string' ? op.tool_use_id : '';
        if (!toolUseId) continue;
        const next = {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'content' in op ? op.content : null,
          ...(op.is_error ? { is_error: true } : {}),
        };
        blocks.push(next);
        continue;
      }
    }

    // Keep the legacy `content` and `meta.thinking` strings in sync for display/fallback.
    if (blocks.length > 0) {
      let text = '';
      let thinking = '';
      for (const block of blocks) {
        if (!isObject(block) || typeof (block as { type?: unknown }).type !== 'string') continue;
        const type = (block as { type: string }).type;
        if (type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
          text += (block as { text: string }).text;
        } else if (type === 'thinking' && typeof (block as { thinking?: unknown }).thinking === 'string') {
          thinking += (block as { thinking: string }).thinking;
        }
      }

      if (text) {
        nextRecord.content = text;
      }
      if (thinking) {
        (nextRecord.meta as { thinking: string }).thinking = thinking;
      }
    }

    const nextMsg: RemoteDecryptedMessage = { ...current, content: nextRecord };
    this.messages[idx] = nextMsg;
  }

  private async renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void> {
    const processedMarkdown = replaceImageEmbedsWithHtml(
      markdown,
      this.app,
      ''
    );
    await MarkdownRenderer.renderMarkdown(processedMarkdown, el, '', this);
  }

  private async renderMessages(): Promise<void> {
    if (this.messagesRenderInProgress) {
      this.messagesRenderPending = true;
      return;
    }

    this.messagesRenderInProgress = true;
    const currentGeneration = ++this.renderGeneration;
    const checkCancelled = () => {
      if (this.viewClosed || this.renderGeneration !== currentGeneration) {
        throw new Error('Render cancelled');
      }
    };

    try {
      this.messagesRenderPending = false;
      const shouldStickToBottom =
        this.messagesEl.scrollTop + this.messagesEl.clientHeight >= this.messagesEl.scrollHeight - 20;

      try {
        const existing = this.messagesEl.querySelectorAll('details[data-thinking-message-id]');
        for (const el of existing) {
          const details = el as HTMLDetailsElement;
          const id = details.dataset.thinkingMessageId;
          if (!id) continue;
          if (details.open) {
            this.openThinkingMessageIds.add(id);
          } else {
            this.openThinkingMessageIds.delete(id);
          }
        }
      } catch {
        // ignore
      }

      this.messagesEl.empty();
      checkCancelled();

      if (!this.plugin.settings.lastSessionId) {
        this.messagesEl.createDiv({ text: 'Select a session to view messages.' });
        return;
      }

      for (const msg of this.messages) {
        const record = unwrapRoleWrappedRecordEnvelope(msg.content);
        const role = record?.role ?? 'unknown';
        const body = record ? record.content : msg.content;
        const meta = record?.meta;
        const blocks = extractHubBlocks(record);

        const wrapper = this.messagesEl.createDiv();
        wrapper.style.marginBottom = '10px';

        const header = wrapper.createDiv({ text: role });
        header.style.fontSize = '11px';
        header.style.color = 'var(--text-muted)';

        const blocksThinking = blocks ? extractThinkingFromBlocks(blocks) : '';
        const metaThinking = isObject(meta) && typeof meta.thinking === 'string' ? meta.thinking : '';
        const thinkingText = blocksThinking.trim() ? blocksThinking : metaThinking;
        if (thinkingText.trim()) {
          const details = wrapper.createEl('details');
          details.dataset.thinkingMessageId = msg.id;
          details.open = this.openThinkingMessageIds.has(msg.id);
          details.addEventListener('toggle', () => {
            if (details.open) {
              this.openThinkingMessageIds.add(msg.id);
            } else {
              this.openThinkingMessageIds.delete(msg.id);
            }
          });
          details.style.margin = '4px 0 0 0';
          details.style.background = 'var(--background-secondary)';
          details.style.border = '1px solid var(--background-modifier-border)';
          details.style.borderRadius = '6px';
          details.style.padding = '6px 8px';

          const summary = details.createEl('summary', { text: 'Thinking' });
          summary.style.cursor = 'pointer';
          summary.style.fontSize = '12px';
          summary.style.color = 'var(--text-muted)';

          const thinkingPre = details.createEl('pre', { text: thinkingText });
          thinkingPre.style.whiteSpace = 'pre-wrap';
          thinkingPre.style.wordBreak = 'break-word';
          thinkingPre.style.margin = '6px 0 0 0';
          thinkingPre.style.fontFamily = 'var(--font-text)';
          thinkingPre.style.fontSize = '13px';
          thinkingPre.style.maxHeight = '400px';
          thinkingPre.style.overflowY = 'auto';
        }

        const contentBox = wrapper.createDiv();
        contentBox.style.margin = '4px 0 0 0';
        contentBox.style.background = 'var(--background-secondary)';
        contentBox.style.border = '1px solid var(--background-modifier-border)';
        contentBox.style.borderRadius = '6px';
        contentBox.style.padding = '8px';

        const markdownEl = contentBox.createDiv({ cls: 'clian-message-content' });
        markdownEl.style.fontFamily = 'var(--font-text)';
        markdownEl.style.fontSize = '13px';

        if (blocks && blocks.length > 0) {
          const sessionId = this.plugin.settings.lastSessionId;

          for (const block of blocks) {
            if (!block || typeof block !== 'object' || typeof block.type !== 'string') continue;
            if (block.type === 'thinking') continue;

            if (block.type === 'text') {
              const text = typeof block.text === 'string' ? block.text : safeStringify(block.text);
              if (!text.trim()) continue;
              const el = markdownEl.createDiv();
              await this.renderMarkdownInto(el, text);
              checkCancelled();
              continue;
            }

            if (block.type === 'tool_use') {
              const card = markdownEl.createDiv();
              card.style.marginTop = '6px';
              card.style.padding = '8px';
              card.style.border = '1px solid var(--background-modifier-border)';
              card.style.borderRadius = '6px';
              card.style.background = 'var(--background-secondary)';

              const name = typeof block.name === 'string' ? block.name : 'unknown';
              const status = typeof block.status === 'string' ? block.status : '';
              const title = status ? `tool_use: ${name} (${status})` : `tool_use: ${name}`;
              card.createDiv({ text: title }).style.fontWeight = '600';

              const id = typeof block.id === 'string' ? block.id : '';
              if (id) {
                const idEl = card.createDiv({ text: `id: ${id}` });
                idEl.style.marginTop = '4px';
                idEl.style.fontSize = '12px';
                idEl.style.color = 'var(--text-muted)';
              }

              const inputPre = card.createEl('pre', { text: safeStringify(block.input) });
              inputPre.style.whiteSpace = 'pre-wrap';
              inputPre.style.wordBreak = 'break-word';
              inputPre.style.margin = '6px 0 0 0';
              inputPre.style.fontSize = '12px';

              if (sessionId && id && status === 'pending') {
                const actions = card.createDiv();
                actions.style.display = 'flex';
                actions.style.gap = '8px';
                actions.style.marginTop = '8px';

                const approveBtn = actions.createEl('button', { text: 'Approve' });
                approveBtn.addEventListener('click', async () => {
                  approveBtn.disabled = true;
                  try {
                    await this.client.approvePermission(sessionId, id, {});
                    new Notice('Approved.');
                  } catch (error) {
                    approveBtn.disabled = false;
                    new Notice(`Approve failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                  }
                });

                const denyBtn = actions.createEl('button', { text: 'Deny' });
                denyBtn.addEventListener('click', async () => {
                  denyBtn.disabled = true;
                  try {
                    await this.client.denyPermission(sessionId, id, {});
                    new Notice('Denied.');
                  } catch (error) {
                    denyBtn.disabled = false;
                    new Notice(`Deny failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                  }
                });
              }

              checkCancelled();
              continue;
            }

            if (block.type === 'tool_result') {
              const card = markdownEl.createDiv();
              card.style.marginTop = '6px';
              card.style.padding = '8px';
              card.style.border = '1px solid var(--background-modifier-border)';
              card.style.borderRadius = '6px';
              card.style.background = 'var(--background-secondary)';

              const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
              const isError = !!block.is_error;
              const title = toolUseId
                ? `tool_result${isError ? ' (error)' : ''}: ${toolUseId}`
                : `tool_result${isError ? ' (error)' : ''}`;
              card.createDiv({ text: title }).style.fontWeight = '600';

              const outPre = card.createEl('pre', { text: safeStringify(block.content) });
              outPre.style.whiteSpace = 'pre-wrap';
              outPre.style.wordBreak = 'break-word';
              outPre.style.margin = '6px 0 0 0';
              outPre.style.fontSize = '12px';
              if (isError) {
                outPre.style.color = 'var(--text-error)';
              }

              checkCancelled();
              continue;
            }

            const fallback = markdownEl.createEl('pre', { text: safeStringify(block) });
            fallback.style.whiteSpace = 'pre-wrap';
            fallback.style.wordBreak = 'break-word';
            fallback.style.margin = '6px 0 0 0';
            fallback.style.fontSize = '12px';
            checkCancelled();
          }
        } else {
          const markdownText = typeof body === 'string' ? body : '```\n' + safeStringify(body) + '\n```';
          await this.renderMarkdownInto(markdownEl, markdownText);
        }
        checkCancelled();
      }

      if (shouldStickToBottom) {
        requestAnimationFrame(() => {
          if (!this.viewClosed) {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
          }
        });
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'Render cancelled') {
        return;
      }
      throw err;
    } finally {
      this.messagesRenderInProgress = false;
      if (this.messagesRenderPending && !this.viewClosed) {
        this.scheduleRenderMessages();
      }
    }
  }

  private renderRequests(): void {
    this.requestsEl.empty();

    const sessionId = this.plugin.settings.lastSessionId;
    const requests = this.currentSession?.agentState?.requests ?? null;

    const inlineRequestIds = new Set<string>();
    try {
      for (const msg of this.messages) {
        const record = unwrapRoleWrappedRecordEnvelope(msg.content);
        const blocks = extractHubBlocks(record);
        if (!blocks) continue;
        for (const block of blocks) {
          if (block.type !== 'tool_use') continue;
          const id = typeof block.id === 'string' ? block.id : '';
          const status = typeof block.status === 'string' ? block.status : '';
          if (id && status === 'pending') {
            inlineRequestIds.add(id);
          }
        }
      }
    } catch {
      // ignore
    }

    const entries = Object.entries(requests || {}).filter(([requestId]) => !inlineRequestIds.has(requestId));

    if (!sessionId || !requests || entries.length === 0) {
      this.requestsEl.style.display = 'none';
      return;
    }

    this.requestsEl.style.display = 'block';
    this.requestsEl.style.borderTop = '1px solid var(--background-modifier-border)';

    this.requestsEl.createDiv({ text: 'Pending approvals' }).style.fontSize = '12px';

    for (const [requestId, req] of entries) {
      const card = this.requestsEl.createDiv();
      card.style.marginTop = '8px';
      card.style.padding = '8px';
      card.style.border = '1px solid var(--background-modifier-border)';
      card.style.borderRadius = '6px';
      card.style.background = 'var(--background-secondary)';

      card.createDiv({ text: `${req.tool}` }).style.fontWeight = '600';

      const argsPre = card.createEl('pre', { text: safeStringify(req.arguments) });
      argsPre.style.whiteSpace = 'pre-wrap';
      argsPre.style.wordBreak = 'break-word';
      argsPre.style.margin = '6px 0 0 0';
      argsPre.style.fontSize = '12px';

      const actions = card.createDiv();
      actions.style.display = 'flex';
      actions.style.gap = '8px';
      actions.style.marginTop = '8px';

      const approveBtn = actions.createEl('button', { text: 'Approve' });
      approveBtn.addEventListener('click', async () => {
        try {
          await this.client.approvePermission(sessionId, requestId, {});
          new Notice('Approved.');
        } catch (error) {
          new Notice(`Approve failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      });

      const denyBtn = actions.createEl('button', { text: 'Deny' });
      denyBtn.addEventListener('click', async () => {
        try {
          await this.client.denyPermission(sessionId, requestId, {});
          new Notice('Denied.');
        } catch (error) {
          new Notice(`Deny failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      });
    }
  }

  private async sendCurrentMessage(): Promise<void> {
    const sessionId = this.plugin.settings.lastSessionId;
    const text = this.inputEl.value.trim();
    if (!sessionId) {
      new Notice('Select a session first.');
      return;
    }
    if (!text) return;

    const localId = `obsidian-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    this.slashDropdown?.hide();
    this.mentionDropdown?.hide();
    this.inputEl.value = '';
    try {
      if (!this.sseConnected) {
        new Notice('Warning: SSE not connected. The UI may not update until reconnect.');
      }
      await this.client.sendMessage(sessionId, text, localId);
    } catch (error) {
      new Notice(`Send failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.inputEl.value = text;
    }
  }

  private insertIntoInput(text: string): void {
    const el = this.inputEl;
    const value = el.value;
    const cursor = el.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);

    el.value = `${before}${text}${after}`;
    const nextCursor = before.length + text.length;
    try { el.setSelectionRange(nextCursor, nextCursor); } catch { /* ignore */ }
    el.focus();
  }

  private openMcpServersModal(): void {
    if (this.mcpModalOpen) return;

    const sessionId = this.plugin.settings.lastSessionId;
    if (!sessionId) {
      new Notice('Select a session first.');
      return;
    }

    if (!this.client.getBaseUrl() || !this.plugin.settings.accessToken.trim()) {
      new Notice('Configure hub URL and access token in settings.');
      return;
    }

    this.mcpModalOpen = true;
    const modal = new McpServersModal(this, {
      client: this.client,
      sessionId,
      onClosed: () => {
        this.mcpModalOpen = false;
      },
    });
    modal.open();
  }

  private openUploadFileModal(): void {
    if (this.uploadModalOpen) return;

    const sessionId = this.plugin.settings.lastSessionId;
    if (!sessionId) {
      new Notice('Select a session first.');
      return;
    }

    if (!this.client.getBaseUrl() || !this.plugin.settings.accessToken.trim()) {
      new Notice('Configure hub URL and access token in settings.');
      return;
    }

    this.uploadModalOpen = true;
    const modal = new UploadFileModal(this, {
      client: this.client,
      sessionId,
      onUploaded: (remotePath) => {
        const prefix = this.inputEl.value && !this.inputEl.value.endsWith('\n') ? '\n' : '';
        this.insertIntoInput(`${prefix}Hub file: ${remotePath}\n`);
      },
      onClosed: () => {
        this.uploadModalOpen = false;
      },
    });
    modal.open();
  }

  private async interruptActiveSession(): Promise<void> {
    const sessionId = this.plugin.settings.lastSessionId;
    if (!sessionId) {
      new Notice('Select a session first.');
      return;
    }

    if (!this.client.getBaseUrl() || !this.plugin.settings.accessToken.trim()) {
      new Notice('Configure hub URL and access token in settings.');
      return;
    }

    const prevText = this.stopButtonEl.textContent || 'Stop';
    this.stopButtonEl.disabled = true;
    this.stopButtonEl.textContent = 'Stopping…';

    try {
      const resp = await this.client.interruptSession(sessionId);
      if (resp && resp.interrupted === false) {
        new Notice('Nothing to interrupt.');
      } else {
        new Notice('Interrupt sent.');
      }
    } catch (error) {
      new Notice(`Interrupt failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      this.stopButtonEl.textContent = prevText;
      this.updateActionButtons();
    }
  }

  private getMentionItems(): MobileMentionItem[] {
    const folders: MobileMentionItem[] = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => ({
        type: 'folder' as const,
        name: folder.name,
        path: folder.path.replace(/\\/g, '/').replace(/\/+$/, ''),
      }))
      .filter((item) => item.path.length > 0);

    const files: MobileMentionItem[] = this.app.vault.getMarkdownFiles().map((file) => ({
      type: 'file' as const,
      name: file.name,
      path: file.path,
    }));

    return [...folders, ...files];
  }

  private openCommandPicker(): void {
    if (this.commandPickerOpen) return;

    const sessionId = this.plugin.settings.lastSessionId;
    if (!sessionId) {
      new Notice('Select a session first.');
      return;
    }

    if (!this.client.getBaseUrl() || !this.plugin.settings.accessToken.trim()) {
      new Notice('Configure hub URL and access token in settings.');
      return;
    }

    this.commandPickerOpen = true;
    const modal = new CommandPickerModal(this, {
      client: this.client,
      sessionId,
      onPick: (name) => this.insertSlashCommand(name),
      onClosed: () => {
        this.commandPickerOpen = false;
      },
    });
    modal.open();
  }

  private insertSlashCommand(name: string): void {
    const el = this.inputEl;
    const value = el.value;
    const cursor = el.selectionStart ?? value.length;

    let slashIndex = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === '/') {
        slashIndex = i;
        break;
      }
      if (/\s/.test(ch)) {
        break;
      }
    }

    if (slashIndex === -1) {
      const next = `${value}${value && !value.endsWith(' ') ? ' ' : ''}/${name} `;
      el.value = next;
      el.focus();
      return;
    }

    const nextValue = `${value.slice(0, slashIndex + 1)}${name} ${value.slice(cursor)}`;
    el.value = nextValue;
    const nextCursor = slashIndex + 1 + name.length + 1;
    try {
      el.setSelectionRange(nextCursor, nextCursor);
    } catch {
      // ignore
    }
    el.focus();
  }

  private styleSessionSelect(el: HTMLSelectElement): void {
    el.style.minHeight = '44px';
    el.style.height = '44px';
    el.style.padding = '0 12px';
    el.style.border = '1px solid var(--background-modifier-border)';
    el.style.borderRadius = 'var(--radius-m, 10px)';
    el.style.background = 'var(--background-secondary)';
    el.style.color = 'var(--text-normal)';
    el.style.boxSizing = 'border-box';
  }

  private styleHeaderButton(el: HTMLButtonElement): void {
    el.style.minHeight = '44px';
    el.style.padding = '0 12px';
    el.style.borderRadius = 'var(--radius-m, 8px)';
    el.style.background = 'var(--background-secondary)';
    el.style.color = 'var(--text-normal)';
    el.style.border = '1px solid var(--background-modifier-border)';
    el.style.cursor = 'pointer';
  }

  private styleInputTextarea(el: HTMLTextAreaElement): void {
    el.style.padding = '12px';
    el.style.borderRadius = 'var(--radius-m, 12px)';
    el.style.border = '1px solid var(--background-modifier-border)';
    el.style.background = 'var(--background-secondary)';
    el.style.boxShadow = 'inset 0 1px 2px rgba(0, 0, 0, 0.05)';
    el.style.fontSize = '16px';
  }

  private styleSendButton(el: HTMLButtonElement): void {
    el.style.minHeight = '44px';
    el.style.padding = '0 16px';
    el.style.borderRadius = 'var(--radius-m, 10px)';
    el.style.background = 'var(--interactive-accent)';
    el.style.color = 'var(--text-on-accent)';
    el.style.border = 'none';
    el.style.transform = 'translateY(-6px)';
    el.style.cursor = 'pointer';
  }
}
