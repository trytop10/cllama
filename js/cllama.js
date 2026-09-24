import { browser } from './browser.mjs';
import { TextProcessor } from './text-processor.mjs';
import { ThemeManager } from './theme.mjs';
import { marked } from './marked.mjs';
import { copyToClipboard, thinkCollapseExpanded } from './marked/copy.mjs';
import { balert } from "./dialog.mjs"
import { getServiceInstance } from './client/client.mjs';
import { cloneOllamaOptions, isGemini, removeThinkTags, replaceElementContent, replaceThinkTags } from './util.js';
import { parseToolCalls, parseToolCallsDetailed, stripToolCalls, executeToolCall, buildSkillSystemMessage, buildToolInstructions, buildNativeTools, runTool, getMcpReady, listTools, registerTool, getTool, previewToolArgs, SKILL_TOOL_MAX_ITER } from './skill-tools.mjs';


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
  const clientServiceDefault = await getClientService();
  let clientService = clientServiceDefault;

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

  // Model actually sent to the service: usually the one selected on the chat
  // page, but a per-call / per-Skill data-source override replaces it (below).
  let modelKey = options?.model || runtimeConfig.modelName || 'default';
  let requestModel = options?.model;
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
  // Auto mode skills: exclude skills flagged manualOnly (user-only invocation,
  // mirroring Claude's disable-model-invocation). They can still be picked via
  // the "/" picker or inline "/name" command.
  const autoSkillPool = (!activeSkill && Array.isArray(options?.skills)) ? options.skills.filter(s => !s?.manualOnly) : [];
  const autoSkills = autoSkillPool.length ? autoSkillPool : null;
  const skillHasTools = activeSkill && Array.isArray(activeSkill.tools) && activeSkill.tools.length;

  // Per-call / per-Skill model override: options.dsService (set by the chat
  // page, e.g. an inline "@<service> " prefix) or the Skill's own dsService
  // field select a data source for this turn only — the global configuration
  // is untouched. Falls back to the default client when the name is unknown.
  let turnService = null;
  const dsOverrideName = options?.dsService || activeSkill?.dsService || null;
  if (dsOverrideName) {
    const entry = (runtimeConfig.dsList || []).find((d) =>
      String(d.service) === String(dsOverrideName) || String(d.name || '') === String(dsOverrideName));
    if (entry) {
      try {
        clientService = await getServiceInstance(entry);
        turnService = entry.service;
        // The model name belongs to its own service: reusing the chat page's
        // model (which may belong to a *different* service) makes the request
        // fail with "model not found". Use the data source's model, or null so
        // the client falls back to its own default model.
        requestModel = entry.modelName || null;
        if (requestModel) modelKey = requestModel;
        else modelKey = entry.service || modelKey;
      } catch (e) {
        console.warn(`Per-call model override "${dsOverrideName}" failed, using default:`, e);
      }
    } else {
      console.warn(`Per-call model override "${dsOverrideName}" not found in dsList.`);
    }
  }

  // Audit run for this turn: records which tools ran, how long they took and
  // where they failed (metadata only — see the tool-governance section).
  const auditRun = (skillHasTools || autoSkills)
    ? startSkillRun({
        skillId: activeSkill?.id || null,
        skillName: activeSkill?.name || null,
        model: modelKey,
        service: turnService || runtimeConfig.service,
        sessionId: options?.sessionId || null
      })
    : null;
  const toolCtx = buildToolContext({
    run: auditRun,
    activeSkill: activeSkill || null,
    options,
    model: modelKey,
    service: turnService || runtimeConfig.service
  });
  // Only runs that actually called a tool are worth keeping — a turn where the
  // model never used a tool leaves no audit record.
  const closeAuditRun = async (status) => {
    if (!auditRun || !auditRun.steps.length) return;
    await finishSkillRun(auditRun, status);
  };

  /**
   * Switch the running turn to a Skill the model adopted mid-answer (Auto mode)
   * and build the text that tells it the Skill is now active. Used by both the
   * text protocol and the opportunistic native-call path.
   * @param {Object} matched - The Skill to adopt
   * @returns {string} Instruction text for the model
   */
  const adoptSkill = (matched) => {
    adoptedSkill = matched;
    toolCtx.skillName = matched.name;
    toolCtx.skillId = matched.id || null;
    if (auditRun) auditRun.skillName = matched.name;
    let output = `Skill activated: ${matched.name}.`;
    if (matched.prompt) output += `\n\nInstructions:\n${matched.prompt}`;
    const toolsPart = buildToolInstructions(matched);
    if (toolsPart) output += `\n\n${toolsPart}`;
    return output;
  };

  /**
   * Wrap a plain tool result in the <tool_result> block the model understands.
   * @param {string} name - Tool name
   * @param {string} output - Raw tool output
   * @returns {string}
   */
  const wrapToolResult = (name, output) => {
    const ok = !/^(Error:|Execution of )/i.test(String(output));
    return `<tool_result>\n<tool_name>${name}</tool_name>\n<success>${ok}</success>\n<output>${String(output)}</output>\n</tool_result>`;
  };

  // Make sure MCP tools are registered before any tool list is built. This is
  // instant when MCP is unused (already-resolved promise) or registration has
  // already finished; at worst it waits out the short probe timeout once.
  if (skillHasTools || autoSkills) {
    try { await getMcpReady(); } catch (e) { /* registration errors are non-fatal */ }
  }

  let useNativeTools = false;
  let nativeTools = [];
  if (runtimeConfig.service === 'ollama' && typeof clientService.hasNativeTools === 'function') {
    if (skillHasTools || autoSkills) {
      useNativeTools = await clientService.hasNativeTools(requestModel);
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
  // Only re-prompt once for a malformed tool call, so a model that never gets the
  // syntax right cannot loop forever.
  let toolSyntaxRetried = false;
  for (let step = 0; step <= SKILL_TOOL_MAX_ITER; step++) {
    let full = '';
    let lastToolCalls = null;
    try {
      // Await the full sendRequest (including its internal cleanup/finally)
      // so the underlying connection is fully released BEFORE the next request
      // is issued.
      const requestPromise = clientService.sendRequest(msgs, {
        model: requestModel,
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
        await closeAuditRun('aborted');
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
            results.push({ tool_name: 'use_skill', content: `${adoptSkill(matched)}\nYou may now use its tools.` });
          } else {
            results.push({
              tool_name: 'use_skill',
              content: `Unknown Skill "${wanted}". Available: ${autoSkills.map(s => s.name).join(', ')}.`
            });
          }
          continue;
        }

        replaceElementContent(msgDiv, `🔧 running ${fname}...`);
        const resultText = await runTool(fname, fargs || {}, activeSkill, toolCtx);
        results.push({ tool_name: fname, content: resultText });
      }
      msgs.push({ role: 'assistant', content: full, tool_calls: lastToolCalls });
      for (const r of results) msgs.push({ role: 'tool', content: r.content, tool_name: r.tool_name });
      continue;
    }

    // Opportunistic native calls: the backend answered with a tool call although
    // we never declared tools for it (OpenAI-compatible gateways and Gemini do
    // this whenever the prompt mentions tools). Dropping these calls is what
    // used to make such an answer look empty — run them instead. Results go back
    // as text, because the `tool` role is only safe when tools were declared.
    if (!useNativeTools && lastToolCalls && lastToolCalls.length && step < SKILL_TOOL_MAX_ITER) {
      const results = [];
      for (const tc of lastToolCalls) {
        const fname = tc.function?.name;
        if (!fname) continue;
        let fargs = tc.function?.arguments;
        if (typeof fargs === 'string') {
          try { fargs = JSON.parse(fargs); } catch (e) { fargs = {}; }
        }
        console.warn(`[chat] executing undeclared native tool call "${fname}"`);

        if (!activeSkill && autoSkills && fname === 'use_skill') {
          const wanted = String(fargs?.name || '').trim();
          const matched = autoSkills.find(s => String(s.name).toLowerCase() === wanted.toLowerCase());
          if (matched) {
            results.push(wrapToolResult('use_skill', adoptSkill(matched)));
          } else {
            const avail = autoSkills.map(s => s.name).join(', ');
            results.push(wrapToolResult('use_skill', `Unknown Skill "${wanted}". Available: ${avail}.`));
          }
          continue;
        }

        replaceElementContent(msgDiv, `🔧 running ${fname}...`);
        results.push(await executeToolCall({ name: fname, args: fargs || {} }, activeSkill || adoptedSkill || null, toolCtx));
      }
      const toolResultContent = results.join('\n\n');
      if (isGoogle) {
        msgs.push({ role: 'model', parts: [{ text: full || '(tool call)' }] });
        msgs.push({ role: 'user', parts: [{ text: toolResultContent }] });
      } else {
        msgs.push({ role: 'assistant', content: full || '(tool call)' });
        msgs.push({ role: 'user', content: toolResultContent });
      }
      continue;
    }

    // Text-protocol path (models without native tools). Enabled whenever a Skill
    // is forced, or in Auto mode (where the model may first call use_skill to
    // adopt a Skill, then call that Skill's tools).
    const canTextTools = !useNativeTools && (activeSkill || autoSkills);
    const parsedCalls = canTextTools ? parseToolCallsDetailed(full) : { calls: [], malformed: [] };
    const calls = parsedCalls.calls;

    // A tool call we cannot read would otherwise disappear from the answer (before
    // it was stripped from the text and never executed). Report it to the user and
    // ask the model once to rewrite it in the documented syntax.
    if (!calls.length && parsedCalls.malformed.length) {
      const first = parsedCalls.malformed[0];
      console.warn('[chat] unparsable tool call:', first);
      toolCtx.onStep({ tool: 'tool_call', ok: false, error: `unparsable tool call — ${first.reason}` });
      if (!toolSyntaxRetried && step < SKILL_TOOL_MAX_ITER) {
        toolSyntaxRetried = true;
        const reminder = 'Your previous reply contained a tool call that could not be read: ' + first.reason + '.\n' +
          'Rewrite it exactly in this form (no other shape works):\n' +
          '<tool_call><tool_name>TOOL_NAME</tool_name><args>{"key":"value"}</args></tool_call>\n' +
          'then STOP and wait for the result.';
        if (isGoogle) {
          msgs.push({ role: 'model', parts: [{ text: full }] });
          msgs.push({ role: 'user', parts: [{ text: reminder }] });
        } else {
          msgs.push({ role: 'assistant', content: full });
          msgs.push({ role: 'user', content: reminder });
        }
        continue;
      }
    }

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
            resultText = wrapToolResult('use_skill', adoptSkill(matched));
          } else {
            const avail = autoSkills.map(s => s.name).join(', ');
            resultText = wrapToolResult('use_skill', `Unknown Skill "${wanted}". Available: ${avail}.`);
          }
        } else {
          resultText = await executeToolCall(call, activeSkill || adoptedSkill || null, toolCtx);
        }
        // Tell the model its <args> were unusable, so it can correct itself.
        if (call._parseError) {
          console.warn(`[chat] ${call.name}: <args> JSON could not be parsed`, call._parseError);
          resultText = wrapToolResult(call.name,
            `warning: the <args> JSON could not be read (${call._parseError}); the tool ran with empty or default arguments.`) +
            '\n\n' + resultText;
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
    if (!finalResponse.trim()) {
      // An empty answer must never reach the transcript unnoticed: tell the page
      // (which shows a visible notice) and leave a log trail with the shape of
      // what actually came back.
      console.warn('[chat] empty model response', {
        step,
        hadNativeToolCalls: Boolean(lastToolCalls && lastToolCalls.length),
        hadToolCallText: String(full || '').includes('<tool_call>')
      });
      if (typeof options?.onEmptyResponse === 'function') {
        options.onEmptyResponse({
          hadToolCalls: Boolean((lastToolCalls && lastToolCalls.length) || String(full || '').includes('<tool_call>'))
        });
      }
    }
    break;
  }

  await closeAuditRun(options.stop() ? 'aborted' : undefined);
  if (!options.stop()) {
    // Never persist a blank assistant turn (it would look like the chat lost the
    // answer); the page shows the notice rendered by onEmptyResponse instead.
    if (String(finalResponse || '').trim()) {
      historyMessages.push({ role: 'assistant', content: finalResponse, rtime: Date.now() });
    }
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
    version: 1,
    name: browser.i18n.getMessage('skillDefaultGeneralHelper'),
    description: browser.i18n.getMessage('skillDefaultGeneralHelperDesc'),
    prompt: 'Answer the user\'s questions based on the current webpage. Its content (title, URL, text) is provided in the conversation — use it as the primary source. If that content is missing, or you need the latest page text, first call the get_page_content tool, then answer from its result. Be concise and accurate; refer to the page when it helps.',
    tools: [{ name: 'get_page_content', args: {} }, { name: 'current_time', args: {} }, { name: 'echo', args: {} }],
    usePage: true
  },
  {
    id: 'date-time',
    version: 1,
    name: browser.i18n.getMessage('skillDefaultDateTime') || 'Date & Time',
    description: browser.i18n.getMessage('skillDefaultDateTimeDesc') || 'Answers questions about the current date, time and weekday.',
    prompt: 'You are a date & time assistant. Whenever the user asks about the current time, date or weekday, call the current_time tool and answer from its result (mention the weekday when relevant). Do not guess the current time.',
    tools: [{ name: 'current_time', args: {} }]
  },
  {
    id: 'page-builder',
    version: 1,
    name: browser.i18n.getMessage('skillDefaultPageBuilder') || 'Page Builder',
    description: browser.i18n.getMessage('skillDefaultPageBuilderDesc') || 'Surveys what the current webpage could become, lets you pick the target and imports only after you confirm.',
    prompt: [
      'You are Page Builder. You help the user turn parts of the current webpage into reusable artifacts: a Skill, a chat scenario or an insight recipe. You never import anything yourself - the chat page shows Import buttons for what you output and writes only after the user clicks one.',
      '',
      'Input: the current webpage content is provided in the conversation. If it is missing or you need the latest version, first call get_page_content.',
      '',
      'STEP 1 - Judge suitability and say it out loud ("Suitable: ..." / "Not suitable: ...").',
      'Suitable: transferable know-how - a role, methodology, workflow, checklist, house style, expert procedure, or a repeatable analysis/transformation task.',
      'Not suitable: news, announcements, dashboards or raw data, product/landing pages, navigation or docs indexes, commentary about one single event, time-sensitive facts, content that only works with its own charts and links, too little text to extract rules from, or a page about writing prompts/Skills/recipes itself.',
      'If it is not suitable: explain briefly why, suggest what to do instead, and stop. Do not output any JSON.',
      '',
      'STEP 2 - Inventory the page and classify what is in it. Answer with a numbered list, one line per item:',
      '1. <short title> - <one line: what it is> - suggest: <Skill|chat scenario|insight recipe>',
      '2. ...',
      'Rules: one item per prompt/method - NEVER merge different things into one item; use the page headings as a guide; 1 item is fine when the page is about one thing; list at most 8 items.',
      'The chat page turns this numbered list into clickable buttons, so the user can answer with one click - keep it a clean flat list (no sub-bullets, no extra numbering).',
      'End with one line asking the user which item(s) to build. Do not output any JSON in this step.',
      '',
      'STEP 3 - The user answers with the item numbers they picked (their message may look like "Build the following selected items: #1 ...; #3 ..."). Draft exactly those items - no more, no fewer - and output one fenced ```json block per item:',
      '- Skill: {"name": "<short, no spaces, max 4 words>", "description": "<when to use it>", "prompt": "<self-contained system prompt: role, numbered workflow, output format, boundaries>", "tools": [{"name": "tool_name", "args": {}}], "starter": "<optional first message to prefill>"}',
      '- Chat scenario: {"name": "<short reusable title>", "prompt": "<self-contained system prompt: persona, goal, workflow, hard rules, output format>", "sample": "<example first user message, max 200 characters>"}',
      '- Insight recipe: {"name": "<2-6 characters, max 12>", "prompt": "<one-shot analysis instruction: role, what to produce, output format, hard rules>"}',
      'Include "sample" only for chat scenarios; include "description"/"tools"/"starter" only for Skills - that is how the type is recognized. Use only tool names that list_tools returns.',
      'Then stop: add one short line per draft saying what it is, and ask whether to change anything. Say nothing about pressing anything else - the buttons appear on their own.',
      '',
      'STEP 4 - If the user asks for changes, output the corrected ```json block(s) again (they replace the previous ones). If they want another type, re-draft for that type.',
      '',
      'Rules:',
      '- Generated text must stand alone (it is used without this page): never write "as described above / in the article". Write it in the language of the page and address the target directly ("You are ...").',
      '- Keep every concrete rule, threshold, checklist and template of the chosen item; drop links, ads and navigation.',
      '- One artifact per item: when a page holds 4 distinct prompts and the user picked 2, output exactly those 2 blocks - never one merged block.',
      '- Never tell the user to click something you did not output, and never claim that something was already imported: the user imports through the buttons on the JSON blocks.',
      '- When the user asks where an artifact lives: Skill -> the "/" list in chat; chat scenario -> the scenario dropdown on the chat page; insight recipe -> the Insightify sidebar buttons and the right-click Insight menu.',
      '- Recipe names must be 2-6 characters (hard limit 12); Skill names should contain no spaces so the inline /name shortcut works.'
    ].join('\n'),
    tools: [
      { name: 'get_page_content', args: {} },
      { name: 'list_tools', args: {} },
      { name: 'ask_user_choice', args: {} },
      { name: 'propose_artifact', args: {} }
    ],
    usePage: true,
    starter: browser.i18n.getMessage('pageBuilderStarter') || 'First tell me what this page could become: list the separate pieces it contains (title + one line + suggested type), then I pick and you output the JSON draft(s) - import only after I click.'
  }
];

