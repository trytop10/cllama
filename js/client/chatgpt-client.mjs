/**
 * OpenAI ChatGPT API Client
 * Fully compatible with AI Service SDK Standard v1.0
 */
export class ChatGPTClient {
  /**
   * Initializes the client with configuration
   * @param {object} config - Must contain { endpoint, apiKey }
   */
  constructor(config) {
    if (!config || !config.endpoint || !config.apiKey) {
      throw new Error('Missing required configuration: endpoint, apiKey');
    }

    if (config.service) {
      this._service = config.service;
    }

    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;

    this.modelsEndpoint = `${this.endpoint.replace(/\/chat\/completions$/, '')}/models`;

    this.modelsCache = null;
    this.activeSessions = new Map(); // sessionId -> AbortController
  }

  /**
   * Retrieves available models list
   * @param {boolean} forceRefresh - Whether to skip cache
   * @returns {Promise<string[]>} Array of model IDs
   */
  async getModels(forceRefresh = false) {

    if (!forceRefresh && this.modelsCache) {
      return this.modelsCache;
    }

    try {
      const response = await fetch(this.modelsEndpoint, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }

      const data = await response.json();
      this.modelsCache = data.data.map(model => model.id);
      return this.modelsCache;
    } catch (error) {
      console.error('Failed to fetch models:', error);
      throw new Error('Failed to retrieve model list');
    }
  }

  /**
   * Sends a chat request with streaming support
   * @param {object[]} messages - Conversation history
   * @param {object} options - Request options including callbacks
   * @returns {Promise<string>} Session ID
   */
  async sendRequest(messages, options = {}) {
    const sessionId = this._generateSessionId();
    const controller = new AbortController();
    this.activeSessions.set(sessionId, controller);

    // Note: 'think' parameter disabled to avoid errors with some providers
    const think = options?.options?.think ?? true;

    const requestOptions = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature ?? 1,
      top_p: options.top_p ?? 0.9,
      stream: true
    };

    if (typeof options.onStart === 'function') {
      options.onStart(sessionId);
    }

