import { DB_KEY, loadDefaultActions } from './js/cllama.js';
import { browser, isFirefox } from './js/browser.mjs';
import { handleViewerMessage } from './js/viewer-bridge.mjs';

const INSIGHT_MENU_ID = 'cllama-insight';
const INSIGHT_ACTION_PREFIX = 'cllama-insight-action-';

let actionList = [];

/**
 * Open the insight sidebar (Firefox sidebar / Chrome side panel)
 * @param {string} url - Relative path of the panel page
 * @param {Object} [tab] - The tab from which the context menu was triggered
 */
function openSidebar(url, tab) {
  if (isFirefox) {
    const sidebar = browser.sidebarAction;
    sidebar.setPanel({ panel: browser.runtime.getURL(url) });
    sidebar.open();
  } else {
    const tabId = tab?.id;
    const opts = { enabled: true, path: url };
    if (tabId) opts.tabId = tabId;
    browser.sidePanel.setOptions(opts, () => {
      if (tabId) {
        browser.sidePanel.open({ tabId });
      } else {
        browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs?.[0]?.id) browser.sidePanel.open({ tabId: tabs[0].id });
        });
      }
    });
  }
}

/**
 * Load the list of insight actions (stored config, fallback to defaults)
 * @returns {Promise<Array>} Array of { id, name, prompt } objects
 */
function loadActions() {
  return new Promise((resolve) => {
    browser.storage.local.get(DB_KEY.actionList, (data) => {
      const stored = data[DB_KEY.actionList];
      if (stored && stored.length) {
        resolve(stored);
      } else {
        loadDefaultActions().then(resolve);
      }
    });
  });
}

/**
 * Rebuild the insight context menu (parent + one item per action)
 */
async function initContextMenu() {
  actionList = await loadActions();

  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id: INSIGHT_MENU_ID,
      title: browser.i18n.getMessage("Insightify"),
      contexts: ["selection"]
    });

    actionList.forEach((action) => {
      browser.contextMenus.create({
        id: `${INSIGHT_ACTION_PREFIX}${action.id}`,
        parentId: INSIGHT_MENU_ID,
        title: action.name,
        contexts: ["selection"]
      });
    });
  });
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith(INSIGHT_ACTION_PREFIX)) {
    const actionId = info.menuItemId.substring(INSIGHT_ACTION_PREFIX.length);
    const action = actionList.find(a => String(a.id) === String(actionId));
    if (!action) return;

    // Store the pending insight so the sidebar can start processing automatically
    browser.storage.local.set({
      [DB_KEY.pendingInsight]: {
        action: { id: action.id, name: action.name, prompt: action.prompt },
        selectionText: info.selectionText || '',
        url: info.pageUrl,
        title: tab?.title || ''
      }
    });

    openSidebar('/insightify/insightify.html', tab);
  }
});

// Rebuild the context menu whenever the action list changes
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[DB_KEY.actionList]) {
    initContextMenu();
  }
});

function handleMessage(request, sender) {
  if (handleViewerMessage(request, sender)) return true;

  return false;
}

function handleInstalled() {
  initContextMenu();
}

browser.runtime.onMessage.addListener(handleMessage);
browser.runtime.onInstalled.addListener(handleInstalled);
initContextMenu();