/**
 * Built-in Skills that were replaced by the merged `page-builder`. A stored copy
 * that still uses the shipped prompt is dropped on load, so an upgraded install
 * does not end up with both the old builders and the new one. A copy the user
 * edited (its prompt no longer starts with the shipped text) is kept as-is.
 * The fingerprints are the first lines of the retired prompts: short on purpose,
 * so they can stay here after the prompts themselves are gone.
 */
const RETIRED_SKILLS = [
  { id: 'skill-builder', promptStartsWith: 'You are Skill Builder: you compile the current webpage' },
  { id: 'scenario-builder', promptStartsWith: 'You are Scenario Builder: you judge whether the current webpage' },
  { id: 'insight-builder', promptStartsWith: 'You are Insight Builder: you judge whether the current webpage' }
];

/**
 * Whether a stored Skill is an unmodified copy of a retired built-in Skill.
 * @param {Object} skill - Stored Skill
 * @returns {boolean} True when it should be dropped
 */
function isRetiredDefaultSkill(skill) {
  const retired = RETIRED_SKILLS.find((r) => String(skill?.id) === r.id);
  if (!retired) return false;
  return String(skill?.prompt || '').trimStart().startsWith(retired.promptStartsWith);
}

/**
 * Merge built-in skills (SKILL_DEFAULTS) that the user does not have yet into a
 * stored skill list. Existing entries are never modified: a default is appended
 * only when no stored skill shares its id (or its name) and it was not deleted
 * by the user before. This way users who already configured their own skills
 * still receive built-in skills added by a later version. Unmodified copies of
 * retired built-ins (see RETIRED_SKILLS) are filtered out.
 * @param {Array} stored - The stored skill list (may be empty)
 * @param {Array<string>} removedIds - Ids of defaults the user deleted
 * @returns {Array} A new list with the missing defaults appended
 */
