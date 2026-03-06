import { setIcon } from 'obsidian';

import { SelectableDropdown } from '../../shared/components/SelectableDropdown';

export type MobileMentionItem =
  | { type: 'folder'; name: string; path: string }
  | { type: 'file'; name: string; path: string };

function isVisibleVaultPath(vaultPath: string): boolean {
  const normalized = vaultPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized) return false;
  return !normalized.split('/').some((segment) => segment.startsWith('.'));
}

function scoreMentionItem(item: MobileMentionItem, queryLower: string): { startsWith: boolean; path: string } {
  const nameLower = item.name.toLowerCase();
  return {
    startsWith: queryLower.length > 0 && nameLower.startsWith(queryLower),
    path: item.path,
  };
}

export class MobileMentionDropdown {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private dropdown: SelectableDropdown<MobileMentionItem>;
  private getItems: () => MobileMentionItem[];

  private mentionStartIndex = -1;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    containerEl: HTMLElement;
    inputEl: HTMLTextAreaElement;
    getItems: () => MobileMentionItem[];
  }) {
    this.containerEl = options.containerEl;
    this.inputEl = options.inputEl;
    this.getItems = options.getItems;

    this.dropdown = new SelectableDropdown<MobileMentionItem>(this.containerEl, {
      listClassName: 'clian-mention-dropdown',
      itemClassName: 'clian-mention-item',
      emptyClassName: 'clian-mention-empty',
    });
  }

  isVisible(): boolean {
    return this.dropdown.isVisible();
  }

  hide(): void {
    this.dropdown.hide();
    this.mentionStartIndex = -1;
  }

  destroy(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.dropdown.destroy();
  }

  handleInputChange(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      const text = this.inputEl.value;
      const cursorPos = this.inputEl.selectionStart ?? 0;
      const textBeforeCursor = text.substring(0, cursorPos);
      const lastAtIndex = textBeforeCursor.lastIndexOf('@');

      // Don't show @ dropdown while composing a slash command at start.
      if (text.charAt(0) === '/') {
        this.hide();
        return;
      }

      if (lastAtIndex === -1) {
        this.hide();
        return;
      }

      const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
      if (!/\s/.test(charBeforeAt) && lastAtIndex !== 0) {
        this.hide();
        return;
      }

      const searchText = textBeforeCursor.substring(lastAtIndex + 1);
      if (/\s/.test(searchText)) {
        this.hide();
        return;
      }

      this.mentionStartIndex = lastAtIndex;
      this.showDropdown(searchText);
    }, 200);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.dropdown.isVisible()) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.dropdown.moveSelection(1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.dropdown.moveSelection(-1);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
      const selected = this.dropdown.getSelectedItem();
      if (!selected) return false;
      e.preventDefault();
      this.selectItem(selected);
      return true;
    }
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      this.hide();
      return true;
    }

    return false;
  }

  private showDropdown(searchText: string): void {
    const searchLower = searchText.toLowerCase();

    const items = this.getItems()
      .filter((item) => isVisibleVaultPath(item.path))
      .filter((item) => {
        if (!searchLower) return true;
        return (
          item.path.toLowerCase().includes(searchLower) ||
          item.name.toLowerCase().includes(searchLower)
        );
      })
      .map((item) => ({ item, score: scoreMentionItem(item, searchLower) }))
      .sort((a, b) => {
        if (a.score.startsWith !== b.score.startsWith) return a.score.startsWith ? -1 : 1;
        return a.score.path.localeCompare(b.score.path);
      })
      .map((x) => x.item)
      .slice(0, 80);

    if (searchText.length > 0 && items.length === 0) {
      this.hide();
      return;
    }

    this.dropdown.render({
      items,
      selectedIndex: 0,
      emptyText: 'No matches',
      getItemClass: (item) => (item.type === 'folder' ? 'vault-folder' : undefined),
      renderItem: (item, itemEl) => {
        const iconEl = itemEl.createSpan({ cls: 'clian-mention-icon' });
        setIcon(iconEl, item.type === 'folder' ? 'folder' : 'file-text');

        const pathEl = itemEl.createSpan({ cls: 'clian-mention-path' });
        pathEl.setText(`@${item.path}${item.type === 'folder' ? '/' : ''}`);
      },
      onItemClick: (item) => {
        this.selectItem(item);
      },
    });

    window.requestAnimationFrame(() => {
      this.constrainDropdownToViewport(250);
    });
  }

  private getSafeTopPx(): number {
    const defaultSafeTop = 8;

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
      dropdownEl.style.maxHeight = '';
      return;
    }

    dropdownEl.style.maxHeight = `${Math.min(defaultMaxHeightPx, Math.floor(spaceAbove))}px`;
  }

  private selectItem(item: MobileMentionItem): void {
    const text = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart ?? 0;
    const beforeAt = text.substring(0, this.mentionStartIndex);
    const afterCursor = text.substring(cursorPos);
    const replacement = `@${item.path}${item.type === 'folder' ? '/' : ''} `;

    this.inputEl.value = beforeAt + replacement + afterCursor;
    const nextCursor = beforeAt.length + replacement.length;
    try {
      this.inputEl.setSelectionRange(nextCursor, nextCursor);
    } catch {
      // ignore
    }

    this.hide();
    this.inputEl.focus();
  }
}
