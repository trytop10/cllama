/**
 * Image-generation client. One instance speaks one protocol (currently
 * OpenRouter Images) through its codec, but always returns the canonical
 * response from `js/image-protocol.mjs`.
 */

import { buildModelsEndpoint, sortModelNames } from '../api-providers.mjs';
import {
  IMAGE_ERROR_CODES,
  buildImageModelsEndpoint,
  imageCapabilitiesFor,
  normalizeImageError
} from '../image-protocol.mjs';
import { getImageCodec } from '../image-codecs.mjs';

/** Request timeout for a generation call (images routinely take 30–180s). */
const DEFAULT_TIMEOUT_MS = 300000;
/** Hard cap on one downloaded image. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Error with a stable code the UI can localise. */
export class ImageClientError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'ImageClientError';
    this.code = code;
    this.status = details.status ?? null;
    this.retryable = details.retryable === true;
    this.raw = details.raw ?? null;
  }
}

export class ImageClient {
  /**
   * @param {Object} config - { protocol, endpoint, apiKey, defaultModel, service, modelsEndpoint }
   */
  constructor(config) {
    if (!config || !config.endpoint) {
      throw new Error('ImageClient: endpoint is required');
    }
    this.protocol = config.protocol || '';
    this.codec = getImageCodec(this.protocol);
    if (!this.codec) {
      throw new ImageClientError(
        IMAGE_ERROR_CODES.UNSUPPORTED_PROTOCOL,
        `unsupported image protocol: ${this.protocol || '(none)'}`
      );
    }
    this.endpoint = String(config.endpoint).replace(/\/+$/, '');
    this.apiKey = config.apiKey || '-';
    this.defaultModel = config.defaultModel || '';
    this.service = config.service || '';
    this.modelsEndpoint = config.modelsEndpoint
      || buildImageModelsEndpoint({ imageApiUrl: this.endpoint, service: this.service });
    this.modelsCache = null;
    this.activeSessions = new Map();
  }