/**
 * Fingerprints (first lines) of the prompts shipped by *earlier* versions of a
 * built-in Skill, keyed by Skill id. Add an entry here whenever a default's
 * prompt is rewritten while bumping its `version`: a stored copy that still
 * starts with a known fingerprint is recognized as "unmodified" and may be
 * upgraded in place, while a copy the user edited is never overwritten.
 * @type {Object<string, Array<string>>}
 */
const SKILL_PROMPT_HISTORY = {
  // 'example-skill': ['First line of the v1 prompt', 'First line of the v2 prompt']
};

/**
 * Whether a stored copy of a built-in Skill still carries the shipped prompt.
 * @param {Object} stored - Stored skill
 * @param {Object} def - Current built-in definition
 * @returns {boolean} True when the prompt was not edited by the user
 */
function isUnmodifiedDefaultSkill(stored, def) {
  const prompt = String(stored?.prompt || '').trimStart();
  if (!prompt) return true;
  const current = String(def.prompt || '').trimStart().split('\n')[0];
  if (current && prompt.startsWith(current)) return true;
  const history = SKILL_PROMPT_HISTORY[String(def.id)] || [];
  return history.some((fingerprint) => prompt.startsWith(fingerprint));
}

export function mergeDefaultSkills(stored, removedIds = []) {
  const list = (Array.isArray(stored) ? stored.slice() : []).filter((s) => !isRetiredDefaultSkill(s));
  const removed = new Set((removedIds || []).map(String));
  const ids = new Set(list.map((s) => String(s?.id)));
  const names = new Set(list.map((s) => String(s?.name || '').toLowerCase()));

  // Idempotent version migration for built-in skills. A stored default is
  // upgraded in place when (a) its id matches, (b) its prompt is still the
  // shipped text (unmodified — a user-edited copy is never overwritten), and
  // (c) its version is older than the current default's. Because only exact
  // shipped copies are touched, re-running this is a no-op and downgrades
  // (an older extension version) simply leave the higher version untouched.
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const def = SKILL_DEFAULTS.find((d) => String(d.id) === String(s?.id));
    if (!def || removed.has(String(def.id))) continue;
    const defVersion = def.version || 1;
    const storedVersion = s.version || 1;
    if (storedVersion >= defVersion) continue;
    if (isUnmodifiedDefaultSkill(s, def)) {
      // Keep the entry's position; everything else comes from the new default.
      list[i] = { ...def };
    }
  }

  for (const def of SKILL_DEFAULTS) {
    const id = String(def.id);
    if (removed.has(id) || ids.has(id) || names.has(String(def.name).toLowerCase())) continue;
    list.push({ ...def });
  }
  return list;
}

/**
 * Load the list of skills from storage. Built-in skills the user has not
 * configured yet are merged in (see mergeDefaultSkills); a default the user
 * deliberately deleted (tracked in DB_KEY.skillDefaultRemoved) stays deleted.
 * @returns {Promise<Array>} Array of skill objects
 */
export function loadSkills() {
  return new Promise((resolve) => {
    browser.storage.local.get([DB_KEY.skillList, DB_KEY.skillDefaultRemoved], (data) => {
      const stored = data[DB_KEY.skillList];
      const rawRemoved = data[DB_KEY.skillDefaultRemoved];
      const removed = Array.isArray(rawRemoved) ? rawRemoved.map(String) : [];

      if (stored && stored.length) {
        resolve(mergeDefaultSkills(stored, removed));
      } else {
        // No configuration yet: use the defaults (minus deleted ones). A copy is
        // returned so callers can safely mutate the result before saving.
        resolve(SKILL_DEFAULTS.filter((d) => !removed.includes(String(d.id))));
      }
    });
  });
}

/**
 * Persist the list of skills to storage. Built-in skills missing from the saved
 * list are recorded as "removed by the user" so that merging them back in on the
 * next load would not resurrect a Skill the user explicitly deleted.
 * @param {Array} skills - Skill objects
 * @returns {Promise<void>}
 */
export function saveSkills(skills) {
  return new Promise((resolve) => {
    const list = Array.isArray(skills) ? skills : [];
    const present = new Set(list.map((s) => String(s?.id)));
    const removed = SKILL_DEFAULTS.filter((d) => !present.has(String(d.id))).map((d) => String(d.id));
    browser.storage.local.set({
      [DB_KEY.skillList]: list,
      [DB_KEY.skillDefaultRemoved]: removed
    }, resolve);
  });
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
  skillSystemDisabled: "skillSystemDisabled",
  skillDefaultRemoved: "skillDefaultRemoved",
  pendingArtifact: "pendingArtifact",
  pendingChoice: "pendingChoice",
  mcpServers: "mcpServers",
  // Tool-governance keys:
  pendingToolConfirm: "pendingToolConfirm", // side-effect tool awaiting user confirmation
  toolGrants: "toolGrants",                 // "session:tool" pairs allowed without re-asking
  skillRuns: "skillRuns"                    // audit trail of skill/tool runs (metadata only)
};

// ------------------- Tool governance: audit trail & confirmation -------------------
// Metadata only: run records never contain page content, model answers or
// API keys — only which tools ran, how long they took, whether they succeeded
// and (redacted, truncated) argument previews.

// Cap the persisted audit trail so it never grows unbounded.
const MAX_SKILL_RUNS = 50;
const MAX_RUN_STEPS = 60;
// How long a confirmation card stays open before the tool is denied.
const TOOL_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Filter the audit trail for display. Kept as a pure function (and exported) so
 * the settings page and the tests share exactly one definition of what each
 * filter means.
 * @param {Array<Object>} runs - Records from loadSkillRuns()
 * @param {Object} [filter] - { origin, status, skill, query }
 *   origin: 'all' | 'model' | 'user' | 'page'; status: 'all' | 'ok' | 'failed';
 *   skill: exact skill name ('all' for every Skill); query: free text search.
 * @returns {Array<Object>} Matching records, order preserved
 */
