import { ChatGPTClient } from './chatgpt-client.mjs';
import { OllamaClient } from './ollama-client.mjs';
import { GeminiClient } from './gemini-client.mjs';
import { isGemini } from '../util.js';

// Internal cache to store initialized client instances to avoid redundant creation.
const serviceCache = new Map();

/**
 * Internal factory function to create a client instance based on the configuration.
 * Centralizes the creation logic to ensure consistency between getService and getServiceInstance.
 * * @param {Object} config - The configuration object containing service details.
 * @returns {Object} A new instance of the specific client.
 */
function createClient(config) {
    const { service, apiUrl: endpoint, apiKey, modelName: defaultModel } = config;
    // Use "-" as a fallback if apiKey is missing, common for local or self-hosted services.
    const safeApiKey = apiKey || "-"; 

    if (service === "ollama") {
        return new OllamaClient({ endpoint, defaultModel });
    }

    if (isGemini(config)) {
        return new GeminiClient({ 
            service, 
            endpoint, 
            apiKey: safeApiKey, 
            defaultModel 
        });
    }

    if (endpoint) {
        let ep_ = endpoint;
        if(!endpoint.endsWith("chat/completions")){
            ep_ = endpoint + (endpoint.endsWith("/")?"chat/completions":"/chat/completions");
        }
        return new ChatGPTClient({ 
            service, 
            endpoint: ep_, 
            apiKey: safeApiKey, 
            defaultModel 
        });
    }

    throw new Error(`Unsupported service or configuration: ${service}`);
}

/**
 * Retrieves a cached service instance or creates a new one if it doesn't exist.
 * Uses a composite key to ensure uniqueness for different configurations.
 * * @param {Object} runtimeConfig - Configuration for the service.
 * @returns {Object} The client instance.
 */
export function getServiceInstance(runtimeConfig) {
    // Cache by the actual connection parameters. Including the API key keeps
    // two configurations of the same provider/endpoint from sharing the wrong
    // client, while base and dsList entries that point at the same endpoint
    // still share one instance (and its native-tools capability cache).
    const cacheKey = `${runtimeConfig.service}|${runtimeConfig.apiUrl}|${runtimeConfig.apiKey || ''}`;

    // Return cached instance if it exists
    if (serviceCache.has(cacheKey)) {
        return serviceCache.get(cacheKey);
    }

    // Create new instance and store it in cache
    const newInstance = createClient(runtimeConfig);
    serviceCache.set(cacheKey, newInstance);

    return newInstance;
}

/**
 * Legacy or direct accessor to get a service instance without caching logic.
 * Wraps parameters into a config object to reuse the central createClient logic.
 * * @param {string} service - The service name.
 * @param {string} apiUrl - The API endpoint URL.
 * @param {string} apiKey - The API key.
 * @returns {Object} The client instance.
 */
export function getService(service, apiUrl, apiKey) {
    // Construct a config object to reuse the unified factory logic
    const config = {
        service,
        apiUrl,
        apiKey
    };
    
    return createClient(config);
}