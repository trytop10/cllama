import { DB_KEY, loadDefaultActions } from './js/cllama.js';
import { browser, isFirefox } from './js/browser.mjs';

// Determine if the current browser is Firefox


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

function handleMessage(request, sender, sendResponse) {
  if (request.action === 'openHtmlInNewTab') {
    const { htmlString, title } = request.data;

    if (isFirefox) {
      // Firefox (MV2) specific logic: Use viewer/viewer.html and sendMessage
      browser.tabs.create({ url: browser.runtime.getURL('viewer/viewer.html') }, (newTab) => {
        if (browser.runtime.lastError) {
          console.error(`Failed to create viewer tab. Error: ${browser.runtime.lastError.message}`);
          return;
        }
        const dataToStore = {};
        dataToStore[`viewer_data_${newTab.id}`] = { htmlString, title };
        browser.storage.local.set(dataToStore);
      });
    } else {
      // Chrome (MV3) specific logic: Use a data URL. This is a last resort as executeScript is failing.
      // Note: Inline scripts in data URLs may be blocked by browser's default CSP.
      const fullHtml = `<!DOCTYPE html><html><head><title>${title}</title></head><body>${htmlString}</body></html>`;
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`;
      
      browser.tabs.create({ url: dataUrl });
    }
    return true;
  }

  if (request.action === 'viewerReady') {
    // This message is only sent by viewer.js (Firefox path)
    if (isFirefox) {
      const tabId = sender.tab.id;
      const storageKey = `viewer_data_${tabId}`;
      browser.storage.local.get(storageKey, (data) => {
        if (data[storageKey] && data[storageKey].htmlString) {
          browser.tabs.sendMessage(tabId, {
            action: "displayHtml",
            data: data[storageKey]
          });
          browser.storage.local.remove(storageKey);
        }
      });
    }
    return true;
  }

  if (typeof request === 'string') {
    sendResponse({ received: true, originalMessage: request });
  } else if (request.type === 'userAction') {
    console.log(`User action: ${request.action} on ${request.elementId}`);
    sendResponse({ status: 'processed', action: request.action });
  }
  return false;
}

async function handleInstalled(details) {
  if (details.reason === "install") {
    initContextMenu();
  } else if (details.reason === "update") {
    initContextMenu();
  }
}

browser.runtime.onMessage.addListener(handleMessage);
browser.runtime.onInstalled.addListener(handleInstalled);
initContextMenu();