export function filterSkillRuns(runs, filter = {}) {
  const origin = filter.origin && filter.origin !== 'all' ? String(filter.origin) : null;
  const status = filter.status && filter.status !== 'all' ? String(filter.status) : null;
  const skill = filter.skill && filter.skill !== 'all' ? String(filter.skill) : null;
  const query = String(filter.query || '').trim().toLowerCase();

  return (Array.isArray(runs) ? runs : []).filter((run) => {
    if (!run) return false;
    if (origin && (run.origin || 'model') !== origin) return false;
    if (status === 'failed' && run.status !== 'failed') return false;
    if (status === 'ok' && run.status === 'failed') return false;
    if (skill && String(run.skillName || '') !== skill) return false;
    if (query) {
      // Search the fields a user would look for: skill, action, tool names,
      // argument previews and error text.
      const haystack = [
        run.skillName,
        run.action,
        run.detail,
        ...(Array.isArray(run.steps) ? run.steps.flatMap((s) => [s.tool, s.argsPreview, s.error]) : [])
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/**
 * Read the persisted audit trail.
 * @returns {Promise<Array>} Run records (oldest first)
 */
export async function loadSkillRuns() {
  const data = await browser.storage.local.get(DB_KEY.skillRuns);
  return Array.isArray(data[DB_KEY.skillRuns]) ? data[DB_KEY.skillRuns] : [];
}

/**
 * Remove every audit record.
 * @returns {Promise<void>}
 */
export async function clearSkillRuns() {
  await browser.storage.local.set({ [DB_KEY.skillRuns]: [] });
}

/**
 * Remove a single audit record.
 * @param {string|number} id - Run id
 * @returns {Promise<void>}
 */
export async function removeSkillRun(id) {
  const runs = await loadSkillRuns();
  await browser.storage.local.set({ [DB_KEY.skillRuns]: runs.filter((r) => String(r.id) !== String(id)) });
}

/**
 * Append/replace one record in the audit trail, keeping the trail capped.
 * @param {Object} run - Record to store (matched by id)
 * @returns {Promise<void>}
 */
async function persistRun(run) {
  const runs = await loadSkillRuns();
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = run; else runs.push(run);
  await browser.storage.local.set({ [DB_KEY.skillRuns]: runs.slice(-MAX_SKILL_RUNS) });
}

/**
 * Truncate the argument preview / error text a step may carry.
 * @param {Object} step - Raw step
 * @returns {Object} Sanitized step (metadata only)
 */
function sanitizeStep(step) {
  return {
    tool: String(step.tool || 'unknown'),
    ok: step.ok === true,
    ...(step.denied ? { denied: true } : {}),
    ...(typeof step.ms === 'number' ? { ms: step.ms } : {}),
    argsPreview: previewToolArgs(step.args),
    ...(step.error ? { error: String(step.error).slice(0, 300) } : {})
  };
}

/**
 * Open a new audit run.
 * @param {Object} meta - { skillId, skillName, model, service, sessionId }
 * @returns {Object} Run object (mutated by recordRunStep / finishSkillRun)
 */
export function startSkillRun(meta = {}) {
  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // 'model': the tools this turn called. 'user'/'page': see below.
    origin: 'model',
    time: Date.now(),
    skillId: meta.skillId || null,
    skillName: meta.skillName || null,
    model: meta.model || null,
    service: meta.service || null,
    sessionId: meta.sessionId || null,
    status: 'running',
    duration: 0,
    steps: []
  };
}

/**
 * Record one tool step of a run (with a redacted argument preview) and persist.
 * @param {Object} run - Run object from startSkillRun (mutated in place)
 * @param {Object} step - { tool, ok, denied?, ms?, args?, error? }
 * @returns {Promise<void>}
 */
export async function recordRunStep(run, step) {
  if (!run) return;
  if (!run.origin) run.origin = 'model';
  run.steps.push(sanitizeStep(step));
  if (run.steps.length > MAX_RUN_STEPS) run.steps = run.steps.slice(-MAX_RUN_STEPS);
  await persistRun(run);
}

/**
 * Close a run: compute its final status ('ok' | 'failed' | 'aborted') and
 * total duration, then persist.
 * @param {Object} run - Run object (may be null)
 * @param {string} [status] - Force a status (e.g. 'aborted')
 * @returns {Promise<void>}
 */
export async function finishSkillRun(run, status) {
  if (!run) return;
  if (!run.origin) run.origin = 'model';
  run.status = status || (run.steps.some((s) => !s.ok) ? 'failed' : 'ok');
  run.duration = Date.now() - run.time;
  await persistRun(run);
}

/**
 * Record a user-confirmed action (import / overwrite / cancel / stale card) in
 * the audit trail. Clicking Import never goes through the tool pipeline, so
 * without this the write would leave no trace at all — and "the import did
 * nothing" would be impossible to verify afterwards.
 * @param {Object} entry - { action, target, name, ok, error, sessionId, detail }
 * @returns {Promise<void>}
 */
export async function recordUserAction(entry = {}) {
  const action = String(entry.action || 'action');
  const run = {
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    origin: 'user',
    action,
    target: entry.target || null,
    name: entry.name || null,
    time: Date.now(),
    skillId: null,
    skillName: null,
    model: null,
    service: null,
    sessionId: entry.sessionId || null,
    status: entry.ok === true ? 'ok' : 'failed',
    duration: 0,
    steps: [sanitizeStep({
      tool: action,
      ok: entry.ok === true,
      args: { target: entry.target || undefined, name: entry.name || undefined },
      error: entry.error
    })]
  };
  if (entry.detail) run.detail = String(entry.detail).slice(0, 300);
  await persistRun(run);
}

/**
 * Record something the page itself did while turning an answer into cards
 * (`parse_drafts`), so a turn where the model called no tool at all still leaves
 * a trace instead of looking like nothing happened.
 * @param {Object} entry - { action, ok, count, detail, sessionId }
 * @returns {Promise<void>}
 */
export async function recordPageEvent(entry = {}) {
  const action = String(entry.action || 'page_event');
  const run = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    origin: 'page',
    action,
    count: typeof entry.count === 'number' ? entry.count : null,
    time: Date.now(),
    skillId: null,
    skillName: null,
    model: null,
    service: null,
    sessionId: entry.sessionId || null,
    status: entry.ok === false ? 'failed' : 'ok',
    duration: 0,
    steps: [sanitizeStep({
      tool: action,
      ok: entry.ok !== false,
      ...(typeof entry.count === 'number' ? { args: { count: entry.count } } : {}),
      error: entry.error
    })]
  };
  if (entry.detail) run.detail = String(entry.detail).slice(0, 300);
  await persistRun(run);
}

/**
 * Read the persisted "always allow" grants (per session+tool).
 * @returns {Promise<Array<string>>}
 */
async function getToolGrants() {
  const data = await browser.storage.local.get(DB_KEY.toolGrants);
  return Array.isArray(data[DB_KEY.toolGrants]) ? data[DB_KEY.toolGrants] : [];
}

/**
 * Ask the user to confirm a side-effect tool call. Writes a pending request to
 * storage; the chat page renders it as a card and resolves it. Resolves false
 * on refusal or timeout — the tool is then NOT executed.
 * @param {Object} req - { tool, args, sideEffect, sessionId, skillName, model }
 * @returns {Promise<boolean>} Whether the user confirmed
 */
export async function requestToolConfirmation(req) {
  const grantKey = `${req.sessionId || '*'}:${req.tool}`;
  const grants = await getToolGrants();
  if (grants.includes(grantKey)) return true;

  const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pending = {
    id,
    tool: req.tool,
    argsPreview: previewToolArgs(req.args),
    sideEffect: req.sideEffect || 'external',
    sessionId: req.sessionId || null,
    skillName: req.skillName || null,
    model: req.model || null,
    time: Date.now()
  };
  await browser.storage.local.set({ [DB_KEY.pendingToolConfirm]: pending });

  const granted = await new Promise((resolve) => {
    let done = false;
    const listener = (changes, area) => {
      if (area !== 'local' || !changes[DB_KEY.pendingToolConfirm]) return;
      const val = changes[DB_KEY.pendingToolConfirm].newValue;
      if (!val || val.id !== id || val.resolved !== true) return;
      finish(val.granted === true);
      if (val.granted === true && val.always === true) {
        getToolGrants().then((g) => {
          if (!g.includes(grantKey)) browser.storage.local.set({ [DB_KEY.toolGrants]: [...g, grantKey] });
        }).catch(() => {});
      }
    };
    const timer = setTimeout(() => finish(false), TOOL_CONFIRM_TIMEOUT_MS);
    const finish = (value) => {
      if (done) return;
      done = true;
      if (typeof browser.storage.onChanged.removeListener === 'function') {
        browser.storage.onChanged.removeListener(listener);
      }
      clearTimeout(timer);
      resolve(value);
    };
    browser.storage.onChanged.addListener(listener);
  });

  // Consume the pending request either way, so no stale card lingers.
  const data = await browser.storage.local.get(DB_KEY.pendingToolConfirm);
  if (data[DB_KEY.pendingToolConfirm]?.id === id) {
    await browser.storage.local.remove(DB_KEY.pendingToolConfirm);
  }
  return granted;
}

/**
 * Build the per-turn tool context handed to every tool invocation: where the
 * call happens (session, skill, page, model) plus the confirmation and audit
 * hooks. Tools no longer have to guess the current tab or model themselves.
 * @param {Object} meta - { run, activeSkill, options, model, service }
 * @returns {Object} Tool context (pass as `ctx`)
 */
export function buildToolContext(meta = {}) {
  const run = meta.run || null;
  const skill = meta.activeSkill || null;
  const options = meta.options || {};
  return {
    sessionId: options.sessionId || null,
    skillId: skill?.id || null,
    skillName: skill?.name || null,
    model: meta.model || options.model || null,
    service: meta.service || null,
    pageUrl: options.pageUrl || null,
    pageTitle: options.pageTitle || null,
    /**
     * Side-effect confirmation hook — a tool runs only when this resolves true.
     * @param {Object} info - { tool, args, sideEffect }
     * @returns {Promise<boolean>}
     */
    requestConfirm: (info) => requestToolConfirmation({
      tool: info.tool,
      args: info.args,
      sideEffect: info.sideEffect,
      sessionId: options.sessionId || null,
      skillName: skill?.name || null,
      model: meta.model || options.model || null
    }),
    /**
     * Audit + live-UI hook invoked after every tool step (success or failure).
     * @param {Object} step - { tool, ok, denied?, ms?, args?, error? }
     */
    onStep: (step) => {
      if (run) recordRunStep(run, step).catch((e) => console.warn('audit write failed:', e));
      typeof options.onToolStep === 'function' && options.onToolStep(step);
    }
  };
}

// ------------------- Skill management tools -------------------
// Registered here (instead of js/skill-tools.mjs) because they read/write
// DB_KEY.skillList through the Skill helpers above; skill-tools.mjs must not
// import cllama.js, otherwise the two modules would form an import cycle.

/**
 * Tool: list the tools a Skill can bind to. Used by the "Skill Builder" default
 * Skill so generated Skills only reference existing tool names.
 */
registerTool({
  name: 'list_tools',
  i18nKey: 'tool_list_tools',
  description: 'Lists the tools that can be bound to a Skill (name, description and parameters). Call this before creating a Skill so that only existing tool names are used.',
  parameters: { type: 'object', properties: {} },
  func: async () => {
    const tools = listTools();
    if (!tools.length) return 'No tools are registered.';
    return tools
      .map((t) => {
        const props = t.parameters?.properties;
        const params = props ? Object.keys(props).join(', ') : '';
        return `- ${t.name}: ${t.description}${params ? ` (params: ${params})` : ''}`;
      })
      .join('\n');
  }
});

/**
 * Tool: store a Skill produced by the model, so that a Skill generated from a
 * webpage (see the "Skill Builder" default Skill) becomes usable right away.
 */
registerTool({
  name: 'save_skill',
  sideEffect: 'write',
  i18nKey: 'tool_save_skill',
  description: 'Creates a cllama Skill (or overwrites the existing one with the same name when overwrite=true) so the user can activate it in chat with /name. Pass a skill object: { name, description, prompt, tools: [{ name, args }], manualOnly, starter, usePage }. Tool names must come from list_tools; unknown names are dropped.',
  parameters: {
    type: 'object',
    properties: {
      skill: {
        type: 'object',
        description: 'The Skill to store: { name, description, prompt, tools, manualOnly, starter, usePage }'
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing Skill with the same name (default false)'
      }
    },
    required: ['skill']
  },
  func: async (params = {}) => {
    // Tolerate a flat call (the model putting the Skill fields at the top level
    // instead of nesting them under "skill"), which is common with the text
    // <tool_call> protocol.
    const flat = params && typeof params === 'object' ? params : {};
    const src = (flat.skill && typeof flat.skill === 'object')
      ? flat.skill
      : ((flat.name || flat.prompt) ? flat : {});

    const res = await applyArtifact('skill', src, { overwrite: flat.overwrite === true });
    if (!res.ok) return res.message;

    const notes = res.notes || [];
    return `Skill "${res.name}" ${res.action} and saved (${res.count} Skill(s) total)${notes.length ? ` — ${notes.join('; ')}` : ''}. ` +
      `The user can pick it from the "/" list in chat${/\s/.test(res.name) ? ' (its name contains spaces, so the inline "/name" shortcut is unavailable)' : `, or start it by typing /${res.name}`}.`;
  }
});

// ------------------- Content-builder tools -------------------
// Compile a webpage into a chat scenario / insight recipe. Registered here too,
// because they read/write DB_KEY.chatTpaList / DB_KEY.actionList.

/**
 * The chat scenario chat/chat.js seeds when the user has configured none, so
 * that saving a generated scenario does not silently drop it.
 * @returns {Object} Default scenario
 */
function defaultChatScenario() {
  return {
    id: 1,
    name: browser.i18n.getMessage('directorExample1_name'),
    prompt: browser.i18n.getMessage('directorExample1_prompt'),
    sample: browser.i18n.getMessage('directorExample1_sample')
  };
}

/**
 * Load the chat scenarios (DB_KEY.chatTpaList). When the user has none yet, the
 * built-in example scenario is returned so it is kept instead of replaced.
 * @returns {Promise<Array>} A mutable copy of the scenario list
 */
async function loadChatScenarios() {
  const data = await browser.storage.local.get(DB_KEY.chatTpaList);
  const stored = data[DB_KEY.chatTpaList];
  return (Array.isArray(stored) && stored.length) ? stored.slice() : [defaultChatScenario()];
}

/**
 * Load the insight recipes (DB_KEY.actionList). When the user has none yet, the
 * language-specific defaults (init/insightify/actions_*.json) are returned so
 * they are kept instead of replaced.
 * @returns {Promise<Array>} A mutable copy of the recipe list
 */
async function loadInsightActions() {
  const data = await browser.storage.local.get(DB_KEY.actionList);
  const stored = data[DB_KEY.actionList];
  if (Array.isArray(stored) && stored.length) return stored.slice();
  const defaults = await loadDefaultActions();
  return Array.isArray(defaults) ? defaults.slice() : [];
}

/**
 * Count characters the way a user sees them (code points, so a CJK character or
 * an emoji counts as one).
 * @param {string} text - Text to measure
 * @returns {number} Number of code points
 */
function countChars(text) {
  return [...String(text || '')].length;
}

// ------------------- Artifact drafts (page -> Skill / scenario / recipe) -------------------
// Validation and persistence shared by the save_* tools and by the confirmation
// card in chat/chat.js (the user's "Import" click calls applyArtifact()).

/** The three artifact kinds a page can be compiled into. */
export const ARTIFACT_TARGETS = ['skill', 'scenario', 'recipe'];

/**
 * Normalize a Skill draft (see the Skill spec) and report the problems found.
 * @param {Object} src - Raw payload from the model
 * @returns {{ok: boolean, message?: string, entry?: Object, notes?: Array<string>}}
 */
function normalizeSkillDraft(src) {
  const name = String(src?.name || '').trim();
  const prompt = String(src?.prompt || '').trim();
  const description = String(src?.description || '').trim();

  if (!name || !prompt) {
    return { ok: false, message: 'Error: the skill needs at least a "name" and a "prompt". Nothing was saved.' };
  }
  if (countChars(name) > 100) {
    return { ok: false, message: 'Error: the skill name is too long (max 100 characters). Nothing was saved.' };
  }
  if (countChars(prompt) > 8000) {
    return { ok: false, message: 'Error: the skill prompt is too long (max 8000 characters). Shorten it and try again. Nothing was saved.' };
  }

  // Keep only registered tools: a hallucinated name would make the Skill look
  // broken at runtime (see executeToolCall), so drop it and report it back.
  const notes = [];
  const dropped = [];
  const tools = [];
  for (const entry of Array.isArray(src?.tools) ? src.tools : []) {
    const toolName = typeof entry === 'string' ? entry.trim() : String(entry?.name || '').trim();
    if (!toolName) continue;
    if (!getTool(toolName)) { dropped.push(toolName); continue; }
    if (tools.some((t) => t.name === toolName)) continue;
    const args = (entry && typeof entry === 'object' && entry.args && typeof entry.args === 'object') ? entry.args : {};
    tools.push({ name: toolName, args });
  }
  if (dropped.length) notes.push(`dropped unknown tool(s): ${dropped.join(', ')}`);
  if (!tools.length) notes.push('this Skill uses no tools');

  const skill = { name, description, prompt, tools };
  if (src?.manualOnly === true) skill.manualOnly = true;
  const starter = String(src?.starter || '').trim();
  if (starter) skill.starter = starter;
  if (src?.usePage === true) skill.usePage = true;
  if (starter) notes.push('a starter message is prefilled when the Skill is selected');

  return { ok: true, entry: skill, notes };
}

/**
 * Normalize a chat-scenario draft ({ name, prompt, sample }).
 * @param {Object} src - Raw payload from the model
 * @returns {{ok: boolean, message?: string, entry?: Object, notes?: Array<string>}}
 */
function normalizeScenarioDraft(src) {
  const name = String(src?.name || '').trim();
  const prompt = String(src?.prompt || '').trim();
  let sample = String(src?.sample || '').trim();

  if (!name || !prompt) {
    return { ok: false, message: 'Error: the scenario needs at least a "name" and a "prompt". Nothing was saved.' };
  }
  if (countChars(name) > 100) {
    return { ok: false, message: 'Error: the scenario name is too long (max 100 characters). Nothing was saved.' };
  }
  if (countChars(prompt) > 20000) {
    return { ok: false, message: 'Error: the scenario prompt is too long (max 20000 characters). Shorten it and try again. Nothing was saved.' };
  }

  const notes = [];
  if (countChars(sample) > 300) {
    sample = [...sample].slice(0, 300).join('');
    notes.push('sample truncated to 300 characters');
  }
  return { ok: true, entry: { name, prompt, sample }, notes };
}

/**
 * Normalize an insight-recipe draft ({ name, prompt }). The name is rendered as
 * a small toolbar button, so it must stay very short.
 * @param {Object} src - Raw payload from the model
 * @returns {{ok: boolean, message?: string, entry?: Object, notes?: Array<string>}}
 */
function normalizeRecipeDraft(src) {
  const name = String(src?.name || '').trim();
  const prompt = String(src?.prompt || '').trim();

  if (!name || !prompt) {
    return { ok: false, message: 'Error: the recipe needs at least a "name" and a "prompt". Nothing was saved.' };
  }
  if (countChars(name) > 12) {
    return {
      ok: false,
      message: `Error: the recipe name "${name}" is too long (${countChars(name)} characters, max 12). ` +
        'Shorten it to 2-6 concise characters that still describe the task, then try again. Nothing was saved.'
    };
  }
  if (countChars(prompt) > 2000) {
    return { ok: false, message: 'Error: the recipe prompt is too long (max 2000 characters). Shorten it and try again. Nothing was saved.' };
  }
  return { ok: true, entry: { name, prompt }, notes: [] };
}

/**
 * Validate a draft for one target and return the normalized entry.
 * @param {string} target - 'skill' | 'scenario' | 'recipe'
 * @param {Object} payload - Raw draft payload
 * @returns {{ok: boolean, message?: string, entry?: Object, notes?: Array<string>}}
 */
export function normalizeArtifactDraft(target, payload) {
  const src = (payload && typeof payload === 'object') ? payload : {};
  if (target === 'skill') return normalizeSkillDraft(src);
  if (target === 'scenario') return normalizeScenarioDraft(src);
  if (target === 'recipe') return normalizeRecipeDraft(src);
  return {
    ok: false,
    message: `Error: unknown target "${target}". Use one of: ${ARTIFACT_TARGETS.join(', ')}. Nothing was saved.`
  };
}

/**
 * Human-readable name of a target, in the current UI language.
 * @param {string} target - 'skill' | 'scenario' | 'recipe'
 * @returns {string} Localized label
 */
export function artifactTargetLabel(target) {
  const key = { skill: 'artifactTargetSkill', scenario: 'artifactTargetScenario', recipe: 'artifactTargetRecipe' }[target];
  const fallback = { skill: 'Skill', scenario: 'Chat scenario', recipe: 'Insight recipe' }[target];
  return (key && browser.i18n.getMessage(key)) || fallback || String(target);
}

/**
 * Parse one candidate line into an option ({ title, detail, target }). The model
 * usually writes "<short title> — <what it is> — 建议：<target>".
 * @param {string} rawLine - One numbered line (without its number)
 * @returns {Object|null} Parsed option, or null when the line is unusable
 */
export function parseChoiceOption(rawLine) {
  let text = String(rawLine || '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || countChars(text) > 200) return null;

  // Optional target hint: "建议：聊天场景", "(Skill)", "-> recipe", ...
  let target = '';
  const hit = /\b(skill|chat scenario|scenario|insight recipe|recipe)\b/i.exec(text) || /(技能|聊天场景|洞察配方|场景|配方)/.exec(text);
  if (hit) {
    const word = hit[1] || hit[0];
    const lower = word.toLowerCase();
    target = (lower.includes('skill') || word.includes('技能')) ? 'skill'
      : (lower.includes('scenario') || word.includes('场景')) ? 'scenario'
        : 'recipe';
    text = text.replace(word, ' ');
  }
  text = text
    .replace(/(建议(做成|目标)?|suggested target|suggested|suggest|target|做成|推荐)\s*[:：]?/gi, ' ')
    .replace(/[（(【\[]\s*[）)】\]]/g, ' ')
    .replace(/\s*[—–-]{1,2}\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–,，、。;；:：]+|[\s—–,，、。;；:：]+$/g, '')
    .trim();
  if (!text) return null;

  const parts = text.split(' — ').map((s) => s.trim()).filter(Boolean);
  const title = (parts[0] || text).slice(0, 80);
  const detail = parts.slice(1).join(' — ').slice(0, 200);
  if (!title) return null;
  return { title, detail, target };
}

/**
 * Parse a numbered list of candidates out of a model answer, so the chat page can
 * offer it as clickable options even when the model never called
 * ask_user_choice. The longest consecutive list starting at 1 with 2..8 items is
 * used; anything else is ignored so ordinary prose never turns into buttons.
 * @param {string} text - Assistant answer text
 * @returns {Array<{title: string, detail: string, target: string}>} Parsed options
 */
export function parseChoiceOptions(text) {
  if (!text) return [];
  let current = [];
  let best = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:[*\-•]\s*)?(?:☐|☑|\[\s?\]|\[x\])?\s*(\d{1,2})\s*[.)、,，:：]\s*(\S.*)$/.exec(line);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num === 1) current = [];
    if (num !== current.length + 1) continue;
    const option = parseChoiceOption(m[2]);
    if (!option) continue;
    current.push(option);
    if (current.length > best.length) best = current.slice();
  }
  return (best.length >= 2 && best.length <= 8) ? best : [];
}

