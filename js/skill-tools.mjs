/**
 * SKILL & TOOL specifications for cllama chat.
 *
 * ── SKILL ────────────────────────────────────────────────────────────────
 * A "skill" is a user-defined capability (a subset of the skills found in
 * tools like cc / codex / cline). Each skill declares a system prompt and an
 * optional list of allowed tool names. Skills are stored in
 * `DB_KEY.skillList` and can be added/edited/deleted by the user.
 *
 *   {
 *     id: "unique-string",
 *     name: "Name shown in the / picker",
 *     description: "Short description shown in the / picker",
 *     prompt: "System prompt injected when the skill is active",
 *     tools: ["toolName1", "toolName2"]   // allowed tools; empty = none
 *   }
 *
 * ── TOOL ────────────────────────────────────────────────────────────────
 * A "tool" is a pre-written function registered in this module. Tools are
 * called by the model using a text-based protocol that works across all
 * backends (OpenAI-compatible / Gemini / Ollama).
 *
 *   {
 *     name: "toolName",
 *     description: "Description shown to the model",
 *     parameters: { type: "object", properties: {...} },  // JSON Schema-ish
 *     func: async (args) => "string result"
 *   }
 *
 * The model requests a tool by emitting a <tool_call> block; the harness
 * (see cllama.js chat()) executes it and feeds back a <tool_result> block.
 */

// Maximum number of tool-call iterations allowed per single chat turn.
export const SKILL_TOOL_MAX_ITER = 6;

// ------------------- Tool registry -------------------
const toolRegistry = new Map();

/**
 * Register a tool definition.
 * @param {Object} tool - { name, description, parameters, func }
 */
export function registerTool(tool) {
  if (!tool || !tool.name || typeof tool.func !== 'function') {
    throw new Error(`Invalid tool definition: ${tool?.name || tool}`);
  }
  toolRegistry.set(tool.name, tool);
}

/**
 * Get a registered tool by name.
 * @param {string} name - Tool name
 * @returns {Object|undefined}
 */
export function getTool(name) {
  return toolRegistry.get(name);
}

/**
 * List all registered tools.
 * @returns {Array<Object>}
 */
export function listTools() {
  return [...toolRegistry.values()];
}

// ------------------- Built-in tools -------------------

registerTool({
  name: 'current_time',
  i18nKey: 'tool_current_time',
  description: 'Returns the current date and time in the user\'s locale.',
  parameters: { type: 'object', properties: {} },
  func: async () => new Date().toLocaleString()
});

registerTool({
  name: 'add_numbers',
  i18nKey: 'tool_add_numbers',
  description: 'Adds a list of numbers and returns the sum. Provide "numbers" as an array of numbers.',
  parameters: {
    type: 'object',
    properties: { numbers: { type: 'array', items: { type: 'number' } } },
    required: ['numbers']
  },
  func: async ({ numbers }) => {
    const arr = Array.isArray(numbers) ? numbers : [];
    const total = arr.reduce((sum, n) => sum + Number(n), 0);
    return String(total);
  }
});

registerTool({
  name: 'echo',
  i18nKey: 'tool_echo',
  description: 'Echoes back the exact text given in the "text" argument.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  func: async ({ text }) => String(text ?? '')
});

registerTool({
  name: 'fetch_url',
  i18nKey: 'tool_fetch_url',
  description: 'Fetches the text content of a URL and returns up to maxLen characters. May fail if the URL is blocked by CORS or extension permissions.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      maxLen: { type: 'number' }
    },
    required: ['url']
  },
  func: async ({ url, maxLen = 3000 }) => {
    if (!url) return 'Error: no url provided';
    try {
      const resp = await fetch(url);
      if (!resp.ok) return `Error: HTTP ${resp.status}`;
      const text = await resp.text();
      return text.slice(0, Number(maxLen) || 3000);
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }
});

// ---- Safe arithmetic evaluator (no eval) ----
const SAFE_PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

