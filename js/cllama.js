import { browser } from './browser.mjs';
import { TextProcessor } from './text-processor.mjs';
import { ThemeManager } from './theme.mjs';
import { marked } from './marked.mjs';
import { copyToClipboard, thinkCollapseExpanded } from './marked/copy.mjs';
import { balert } from "./dialog.mjs"
import { getServiceInstance } from './client/client.mjs';
import { cloneOllamaOptions, isGemini, removeThinkTags, replaceElementContent, replaceThinkTags } from './util.js';
import { parseToolCalls, stripToolCalls, executeToolCall, buildSkillSystemMessage, buildToolInstructions, buildNativeTools, runTool, SKILL_TOOL_MAX_ITER } from './skill-tools.mjs';


// Default configuration

export const defaultSettings = {
  maxTokens: 30000,
  tranPrompt: browser.i18n.getMessage("tranPrompt").replaceAll("{localLanguage}", browser.i18n.getMessage("localLanguage")),
  tranThink: false,
  tranTemperature: 0.7,
  tranTopP: 0.9,
  insightThink: false,
  insightTemperature: 0.7,
  insightTopP: 0.9
};

let runtimeConfig = { ...defaultSettings }, chatClient;
let _configManuallySet = false;

// Per-model cache: whether injecting a skill as a "system" message is usable.
// undefined/absent => assume usable; set to false after a failed attempt, so
// that model falls back to user injection without re-triggering EOF.
const skillSystemCache = new Map();
let _skillCacheLoaded = false;

// Native function definition for the model to adopt a Skill on demand. Only
// offered in "Auto" mode on backends with native function calling.
const USE_SKILL_TOOL = {
  type: 'function',
  function: {
    name: 'use_skill',
    description: "Activate one of the available Skills by its exact name so that its instructions and tools become usable. Call it before using that Skill's tools.",
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The exact name of the Skill to activate' } },
      required: ['name']
    }
  }
};

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
 * Switches runtime configuration to a different data source at runtime
 * Resets the cached chat client so next call reinitialises with new config
 * @param {Object} config - The new data source configuration
 */
export function setRuntimeConfig(config) {
  if (!config || !config.service || !config.apiUrl) {
    console.warn("setRuntimeConfig: invalid config", config);
    return;
  }
  // Merge into existing runtimeConfig, preserving other settings
  runtimeConfig.service = config.service;
  runtimeConfig.apiUrl = config.apiUrl;
  runtimeConfig.apiKey = config.apiKey || "-";
  runtimeConfig.modelName = config.modelName || runtimeConfig.modelName;
  // Reset the cached client so it will be re-initialized
  chatClient = null;
  _configManuallySet = true;
}

/**
 * Gets or initializes the AI service client
 * @returns {Promise<Object>} Chat client instance
 */
