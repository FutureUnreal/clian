import type { TabBarItem, TabId } from './types';

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab badge is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when the close button is clicked on a tab. */
  onTabClose: (tabId: TabId) => void;

  /** Called when the new tab button is clicked. */
  onNewTab: () => void;
}

/**
 * TabBar renders minimal numbered badge navigation.
 */
export class TabBar {
  private containerEl: HTMLElement;
  private callbacks: TabBarCallbacks;

  constructor(containerEl: HTMLElement, callbacks: TabBarCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;
    this.build();
  }

  /** Builds the tab bar UI. */
  private build(): void {
    this.containerEl.addClass('clian-tab-badges');
  }

  /**
   * Updates the tab bar with new tab data.
   * @param items Tab items to render.
   */
  update(items: TabBarItem[]): void {
    this.containerEl.empty();

    for (const item of items) {
      this.renderBadge(item);
    }
  }

  /** Renders a single tab badge. */
  private renderBadge(item: TabBarItem): void {
    let stateClass = 'clian-tab-badge-idle';
    if (item.isActive) {
      stateClass = 'clian-tab-badge-active';
    } else if (item.needsAttention) {
      stateClass = 'clian-tab-badge-attention';
    } else if (item.isStreaming) {
      stateClass = 'clian-tab-badge-streaming';
    }

    const badgeEl = this.containerEl.createDiv({
      cls: `clian-tab-badge ${stateClass}`,
      text: String(item.index),
    });

    badgeEl.setAttribute('aria-label', item.title);
    badgeEl.setAttribute('title', item.title);

    badgeEl.addEventListener('click', () => {
      this.callbacks.onTabClick(item.id);
    });

    if (item.canClose) {
      badgeEl.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.callbacks.onTabClose(item.id);
      });
    }
  }

  /** Destroys the tab bar. */
  destroy(): void {
    this.containerEl.empty();
    this.containerEl.removeClass('clian-tab-badges');
  }
}
