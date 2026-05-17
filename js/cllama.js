import { TextProcessor } from './text-processor.mjs';
import { ThemeManager } from './theme.mjs';
import { marked } from './marked.mjs';
import { copyToClipboard, thinkCollapseExpanded } from './marked/copy.mjs';
import { balert } from "./dialog.mjs"
import { getServiceInstance } from './client/client.mjs';
import { cloneOllamaOptions, isGemini, removeThinkTags, replaceElementContent, replaceThinkTags } from './util.js';

export const browser = typeof chrome !== 'undefined' ? chrome : browser;
export const isFirefox = navigator.userAgent.indexOf('Firefox') >= 0;

// Default configuration

export const defaultSettings = {
  maxTokens: 30000,
  tranPrompt: browser.i18n.getMessage("tranPrompt").replaceAll("{localLanguage}", browser.i18n.getMessage("localLanguage"))
};

let runtimeConfig = { ...defaultSettings }, chatClient;

/**
 * Loads configuration from browser storage
 * @returns {Promise<void>}
 */
async function loadConfiguration() {
  return new Promise(resolve => {
    browser.storage.local.get([DB_KEY.base, DB_KEY.dsList], data => {
      const conf = data[DB_KEY.base];
      if (conf) {
        runtimeConfig = { ...defaultSettings, ...conf };
      } else {
        runtimeConfig = { ...defaultSettings };
        browser.storage.local.set({ [DB_KEY.base]: defaultSettings });
      }
      runtimeConfig.dsList = data[DB_KEY.dsList] || [];
      resolve();
    });
  });
}

/**
 * Gets or initializes the AI service client
 * @returns {Promise<Object>} Chat client instance
 */
export async function getClientService() {
  if (!chatClient) {
    await loadConfiguration();
    try {
      chatClient = getServiceInstance(runtimeConfig);
    } catch (e) {
      console.warn("Failed to initialize chat client:", e.message);
      chatClient = null;
    }
  }
  return chatClient;
}

/**
 * Gets current runtime configuration
 * @returns {Promise<Object>} Runtime config object
 */
export async function getRuntimeConfig() {
  await loadConfiguration();
  return runtimeConfig;
}

/**
 * Renders markdown content with debouncing
 */
function renderWithDebounce(element, content) {
  replaceElementContent(element, marked.parse(replaceThinkTags(content)));
  copyToClipboard(element);
}

/**
 * Prepares client and message data for insight processing
 * @private
 */
async function _getInsightClientAndData(prompt, doc) {
  await getClientService();

  const insightServiceName = runtimeConfig.insightService;
  let clientService = chatClient;
  let serviceConfig = runtimeConfig;

  if (insightServiceName && runtimeConfig.dsList) {
    const foundConfig = runtimeConfig.dsList.find(item => item.service === insightServiceName);
    if (foundConfig) {
      clientService = getServiceInstance(foundConfig);
      serviceConfig = foundConfig;
    }
  }
  const isGoogle = isGemini(serviceConfig);

  let msgData;
  if (prompt.indexOf("${doc.") > 0) {
    msgData = [{ role: 'user', content: TextProcessor.renderTemplate(prompt, doc) }];
  } else {
    if (isGoogle) {
      msgData = [{
        role: 'user',
        parts: [
          { text: prompt },
          { text: `${doc.title}\n${doc.content}` }
        ]
      }];
    } else {
      msgData = [
        { role: 'system', content: prompt },
        { role: 'user', content: `${doc.title}\n${doc.content}` }
      ];
    }
  }
  return { clientService, msgData };
}

/**
 * Processes insight request for background script
 * @param {string} prompt - System or user prompt
 * @param {Object} doc - Document with title and content
 * @param {Object} options - Callback options (onStream, onComplete, onError)
 */
export async function processInsightForBackground(prompt, doc, options) {
  const { clientService, msgData } = await _getInsightClientAndData(prompt, doc);
  clientService.sendRequest(msgData, {
    onStream: options.onStream,
    onComplete: options.onComplete,
    onError: options.onError
  });
}

/**
 * Processes insight request with UI rendering
 * @param {string} prompt - System or user prompt
 * @param {Object} doc - Document with title and content
 * @param {string} msgId - Target element ID for rendering
 * @param {Object} options - Callback options
 */
export async function processInsight(prompt, doc, msgId, options) {
  const target = document.getElementById(msgId);
  if (!target) {
    console.error(`processInsight target element with ID "${msgId}" not found.`);
    return;
  }

  const { clientService, msgData } = await _getInsightClientAndData(prompt, doc);

  clientService.sendRequest(msgData, {
    onStream: (chunk, full) => renderWithDebounce(target, full),
    onComplete: (fullResponse, id) => {
      renderWithDebounce(target, fullResponse);
      typeof options?.finish === 'function' && options.finish(fullResponse);
    },
    onError: (error, id) => typeof options?.error === 'function' && options.error(error, id)
  });
}

/**
 * Handles chat conversation with streaming responses
 * @param {Array} historyMessages - Conversation history
 * @param {Object} options - Configuration including msgDiv, messages container, callbacks
 * @returns {Promise} Response promise
 */