export async function getClientService() {
  if (!chatClient) {
    if (!_configManuallySet) {
      await loadConfiguration();
    }
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
  const ops = { temperature: runtimeConfig.insightTemperature, top_p: runtimeConfig.insightTopP, think: runtimeConfig.insightThink };
  clientService.sendRequest(msgData, {
    options: ops,
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
  const ops = { temperature: runtimeConfig.insightTemperature, top_p: runtimeConfig.insightTopP, think: runtimeConfig.insightThink };

  clientService.sendRequest(msgData, {
    options: ops,
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

  const modelKey = options?.model || runtimeConfig.modelName || 'default';
  // Load persisted "system disabled" model list into the in-memory cache once.
  await loadSkillSystemCache();
  let skillUsedSystem = false;

  // Decide the skill mode and tool-calling strategy.
  // - activeSkill set             => user forced that one Skill (use it only).
  // - activeSkill null & skills[] => "Auto": the model may call use_skill() to
  //   adopt a Skill on demand — via native function-calling on Ollama, or via
  //   the text <tool_call> protocol on any other backend (adoptedSkill below).
  const activeSkill = options?.activeSkill || null;
  let adoptedSkill = null; // Skill the model adopts mid-turn in Auto mode
  const autoSkills = (!activeSkill && Array.isArray(options?.skills) && options.skills.length) ? options.skills : null;
  const skillHasTools = activeSkill && Array.isArray(activeSkill.tools) && activeSkill.tools.length;

  let useNativeTools = false;
  let nativeTools = [];
  if (runtimeConfig.service === 'ollama' && typeof clientService.hasNativeTools === 'function') {
    if (skillHasTools || autoSkills) {
      useNativeTools = await clientService.hasNativeTools(options?.model);
      if (useNativeTools) {
        // Auto exposes only use_skill first; a forced Skill exposes its tools.
        nativeTools = activeSkill ? buildNativeTools(activeSkill) : [USE_SKILL_TOOL];
      }
    }
  }

  // Build the text to inject. Prefer a real "system" message only when a skill
  // is forced and the model tolerates system; Auto always merges into a user
  // message to avoid EOF on qwen3-style models.
  let injectText = '';
  // Prefer a real "system" message on non-Google backends when the model is
  // known to tolerate it; otherwise merge into the first user message. We
  // default to system and only fall back to user per-model (cache) or after a
  // failed attempt (see catch) — including in Auto mode.
  const allowSystemForInject = !isGoogle && skillSystemCache.get(modelKey) !== false;
  if (activeSkill) {
    injectText = useNativeTools ? (activeSkill.prompt || '') : buildSkillSystemMessage(activeSkill);
  } else if (autoSkills) {
    const lines = autoSkills.map(s => `- ${s.name}: ${s.description || ''}`).join('\n');
    if (useNativeTools) {
      injectText = 'Available Skills:\n' + lines + '\n\nTo use a Skill, call the use_skill tool with its exact name, then follow its instructions and call its tools.';
    } else {
      // Text-protocol Auto mode (non-Ollama backends or models without native
      // tools): tell the model how to adopt a Skill through <tool_call> syntax.
      injectText = 'Available Skills:\n' + lines +
        '\n\nIf one of the Skills above is relevant to the user request, do not answer yet. ' +
        'Instead reply with exactly one line:\n' +
        '<tool_call><tool_name>use_skill</tool_name><args>{"name":"EXACT_SKILL_NAME"}</args></tool_call>\n' +
        'Then STOP and wait for the result, and follow the Skill instructions it returns.';
    }
  }
  if (injectText) {
    if (isGoogle) {
      msgs.unshift({ role: 'user', parts: [{ text: injectText }] });
    } else if (allowSystemForInject) {
      msgs.unshift({ role: 'system', content: injectText });
      skillUsedSystem = true;
    } else {
      const firstUser = msgs.findIndex(m => m.role === 'user' && typeof m.content === 'string');
      if (firstUser >= 0) {
        msgs[firstUser] = { ...msgs[firstUser], content: injectText + '\n\n' + msgs[firstUser].content };
      } else {
        msgs.unshift({ role: 'user', content: injectText });
      }
    }
  }

  // Tool-call loop: send a request, and if the model requests tools, execute
  // them and feed the results back until we get a final answer.
  let finalResponse = '';
  for (let step = 0; step <= SKILL_TOOL_MAX_ITER; step++) {
    let full = '';
    let lastToolCalls = null;
    try {
      // Await the full sendRequest (including its internal cleanup/finally)
      // so the underlying connection is fully released BEFORE the next request
      // is issued.
      const requestPromise = clientService.sendRequest(msgs, {
        model: options?.model,
        options: ops,
        tools: useNativeTools ? nativeTools : undefined,
        onStart: () => {
          typeof options?.start === 'function' && options.start();
        },
        onStream: (_, text, sessionId) => {
          if (options.stop()) {
            clientService.abort(sessionId);
            typeof options?.finish === 'function' && options.finish();
            full = text;
            return;
          }
          renderWithDebounce(msgDiv, stripToolCalls(text));
          if (!options?.stopScroll())
            messages.scrollTop = messages.scrollHeight;
        },
        onComplete: (text, id, toolCalls) => {
          renderWithDebounce(msgDiv, stripToolCalls(text));
          thinkCollapseExpanded(msgDiv);
          full = text;
          lastToolCalls = toolCalls || null;
        },
        onError: (error, id) => {
          if (error.name !== 'AbortError')
            balert(`[${id}] Error:${error}`, { title: "Error" });
        }
      });
      await requestPromise;
    } catch (err) {
      // First request failed while the skill was injected as a "system" message:
      // fall back to user injection for this model and retry once (some
      // Ollama/qwen3 models return EOF on an independent system message).
      if (step === 0 && skillUsedSystem && skillSystemCache.get(modelKey) !== false) {
        skillSystemCache.set(modelKey, false);
        persistSkillDisabled();
        console.warn(`[skill] system injection failed for "${modelKey}", retrying as user:`, err);
        return chat(historyMessages, options);
      }
      // A transport/stream error (e.g. Ollama "ResponseError: EOF"). Show an
      // error and stop gracefully instead of throwing an uncaught promise.
      if (err.name !== 'AbortError') {
        console.error('Chat request error:', err);
        replaceElementContent(msgDiv, browser.i18n.getMessage("cllamaError"));
      }
      if (!options.stop()) typeof options?.finish === 'function' && options.finish(historyMessages);
      break;
    }

    // If the request was stopped mid-stream, do not continue the tool loop.
    if (options.stop()) break;

    // Native function-calling path (Ollama models with tools capability).
    if (useNativeTools && lastToolCalls && lastToolCalls.length && step < SKILL_TOOL_MAX_ITER) {
      const results = [];
      for (const tc of lastToolCalls) {
        const fname = tc.function?.name;
        let fargs = tc.function?.arguments;
        if (typeof fargs === 'string') {
          try { fargs = JSON.parse(fargs); } catch (e) { fargs = {}; }
        }

        // Auto mode: the model may call use_skill(name) to adopt a Skill. When
        // it does, swap the offered tools to that Skill's tools and feed the
        // Skill's instructions back so the model can continue using them.
        if (autoSkills && fname === 'use_skill') {
          const wanted = String(fargs?.name || '').trim();
          const matched = autoSkills.find(s => String(s.name).toLowerCase() === wanted.toLowerCase());
          if (matched) {
            nativeTools = buildNativeTools(matched);
            results.push({
              tool_name: 'use_skill',
              content: `Skill activated: ${matched.name}.\nInstructions: ${matched.prompt || ''}\nYou may now use its tools.`
            });
          } else {
            results.push({
              tool_name: 'use_skill',
              content: `Unknown Skill "${wanted}". Available: ${autoSkills.map(s => s.name).join(', ')}.`
            });
          }
          continue;
        }

        replaceElementContent(msgDiv, `🔧 running ${fname}...`);
        const resultText = await runTool(fname, fargs || {}, activeSkill);
        results.push({ tool_name: fname, content: resultText });
      }
      msgs.push({ role: 'assistant', content: full, tool_calls: lastToolCalls });
      for (const r of results) msgs.push({ role: 'tool', content: r.content, tool_name: r.tool_name });
      continue;
    }

    // Text-protocol path (models without native tools). Enabled whenever a Skill
    // is forced, or in Auto mode (where the model may first call use_skill to
    // adopt a Skill, then call that Skill's tools).
    const canTextTools = !useNativeTools && (activeSkill || autoSkills);
    const calls = canTextTools ? parseToolCalls(full) : [];
    if (calls.length && step < SKILL_TOOL_MAX_ITER) {
      const results = [];
      for (const call of calls) {
        replaceElementContent(msgDiv, `🔧 running ${call.name}...`);
        let resultText;
        if (!activeSkill && autoSkills && call.name === 'use_skill') {
          // Auto text-protocol adoption: swap to the matched Skill and feed its
          // instructions + tool list back so the model can continue using them.
          const wanted = String(call.args?.name || '').trim();
          const matched = autoSkills.find(s => String(s.name).toLowerCase() === wanted.toLowerCase());
          if (matched) {
            adoptedSkill = matched;
            let output = `Skill activated: ${matched.name}.`;
            if (matched.prompt) output += `\n\nInstructions:\n${matched.prompt}`;
            const toolsPart = buildToolInstructions(matched);
            if (toolsPart) output += `\n\n${toolsPart}`;
            resultText =
              `<tool_result>\n<tool_name>use_skill</tool_name>\n<success>true</success>\n<output>` +
              output + `\n</output>\n</tool_result>`;
          } else {
            const avail = autoSkills.map(s => s.name).join(', ');
            resultText =
              `<tool_result>\n<tool_name>use_skill</tool_name>\n<success>false</success>\n<output>` +
              `Unknown Skill "${wanted}". Available: ${avail}.\n</output>\n</tool_result>`;
          }
        } else {
          resultText = await executeToolCall(call, activeSkill || adoptedSkill || null);
        }
        results.push(resultText);
      }
      const toolResultContent = results.join('\n\n');
      if (isGoogle) {
        msgs.push({ role: 'model', parts: [{ text: full }] });
        msgs.push({ role: 'user', parts: [{ text: toolResultContent }] });
      } else {
        msgs.push({ role: 'assistant', content: full });
        msgs.push({ role: 'user', content: toolResultContent });
      }
      continue;
    }

    finalResponse = stripToolCalls(full);
    break;
  }

  if (!options.stop()) {
    historyMessages.push({ role: 'assistant', content: finalResponse, rtime: Date.now() });
    typeof options?.finish === 'function' && options.finish(historyMessages);
  }
  return finalResponse;
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

/**
 * Load default action list from language-specific JSON file.
 * Falls back through: current language → short language code → English → empty array
 * @returns {Promise<Array>} Array of default action objects
 */
export async function loadDefaultActions() {
    const uiLang = browser.i18n.getUILanguage();
    const underscore = uiLang.replace(/-/g, '_');  // "zh-CN" → "zh_CN", "en" → "en"
    const shortCode = underscore.split('_')[0];     // "zh_CN" → "zh", "en" → "en"

    const candidates = [...new Set([underscore, shortCode, 'en'])];

    for (const lang of candidates) {
        const url = browser.runtime.getURL(`/init/insightify/actions_${lang}.json`);
        try {
            const resp = await fetch(url);
            if (resp.ok) return await resp.json();
        } catch (e) {
            // Try next candidate
        }
    }
    return [];
}

/**
 * Substitute Claude-style argument placeholders in a Skill prompt.
 *
 * Supported placeholders (mirroring the Agent Skills convention):
 *   - `$ARGUMENTS`      -> the whole argument string (everything after the name)
 *   - `$ARGUMENTS[N]`   -> the Nth whitespace-separated token (0-based)
 *   - `$N`              -> shorthand for `$ARGUMENTS[N]` (also 0-based)
 *
 * An indexed placeholder with no token at that position is left as literal text
 * (so prompts that also use `$ARGUMENTS` still receive the full text).
 *
 * @param {string} prompt - Skill prompt text.
 * @param {string|undefined} args - Raw argument string after the skill name.
 * @returns {string} The prompt with placeholders substituted.
 */
export function applySkillArguments(prompt = '', args) {
  if (typeof prompt !== 'string' || !prompt) return prompt || '';
  const argText = (args === undefined || args === null) ? '' : String(args).trim();
  const tokens = argText ? argText.split(/\s+/) : [];

  let out = prompt.replace(/\$ARGUMENTS(?:\[(\d+)\])?/g, (_m, idx) => {
    if (idx === undefined) return argText;             // $ARGUMENTS -> whole text
    const n = parseInt(idx, 10);
    return tokens[n] !== undefined ? tokens[n] : _m;   // absent -> keep literal
  });
  out = out.replace(/\$(\d+)\b/g, (_m, num) => {
    const n = parseInt(num, 10);
    return tokens[n] !== undefined ? tokens[n] : _m;
  });
  return out;
}

// Default skills used when the user has not configured any.
export const SKILL_DEFAULTS = [
  {
    id: 'general-helper',
    name: browser.i18n.getMessage('skillDefaultGeneralHelper'),
    description: browser.i18n.getMessage('skillDefaultGeneralHelperDesc'),
    prompt: 'Answer the user\'s questions based on the current webpage. Its content (title, URL, text) is provided in the conversation — use it as the primary source. If that content is missing, or you need the latest page text, first call the get_page_content tool, then answer from its result. Be concise and accurate; refer to the page when it helps.',
    tools: [{ name: 'get_page_content', args: {} }, { name: 'current_time', args: {} }, { name: 'echo', args: {} }],
    usePage: true
  },
  {
    id: 'date-time',
    name: browser.i18n.getMessage('skillDefaultDateTime') || 'Date & Time',
    description: browser.i18n.getMessage('skillDefaultDateTimeDesc') || 'Answers questions about the current date, time and weekday.',
    prompt: 'You are a date & time assistant. Whenever the user asks about the current time, date or weekday, call the current_time tool and answer from its result (mention the weekday when relevant). Do not guess the current time.',
    tools: [{ name: 'current_time', args: {} }]
  }
];

/**
 * Load the list of skills from storage (fallback to defaults).
 * @returns {Promise<Array>} Array of skill objects
 */
export function loadSkills() {
  return new Promise((resolve) => {
    browser.storage.local.get(DB_KEY.skillList, (data) => {
      const stored = data[DB_KEY.skillList];
      resolve(stored && stored.length ? stored : SKILL_DEFAULTS);
    });
  });
}

/**
 * Persist the list of skills to storage.
 * @param {Array} skills - Skill objects
 * @returns {Promise<void>}
 */
export function saveSkills(skills) {
  return new Promise((resolve) => browser.storage.local.set({ [DB_KEY.skillList]: skills }, resolve));
}

/**
 * Find a skill by id.
 * @param {string} id - Skill id
 * @returns {Promise<Object|null>}
 */
export async function getSkillById(id) {
  const skills = await loadSkills();
  return skills.find((s) => String(s.id) === String(id)) || null;
}

/**
 * Load the persisted list of models for which system injection is disabled into
 * the in-memory skillSystemCache. Runs at most once per module load.
 * @returns {Promise<void>}
 */
async function loadSkillSystemCache() {
  if (_skillCacheLoaded) return;
  _skillCacheLoaded = true;
  try {
    const d = await browser.storage.local.get(DB_KEY.skillSystemDisabled);
    const arr = d[DB_KEY.skillSystemDisabled];
    if (Array.isArray(arr)) {
      skillSystemCache.clear();
      arr.forEach((k) => skillSystemCache.set(k, false));
    }
  } catch (e) {
    // Ignore: fall back to empty in-memory cache.
  }
}

/**
 * Persist the current "system disabled" model list to storage so the decision
 * survives page reloads / Service Worker restarts.
 */
function persistSkillDisabled() {
  const arr = Array.from(skillSystemCache.keys());
  browser.storage.local.set({ [DB_KEY.skillSystemDisabled]: arr });
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
  fishIconActive: "fishIconActive",
  pendingInsight: "pendingInsight",
  skillList: "skillList",
  skillSystemDisabled: "skillSystemDisabled"
};

// Initialize theme system for extension pages
if (browser.extension && browser.extension.getBackgroundPage)
  window.themeManager = new ThemeManager();