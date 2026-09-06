import { browser, isFirefox } from './browser.mjs';
import { TextProcessor } from "./text-processor.mjs";

/**
 * Sends a message to the content script in the active tab
 * @param {Object} message - Message object with action and optional data
 * @returns {Promise} Resolves with the response from content script
 */
export function sendToContentScript(message) {
  return new Promise((resolve, reject) => {
    if (typeof message !== 'object' || message === null) {
      reject(new TypeError('Message must be an object'));
      return;
    }
    if (typeof message.action !== 'string' || message.action.trim() === '') {
      reject(new TypeError('message.action must be a non-empty string'));
      return;
    }

    browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (browser.runtime?.lastError) {
        reject(new Error(browser.runtime.lastError.message || 'Failed to query tabs'));
        return;
      }

      if (!tabs?.[0]?.id) {
        reject(new Error('No active tab found'));
        return;
      }

      if (isFirefox) {
        browser.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (browser.runtime?.lastError) {
            reject(new Error(browser.runtime.lastError.message || 'Message failed to send'));
            return;
          }
          resolve(response);
        });
      } else {
        browser.tabs.sendMessage(tabs[0].id, message)
          .then(resolve)
          .catch(reject);
      }
    });
  });
}

/**
 * Checks if an element has a specific CSS class
 * @param {HTMLElement} element - Element to check
 * @param {string} className - Class name to look for
 * @returns {boolean} True if element has the class
 */
export function hasClass(element, className) {
  if (!element) return false;
  
  const cls = className || '';
  if (cls.replace(/\s/g, '').length === 0) {
    return false;
  }
  
  return new RegExp(' ' + cls + ' ').test(' ' + element.className + ' ');
}

/**
 * Removes a CSS class from an element
 * @param {HTMLElement} element - Element to modify
 * @param {string} className - Class name to remove
 */
export function removeClass(element, className) {
  if (!hasClass(element, className)) return;
  
  let newClass = ' ' + element.className.replace(/[\t\r\n]/g, '') + ' ';
  while (newClass.indexOf(' ' + className + ' ') > -1) {
    newClass = newClass.replace(' ' + className + ' ', ' ');
  }
  element.className = newClass.trim();
}

/**
 * Adds a CSS class to an element if it doesn't already have it
 * @param {HTMLElement} element - Element to modify
 * @param {string} className - Class name to add
 */
export function addClass(element, className) {
  if (hasClass(element, className)) return;
  
  element.className = element.className === '' 
    ? className 
    : element.className + ' ' + className;
}

/**
 * Gets a URL query parameter by name
 * @param {string} paramName - Name of the parameter
 * @returns {string|null} Parameter value or null if not found
 */
export const getQueryParam = (paramName) =>
  paramName ? new URLSearchParams(window.location.search).get(paramName) : null;

/**
 * Replaces the content of target element(s) with new content
 * @param {HTMLElement|string} target - Element or selector
 * @param {string|Function} content - HTML string or function that returns DOM element
 * @returns {boolean} True if replacement succeeded
 */
export function replaceElementContent(target, content) {
  try {
    const parent = target.parentElement || document.body;
    const elements = target instanceof Element 
      ? [target] 
      : [...parent.querySelectorAll(target)];
    
    if (!elements.length) return false;

    const createContent = typeof content === 'function' 
      ? content 
      : () => {
          const doc = new DOMParser().parseFromString(`<div>${content}</div>`, 'text/html');
          return doc.body.firstChild.cloneNode(true);
        };

    elements.forEach(el => el.replaceChildren(createContent()));
    return true;
  } catch (error) {
    console.error('Content replacement failed:', error);
    return false;
  }
}

/**
 * Adjusts message array to fit within token limit by removing or truncating messages
 * @param {Array} messages - Array of message objects with role and content
 * @param {number} maxTokens - Maximum allowed tokens
 * @returns {Array} Adjusted messages array
 */
export function adjustMessagesToTokenLimit(messages, maxTokens) {
  const calculateTotalTokens = (msgs) => {
    return msgs.reduce((total, msg) => {
      return total + TextProcessor.estimateTokens(`${msg.role}\n${msg.content}`);
    }, 0);
  };

  const adjustedMessages = [...messages];
  let totalTokens = calculateTotalTokens(adjustedMessages);

  if (totalTokens <= maxTokens) {
    return adjustedMessages;
  }

  const hasSystemFirst = adjustedMessages[0]?.role === 'system';
  const minMessagesToKeep = hasSystemFirst ? 2 : 1;

  // Remove oldest messages until within limit
  while (totalTokens > maxTokens && adjustedMessages.length > minMessagesToKeep) {
    const removeIndex = hasSystemFirst ? 1 : 0;
    const removed = adjustedMessages.splice(removeIndex, 1)[0];
    totalTokens -= TextProcessor.estimateTokens(`${removed.role}\n${removed.content}`);
  }

  // Truncate last message if still over limit
  if (totalTokens > maxTokens && adjustedMessages.length >= minMessagesToKeep) {
    const lastMsg = adjustedMessages[adjustedMessages.length - 1];
    const lastMsgTokenCount = TextProcessor.estimateTokens(`${lastMsg.role}\n${lastMsg.content}`);
    const availableTokens = maxTokens - (totalTokens - lastMsgTokenCount);

    if (availableTokens > 0) {
      const roleTokenCount = TextProcessor.estimateTokens(`${lastMsg.role}\n`);
      const contentMaxTokens = Math.max(1, availableTokens - roleTokenCount);
      lastMsg.content = TextProcessor.truncateToTokens(lastMsg.content, contentMaxTokens);
      return adjustedMessages;
    }
  }

  return adjustedMessages.length >= minMessagesToKeep ? adjustedMessages : [];
}

