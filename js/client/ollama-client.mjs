import { Ollama } from './ollama.mjs'

const DEFAULT_MODEL = 'gemma3';

/**
 * Ollama AI Service Client (Browser Environment)
 * Provides streaming chat with session management and model caching
 */
export class OllamaClient {
  constructor(config) {
    if (!config || !config.endpoint) {
      throw new Error('Endpoint is required in config')
    }

    this.client = new Ollama({
      host: config.endpoint,
    })

    this.config = {
      ...config,
      defaultModel: config.defaultModel || DEFAULT_MODEL,
    }

    this.activeSessions = new Map() // sessionId -> { controller, request }
    this.cachedModels = null
    this._nativeToolsCache = null
  }

  /**
   * Retrieves available models list
   * @param {boolean} forceRefresh - Whether to skip cache
   * @returns {Promise<string[]>} Array of model names
   */
  async getModels(forceRefresh = false) {
    try {
      if (!forceRefresh && this.cachedModels) {
        return this.cachedModels
      }

      const response = await this.client.list()
      this.cachedModels = response.models.map(model => model.name)
      return this.cachedModels
    } catch (error) {
      console.error('Failed to fetch models:', error)
      throw new Error(`Failed to get models: ${error.message}`)
    }
  }

  /**
   * Sends a chat request with streaming support
   * @param {object[]} messages - Conversation history
   * @param {object} options - Request options including model, options object, and callbacks
   * @returns {Promise<string>} Session ID
   */
  async sendRequest(messages, options = {}) {
    if (!messages || !Array.isArray(messages)) {
      throw new Error('Messages must be an array')
    }

    const model = options.model || this.config.defaultModel;
    const num_ctx = this.estimateTokens(JSON.stringify(messages));

    const ops = { ...options.options };

    // Auto-set context window if needed
    if (!ops.num_ctx && num_ctx > 1800)
      ops.num_ctx = num_ctx;

    const think = options?.options?.think ?? true;

    let sessionId = null;
    let abortController = null;
    let abortableAsyncIterator = null;
    let thinkingBuilder = [];
    let contentBuilder = [];
    let completedNormally = false;
    let toolCalls = [];

    let requestOptions = {
      model,
      messages,
      options: ops,
      stream: true
    };
    if (options.tools)
      requestOptions.tools = options.tools;
    if (!think)
      requestOptions["think"] = false;

    try {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      if (typeof options.onStart === 'function') {
        options.onStart(sessionId)
      }

      abortController = new AbortController()

      this.activeSessions.set(sessionId, {
        controller: abortController,
        request: requestOptions
      })

      abortableAsyncIterator = await this.client.chat({
        signal: abortController.signal,
        ...requestOptions
      });

      for await (const part of abortableAsyncIterator) {
        // Check if session was aborted
        if (!this.activeSessions.has(sessionId)) {
          break
        }

        // New Ollama API: standalone thinking field
        if (part.message?.thinking) {
          const chunk = part.message.thinking
          thinkingBuilder.push(chunk);

          if (typeof options.onStream === 'function') {
            const thinkingText = thinkingBuilder.join('');
            const full = '<think>' + thinkingText + '</think>' + contentBuilder.join('');
            options.onStream(chunk, full, sessionId)
          }
        }

        // Content field (both old API with <think> tags and new API body text)
        if (part.message?.content) {
          const chunk = part.message.content
          contentBuilder.push(chunk);

          if (typeof options.onStream === 'function') {
            const thinkingText = thinkingBuilder.join('');
            const full = (thinkingText ? '<think>' + thinkingText + '</think>' : '') + contentBuilder.join('');
            options.onStream(chunk, full, sessionId)
          }
        }

        // Native tool calls (Ollama models with tools capability, e.g. qwen3)
        if (Array.isArray(part.message?.tool_calls) && part.message.tool_calls.length) {
          toolCalls = part.message.tool_calls;
        }
      }

      if (this.activeSessions.has(sessionId)) {
        const thinkingText = thinkingBuilder.join('');
        const fullResponse = (thinkingText ? '<think>' + thinkingText + '</think>' : '') + contentBuilder.join('');
        // Mark as completed normally so the finally block does not abort the
        // underlying stream. Aborting a completed fetch can reset the keep-alive
        // connection, causing "ResponseError: EOF" on a immediately-following
        // back-to-back request (e.g. the multi-round tool-call loop in chat()).
        completedNormally = true;
        if (typeof options.onComplete === 'function') {
          options.onComplete(fullResponse, sessionId, toolCalls)
        }
        this.activeSessions.delete(sessionId)
      }

      return sessionId
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('[Ollama sendRequest error]', {
          message: error.message,
          model,
          num_ctx: ops.num_ctx,
          messagesLen: JSON.stringify(messages).length,
          messages: (messages || []).map(m => ({
            role: m.role,
            len: String(m.content || (m.parts && m.parts[0] && m.parts[0].text) || '').length
          }))
        }, error);
      }
      if (error.name !== 'AbortError' && typeof options.onError === 'function') {
        options.onError(error, sessionId)
      }

      if (this.activeSessions.has(sessionId)) {
        this.activeSessions.delete(sessionId)
      }

      if (error.name !== 'AbortError') {
        throw error
      }

      return sessionId
    } finally {
      // Cleanup: only abort the underlying stream if it did not complete
      // normally (i.e. on error or user cancel). Aborting a finished stream
      // can leave a reset keep-alive connection that breaks the next request.
      if (!completedNormally && abortableAsyncIterator && typeof abortableAsyncIterator.abort === 'function') {
        abortableAsyncIterator.abort();
      }

      if (this.activeSessions.has(sessionId)) {
        this.activeSessions.delete(sessionId);
      }
    }
  }

  /**
   * Aborts a specific session
   * @param {string} sessionId - Session to abort
   * @returns {boolean} Whether abort was successful
   */
  abort(sessionId) {
    if (!sessionId) return false

    const session = this.activeSessions.get(sessionId)
    if (session) {
      try {
        session.controller.abort()
        this.activeSessions.delete(sessionId)
        return true
      } catch (e) {
        console.error('Abort error:', e)
        return false
      }
    }
    return false
  }

  /**
   * Aborts all active sessions
   * @returns {number} Number of sessions aborted
   */
  abortAllSessions() {
    let count = 0
    for (const [sessionId, session] of this.activeSessions) {
      try {
        session.controller.abort()
        this.activeSessions.delete(sessionId)
        count++
      } catch (e) {
        console.error(`Error aborting session ${sessionId}:`, e)
      }
    }
    return count
  }

  /**
   * Whether the given Ollama model supports native function calling (tools).
   * Result is cached per model.
   * @param {string} model - Model name
   * @returns {Promise<boolean>}
   */
  async hasNativeTools(model) {
    const m = model || this.config.defaultModel;
    if (this._nativeToolsCache && this._nativeToolsCache.model === m) {
      return this._nativeToolsCache.value;
    }
    let value = false;
    try {
      const info = await this.client.show({ model: m });
      value = Array.isArray(info.capabilities) && info.capabilities.includes('tools');
    } catch (e) {
      console.warn('Failed to detect native tools support:', e.message);
      value = false;
    }
    this._nativeToolsCache = { model: m, value };
    return value;
  }

  /**
   * Estimates token count for mixed Chinese/English text
   * @param {string} text - Input text
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (!text) return 0;

    const chinese = text.match(/[\u4e00-\u9fa5]/g) || [];
    const words = text.split(/[\s\n]+/).filter(w => w);
    const symbols = text.match(/[^\p{L}\s]/gu) || [];

    // Estimation based on GPT-4 encoding patterns
    const chineseTokens = chinese.length * 1.3; // ~2.5 tokens per character
    const wordTokens = words.length * 1.3;
    const symbolTokens = symbols.length * 0.7;

    // Add 10% safety margin
    return Math.ceil((chineseTokens + wordTokens + symbolTokens) * 1.1);
  }
}