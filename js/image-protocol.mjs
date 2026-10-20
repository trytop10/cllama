/**
 * cllama Image Protocol (internal canonical form).
 *
 * Every image provider is spoken to through a small codec (see
 * `image-codecs.mjs`). This module owns the *provider-neutral* half: validation,
 * size handling, response/error normalisation and capability descriptors. It has
 * no browser APIs, so it can be exercised directly from Node
 * (`tools/image-protocol.test.mjs`).
 *
 * The canonical request deliberately mirrors OpenRouter's Images API: that API
 * is a superset of OpenAI's Images API and already normalises the fields that
 * differ between vendors (size / resolution / aspect_ratio / references).
 */

import {
  IMAGE_DEFAULTS,
  getProviderMeta,
  normalizeImageDefaults
} from './api-providers.mjs';

/** Bumped whenever the canonical request/response shape changes. */
export const IMAGE_PROTOCOL_VERSION = '1.0';

/** Protocol id for OpenRouter's dedicated Images API. */
export const OPENROUTER_IMAGE_PROTOCOL = 'openrouter-images';

/** Known image protocols. Adding a vendor means adding an entry here + a codec. */
export const IMAGE_PROTOCOLS = [
  {
    id: OPENROUTER_IMAGE_PROTOCOL,
    label: 'OpenRouter Images',
    endpoint: 'https://openrouter.ai/api/v1/images'
  }
];

/** Normalised error codes (the UI maps these to localised messages). */
export const IMAGE_ERROR_CODES = Object.freeze({
  CANCELLED: 'cancelled',
  AUTH: 'auth',
  PAYMENT: 'payment',
  RATE_LIMIT: 'rate_limit',
  INVALID_REQUEST: 'invalid_request',
  UNSUPPORTED_PARAMETER: 'unsupported_parameter',
  CONTENT_POLICY: 'content_policy',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  UPSTREAM: 'upstream',
  EMPTY: 'empty',
  TOO_LARGE: 'too_large',
  NOT_IMAGE_MODEL: 'not_image_model',
  VIDEO_UNSUPPORTED: 'video_unsupported',
  UNSUPPORTED_PROTOCOL: 'unsupported_protocol'
});

/** Conservative defaults used when a vendor does not publish capabilities. */
export const DEFAULT_IMAGE_CAPABILITIES = Object.freeze({
  n: { min: 1, max: 1 },
  size: { auto: true, pixels: [], tiers: [] },
  aspectRatio: false,
  resolution: false,
  quality: ['auto'],
  background: ['auto'],
  outputFormat: ['auto'],
  referenceImages: { max: 0 },
  mask: false,
  seed: false,
  negativePrompt: false,
  stream: false
});

/**
 * Resolves the image protocol of a provider entry. Host-based detection keeps
 * the historical `service` keys untouched; an explicit `imageProtocol` wins so
 * self-hosted gateways can opt in later.
 * @param {Object} entry - dsList entry
 * @returns {string} Protocol id or '' when unsupported
 */
export function getImageProtocol(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.imageProtocol === 'string' && entry.imageProtocol.trim()) {
    return entry.imageProtocol.trim();
  }
  const meta = getProviderMeta(entry.service);
  if (meta.imageProtocol) return meta.imageProtocol;

  const urls = [entry.imageApiUrl, entry.apiUrl, meta.imageDefaultUrl]
    .filter((value) => typeof value === 'string' && value.trim());
  for (const raw of urls) {
    try {
      if (/(^|\.)openrouter\.ai$/i.test(new URL(raw).hostname)) {
        return OPENROUTER_IMAGE_PROTOCOL;
      }
    } catch (error) {
      // Relative / malformed URLs are not image endpoints; keep looking.
    }
  }
  return '';
}

/**
 * Image endpoint for an entry. Never derived from `apiUrl` by string surgery:
 * a chat-completions URL and an images URL are different resources.
 * @param {Object} entry - dsList entry
 * @returns {string} Absolute endpoint or ''
 */