function safeCalcValue(expr) {
  const tokens = String(expr || '').replace(/\s+/g, '').match(/(\d+\.?\d*|\+|-|\*|\/|\^|%|\(|\))/g);
  if (!tokens) return NaN;
  const output = [];
  const ops = [];
  for (const t of tokens) {
    if (/^\d/.test(t)) { output.push(parseFloat(t)); continue; }
    if (t === '(') { ops.push(t); continue; }
    if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop());
      ops.pop();
      continue;
    }
    if (t in SAFE_PREC) {
      while (ops.length && ops[ops.length - 1] !== '(' && SAFE_PREC[ops[ops.length - 1]] >= SAFE_PREC[t]) output.push(ops.pop());
      ops.push(t);
    } else {
      return NaN;
    }
  }
  while (ops.length) output.push(ops.pop());
  const stack = [];
  for (const t of output) {
    if (typeof t === 'number') { stack.push(t); continue; }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return NaN;
    let r;
    switch (t) {
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '*': r = a * b; break;
      case '/': r = b === 0 ? NaN : a / b; break;
      case '%': r = a % b; break;
      case '^': r = Math.pow(a, b); break;
    }
    stack.push(r);
  }
  return stack[0];
}

registerTool({
  name: 'safe_calculate',
  i18nKey: 'tool_safe_calculate',
  description: 'Safely evaluates a math expression using + - * / % ^ and parentheses, e.g. "2*(3+4)^2".',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'Math expression to evaluate' } },
    required: ['expression']
  },
  func: async ({ expression }) => {
    const res = safeCalcValue(expression);
    if (typeof res !== 'number' || !isFinite(res)) return 'Error: could not evaluate expression';
    return String(Math.round(res * 1e10) / 1e10);
  }
});

registerTool({
  name: 'text_stats',
  i18nKey: 'tool_text_stats',
  description: 'Returns statistics for a text: total chars, words, sentences and CJK characters.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  func: async ({ text }) => {
    const s = String(text || '');
    const words = (s.match(/\S+/g) || []).length;
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const sentences = (s.match(/[^.!?。！？]+[.!?。！？]?/g) || []).filter(x => x.trim()).length;
    return `chars: ${s.length}, words: ${words}, sentences: ${sentences}, CJK chars: ${cjk}`;
  }
});

registerTool({
  name: 'generate_uuid',
  i18nKey: 'tool_generate_uuid',
  description: 'Generates a random UUID v4 string.',
  parameters: { type: 'object', properties: {} },
  func: async () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
});

registerTool({
  name: 'random_number',
  i18nKey: 'tool_random_number',
  description: 'Returns a random integer between min and max (inclusive).',
  parameters: {
    type: 'object',
    properties: {
      min: { type: 'number', description: 'Lower bound (default 1)' },
      max: { type: 'number', description: 'Upper bound (default 100)' }
    }
  },
  func: async ({ min = 1, max = 100 }) => {
    const lo = Math.ceil(Number(min));
    const hi = Math.floor(Number(max));
    if (isNaN(lo) || isNaN(hi) || lo > hi) return 'Error: invalid range';
    return String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
  }
});

registerTool({
  name: 'base64_encode',
  i18nKey: 'tool_base64_encode',
  description: 'Encodes the given text to base64 (UTF-8 safe).',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  func: async ({ text }) => {
    try { return btoa(unescape(encodeURIComponent(String(text || '')))); }
    catch (e) { return `Error: ${e.message}`; }
  }
});

registerTool({
  name: 'base64_decode',
  i18nKey: 'tool_base64_decode',
  description: 'Decodes a base64 string back to text (UTF-8 safe).',
  parameters: {
    type: 'object',
    properties: { encoded: { type: 'string' } },
    required: ['encoded']
  },
  func: async ({ encoded }) => {
    try { return decodeURIComponent(escape(atob(String(encoded || '')))); }
    catch (e) { return `Error: ${e.message}`; }
  }
});

registerTool({
  name: 'url_encode',
  i18nKey: 'tool_url_encode',
  description: 'URL-encodes the given text (component encoding).',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  func: async ({ text }) => encodeURIComponent(String(text || ''))
});

registerTool({
  name: 'url_decode',
  i18nKey: 'tool_url_decode',
  description: 'URL-decodes the given encoded text.',
  parameters: {
    type: 'object',
    properties: { encoded: { type: 'string' } },
    required: ['encoded']
  },
  func: async ({ encoded }) => {
    try { return decodeURIComponent(String(encoded || '')); }
    catch (e) { return `Error: ${e.message}`; }
  }
});

registerTool({
  name: 'get_browser_info',
  i18nKey: 'tool_get_browser_info',
  description: 'Returns browser/system info: user agent, language, platform, timezone and current timestamp.',
  parameters: { type: 'object', properties: {} },
  func: async () => JSON.stringify({
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timestamp: new Date().toLocaleString()
  })
});

