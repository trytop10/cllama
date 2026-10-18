import { GoogleGenAI } from './gemini.mjs';
import { normalizeGeminiUsage } from '../token-usage.mjs';
import { toGeminiGenerationConfig, toGeminiFunctionDeclarations } from '../request-options.mjs';

export class GeminiClient {
    constructor(config) {
        if (!config || !config.endpoint) {
            throw new Error('GeminiClient: endpoint is required in config.');
        }
        this.config = { ...config };
        this.apiClient = new GoogleGenAI({
            apiKey: this.config.apiKey,
            // Assuming endpoint can be directly used as baseUrl for GoogleGenAI
            httpOptions: { baseUrl: this.config.endpoint },
            // Vertex AI is false by default, assuming Gemini API for now
            vertexai: this.config.service === 'Google' ? false : false, // Adjust if Vertex AI is needed
        });
        this.activeSessions = new Map();
        this.modelCache = null;
    }

    async getModels(forceRefresh = false) {
        //if (this.modelCache && !forceRefresh) {
        //    return this.modelCache;
        //}

        try {
            const listModelsResponse = await this.apiClient.models.list();
            const modelsArray = listModelsResponse.pageInternal || listModelsResponse.models || (Array.isArray(listModelsResponse) ? listModelsResponse : null);

            if (!modelsArray) {
                console.error('Unexpected response structure for models:', listModelsResponse);
                throw new Error('Failed to fetch models: Unexpected response structure.');
            }

            const models = modelsArray
                .filter(model => model.supportedActions && model.supportedActions.includes('generateContent'))
                .map(model => model.name.replace(/^models\//, ''));

            this.modelCache = models;
            return models;    
        } catch (error) {
            console.error('Error fetching models:', error);
            throw new Error(`Failed to fetch models: ${error.message || error}`);
        }
    }

    async sendRequest(messages, options = {}) {
        const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const abortController = new AbortController();
        this.activeSessions.set(sessionId, abortController);

        const model = options.model || this.config.defaultModel;
        if (!model) {
            throw new Error('GeminiClient: model must be specified or a defaultModel must be configured.');
        }

        const requestParams = {
            model: model,
            contents: messages.map(msg => ({ role: msg.role, parts: msg.parts || [{ text: msg.content }] })),
            config: {
                ...toGeminiGenerationConfig(options),
                httpOptions: {
                    abortSignal: abortController.signal,
                },
            },
        };

        // Native system instruction: chat() merges the scenario prompt and the
        // active Skill into one block and passes it here.
        if (typeof options.systemInstruction === 'string' && options.systemInstruction.trim()) {
            requestParams.config.systemInstruction = options.systemInstruction;
        }

        // Native function declarations. `parametersJsonSchema` accepts the same
        // JSON Schema the registry already uses (including MCP input schemas).
        const functionDeclarations = toGeminiFunctionDeclarations(options.tools);
        if (functionDeclarations.length) {
            requestParams.config.tools = [{ functionDeclarations }];
        }

        if (options.onStart) {
            options.onStart(sessionId);
        }

        let fullText = '';
        // Native function calls: Gemini delivers them as `functionCall` parts
        // (empty text), so they are collected here and handed to the caller —
        // ignoring them made such answers look like an empty reply. They are
        // mapped to the same `{ function: { name, arguments } }` shape the
        // OpenAI-compatible path uses, so chat() can run both the same way.
        const toolCalls = [];
        // Token usage: every chunk may carry `usageMetadata` (the last one is
        // the complete figure, including thinking tokens).
        let usage = null;
        try {
            const stream = await this.apiClient.models.generateContentStream(requestParams);
            for await (const chunk of stream) {
                if (chunk.usageMetadata) {
                    usage = normalizeGeminiUsage(chunk.usageMetadata) || usage;
                }
                const chunkText = chunk.text || '';
                fullText += chunkText;
                if (options.onStream) {
                    options.onStream(chunkText, fullText, sessionId);
                }
                const parts = chunk.candidates?.[0]?.content?.parts;
                if (Array.isArray(parts)) {
                    for (const part of parts) {
                        const call = part?.functionCall;
                        if (call?.name) {
                            toolCalls.push({
                                id: `call_${toolCalls.length}`,
                                type: 'function',
                                function: {
                                    name: call.name,
                                    arguments: JSON.stringify(call.args || {})
                                }
                            });
                        }
                    }
                }
            }
            if (!fullText.trim() && !toolCalls.length) {
                // Nothing usable came back: log the shape so an empty answer is
                // explainable instead of silent.
                console.warn('[GeminiClient] empty completion (no text and no functionCall)', {
                    finishReason: 'unknown'
                });
            }
            if (options.onComplete) {
                options.onComplete(fullText, sessionId, toolCalls, usage);
            }
            return sessionId;
        } catch (error) {
            if (options.onError) {
                options.onError(error, sessionId);
            }
            throw error;
        } finally {
            this.activeSessions.delete(sessionId);
        }
    }

    abort(sessionId) {
        const controller = this.activeSessions.get(sessionId);
        if (controller) {
            controller.abort();
            this.activeSessions.delete(sessionId);
            return true;
        }
        return false;
    }

    abortAllSessions() {
        let abortedCount = 0;
        for (const [sessionId, controller] of this.activeSessions.entries()) {
            controller.abort();
            this.activeSessions.delete(sessionId);
            abortedCount++;
        }
        return abortedCount;
    }
}