/**
 * Guess which artifact a JSON payload describes: a chat scenario when it carries
 * a "sample", a Skill when it carries skill-only fields, otherwise a recipe when
 * the name is short enough for a toolbar button and a scenario when it is not.
 * @param {Object} payload - Parsed JSON from a model answer
 * @returns {string} 'skill' | 'scenario' | 'recipe'
 */
export function guessArtifactTarget(payload) {
  // An explicit target/type from the model always wins (the page-builder prompt
  // may state it), then the distinguishing fields, then a name-length heuristic.
  const declared = String(payload?.target || payload?.type || '').toLowerCase();
  if (ARTIFACT_TARGETS.includes(declared)) return declared;
  if (declared === 'chat scenario' || declared === 'scenarios') return 'scenario';
  if (declared === 'insight recipe' || declared === 'insights' || declared === 'action') return 'recipe';
  if (payload?.sample !== undefined) return 'scenario';
  const skillOnly = ['tools', 'usePage', 'starter', 'manualOnly', 'description'];
  if (skillOnly.some((k) => payload?.[k] !== undefined)) return 'skill';
  return countChars(String(payload?.name || '')) <= 12 ? 'recipe' : 'scenario';
}

/**
 * Extract importable drafts from the ```json blocks of a model answer, so the
 * chat page can show Import buttons even when the model never called
 * propose_artifact. Invalid blocks are ignored.
 * @param {string} text - Assistant answer text
 * @returns {Array<{target: string, payload: Object, name: string, summary: string}>} Drafts
 */