registerTool({
  name: 'get_page_content',
  i18nKey: 'tool_get_page_content',
  description: 'Returns the content of the current webpage (title, url and extracted text) to answer questions about the page.',
  parameters: { type: 'object', properties: {} },
  func: async () => {
    const browserRef = typeof chrome !== 'undefined' ? chrome : (typeof browser !== 'undefined' ? browser : null);
    if (!browserRef || !browserRef.tabs) return 'Error: tabs API unavailable';
    try {
      const tabs = await browserRef.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) return 'Error: no active tab';
      const resp = await browserRef.tabs.sendMessage(tab.id, { action: 'getPageInfo' });
      if (resp && resp.content) {
        return `Title: ${resp.title || ''}\nURL: ${resp.url || ''}\n\n${resp.content}`;
      }
      return 'Error: no page content available';
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }
});

registerTool({
  name: 'convert_temperature',
  i18nKey: 'tool_convert_temperature',
  description: 'Converts a temperature between Celsius (C), Fahrenheit (F) and Kelvin (K). from/to are unit codes, e.g. "C", "F", "K".',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'number' },
      from: { type: 'string', description: 'Source unit: C, F or K' },
      to: { type: 'string', description: 'Target unit: C, F or K' }
    },
    required: ['value', 'from', 'to']
  },
  func: async ({ value, from = 'C', to = 'F' }) => {
    const v = Number(value);
    if (isNaN(v)) return 'Error: invalid value';
    const uf = String(from).toUpperCase();
    const ut = String(to).toUpperCase();
    let c;
    if (uf === 'C') c = v;
    else if (uf === 'F') c = (v - 32) * 5 / 9;
    else if (uf === 'K') c = v - 273.15;
    else return `Error: unknown unit ${from}`;
    let out;
    if (ut === 'C') out = c;
    else if (ut === 'F') out = c * 9 / 5 + 32;
    else if (ut === 'K') out = c + 273.15;
    else return `Error: unknown unit ${to}`;
    return `${Math.round(out * 100) / 100} ${ut}`;
  }
});

const LENGTH_UNITS = { m: 1, cm: 0.01, mm: 0.001, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 };

registerTool({
  name: 'convert_length',
  i18nKey: 'tool_convert_length',
  description: 'Converts a length between m, cm, mm, km, in, ft, yd and mi. from/to are unit codes.',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'number' },
      from: { type: 'string', description: 'Source unit' },
      to: { type: 'string', description: 'Target unit' }
    },
    required: ['value', 'from', 'to']
  },
  func: async ({ value, from = 'm', to = 'cm' }) => {
    const v = Number(value);
    if (isNaN(v)) return 'Error: invalid value';
    const f = String(from).toLowerCase();
    const t = String(to).toLowerCase();
    if (!(f in LENGTH_UNITS) || !(t in LENGTH_UNITS)) return 'Error: unknown unit';
    const out = v * LENGTH_UNITS[f] / LENGTH_UNITS[t];
    return `${Math.round(out * 1e6) / 1e6} ${t}`;
  }
});

// ------------------- Tool-call text protocol -------------------
const TOOL_CALL_BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/**
 * Extract tool call blocks from a model response.
 * @param {string} text - Model response text
 * @returns {Array<{name:string, args:Object}>}
 */