    // Merge provider-specific extra parameters into the request body
    const extraBody = this._buildExtraBody(this.endpoint, requestOptions.model, think);
    const requestBody = { ...requestOptions, ...extraBody };

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `Request failed with status ${response.status}`);
      }

      await this._processStreamResponse(response, sessionId, options);
      return sessionId;
    } catch (error) {
      this.activeSessions.delete(sessionId);
      if (error.name !== 'AbortError' && typeof options.onError === 'function') {
        options.onError(error, sessionId);
      }
      throw error;
    }
  }

  /**
   * Processes streaming response with buffer handling for incomplete data
   * @private
   */
  async _processStreamResponse(response, sessionId, options) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let thinkingText = '';
    let contentText = '';
    let buffer = '';
    let completedNormally = false;

    try {
      while (true) {
        // Check if session was aborted
        if (!this.activeSessions.has(sessionId)) {
          await reader.cancel();
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split by newlines, keeping incomplete last line
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        // 'data: [DONE]' marks the end of an OpenAI SSE stream. We must stop
        // the outer read loop here: some servers/proxies reset the connection
        // right after [DONE], so an extra reader.read() would throw
        // "TypeError: Error in input stream" and wipe a fully-received answer.
        let streamEnded = false;
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          if (trimmedLine === 'data: [DONE]') {
            buffer = '';
            streamEnded = true;
            break;
          }

          const messageStart = trimmedLine.indexOf('data: ');
          if (messageStart === -1) continue;

          const jsonStr = trimmedLine.slice(messageStart + 5).trim();
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices[0]?.delta || {};

            // New API: standalone reasoning_content field for thinking
            if (delta.reasoning_content) {
              thinkingText += delta.reasoning_content;
              if (typeof options.onStream === 'function') {
                const full = '<think>' + thinkingText + '</think>' + contentText;
                options.onStream(delta.reasoning_content, full, sessionId);
              }
            }

            // Content field (both old API with <think> tags and new API body text)
            if (delta.content) {
              contentText += delta.content;
              if (typeof options.onStream === 'function') {
                const full = (thinkingText ? '<think>' + thinkingText + '</think>' : '') + contentText;
                options.onStream(delta.content, full, sessionId);
              }
            }
          } catch (jsonError) {
            throw new Error(`Error: ${jsonError.message}`);
          }
        }

        // Exit the read loop as soon as the stream terminator was seen, so we
        // don't attempt another reader.read() on a possibly-reset connection.
        if (streamEnded) break;
      }

      if (buffer.trim()) {
        console.warn('Unprocessed residual data:', buffer);
      }

      completedNormally = true;
      this.activeSessions.delete(sessionId);
      if (typeof options.onComplete === 'function') {
        const fullResponse = (thinkingText ? '<think>' + thinkingText + '</think>' : '') + contentText;
        options.onComplete(fullResponse, sessionId);
      }
    } catch (error) {
      this.activeSessions.delete(sessionId);
      if (error.name !== 'AbortError' && typeof options.onError === 'function') {
        options.onError(error, sessionId);
      }
      if (error.name !== 'AbortError') {
        throw error;
      }
    } finally {
      // Only cancel the reader when the stream did not complete normally.
      // Cancelling a finished stream can leave a reset keep-alive connection
      // that breaks the immediately-following request (e.g. tool-call loop).
      if (!completedNormally && reader) {
        await reader.cancel().catch(() => {});
      }
    }
  }

  /**
   * Aborts a specific session
   * @param {string} sessionId - Session to abort
   * @returns {boolean} Whether abort was successful
   */
  abort(sessionId) {
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeSessions.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Aborts all active sessions
   */
  abortAllSessions() {
    for (const [sessionId, controller] of this.activeSessions) {
      controller.abort();
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * Generates unique session ID
   * @private
   */
  _generateSessionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }


  /**
   * Builds provider-specific extra body parameters for thinking control
   * @param {string} baseURL - API endpoint URL
   * @param {string} modelName - Model name
   * @param {boolean} thinking - Whether thinking mode is enabled
   * @returns {object} Extra body parameters
   * @private
   */
  /**
   * Whether a Zhipu (bigmodel) model supports the `thinking` parameter
   * (including disabling it). Only a subset of hybrid-reasoning models do;
   * glm-5 series and other models reject or ignore it (HTTP 400 on disable).
   * @param {string} model - Lowercased model name
   * @returns {boolean}
   * @private
   */
  _zhipuSupportsThinkingControl(model) {
    // glm-4.5 / 4.6 series (including 4.5v, 4.6v, air/flash variants of 4.5+)
    // and glm-z1 series; plus explicit "-thinking" variants such as
    // glm-4.1v-thinking. NOT glm-5 series: it does not accept the parameter.
    if (/^glm-(4\.[5-9]|z1)/.test(model)) return true;
    return model.includes('-thinking');
  }

  _buildExtraBody(baseURL, modelName, thinking) {
    const url = (baseURL || '').toLowerCase();
    const model = (modelName || '').toLowerCase();

  if (url.includes('deepseek.com') || model.startsWith('deepseek-')) {
    return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  }

  if (url.includes('moonshot') || model.startsWith('kimi-')) {
    if (model.includes('k3') || model.includes('k2.7-code')) {
      return {};
    }
    return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  }

  if (
    url.includes('dashscope') ||
    url.includes('aliyun') ||
    model.startsWith('qwen')
  ) {

    const isSelfHosted =
      url.includes('vllm') ||
      url.includes('localhost') ||
      url.includes('127.0.0.1') ||
      url.includes('0.0.0.0') ||
      url.includes('192.168.');

    if (isSelfHosted) {
      return { chat_template_kwargs: { enable_thinking: thinking } };
    }
    // Cloud DashScope: only qwen3 hybrid-reasoning models accept
    // `enable_thinking`; sending it to qwen-max/plus/turbo etc. returns 400.
    if (!model.includes('qwen3')) {
      return {};
    }
    return { enable_thinking: thinking };
  }

  if (url.includes('zhipu') || url.includes('bigmodel') || model.startsWith('glm-')) {
    const isSelfHosted =
      url.includes('vllm') ||
      url.includes('localhost') ||
      url.includes('127.0.0.1') ||
      url.includes('0.0.0.0') ||
      url.includes('192.168.');

    if (isSelfHosted) {
      return { chat_template_kwargs: { enable_thinking: thinking } };
    }
    // Zhipu cloud: only hybrid-reasoning models (glm-4.5/4.6, glm-z1, and
    // *-thinking variants) accept the `thinking` parameter; other models
    // (glm-4-plus, glm-4-flash, glm-4-air...) reject it with 400.
    if (this._zhipuSupportsThinkingControl(model)) {
      return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
    }
    return {};
  }

  if (url.includes('api.openai.com')) {
    if (thinking === false) {
      return { reasoning_effort: 'none' };
    }
    return {}; 
  }

  if (url.includes('googleapis') || model.startsWith('gemini-')) {
    if (thinking === false) {
      return { thinking_budget: 0 };
    }
    return {};
  }
  return {};
}
}