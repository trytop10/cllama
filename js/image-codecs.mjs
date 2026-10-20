/**
 * Provider codecs for the cllama Image Protocol.
 *
 * A codec is deliberately tiny: it translates the canonical request into the
 * provider's wire body and the provider's response into the canonical shape.
 * Everything that is provider-neutral (validation, size precedence, capability
 * checks, error codes) lives in `image-protocol.mjs`.
 *
 * Adding a vendor later means adding one entry here; the chat page, runtime and
 * storage do not know which provider answered.
 */

import {
  IMAGE_PROTOCOL_VERSION,
  OPENROUTER_IMAGE_PROTOCOL,
  normalizeImageResponse
} from './image-protocol.mjs';

/**
 * OpenRouter's dedicated Images API.
 * Docs: POST https://openrouter.ai/api/v1/images
 * Response: { created, data: [{ b64_json, media_type }], usage }
 */
export const openrouterImagesCodec = {
  protocol: OPENROUTER_IMAGE_PROTOCOL,
  version: IMAGE_PROTOCOL_VERSION,

  /**
   * Builds the JSON body. The canonical request is already normalised, so this
   * is mostly a defensive copy that drops fields OpenRouter does not accept.
   * @param {Object} request - Canonical request
   * @returns {Object} Wire body
   */
  buildRequest(request) {
    const body = {
      model: request.model,
      prompt: request.prompt,
      n: request.n,
      // OpenRouter streams partial previews; P1 keeps a single final image and
      // avoids showing a half-rendered result as if it were final.
      stream: false
    };

    for (const key of [
      'size',
      'resolution',
      'aspect_ratio',
      'quality',
      'output_format',
      'background',
      'output_compression',
      'seed',
      'input_references',
      'user',
      'provider'
    ]) {
      if (request[key] !== undefined && request[key] !== null) body[key] = request[key];
    }

    // `ext` is intentionally never forwarded: OpenRouter rejects unknown fields.
    return body;
  },

  /**
   * @param {Object} payload - Raw response JSON
   * @param {number} requestedN - Number of images requested
   * @returns {Object} Canonical response
   */
  parseResponse(payload, requestedN = 1) {
    return normalizeImageResponse(payload, {
      protocol: this.protocol,
      requestedN
    });
  }
};

/** Registry consumed by ImageClient. */
export const IMAGE_CODECS = {
  [OPENROUTER_IMAGE_PROTOCOL]: openrouterImagesCodec
};

/**
 * @param {string} protocol - Protocol id
 * @returns {Object|null} Codec or null
 */
export function getImageCodec(protocol) {
  return IMAGE_CODECS[protocol] || null;
}