export function collectArtifactDrafts(text) {
  return collectArtifactDraftsDetailed(text).drafts;
}

/**
 * Find balanced `{...}` objects in free text (outside ``` fences), so a draft the
 * model printed as plain JSON — without a code fence — can still become a card.
 * @param {string} text - Answer text
 * @param {number} [maxObjects=12] - Stop after this many parsed objects
 * @param {number} [maxLength=20000] - Longest object to consider
 * @returns {Array<Object>} Parsed objects, in order of appearance
 */
export function extractBareJsonObjects(text, maxObjects = 12, maxLength = 20000) {
  const out = [];
  const source = String(text || '');
  let i = 0;
  let inFence = false;
  while (i < source.length && out.length < maxObjects) {
    if (source.startsWith('```', i)) {
      inFence = !inFence;
      i += 3;
      continue;
    }
    if (inFence || source[i] !== '{') {
      i++;
      continue;
    }

    // Walk to the matching closing brace, respecting strings and escapes.
    let depth = 0;
    let j = i;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (; j < source.length && j - i <= maxLength; j++) {
      const c = source[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { closed = true; break; }
      }
    }
    if (!closed) break; // unbalanced from here on: nothing more to read

    const candidate = source.slice(i, j + 1);
    try {
      out.push(JSON.parse(candidate));
    } catch (e) { /* not valid JSON — keep scanning after it */ }
    i = j + 1;
  }
  return out;
}