/**
 * Escapes HTML special characters in a string
 * @param {string} html - String to escape
 * @returns {string} Escaped HTML string
 */
export function htmlEncode(html) {
  const temp = document.createElement("div");
  temp.textContent = html;
  const output = temp.innerHTML;
  return output;
}

/**
 * Checks if the config is for Google Gemini service
 * @param {Object} config - Configuration object with service and apiUrl
 * @returns {boolean} True if Gemini service
 */
export function isGemini(config) {
  if (!config) return false;
  
  const service = config.service?.toLowerCase();
  return (service === "google" || service === "test") 
    && !config.apiUrl.endsWith("chat/completions");
}

/**
 * Gets the appropriate language code for the user's locale
 * @returns {string} Language code with underscore separator
 */
export function getLanguageCode() {
  const supportedLocales = [
    'zh-CN', 'de', 'en', 'fr', 'pt-BR', 
    'pt-PT', 'ja', 'ru', 'es', 'tr', 
    'vi', 'th', 'ko', 'id'
  ];

  const userLang = browser.i18n.getUILanguage();

  // Check for exact or prefix match
  for (const locale of supportedLocales) {
    if (userLang.startsWith(locale)) {
      return locale.replace("-", "_");
    }
  }

  // Handle Chinese variants
  if (/zh/i.test(userLang)) {
    return 'zh_Hant';
  }

  // Handle Portuguese variants
  if (/pt/i.test(userLang)) {
    return userLang.startsWith('pt-BR') ? 'pt_BR' : 'pt_PT';
  }

  return 'en';
}

/**
 * Opens HTML content in a new browser tab
 * @param {string} htmlString - HTML content to display
 * @param {string} [title='New Page'] - Page title
 */
export function openHtmlInNewTab(htmlString, title = 'New Page') {
  browser.runtime.sendMessage({
    action: 'openHtmlInNewTab',
    data: { htmlString, title }
  });
}

/**
 * Finds the first parent node matching any of the given selectors
 * @param {HTMLElement} node - Starting node
 * @param {...string} selectors - CSS selectors to match
 * @returns {HTMLElement|null} Matching parent node or null
 */
export function findMatchingParentNode(node, ...selectors) {
  const combinedSelector = selectors.join(', ');

  while (node?.parentNode && node.parentNode !== document.body.parentNode) {
    if (node.parentNode.matches(combinedSelector)) {
      return node.parentNode;
    }
    node = node.parentNode;
  }
  
  return null;
}

/**
 * Replaces <think> tags with div elements with class "think"
 * @param {string} inputText - Text containing <think> tags
 * @returns {string} Text with replaced tags
 */
export function replaceThinkTags(inputText) {
  if (typeof inputText !== 'string' || inputText.length === 0) {
    return inputText;
  }

  return inputText
    .replace(/<\/think>/g, '</div>')
    .replace(/<think>/g, '<div class="think">');
}

/**
 * Removes all <think> tags and their content from a string
 * @param {string} str - String to process
 * @returns {string} String with <think> sections removed
 */
export function removeThinkTags(str) {
  if (!str) return "";
  
  const regex = /<think>[\s\S]*?<\/think>/g;
  return str.replace(regex, "");
}

/**
 * Exports data as a downloadable file
 * @param {string} data - Data to export
 * @param {string} format - File format/extension
 * @param {string} [fileName] - Optional filename (auto-generated if not provided)
 */
export function exportFile(data, format, fileName) {
  const blob = new Blob([data], { type: `application/${format}` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  
  link.href = url;
  link.download = fileName || `${Date.now()}.${format}`;
  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Clones specific properties from an object
 * @param {Object} original - Source object
 * @param {Array<string>} properties - Properties to clone
 * @returns {Object} New object with cloned properties
 */
function cloneProperties(original, properties) {
  const clonedObject = {};
  properties.forEach(property => {
    if (original.hasOwnProperty(property)) {
      clonedObject[property] = original[property];
    }
  });
  return clonedObject;
}

/**
 * Clones Ollama-specific options from a config object
 * @param {Object} options - Source options object
 * @returns {Object} Object with only Ollama options
 */
export function cloneOllamaOptions(options) {
  const props = [
    "num_keep", "num_predict", "seed", "top_k", "top_p", 
    "min_p", "think", "repeat_last_n", "temperature", 
    "num_ctx", "stop"
  ];
  return cloneProperties(options, props);
}

/**
 * Formats a timestamp as a readable time string
 * Returns "HH:mm" for today's timestamps, "YYYY-MM-DD HH:mm" for other dates
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string} Formatted time string
 */
export function formatTimestamp(timestamp) {
  const date = new Date(timestamp);

  if (isNaN(date.getTime())) {
    return 'Invalid Date';
  }

  const now = new Date();
  const padZero = (num) => num < 10 ? '0' + num : num;

  const isToday = 
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const hours = padZero(date.getHours());
  const minutes = padZero(date.getMinutes());

  if (isToday) {
    return `${hours}:${minutes}`;
  }

  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1);
  const day = padZero(date.getDate());
  
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Detects if the current device is a mobile device
 * @returns {boolean} True if mobile device
 */
export function isMobile() {
  if (navigator.userAgentData?.mobile) {
    return true;
  }

  const userAgent = (navigator.userAgent || navigator.vendor || window.opera).toLowerCase();
  return /android|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
}