export async function chat(historyMessages, options) {
  const msgDiv = options["msgDiv"];
  const messages = options["messages"];
  const clientService = await getClientService();

  if (historyMessages == null || historyMessages.length < 1) {
    return;
  }

  let msgs = [];
  const isOllama = runtimeConfig.service == "ollama";
  const isGoogle = isGemini(runtimeConfig);

  // Format messages based on service type
  if (isGoogle) {
    let systemContentBuffer = '';
    const tempMsgs = [];

    for (const m of historyMessages) {
      if (m.role === 'system') {
        systemContentBuffer += (systemContentBuffer ? '\n\n' : '') + removeThinkTags(m.content);
        continue;
      }

      let role = m.role === 'assistant' ? 'model' : m.role;
      let content = removeThinkTags(m.content);
      
      if (role === 'user' && systemContentBuffer) {
        content = systemContentBuffer + '\n\n' + content;
        systemContentBuffer = '';
      }

      tempMsgs.push({ role, content, images: m.images });
    }

    // Merge consecutive messages from same role
    if (tempMsgs.length > 0) {
      const mergedMsgs = [];
      let lastMsg = null;

      for (const msg of tempMsgs) {
        if (lastMsg && lastMsg.role === msg.role) {
          if (typeof lastMsg.content === 'string' && typeof msg.content === 'string' && !lastMsg.images && !msg.images) {
            lastMsg.content += '\n\n' + msg.content;
          } else {
            mergedMsgs.push(lastMsg);
            lastMsg = msg;
          }
        } else {
          if (lastMsg) mergedMsgs.push(lastMsg);
          lastMsg = { ...msg };
        }
      }
      if (lastMsg) mergedMsgs.push(lastMsg);

      // Convert to Gemini format with parts
      mergedMsgs.forEach(m => {
        const parts = [{ text: m.content }];
        if (m.images) {
          m.images.forEach(imgDataUrl => {
            const match = imgDataUrl.match(/^data:(.*?);base64,(.*)$/);
            if (match) {
              parts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2]
                }
              });
            }
          });
        }
        msgs.push({ role: m.role, parts: parts });
      });
    }
  } else {
    // OpenAI/Ollama format
    historyMessages.forEach(m => {
      const msg = { role: m.role, content: removeThinkTags(m.content) };
      if (m.images) {
        if (isOllama) {
          msg.images = m.images.map(item => item.split(',')[1]);
        } else {
          msg.content = [{ type: "text", text: msg.content }];
          m.images.forEach(imgUrl => {
            msg.content.push({ type: "image_url", image_url: { url: imgUrl } });
          });
        }
      }
      msgs.push(msg);
    });
  }

  const ops = cloneOllamaOptions(options);

  const response = await clientService.sendRequest(msgs, {
    model: options?.model,
    options: ops,
    onStart: () => {
      typeof options?.start === 'function' && options.start();
    },
    onStream: (_, full, sessionId) => {
      if (options.stop()) {
        clientService.abort(sessionId);
        typeof options?.finish === 'function' && options.finish();
        historyMessages.pop();
        return;
      }
      renderWithDebounce(msgDiv, full);
      if (!options?.stopScroll())
        messages.scrollTop = messages.scrollHeight;
    },
    onComplete: (fullResponse, id) => {
      renderWithDebounce(msgDiv, fullResponse);
      thinkCollapseExpanded(msgDiv);
      historyMessages.push({ role: 'assistant', content: fullResponse, rtime: Date.now() });
      typeof options?.finish === 'function' && options.finish(historyMessages);
    },
    onError: (error, id) => {
      if (error.name !== 'AbortError')
        balert(`[${id}] Error:${error}`, { title: "Error" });
    }
  });
  return response;
}

/**
 * Translates text using configured translation service
 * @param {string} input - Text to translate
 * @param {Function} callback - Callback receiving translated chunks
 * @param {Object} options - Additional options including stop flag
 */
export async function translate(input, callback, options) {
  await getClientService();

  const tranServiceName = runtimeConfig.tranService;
  let clientService = chatClient;
  let serviceConfig = runtimeConfig;

  if (tranServiceName && runtimeConfig.dsList) {
    const foundConfig = runtimeConfig.dsList.find(item => item.service === tranServiceName);
    if (foundConfig) {
      clientService = getServiceInstance(foundConfig);
      serviceConfig = foundConfig;
    }
  }
  
  const isGoogle = isGemini(serviceConfig);
  let messages;
  if (isGoogle) {
    messages = [{
      role: 'user',
      parts: [
        { text: runtimeConfig.tranPrompt },
        { text: input }
      ]
    }];
  } else {
    messages = [
      { role: 'system', content: runtimeConfig.tranPrompt },
      { role: 'user', content: input }
    ];
  }
  
  clientService.sendRequest(messages, {
    onStream: (_, full) => {
      callback(full);
      if (options?.stop()) {
        clientService.abortAllSessions();
      }
    },
    onComplete: (fullResponse, id) => {
      callback(removeThinkTags(fullResponse));
    }
  });
}

/**
 * Fetches available models from the service
 * @returns {Promise<Array>} List of available models
 */
export async function getModels() {
  await getClientService();
  return chatClient.getModels();
}

/**
 * Aborts a specific chat session
 * @param {string} sessionId - Session ID to abort
 */
export async function abortSession(sessionId) {
  const clientService = await getClientService();
  clientService.abort(sessionId);
}

/**
 * Applies i18n translations to elements with 'i18n' class
 * Supports text content and attribute translation
 */
export function i18n() {
  document.querySelectorAll('.i18n').forEach(el => {
    const attr = el.getAttribute("i18n") || 'text';
    const key = attr === 'text' ? el.textContent : el.getAttribute(attr);
    if (!key) return;

    const localized = browser.i18n.getMessage(key);
    if (localized) {
      attr === 'text' ? (el.textContent = localized) : el.setAttribute(attr, localized);
    }
  });
}

// Browser storage keys
export const DB_KEY = {
  base: "base",
  urls: "urls",
  actionList: "actionList",
  chatTpaList: "chatTpaList",
  insightList: "insightList",
  dsList: "dsList",
  apiConfig: "apiConfig",
  fishIconActive: "fishIconActive"
};

// Initialize theme system for extension pages
if (browser.extension && browser.extension.getBackgroundPage)
  window.themeManager = new ThemeManager();