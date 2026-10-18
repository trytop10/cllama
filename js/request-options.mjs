/**
 * Pure mapping helpers shared by the AI clients.
 *
 * `chat()` historically passes the sampling options in the Ollama shape, under
 * `options.options` (`temperature`, `top_p`, `top_k`, `num_predict`, `stop`).
 * Each backend names those fields differently, so the mapping lives here instead
 * of being duplicated (and silently forgotten) inside every client.
 */

/** Returns the first value that is actually defined. */
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

/**
 * Normalize the caller's options to the common sampling shape.
 * @param {Object} [options] - Options passed to a client's sendRequest()
 * @returns {{temperature: (number|undefined), topP: (number|undefined), topK: (number|undefined), maxOutputTokens: (number|undefined), stopSequences: (Array|undefined)}}
 */
export function normalizeSamplingOptions(options = {}) {
  const nested = options.options || {};
  return {
    temperature: firstDefined(options.temperature, nested.temperature),
    topP: firstDefined(options.topP, nested.top_p, nested.topP),
    topK: firstDefined(options.topK, nested.top_k, nested.topK),
    maxOutputTokens: firstDefined(options.maxOutputTokens, nested.num_predict, nested.maxTokens),
    stopSequences: firstDefined(options.stopSequences, nested.stop)
  };
}

/**
 * OpenAI-compatible request fields. Falls back to the historical defaults.
 * @param {Object} [options] - Options passed to sendRequest()
 * @returns {{temperature: number, top_p: number}}
 */
export function openAISamplingOptions(options = {}) {
  const sampling = normalizeSamplingOptions(options);
  return {
    temperature: sampling.temperature ?? 1,
    top_p: sampling.topP ?? 0.9
  };
}

/**
 * Gemini's GenerateContentConfig. Only known fields are forwarded: spreading the
 * Ollama-style options would send `num_ctx`, `think`, … to the Gemini API.
 * @param {Object} [options] - Options passed to sendRequest()
 * @returns {Object} Generation config (undefined fields removed)
 */
export function toGeminiGenerationConfig(options = {}) {
  const sampling = normalizeSamplingOptions(options);
  const config = {
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    maxOutputTokens: sampling.maxOutputTokens,
    stopSequences: sampling.stopSequences
  };
  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key];
  }
  return config;
}

/**
 * Convert the registry's OpenAI-style tool definitions to Gemini function
 * declarations. `parametersJsonSchema` lets the SDK accept the original JSON
 * Schema (including MCP input schemas) without narrowing it to Gemini's Schema
 * subset first.
 * @param {Array<Object>} [tools] - [{ type:'function', function:{ name, description, parameters } }]
 * @returns {Array<Object>} Gemini function declarations
 */
export function toGeminiFunctionDeclarations(tools = []) {
  const list = Array.isArray(tools) ? tools : [];
  return list
    .map((tool) => {
      const fn = tool?.function || tool || {};
      const name = typeof fn.name === 'string' ? fn.name.trim() : '';
      if (!name) return null;
      return {
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parametersJsonSchema: fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} }
      };
    })
    .filter(Boolean);
}