  /**
   * Reads the provider's image-model catalogue. Falls back to the regular
   * `/models` endpoint when the dedicated endpoint is unavailable.
   * @param {boolean} forceRefresh - Skip the cache
   * @returns {Promise<{ids: string[], infoById: Object}>}
   */
  async getImageModels(forceRefresh = false) {
    if (!forceRefresh && this.modelsCache) return this.modelsCache;

    const endpoints = [];
    if (this.modelsEndpoint) endpoints.push(this.modelsEndpoint);
    if (this.endpoint) {
      // `/api/v1/images/models` is the dedicated catalogue; if a gateway does
      // not expose it, the general `/api/v1/models?output_modalities=image`
      // endpoint still answers (OpenRouter supports that filter).
      let fallback = buildModelsEndpoint(this.endpoint);
      try {
        const url = new URL(this.endpoint);
        if (/\/images(?:\/models)?$/.test(url.pathname)) {
          url.pathname = url.pathname.replace(/\/images(?:\/models)?$/, '/models');
          url.search = '';
          fallback = url.toString();
        }
      } catch (error) {
        // Keep the string-based fallback for relative endpoints.
      }
      if (fallback && !endpoints.includes(fallback)) endpoints.push(fallback);
    }

    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const url = new URL(endpoint);
        // The dedicated `/images/models` endpoint already lists only image
        // models; the generic `/models` fallback needs the filter.
        if (!/\/images\/models$/.test(url.pathname) && !url.searchParams.has('output_modalities')) {
          url.searchParams.set('output_modalities', 'image');
        }
        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        });
        if (!response.ok) {
          lastError = new Error(`model list failed with status ${response.status}`);
          continue;
        }
        const payload = await response.json();
        const list = Array.isArray(payload?.data) ? payload.data : [];
        const infoById = {};
        const ids = [];
        for (const item of list) {
          const id = typeof item?.id === 'string' ? item.id : '';
          if (!id) continue;
          ids.push(id);
          infoById[id] = item;
        }
        this.modelsCache = { ids: sortModelNames(ids), infoById };
        return this.modelsCache;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Failed to retrieve image model list');
  }

  /**
   * Capabilities for one model (dynamic catalogue data when available).
   * @param {Object} entry - Provider entry
   * @param {string} [model] - Model id
   * @returns {Object} Capabilities descriptor
   */
  getCapabilities(entry, model = '') {
    const info = model ? this.modelsCache?.infoById?.[model] : null;
    return imageCapabilitiesFor(entry, info);
  }

  /**
   * Generates images and returns the canonical response.
   * @param {Object} request - Canonical request from normalizeImageRequest()
   * @param {Object} [options] - { signal, timeoutMs, onStart, onComplete, onError }
   * @returns {Promise<{sessionId: string, images: Array, usage: Object, warnings: Array}>}
   */
  async generate(request, options = {}) {
    const sessionId = this._generateSessionId();
    const controller = new AbortController();
    this.activeSessions.set(sessionId, controller);

    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    if (typeof options.onStart === 'function') options.onStart(sessionId);

    try {
      const body = this.codec.buildRequest(request);
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) throw await this._errorFromResponse(response);

      const payload = await response.json();
      const parsed = this.codec.parseResponse(payload, request.n || 1);
      if (!parsed.ok) {
        throw new ImageClientError(
          parsed.error?.code || IMAGE_ERROR_CODES.EMPTY,
          parsed.error?.message || 'the provider returned no image',
          { raw: payload }
        );
      }

      // Providers that return URLs (not OpenRouter today) must be downloaded
      // immediately: the URLs are temporary and cannot be persisted.
      const images = [];
      for (const image of parsed.images) {
        if (image.b64_json) {
          images.push(image);
          continue;
        }
        images.push(await this._downloadImage(image.url, controller.signal));
      }

      const result = { sessionId, images, usage: parsed.usage, warnings: parsed.warnings };
      if (typeof options.onComplete === 'function') options.onComplete(result);
      return result;
    } catch (error) {
      const normalized = this._normalizeThrown(error, timedOut, controller.signal.aborted);
      const wrapped = error instanceof ImageClientError
        ? error
        : new ImageClientError(normalized.code, normalized.message, normalized);
      if (typeof options.onError === 'function') options.onError(wrapped);
      throw wrapped;
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * Converts a non-OK HTTP response into a typed error.
   * @private
   */
  async _errorFromResponse(response) {
    let body = null;
    // Clone first: a failed json() still consumes the original body, so the
    // text fallback would otherwise always be empty.
    const copy = typeof response.clone === 'function' ? response.clone() : response;
    try {
      body = await response.json();
    } catch (error) {
      try { body = await copy.text(); } catch (ignored) { body = null; }
    }
    const normalized = normalizeImageError({ status: response.status, body });
    return new ImageClientError(normalized.code, normalized.message, normalized);
  }

  /**
   * @private
   */
  _normalizeThrown(error, timedOut, aborted) {
    if (error instanceof ImageClientError) return error;
    if (error?.name === 'AbortError') {
      if (timedOut) {
        return {
          code: IMAGE_ERROR_CODES.TIMEOUT,
          message: 'image generation timed out',
          status: null,
          retryable: true,
          raw: error
        };
      }
      return normalizeImageError({
        cancelled: true,
        status: null,
        error: { message: 'cancelled' }
      });
    }
    return normalizeImageError({ error, status: null, cancelled: aborted });
  }

  /**
   * Downloads a temporary provider URL and turns it into base64.
   * @private
   */
  async _downloadImage(url, signal) {
    if (!url) throw new ImageClientError(IMAGE_ERROR_CODES.EMPTY, 'missing image URL');
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new ImageClientError(
        IMAGE_ERROR_CODES.NETWORK,
        `image download failed with status ${response.status}`
      );
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      throw new ImageClientError(IMAGE_ERROR_CODES.TOO_LARGE, 'image exceeds the size limit');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageClientError(IMAGE_ERROR_CODES.TOO_LARGE, 'image exceeds the size limit');
    }
    return {
      b64_json: arrayBufferToBase64(buffer),
      media_type: response.headers.get('content-type') || 'image/png',
      url: '',
      width: null,
      height: null,
      revised_prompt: ''
    };
  }

  abort(sessionId) {
    const controller = this.activeSessions.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.activeSessions.delete(sessionId);
    return true;
  }

  abortAllSessions() {
    let count = 0;
    for (const [sessionId, controller] of this.activeSessions.entries()) {
      controller.abort();
      this.activeSessions.delete(sessionId);
      count++;
    }
    return count;
  }

  /** @private */
  _generateSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `img_${crypto.randomUUID()}`;
    }
    return `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Converts an ArrayBuffer to base64 without blowing the call stack. */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

