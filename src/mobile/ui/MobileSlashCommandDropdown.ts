import type { SlashCommand } from '../../core/types';
import { SelectableDropdown } from '../../shared/components/SelectableDropdown';
import type { RemoteHubClient } from '../remoteHubClient';

export class MobileSlashCommandDropdown {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private client: RemoteHubClient;
  private getSessionId: () => string | null;

  private dropdown: SelectableDropdown<SlashCommand>;
  private slashStartIndex = -1;
  private requestId = 0;
  private lastFetchAtMs = 0;

  private cachedForSessionId: string | null = null;
  private cachedCommands: SlashCommand[] = [];

  constructor(options: {
    containerEl: HTMLElement;
    inputEl: HTMLTextAreaElement;
    client: RemoteHubClient;
    getSessionId: () => string | null;
  }) {
    this.containerEl = options.containerEl;
    this.inputEl = options.inputEl;
    this.client = options.client;
    this.getSessionId = options.getSessionId;

    this.dropdown = new SelectableDropdown<SlashCommand>(this.containerEl, {
      listClassName: 'clian-slash-dropdown',
      itemClassName: 'clian-slash-item',
      emptyClassName: 'clian-slash-empty',
    });
  }

  resetCache(): void {
    this.cachedForSessionId = null;
    this.cachedCommands = [];
    this.requestId = 0;
    this.lastFetchAtMs = 0;
  }

  isVisible(): boolean {
    return this.dropdown.isVisible();
  }

  hide(): void {
    this.dropdown.hide();
    this.slashStartIndex = -1;
  }

  destroy(): void {
    this.dropdown.destroy();
  }

  handleInputChange(): void {
    const text = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart ?? 0;
    const textBeforeCursor = text.substring(0, cursorPos);

    // Only show dropdown if / is at position 0
    if (text.charAt(0) !== '/') {
      this.hide();
      return;
    }

    const slashIndex = 0;
    const searchText = textBeforeCursor.substring(slashIndex + 1);

    // Hide if there's whitespace in the search text (command already selected)
    if (/\s/.test(searchText)) {
      this.hide();
      return;
    }

    this.slashStartIndex = slashIndex;
    void this.showDropdown(searchText);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.dropdown.isVisible()) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.dropdown.moveSelection(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this.dropdown.moveSelection(-1);
        return true;
      case 'Enter':
      case 'Tab': {
        if (e.isComposing) return false;
        const selected = this.dropdown.getSelectedItem();
        if (!selected) return false;
        e.preventDefault();
        this.selectCommand(selected);
        return true;
      }
      case 'Escape':
        if (e.isComposing) return false;
        e.preventDefault();
        this.hide();
        return true;
    }

    return false;
  }

  private async showDropdown(searchText: string): Promise<void> {
    const currentRequest = ++this.requestId;
    const sessionId = this.getSessionId();

    if (!sessionId) {
      this.hide();
      return;
    }

    const now = Date.now();
    const canRefetchEmpty = searchText.length === 0 && now - this.lastFetchAtMs > 2000;
    const shouldFetch = this.cachedForSessionId !== sessionId || (this.cachedCommands.length === 0 && canRefetchEmpty);

    if (shouldFetch) {
      try {
        this.lastFetchAtMs = now;
        const res = await this.client.getCommands(sessionId);
        if (currentRequest !== this.requestId) return;

        const names = Array.isArray(res?.commands) ? res.commands : [];
        this.cachedCommands = names
          .filter((name) => typeof name === 'string' && name.trim().length > 0)
          .map((name) => ({
            id: `remote:${name}`,
            name,
            description: '',
            content: '',
            source: 'sdk',
          }));
        this.cachedForSessionId = sessionId;
      } catch {
        if (currentRequest !== this.requestId) return;
        this.cachedCommands = [];
        this.cachedForSessionId = sessionId;
      }
    }

    const searchLower = searchText.toLowerCase();
    const filtered = this.cachedCommands
      .filter((cmd) => cmd.name.toLowerCase().includes(searchLower))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 60);

    if (searchText.length > 0 && filtered.length === 0) {
      this.hide();
      return;
    }

    this.dropdown.render({
      items: filtered,
      selectedIndex: 0,
      emptyText: 'No matching commands',
      renderItem: (cmd, itemEl) => {
        const nameEl = itemEl.createSpan({ cls: 'clian-slash-name' });
        nameEl.setText(`/${cmd.name}`);
      },
      onItemClick: (cmd) => {
        this.selectCommand(cmd);
      },
    });

    window.requestAnimationFrame(() => {
      this.constrainDropdownToViewport(300);
    });
  }

  private getSafeTopPx(): number {
    const defaultSafeTop = 8;

    // Prefer the current leaf's view header (Obsidian mobile top chrome).
    try {
      const leafContent = this.containerEl.closest('.workspace-leaf-content') as HTMLElement | null;
      const viewHeader = leafContent?.querySelector('.view-header') as HTMLElement | null;
      const headerBottom = viewHeader?.getBoundingClientRect().bottom;
      if (typeof headerBottom === 'number' && Number.isFinite(headerBottom) && headerBottom > 0) {
        return Math.max(defaultSafeTop, Math.ceil(headerBottom) + 8);
      }
    } catch {
      // ignore
    }

    return defaultSafeTop;
  }

  private constrainDropdownToViewport(defaultMaxHeightPx: number): void {
    const dropdownEl = this.dropdown.getElement();
    if (!dropdownEl || !dropdownEl.hasClass('visible')) return;

    const containerRect = this.containerEl.getBoundingClientRect();
    const safeTop = this.getSafeTopPx();
    const gap = 8;
    const spaceAbove = Math.max(0, containerRect.top - safeTop - gap);
    if (spaceAbove <= 0) {
      // Don't collapse the dropdown if the safe-top math is off; fall back to CSS max-height.
      dropdownEl.style.maxHeight = '';
      return;
    }

    dropdownEl.style.maxHeight = `${Math.min(defaultMaxHeightPx, Math.floor(spaceAbove))}px`;
  }

  private selectCommand(command: SlashCommand): void {
    const text = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart ?? 0;
    const afterCursor = text.substring(cursorPos);
    const beforeSlash = text.substring(0, this.slashStartIndex);
    const replacement = `/${command.name} `;

    this.inputEl.value = beforeSlash + replacement + afterCursor;
    const nextCursor = beforeSlash.length + replacement.length;
    try {
      this.inputEl.setSelectionRange(nextCursor, nextCursor);
    } catch {
      // ignore
    }

    this.hide();
    this.inputEl.focus();
  }
}
