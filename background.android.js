import { processInsightForBackground, DB_KEY } from './js/cllama.js';
import { browser } from './js/browser.mjs';
import { sendToContentScript } from './js/util.js';
import { handleViewerMessage } from './js/viewer-bridge.mjs';



/**
 * Imports actions from an external source.
 * @param {object} data The action data containing name and prompt.
 * @returns The session ID from the data.
 */
function importActions(data) {
  saveActions(0, data.name, data.prompt);
  return data.sid;
}

/**
 * Saves or updates an action in local storage.
 * @param {number} acId The action ID. If 0, a new action is created.
 * @param {string} name The name of the action.
 * @param {string} prompt The prompt for the action.
 */
function saveActions(acId, name, prompt) {
  browser.storage.local.get(DB_KEY.actionList, function (data) {
    let configurations = data[DB_KEY.actionList];
    if (!configurations) configurations = [];
    
    if (name.length > 1 && prompt.length > 1) {
        if (acId > 0) {
            const item = configurations.find(it=>it.id==acId);
            if(item){
                item.name = name;
                item.prompt = prompt;
            }
        } else {
            const data = { id: Date.now(), name, prompt };
            configurations.push(data);
        }
        browser.storage.local.set({ [DB_KEY.actionList]: configurations });
    }
  });
}

/**
 * Imports actions from AIdir.
 * @param {object} sd The action data.
 * @returns The session ID from the data.
 */
function importAIdirActions(sd) {
    browser.storage.local.get(DB_KEY.chatTpaList, function (sysp) {
        let configurations = sysp[DB_KEY.chatTpaList] || [];

        const data = { 
            "id": Date.now(), 
            "name": sd.name, 
            "prompt": sd.prompt, 
            "sample": sd.sample 
        };
        if (sd.metac && sd.metac.length > 1) {
            data["metac"] = sd.metac;
        }
        configurations.push(data);
        browser.storage.local.set({ [DB_KEY.chatTpaList]: configurations });
    });
    return sd.sid;
}

/**
 * Main message handler for the background script.
 * @param {object} request The message sent by the calling script.
 * @param {object} sender The sender of the message.
 * @param {function} sendResponse Function to call to send a response.
 * @returns {boolean} True to indicate an asynchronous response.
 */
function handleMessage(request, sender, sendResponse) {

  if (request.action === 'process-insight') {
    const { prompt, doc, msgId } = request;
    
    processInsightForBackground(prompt, doc, {
      onStream: (chunk, full) => {
        sendToContentScript({
          action: "process-insight-stream",
          content: full,
          msgId: msgId
        });
      },
      onComplete: (fullResponse) => {
        sendToContentScript({
          action: "process-insight-stream",
          content: fullResponse,
          msgId: msgId,
          isFinal: true
        });
        
        // Save the insight result to local storage.
        const item = {
          url: doc.url,
          title: doc.title,
          content: fullResponse,
          ctime: new Date().toLocaleString(),
          msgId: msgId
        };
        browser.storage.local.get(DB_KEY.insightList, function (data) {
          let insightList = data[DB_KEY.insightList] || [];
          // Keep a maximum of 100 records.
          if(insightList.length >= 100) {
            insightList.shift();
          }
          insightList.push(item);
          browser.storage.local.set({ [DB_KEY.insightList]: insightList });
        });

        sendResponse({ status: 'completed' });
      },
      onError: (error) => {
        console.error('process-insight error:', error);
        sendToContentScript({
          action: "process-insight-stream",
          content: `Error: ${error.message}`,
          msgId: msgId,
          isFinal: true,
          isError: true
        });
        sendResponse({ status: 'error', error: error.message });
      }
    });

    return true; // Keep the message channel open for an async response.
  }

  if (request.action === "callImportInsightPrompt") {
    const result = importActions(request.data);
    sendResponse({ success: true, data: result });
    return true;
  }

  if (request.action === "callImportAIdirPrompt") {
    const result = importAIdirActions(request.data);
    sendResponse({ success: true, data: result });
    return true;
  }

  if (request.action === 'openOptionsPage') {
    browser.runtime.openOptionsPage();
    return true;
  }

  if (request.action === 'openNewPage') {
    browser.tabs.create({ url: browser.runtime.getURL(request.url)});
    return true;
  }

  if (handleViewerMessage(request, sender)) return true;

  return true; // Indicates an asynchronous response.
}

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender, sendResponse);
    return true;
});