export function buildImageEndpoint(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const explicit = typeof entry.imageApiUrl === 'string' ? entry.imageApiUrl.trim() : '';
  if (explicit) return explicit;
  const meta = getProviderMeta(entry.service);
  return typeof meta.imageDefaultUrl === 'string' ? meta.imageDefaultUrl : '';
}

/**
 * Model-discovery endpoint for an entry (where the provider offers one).
 * @param {Object} entry - dsList entry
 * @returns {string} Absolute endpoint or ''
 */
export function buildImageModelsEndpoint(entry) {
  if (getImageProtocol(entry) !== OPENROUTER_IMAGE_PROTOCOL) return '';
  const endpoint = buildImageEndpoint(entry);
  const raw = endpoint || 'https://openrouter.ai/api/v1/images';
  try {
    const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!/\/images\/models$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/images$/, '')}/images/models`;
  }
  url.search = '';
  return url.toString();
  } catch (error) {
    return 'https://openrouter.ai/api/v1/images/models';
  }
}

/**
 * Capability descriptor for an entry, optionally refined by the model
 * catalogue (`/images/models` returns `supported_parameters`).
 * @param {Object} entry - dsList entry
 * @param {Object} [modelInfo] - Catalogue record for the selected model
 * @returns {Object} Capabilities
 */
export function imageCapabilitiesFor(entry, modelInfo = null) {
  const protocol = getImageProtocol(entry);
  if (protocol !== OPENROUTER_IMAGE_PROTOCOL) {
    return { protocol: protocol || '', supports: { ...DEFAULT_IMAGE_CAPABILITIES } };
  }

  const supports = {
    n: { min: 1, max: 10 },
    size: {
      auto: true,
      pixels: ['1024x1024', '1536x1024', '1024x1536', '2048x2048'],
      tiers: ['512', '768', '1K', '1.5K', '2K', '4K']
    },
    aspectRatio: true,
    resolution: true,
    quality: ['auto', 'low', 'medium', 'high'],
    background: ['auto', 'transparent', 'opaque'],
    outputFormat: ['auto', 'png', 'jpeg', 'webp', 'svg'],
    referenceImages: { max: 8 },
    mask: false,
    seed: true,
    negativePrompt: false,
    stream: false
  };

  if (modelInfo && typeof modelInfo === 'object') {
    const params = modelInfo.supported_parameters;
    if (params && typeof params === 'object') {
      if (params.n && typeof params.n === 'object' && Number.isFinite(params.n.max)) {
        supports.n = { min: 1, max: Math.max(1, params.n.max) };
      }
      if (params.resolution && Array.isArray(params.resolution.values)) {
        supports.resolution = true;
        supports.size.tiers = params.resolution.values.filter(Boolean);
      }
      if (params.aspect_ratio && Array.isArray(params.aspect_ratio.values)) {
        supports.aspectRatio = true;
        supports.aspect_ratios = params.aspect_ratio.values.filter(Boolean);
      }
      if (params.quality && Array.isArray(params.quality.values)) {
        supports.quality = ['auto', ...params.quality.values.filter(Boolean)];
      }
      if (params.output_format && Array.isArray(params.output_format.values)) {
        supports.outputFormat = ['auto', ...params.output_format.values.filter(Boolean)];
      }
      if (params.background && Array.isArray(params.background.values)) {
        supports.background = ['auto', ...params.background.values.filter(Boolean)];
      }
      if (params.seed && params.seed.type === 'boolean') supports.seed = Boolean(params.seed.value !== false);
    }
    const inputs = modelInfo.architecture?.input_modalities;
    if (Array.isArray(inputs) && !inputs.includes('image')) {
      supports.referenceImages = { max: 0 };
    }
  }

  return { protocol, supports };
}

/**
 * Parses `size` into pixels or a tier. Returns null when unusable.
 * @param {string} value - "auto", "2K" or "1536x1024"
 * @returns {{kind: 'auto'|'tier'|'pixels', tier?: string, width?: number, height?: number}|null}
 */
export function parseImageSize(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.toLowerCase() === 'auto') return { kind: 'auto' };
  if (/^\d{1,2}(\.\d)?K$/i.test(text) || /^\d{3,4}$/.test(text)) {
    return { kind: 'tier', tier: text.toUpperCase() };
  }
  const match = text.match(/^(\d{3,4})x(\d{3,4})$/i);
  if (!match) return null;
  return { kind: 'pixels', width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Derives an aspect ratio from explicit pixels, reduced by their GCD.
 * @param {number} width - Pixel width
 * @param {number} height - Pixel height
 * @returns {string} "w:h"
 */
export function aspectRatioFromSize(width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const divisor = gcd(w, h);
  return `${w / divisor}:${h / divisor}`;
}

/**
 * Best-effort aspect ratio for providers with an enum (OpenRouter accepts a
 * wide range, so this is only used when a caller supplies pixels).
 * @param {number} width - Pixel width
 * @param {number} height - Pixel height
 * @returns {string} Aspect ratio
 */
export function nearestAspectRatio(width, height) {
  return aspectRatioFromSize(width, height);
}


/**
 * Normalises an incoming image request. Any field that cannot be honoured
 * *semantically* is returned as an error; cosmetic mismatches become warnings.
 *
 * @param {Object} raw - Request (defaults + per-turn overrides)
 * @param {Object} [options] - { capabilities }
 * @returns {{ok: boolean, request: Object|null, errors: Array<Object>, warnings: Array<Object>}}
 */
export function normalizeImageRequest(raw = {}, options = {}) {
  const capabilities = options.capabilities?.supports || DEFAULT_IMAGE_CAPABILITIES;
  const errors = [];
  const warnings = [];

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) errors.push({ code: 'invalid_request', field: 'prompt', message: 'prompt is required' });

  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) errors.push({ code: 'invalid_request', field: 'model', message: 'model is required' });

  const defaults = normalizeImageDefaults({ ...IMAGE_DEFAULTS, ...(raw || {}) });
  const request = { ...defaults, prompt, model };

  // n: fail instead of silently fanning out into several billed requests.
  const maxN = Number(capabilities?.n?.max) || 1;
  if (Number(raw.n) > maxN && maxN <= 1) {
    errors.push({ code: 'unsupported_parameter', field: 'n', message: 'this model generates one image per request' });
  } else if (Number(raw.n) > maxN) {
    warnings.push({
      code: 'n_clamped',
      field: 'n',
      requested: Number(raw.n),
      applied: maxN,
      message: `the provider supports at most ${maxN} image(s) per request`
    });
  }
  request.n = Math.min(maxN, Math.max(1, Math.round(Number(raw.n) || 1)));

  // Reference images: canonical shape is OpenRouter's `image_url`.
  const references = normalizeReferences(raw.input_references);
  const maxRefs = Number(capabilities?.referenceImages?.max) || 0;
  if (references.length > maxRefs) {
    errors.push({
      code: 'unsupported_parameter',
      field: 'input_references',
      message: `at most ${maxRefs} reference image(s) are supported`
    });
  }
  if (references.length) request.input_references = references;

  // Size precedence: explicit pixels win; they replace aspect_ratio/resolution.
  const parsedSize = parseImageSize(request.size);
  if (parsedSize?.kind === 'pixels') {
    if (request.aspect_ratio !== 'auto' || request.resolution !== 'auto') {
      warnings.push({
        code: 'size_precedence',
        field: 'size',
        message: 'explicit pixel size replaces aspect_ratio/resolution'
      });
    }
    request.aspect_ratio = 'auto';
    request.resolution = 'auto';
    const ratio = nearestAspectRatio(parsedSize.width, parsedSize.height);
    if (capabilities?.aspectRatio && Array.isArray(capabilities.aspect_ratios)
      && capabilities.aspect_ratios.length && !capabilities.aspect_ratios.includes(ratio)) {
      warnings.push({
        code: 'aspect_approximated',
        field: 'size',
        requested: ratio,
        message: 'provider will choose the nearest supported aspect ratio'
      });
    }
  } else if (parsedSize?.kind === 'tier') {
    // A tier is a resolution; keep an explicit aspect_ratio alongside it.
    request.resolution = parsedSize.tier;
    request.size = 'auto';
  } else if (!parsedSize) {
    errors.push({ code: 'invalid_request', field: 'size', message: 'size must be auto, a tier or WxH' });
  }

  // Keep the canonical request minimal: OpenRouter treats missing values as
  // provider defaults, and `size: "auto"` is not a valid tier.
  if (request.size === 'auto') delete request.size;
  if (request.resolution === 'auto') delete request.resolution;
  if (request.aspect_ratio === 'auto') delete request.aspect_ratio;
  if (request.quality === 'auto') delete request.quality;
  if (request.background === 'auto') delete request.background;
  if (request.output_format === 'auto') delete request.output_format;
  if (request.seed === null) delete request.seed;

  // transparent necessarily implies an alpha-capable format.
  const format = request.output_format || 'png';
  if (request.background === 'transparent' && !['png', 'webp'].includes(format)) {
    errors.push({
      code: 'unsupported_parameter',
      field: 'background',
      message: 'transparent background requires png or webp'
    });
  }

  if (raw.provider && typeof raw.provider === 'object') {
    const routing = {};
    for (const key of ['only', 'order', 'ignore', 'sort', 'allow_fallbacks']) {
      if (raw.provider[key] !== undefined) routing[key] = raw.provider[key];
    }
    if (raw.provider.options && typeof raw.provider.options === 'object') routing.options = raw.provider.options;
    if (Object.keys(routing).length) request.provider = routing;
  }

  if (typeof raw.user === 'string' && raw.user.trim()) request.user = raw.user.trim();
  if (raw.stream === true && capabilities?.stream) request.stream = true;

  return { ok: errors.length === 0, request: errors.length ? null : request, errors, warnings };
}



/**
 * Normalises reference images to the `image_url` content shape. Strings are
 * accepted as a convenience and converted.
 * @param {Array} list - Reference list
 * @returns {Array<Object>} Canonical references
 */
export function normalizeReferences(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      if (!isDataUrl(item)) continue;
      out.push({ type: 'image_url', image_url: { url: item } });
      continue;
    }
    if (item.type && item.type !== 'image_url') continue;
    const url = item.image_url?.url || item.url;
    if (typeof url !== 'string' || !url.trim()) continue;
    out.push({ type: 'image_url', image_url: { url: url.trim() } });
  }
  return out;
}

/** Whether a string is a base64 data URL (the form we persist). */
export function isDataUrl(value) {
  return typeof value === 'string'
    && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(value);
}

/**
 * Detects the image MIME type from a base64 payload. Used when a provider omits
 * `media_type`; wrong media types break exported data URLs.
 * @param {string} base64 - Raw base64 (no data: prefix)
 * @returns {string} MIME type
 */
export function mimeFromBase64(base64) {
  const text = String(base64 || '').replace(/\s+/g, '');
  if (text.startsWith('iVBORw0KGgo')) return 'image/png';
  if (text.startsWith('/9j/')) return 'image/jpeg';
  if (text.startsWith('UklGR')) return 'image/webp';
  if (text.startsWith('R0lGOD')) return 'image/gif';
  if (text.startsWith('PHN2Zy')) return 'image/svg+xml';
  return 'image/png';
}


/**
 * Normalises one provider response into the canonical shape. Accepts both
 * OpenRouter's `b64_json` and OpenAI-style `url` entries.
 *
 * @param {Object} payload - Raw JSON response
 * @param {Object} [meta] - { requestedN, protocol }
 * @returns {{ok: boolean, images: Array<Object>, usage: Object, warnings: Array<Object>, error: Object|null}}
 */
export function normalizeImageResponse(payload, meta = {}) {
  const warnings = [];
  const errors = [];
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const images = [];

  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const b64 = typeof item.b64_json === 'string' ? item.b64_json.trim() : '';
    const url = typeof item.url === 'string' ? item.url : '';
    if (!b64 && !url) continue;
    const mediaType = typeof item.media_type === 'string' && item.media_type.startsWith('image/')
      ? item.media_type
      : (b64 ? mimeFromBase64(b64) : '');
    images.push({
      b64_json: b64,
      media_type: mediaType,
      url,
      width: Number.isFinite(item.width) ? item.width : null,
      height: Number.isFinite(item.height) ? item.height : null,
      revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : ''
    });
  }

  if (!images.length) {
    errors.push({ code: IMAGE_ERROR_CODES.EMPTY, message: 'the provider returned no image' });
  }

  const requestedN = Number(meta.requestedN);
  if (Number.isFinite(requestedN) && requestedN > images.length && images.length > 0) {
    warnings.push({
      code: 'fewer_images',
      requested: requestedN,
      received: images.length,
      message: 'the provider returned fewer images than requested'
    });
  }

  const sourceUsage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : {};
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'cost']) {
    if (Number.isFinite(Number(sourceUsage[key]))) usage[key] = Number(sourceUsage[key]);
  }
  usage.image_count = Number.isFinite(Number(sourceUsage.image_count))
    ? Number(sourceUsage.image_count)
    : images.length;
  if (meta.protocol) usage.protocol = meta.protocol;

  return {
    ok: errors.length === 0,
    images,
    usage,
    warnings,
    error: errors[0] || null
  };
}


/**
 * Converts an HTTP/network failure into a stable code the UI can localise.
 * @param {Object} input - { status, body, error, cancelled }
 * @returns {{code: string, message: string, status: number|null, retryable: boolean, raw: *}}
 */
export function normalizeImageError(input = {}) {
  const status = Number.isFinite(input.status) ? Number(input.status) : null;
  const body = input.body;
  const raw = body ?? input.error ?? null;
  let message = '';
  if (typeof body?.error === 'string') message = body.error;
  else if (typeof body?.error?.message === 'string') message = body.error.message;
  else if (typeof body?.message === 'string') message = body.message;
  else if (input.error?.message) message = input.error.message;
  else if (typeof body === 'string') message = body;

  if (input.cancelled) {
    return { code: IMAGE_ERROR_CODES.CANCELLED, message: message || 'cancelled', status, retryable: false, raw };
  }
  if (!status) {
    return { code: IMAGE_ERROR_CODES.NETWORK, message: message || 'network error', status, retryable: true, raw };
  }
  const lower = String(message || '').toLowerCase();
  if (status === 401 || status === 403) {
    return { code: IMAGE_ERROR_CODES.AUTH, message, status, retryable: false, raw };
  }
  if (status === 402) {
    return { code: IMAGE_ERROR_CODES.PAYMENT, message, status, retryable: false, raw };
  }
  if (status === 429) {
    return { code: IMAGE_ERROR_CODES.RATE_LIMIT, message, status, retryable: true, raw };
  }
  if (status === 408 || status === 504) {
    return { code: IMAGE_ERROR_CODES.TIMEOUT, message, status, retryable: true, raw };
  }
  if (status >= 500) {
    return { code: IMAGE_ERROR_CODES.UPSTREAM, message, status, retryable: true, raw };
  }
  if (/content.?policy|moderation|safety|violat/i.test(lower)) {
    return { code: IMAGE_ERROR_CODES.CONTENT_POLICY, message, status, retryable: false, raw };
  }
  if (/unsupported|not support|unknown parameter|invalid parameter|invalid value/i.test(lower)) {
    return { code: IMAGE_ERROR_CODES.UNSUPPORTED_PARAMETER, message, status, retryable: false, raw };
  }
  return { code: IMAGE_ERROR_CODES.INVALID_REQUEST, message, status, retryable: false, raw };
}

/**
 * Builds a data URL for an image result. Keeps the provider's media type.
 * @param {Object} image - Canonical image
 * @returns {string} data URL
 */
export function imageToDataUrl(image) {
  if (!image) return '';
  if (!image.b64_json && image.url) return image.url;
  const mime = image.media_type || mimeFromBase64(image.b64_json);
  return `data:${mime};base64,${image.b64_json}`;
}
