import { browser, isFirefox } from './browser.mjs';

/**
 * Open an HTML document in a new tab. Firefox cannot reliably open large data
 * URLs, so the document is handed to viewer/viewer.html through storage;
 * Chrome uses a data URL.
 * @param {Object} data - { htmlString, title }
 */
function openHtmlInNewTab(data = {}) {
  const { htmlString = '', title = '' } = data;

  if (isFirefox) {
    browser.tabs.create({ url: browser.runtime.getURL('viewer/viewer.html') }, (newTab) => {
      if (browser.runtime.lastError) {
        console.error(`Failed to create viewer tab: ${browser.runtime.lastError.message}`);
        return;
      }
      browser.storage.local.set({ [`viewer_data_${newTab.id}`]: { htmlString, title } });
    });
    return;
  }

  const fullHtml = `<!DOCTYPE html><html><head><title>${title}</title></head><body>${htmlString}</body></html>`;
  browser.tabs.create({ url: `data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}` });
}

/**
 * Hand the stored document to the Firefox viewer page that just became ready.
 * @param {Object} sender - Message sender
 */
function deliverViewerData(sender) {
  if (!isFirefox) return;
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  const storageKey = `viewer_data_${tabId}`;
  browser.storage.local.get(storageKey, (data) => {
    if (!data[storageKey]?.htmlString) return;
    browser.tabs.sendMessage(tabId, { action: 'displayHtml', data: data[storageKey] });
    browser.storage.local.remove(storageKey);
  });
}

/**
 * Handle the HTML-preview messages shared by both background scripts.
 * @param {Object} request - Incoming message
 * @param {Object} sender - Message sender
 * @returns {boolean} True when the message was handled
 */
export function handleViewerMessage(request, sender) {
  if (request.action === 'openHtmlInNewTab') {
    openHtmlInNewTab(request.data);
    return true;
  }
  if (request.action === 'viewerReady') {
    deliverViewerData(sender);
    return true;
  }
  return false;
}