export function parseToolCalls(text) {
  if (!text) return [];
  const calls = [];
  let m;
  const re = new RegExp(TOOL_CALL_BLOCK_RE);
  while ((m = re.exec(text))) {
    const body = m[1];
    const nameMatch = body.match(/<tool_name>([\s\S]*?)<\/tool_name>/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const argsMatch = body.match(/<args>([\s\S]*?)<\/args>/);
    let args = {};
    if (argsMatch) {
      try {
        args = JSON.parse(argsMatch[1].trim());
      } catch (e) {
        args = { _parseError: argsMatch[1].trim() };
      }
    }
    calls.push({ name, args });
  }
  return calls;
}

/**
 * Remove tool call blocks from text intended for display.
 * @param {string} text - Raw model response
 * @returns {string} Text safe for display
 */
export function stripToolCalls(text) {
  if (!text) return '';
  return text.replace(TOOL_CALL_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Build the tool-calling instructions appended to a skill's system prompt.
 * @param {Object} activeSkill - The active skill { name, tools: string[] }
 * @returns {string} Empty string if the skill declares no tools.
 */
export function buildToolInstructions(activeSkill) {
  const entries = Array.isArray(activeSkill?.tools) ? activeSkill.tools : [];
  const tools = [];
  for (const entry of entries) {
    const name = entry && typeof entry === 'object' ? entry.name : entry;
    const args = entry && typeof entry === 'object' ? entry.args : undefined;
    const tool = getTool(name);
    if (!tool) continue;
    tools.push({ tool, args });
  }
  if (!tools.length) return '';

  const lines = tools.map(({ tool, args }) => {
    let line = `- ${tool.name}: ${tool.description}`;
    if (args && Object.keys(args).length) {
      line += ` (default args: ${JSON.stringify(args)})`;
    }
    return line;
  });

  return [
    `Available tools:`,
    lines.join('\n'),
    '',
    'To call a tool, reply with exactly one line:',
    '<tool_call><tool_name>TOOL_NAME</tool_name><args>{json}</args></tool_call>',
    'then STOP and wait for the result.'
  ].join('\n');
}

/**
 * Build the full system message (skill prompt + tool instructions) for an active skill.
 * @param {Object} activeSkill - Active skill
 * @returns {string}
 */
export function buildSkillSystemMessage(activeSkill) {
  if (!activeSkill) return '';
  const toolPart = buildToolInstructions(activeSkill);
  const parts = [];
  if (activeSkill.prompt) parts.push(activeSkill.prompt);
  if (toolPart) parts.push(toolPart);
  return parts.join('\n\n---\n\n');
}

/**
 * Execute a single parsed tool call against the active skill's allowed tools,
 * merging the skill's configured default args with the model-provided args
 * (model-provided values take precedence).
 * @param {Object} call - { name, args }
 * @param {Object} activeSkill - The active skill (with its tools config)
 * @returns {Promise<string>} A <tool_result> text block
 */
export async function executeToolCall(call, activeSkill) {
  const tool = toolRegistry.get(call?.name);
  const allowed = Array.isArray(activeSkill?.tools)
    ? activeSkill.tools.map(t => (t && typeof t === 'object' ? t.name : t))
    : [];

  let defaultArgs = {};
  if (Array.isArray(activeSkill?.tools)) {
    const entry = activeSkill.tools.find(t => (t && typeof t === 'object' ? t.name : t) === call?.name);
    if (entry && typeof entry === 'object' && entry.args) defaultArgs = entry.args;
  }

  const wrap = (success, output) =>
    `<tool_result>\n<tool_name>${call.name}</tool_name>\n<success>${success}</success>\n<output>${String(output)}</output>\n</tool_result>`;

  if (!tool) return wrap(false, `Unknown tool: ${call.name}`);
  if (allowed.length && !allowed.includes(call.name)) {
    return wrap(false, `Tool "${call.name}" is not allowed by the active skill.`);
  }

  const mergedArgs = { ...defaultArgs, ...(call.args || {}) };
  try {
    const out = await tool.func(mergedArgs);
    return wrap(true, out);
  } catch (e) {
    return wrap(false, `Error: ${e.message}`);
  }
}

/**
 * Execute a tool by name and return a plain-text result (used by the native
 * function-calling path). Validates against the active skill's allowed tools
 * and merges configured default args.
 * @param {string} name - Tool name
 * @param {Object} args - Arguments provided by the model
 * @param {Object} activeSkill - The active skill
 * @returns {Promise<string>} Plain text result
 */
export async function runTool(name, args, activeSkill) {
  const tool = toolRegistry.get(name);
  const allowed = Array.isArray(activeSkill?.tools)
    ? activeSkill.tools.map(t => (t && typeof t === 'object' ? t.name : t))
    : [];

  if (!tool) return `Unknown tool: ${name}`;
  if (allowed.length && !allowed.includes(name)) {
    return `Tool "${name}" is not allowed by the active skill.`;
  }

  let defaultArgs = {};
  if (Array.isArray(activeSkill?.tools)) {
    const entry = activeSkill.tools.find(t => (t && typeof t === 'object' ? t.name : t) === name);
    if (entry && typeof entry === 'object' && entry.args) defaultArgs = entry.args;
  }

  const mergedArgs = { ...defaultArgs, ...(args || {}) };
  try {
    return String(await tool.func(mergedArgs));
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

/**
 * Build an Ollama/OpenAI-style `tools` array for the active skill's tools.
 * @param {Object} activeSkill - The active skill
 * @returns {Array} Native tools definitions (empty if none)
 */
export function buildNativeTools(activeSkill) {
  const entries = Array.isArray(activeSkill?.tools) ? activeSkill.tools : [];
  const tools = [];
  for (const entry of entries) {
    const name = entry && typeof entry === 'object' ? entry.name : entry;
    const tool = getTool(name);
    if (!tool) continue;
    tools.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {} }
      }
    });
  }
  return tools;
}