/**
 * Same as collectArtifactDrafts, but also reports what could NOT be turned into a
 * draft and why. Silently dropping an invalid block would look like "Import did
 * nothing", so the chat page shows the rejected items with their reason.
 * @param {string} text - Assistant answer text
 * @returns {{drafts: Array<Object>, rejected: Array<{name: string, reason: string, payload?: any, raw?: string}>}}
 */
export function collectArtifactDraftsDetailed(text) {
  const drafts = [];
  const rejected = [];
  if (!text) return { drafts, rejected };
  const source = String(text);
  const seen = new Set();

  const accept = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    if (!item.name && !item.prompt) return;
    const target = guessArtifactTarget(item);
    const check = normalizeArtifactDraft(target, item);
    if (!check.ok) {
      rejected.push({
        name: String(item.name || '(unnamed)'),
        target,
        reason: check.message,
        raw: JSON.stringify(item, null, 2).slice(0, 800)
      });
      return;
    }
    const key = `${target}:${check.entry.name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push({
      target,
      payload: item,
      name: check.entry.name,
      summary: String(check.entry.description || '').trim()
    });
  };

  const re = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(source))) {
    const raw = m[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      if (raw.startsWith('{') || raw.startsWith('[')) {
        rejected.push({ name: '', reason: `invalid JSON: ${e.message}`, raw: raw.slice(0, 800) });
      }
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) accept(item);
    if (drafts.length + rejected.length >= 8) break;
  }

  // Fallback for models that print the draft as plain JSON, without a fence (or
  // inside a broken tool call): scan for balanced objects.
  if (!drafts.length && !rejected.length) {
    for (const item of extractBareJsonObjects(source)) accept(item);
  }

  return { drafts: drafts.slice(0, 5), rejected: rejected.slice(0, 5) };
}

/**
 * Store drafts as the pending confirmation cards (same shape the
 * propose_artifact tool writes; used when the page parses them from the answer).
 * @param {Array} drafts - [{ target, payload, name, summary }]
 * @param {Array} [rejected] - [{ name, target, reason, raw }] blocks that failed
 *   validation; shown as-is so an import never fails silently.
 * @returns {Promise<void>}
 */
export async function setPendingArtifact(drafts, rejected = []) {
  const list = (Array.isArray(drafts) ? drafts : []).filter((d) => d && d.target && d.payload);
  const bad = (Array.isArray(rejected) ? rejected : []).filter((r) => r && r.reason);
  if (!list.length && !bad.length) return;
  await browser.storage.local.set({
    [DB_KEY.pendingArtifact]: { id: Date.now(), drafts: list, rejected: bad }
  });
}

/**
 * Store the clickable option list (same shape the ask_user_choice tool writes;
 * used when the page parses the list out of the answer).
 * @param {Array} options - [{ title, detail, target }]
 * @param {string} [question] - Optional question shown above the list
 * @returns {Promise<void>}
 */
export async function setPendingChoice(options, question = '') {
  const list = (Array.isArray(options) ? options : []).filter((o) => o && o.title);
  if (!list.length) return;
  await browser.storage.local.set({
    [DB_KEY.pendingChoice]: { id: Date.now(), question: String(question || '').trim(), options: list }
  });
}

/**
 * Validate a draft and write it into the matching list (skills / chat scenarios
 * / insight recipes). Used by the save_* tools and by the confirmation card the
 * user clicks in chat, so both paths behave identically.
 * @param {string} target - 'skill' | 'scenario' | 'recipe'
 * @param {Object} payload - Raw draft payload
 * @param {Object} [options] - { overwrite: boolean }
 * @returns {Promise<{ok: boolean, error?: string, message: string, name?: string, action?: string, count?: number, notes?: Array<string>}>}
 */
export async function applyArtifact(target, payload, options = {}) {
  const overwrite = options.overwrite === true;
  const normalized = normalizeArtifactDraft(target, payload);
  if (!normalized.ok) return { ok: false, error: 'invalid', message: normalized.message };

  const { entry, notes = [] } = normalized;
  const name = entry.name;

  let list;
  if (target === 'skill') {
    list = await loadSkills();
  } else if (target === 'scenario') {
    list = await loadChatScenarios();
  } else if (target === 'recipe') {
    list = await loadInsightActions();
  } else {
    return { ok: false, error: 'invalid', message: `Error: unknown target "${target}". Nothing was saved.` };
  }

  const index = list.findIndex((it) => String(it?.name || '').toLowerCase() === name.toLowerCase());
  const stored = { ...entry };
  let action;
  if (index >= 0) {
    if (!overwrite) {
      return {
        ok: false,
        error: 'exists',
        name,
        message: `A ${artifactTargetLabel(target)} named "${name}" already exists. Pass overwrite=true to replace it, or choose a different name.`
      };
    }
    stored.id = list[index].id ?? ((target === 'skill') ? `skill_${Date.now()}` : Date.now());
    list[index] = stored;
    action = 'updated';
  } else {
    stored.id = (target === 'skill') ? `skill_${Date.now()}` : Date.now();
    list.push(stored);
    action = 'created';
  }

  if (target === 'skill') {
    await saveSkills(list);
  } else if (target === 'scenario') {
    await browser.storage.local.set({ [DB_KEY.chatTpaList]: list });
  } else {
    await browser.storage.local.set({ [DB_KEY.actionList]: list });
  }

  return {
    ok: true,
    name,
    action,
    count: list.length,
    notes,
    message: `${artifactTargetLabel(target)} "${name}" ${action} and saved`
  };
}

/**
 * Read the draft(s) the model proposed that still wait for the user's
 * confirmation in chat.
 * @returns {Promise<Object|null>} { id, drafts: [{ target, payload, name, summary }] } or null
 */
export async function loadPendingArtifact() {
  const data = await browser.storage.local.get(DB_KEY.pendingArtifact);
  const pending = data[DB_KEY.pendingArtifact];
  if (!pending) return null;
  const hasDrafts = Array.isArray(pending.drafts) && pending.drafts.length;
  const hasRejected = Array.isArray(pending.rejected) && pending.rejected.length;
  return (hasDrafts || hasRejected) ? pending : null;
}

/**
 * Read the clickable option list the model asked the user to choose from.
 * @returns {Promise<Object|null>} { id, question, options: [{ title, detail, target }] } or null
 */
export async function loadPendingChoice() {
  const data = await browser.storage.local.get(DB_KEY.pendingChoice);
  const pending = data[DB_KEY.pendingChoice];
  return (pending && Array.isArray(pending.options) && pending.options.length) ? pending : null;
}

/**
 * Drop the pending option list (after the user picked or dismissed it).
 * @returns {Promise<void>}
 */
export async function clearPendingChoice() {
  await browser.storage.local.remove(DB_KEY.pendingChoice);
}

/**
 * Remove one draft from the pending proposal and clear the key when nothing is
 * left, so handled drafts stop being rendered as confirmation cards.
 * @param {number} index - Index of the handled draft
 * @returns {Promise<void>}
 */
export async function removePendingDraft(index) {
  const pending = await loadPendingArtifact();
  if (!pending) return;
  const rest = (pending.drafts || []).filter((_, i) => i !== index);
  const rejected = Array.isArray(pending.rejected) ? pending.rejected : [];
  if (rest.length || rejected.length) {
    await browser.storage.local.set({ [DB_KEY.pendingArtifact]: { ...pending, drafts: rest, rejected } });
  } else {
    await browser.storage.local.remove(DB_KEY.pendingArtifact);
  }
}

/**
 * Tool: store a chat scenario (system prompt + optional sample first message)
 * compiled from a webpage, so it shows up in the chat page's scenario dropdown.
 */
registerTool({
  name: 'save_chat_scenario',
  sideEffect: 'write',
  i18nKey: 'tool_save_chat_scenario',
  description: 'Creates a chat scenario (a reusable system prompt, optionally with a sample first message) so the user can pick it from the scenario dropdown on the chat page. Pass a scenario object: { name, prompt, sample }. Use it only after deciding the page is suitable; set overwrite=true to replace a scenario with the same name.',
  parameters: {
    type: 'object',
    properties: {
      scenario: {
        type: 'object',
        description: 'The scenario to store: { name, prompt, sample? }'
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing scenario with the same name (default false)'
      }
    },
    required: ['scenario']
  },
  func: async (params = {}) => {
    const flat = params && typeof params === 'object' ? params : {};
    const src = (flat.scenario && typeof flat.scenario === 'object')
      ? flat.scenario
      : ((flat.name || flat.prompt) ? flat : {});

    const res = await applyArtifact('scenario', src, { overwrite: flat.overwrite === true });
    if (!res.ok) return res.message;

    const notes = res.notes || [];
    return `Chat scenario "${res.name}" ${res.action} and saved (${res.count} total)${notes.length ? ` — ${notes.join('; ')}` : ''}. ` +
      'The user can select it in the scenario dropdown on the chat page.';
  }
});

/**
 * Tool: store an insight recipe (one-shot analysis prompt) compiled from a
 * webpage, so it becomes a button in the Insightify sidebar / right-click menu.
 */
registerTool({
  name: 'save_insight_action',
  sideEffect: 'write',
  i18nKey: 'tool_save_insight_action',
  description: 'Creates an insight recipe (a one-shot analysis prompt) so the user can run it on any page from the Insightify sidebar or the right-click "Insight" menu. Pass an action object: { name, prompt }, where "name" is a very short label (2-6 characters, max 12) because it is rendered as a small button. Use it only after deciding the page is suitable; set overwrite=true to replace a recipe with the same name.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'object',
        description: 'The insight recipe to store: { name, prompt }'
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing recipe with the same name (default false)'
      }
    },
    required: ['action']
  },
  func: async (params = {}) => {
    const flat = params && typeof params === 'object' ? params : {};
    const src = (flat.action && typeof flat.action === 'object')
      ? flat.action
      : ((flat.name || flat.prompt) ? flat : {});

    const res = await applyArtifact('recipe', src, { overwrite: flat.overwrite === true });
    if (!res.ok) return res.message;

    return `Insight recipe "${res.name}" ${res.action} and saved (${res.count} total). ` +
      'The user can run it from the Insightify sidebar buttons or the right-click "Insight" menu.';
  }
});

/**
 * Tool: ask the user to choose from a clickable list rendered in the chat, so
 * they can pick by clicking instead of typing numbers. Renders and returns: the
 * user's click sends the selection as the next user message.
 */
registerTool({
  name: 'ask_user_choice',
  i18nKey: 'tool_ask_user_choice',
  description: 'Shows a clickable option list inside the chat (for example the separate pieces of the page that could be turned into artifacts) so the user can answer by clicking instead of typing. Pass { question?, options: [{ title, detail?, target? }] }. It only renders the list and returns immediately; the user\'s click sends their selection as the next user message, so stop and wait after calling it.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Optional short question shown above the list' },
      options: {
        type: 'array',
        description: '[{ title, detail?, target?: "skill" | "scenario" | "recipe" }] — 1 to 8 options, each with a short title'
      }
    },
    required: ['options']
  },
  func: async (params = {}) => {
    const flat = params && typeof params === 'object' ? params : {};
    const rawOptions = Array.isArray(flat.options) ? flat.options : [];
    if (!rawOptions.length) {
      return 'Error: nothing to ask. Pass options: [{ title, detail?, target? }].';
    }
    if (rawOptions.length > 8) {
      return 'Error: at most 8 options at a time. Group them or ask the user about the rest afterwards.';
    }

    const options = rawOptions.map((opt, i) => {
      const target = String(opt?.target || '').trim().toLowerCase();
      return {
        title: String(opt?.title || '').trim() || `Option ${i + 1}`,
        detail: String(opt?.detail || opt?.description || '').trim(),
        target: ARTIFACT_TARGETS.includes(target) ? target : ''
      };
    });

    await setPendingChoice(options, flat.question);

    const lines = options.map((o, i) => `${i + 1}. ${o.title}${o.target ? ` [${artifactTargetLabel(o.target)}]` : ''}`);
    return `The list is now shown to the user as clickable options in the chat (${options.length}):\n${lines.join('\n')}\n` +
      'Nothing was chosen yet. Stop here and wait — when the user clicks, their selection arrives as the next user message. ' +
      'Keep the same numbering in your own text so the numbers stay meaningful.';
  }
});

/**
 * Tool: show one or more compiled artifacts as confirmation cards in the chat.
 * This is the "ask before importing" gate: nothing is written until the user
 * clicks Import on a card (or replies with an explicit confirmation, which the
 * model signals through userConfirmed — the cards are the guaranteed path).
 */
registerTool({
  name: 'propose_artifact',
  i18nKey: 'tool_propose_artifact',
  description: 'Shows the compiled artifact(s) to the user as confirmation cards inside the chat. NOTHING is imported: the user must click Import on a card (or explicitly confirm in their next message). Use it after you classified the page content and the user picked what to build. For one draft pass target + payload; for several pass drafts: [{ target, payload, summary? }]. Set userConfirmed:true ONLY when the user\'s previous message explicitly agreed to import.',
  parameters: {
    type: 'object',
    properties: {
      drafts: {
        type: 'array',
        description: '[{ target: "skill" | "scenario" | "recipe", payload: {...}, summary?: "one line for the card" }]'
      },
      target: { type: 'string', description: 'Shorthand for a single draft: "skill", "scenario" or "recipe"' },
      payload: { type: 'object', description: 'Shorthand for a single draft: the artifact body' },
      summary: { type: 'string', description: 'Shorthand for a single draft: one-line summary for the card' },
      userConfirmed: {
        type: 'boolean',
        description: 'Import immediately instead of asking. Set true ONLY when the user\'s previous message explicitly agreed (e.g. "yes, import it"). Default false.'
      }
    }
  },
  func: async (params = {}) => {
    const flat = params && typeof params === 'object' ? params : {};

    // Accept: drafts:[...] | single { target, payload } | flat artifact fields.
    let drafts = [];
    if (Array.isArray(flat.drafts) && flat.drafts.length) {
      drafts = flat.drafts;
    } else if (flat.target) {
      drafts = [{ target: flat.target, payload: flat.payload, summary: flat.summary }];
    } else if (flat.name || flat.prompt) {
      drafts = [{ target: flat.artifactTarget, payload: flat }];
    }

    drafts = drafts.filter((d) => d && typeof d === 'object');
    if (!drafts.length) {
      return 'Error: nothing to propose. Pass drafts: [{ target, payload }] with target = "skill", "scenario" or "recipe".';
    }
    if (drafts.length > 5) {
      return 'Error: at most 5 drafts at a time. Propose fewer and ask the user about the rest afterwards.';
    }

    // Validate everything first: a broken draft must be fixed by the model, not
    // shown to the user as a card that cannot be imported.
    const problems = [];
    const prepared = drafts.map((d, i) => {
      const target = String(d.target || '').trim().toLowerCase();
      const payload = (d.payload && typeof d.payload === 'object') ? d.payload : {};
      const check = normalizeArtifactDraft(target, payload);
      if (!check.ok) problems.push(`draft ${i + 1}: ${check.message}`);
      return {
        target,
        payload,
        name: String(check.entry?.name || ''),
        summary: String(d.summary || check.entry?.description || '').trim()
      };
    });
    if (problems.length) {
      return `Error: the draft(s) are not valid, nothing was proposed:\n- ${problems.join('\n- ')}\nFix them and call propose_artifact again.`;
    }

    if (flat.userConfirmed === true) {
      const results = [];
      for (const d of prepared) {
        const res = await applyArtifact(d.target, d.payload, {});
        results.push(res.ok
          ? `- ${res.message} (${res.count} total in the list)`
          : `- ${res.message}`);
      }
      return `Imported after the user's explicit confirmation:\n${results.join('\n')}\nTell the user where each artifact now appears.`;
    }

    await setPendingArtifact(prepared);

    const lines = prepared.map((d, i) => `${i + 1}. ${artifactTargetLabel(d.target)} — ${d.name}`);
    return `Proposed ${prepared.length} draft(s); they are now shown to the user as confirmation cards in the chat:\n${lines.join('\n')}\n` +
      'Nothing has been imported yet. Stop here and let the user decide: they click Import/Cancel on a card, or answer with changes.\n' +
      '- If they ask for changes, adjust and call propose_artifact again (this replaces the pending cards).\n' +
      '- If they reply with an explicit agreement (e.g. "yes, import it") you may call propose_artifact again with the same draft(s) and userConfirmed:true.';
  }
});

// Initialize theme system for extension pages
if (browser.extension && browser.extension.getBackgroundPage)
  window.themeManager = new ThemeManager();