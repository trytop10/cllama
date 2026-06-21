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
    const think = true;

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

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(think ? requestOptions : { think, ...requestOptions }),
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

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          if (trimmedLine === 'data: [DONE]') {
            buffer = '';
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
      }

      if (buffer.trim()) {
        console.warn('Unprocessed residual data:', buffer);
      }

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
      if (reader) {
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
}