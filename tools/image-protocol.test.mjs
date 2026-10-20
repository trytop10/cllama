/**
 * Self-check for the canonical image protocol and the OpenRouter codec.
 *
 *   node tools/image-protocol.test.mjs
 */
import assert from 'node:assert/strict';
import {
  IMAGE_ERROR_CODES,
  OPENROUTER_IMAGE_PROTOCOL,
  aspectRatioFromSize,
  buildImageEndpoint,
  buildImageModelsEndpoint,
  getImageProtocol,
  imageCapabilitiesFor,
  imageToDataUrl,
  isDataUrl,
  mimeFromBase64,
  normalizeImageError,
  normalizeImageRequest,
  normalizeImageResponse,
  normalizeReferences,
  parseImageSize
} from '../js/image-protocol.mjs';
import { openrouterImagesCodec } from '../js/image-codecs.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const entry = {
  service: 'OpenRouter',
  modelType: 'image',
  imageApiUrl: 'https://openrouter.ai/api/v1/images'
};

check('protocol is detected from the provider meta and the host', () => {
  assert.equal(getImageProtocol(entry), OPENROUTER_IMAGE_PROTOCOL);
  assert.equal(getImageProtocol({ service: 'Other', apiUrl: 'https://openrouter.ai/api/v1/chat/completions' }),
    OPENROUTER_IMAGE_PROTOCOL);
  assert.equal(getImageProtocol({ service: 'OpenAI', apiUrl: 'https://api.openai.com/v1/chat/completions' }), '');
});

check('image endpoints are never derived from the chat URL by string surgery', () => {
  assert.equal(buildImageEndpoint(entry), 'https://openrouter.ai/api/v1/images');
  assert.equal(buildImageEndpoint({ service: 'OpenRouter' }), 'https://openrouter.ai/api/v1/images');
  assert.equal(buildImageEndpoint({ service: 'OpenAI', apiUrl: 'https://api.openai.com/v1/chat/completions' }), '');
  assert.equal(buildImageModelsEndpoint(entry), 'https://openrouter.ai/api/v1/images/models');
  assert.equal(buildImageModelsEndpoint({ service: 'OpenAI' }), '');
});

check('size parsing distinguishes auto, tiers and explicit pixels', () => {
  assert.deepEqual(parseImageSize('auto'), { kind: 'auto' });
  assert.deepEqual(parseImageSize('2K'), { kind: 'tier', tier: '2K' });
  assert.deepEqual(parseImageSize('1536x1024'), { kind: 'pixels', width: 1536, height: 1024 });
  assert.equal(parseImageSize('huge'), null);
  assert.equal(aspectRatioFromSize(1536, 1024), '3:2');
});

check('a minimal request contains only what will actually be sent', () => {
  const result = normalizeImageRequest({ model: 'm', prompt: '  a cat  ' }, {
    capabilities: imageCapabilitiesFor(entry)
  });
  assert.equal(result.ok, true);
  assert.equal(result.request.prompt, 'a cat');
  assert.equal(result.request.model, 'm');
  assert.equal(result.request.n, 1);
  for (const key of ['size', 'resolution', 'aspect_ratio', 'quality', 'background', 'output_format', 'seed']) {
    assert.equal(key in result.request, false, `${key} should not be sent when auto/unset`);
  }
});

check('explicit pixels win over aspect_ratio/resolution, with a warning', () => {
  const result = normalizeImageRequest({
    model: 'm',
    prompt: 'p',
    size: '1536x1024',
    aspect_ratio: '16:9',
    resolution: '2K'
  }, { capabilities: imageCapabilitiesFor(entry) });
  assert.equal(result.ok, true);
  assert.equal(result.request.size, '1536x1024');
  assert.equal('aspect_ratio' in result.request, false);
  assert.equal('resolution' in result.request, false);
  assert.equal(result.warnings.some((w) => w.code === 'size_precedence'), true);
});

check('a tier becomes resolution, and aspect_ratio may stay', () => {
  const result = normalizeImageRequest({
    model: 'm', prompt: 'p', size: '2K', aspect_ratio: '16:9'
  }, { capabilities: imageCapabilitiesFor(entry) });
  assert.equal(result.ok, true);
  assert.equal(result.request.resolution, '2K');
  assert.equal('size' in result.request, false);
  assert.equal(result.request.aspect_ratio, '16:9');
});

check('n above the model limit fails instead of fanning out', () => {
  const capabilities = imageCapabilitiesFor(entry);
  capabilities.supports.n = { min: 1, max: 1 };
  const result = normalizeImageRequest({ model: 'm', prompt: 'p', n: 3 }, { capabilities });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'unsupported_parameter');
});

check('reference images use the image_url shape; strings are accepted', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  assert.equal(isDataUrl(dataUrl), true);
  const refs = normalizeReferences([
    dataUrl,
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'text', text: 'ignored' },
    { url: '' }
  ]);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].type, 'image_url');
  assert.equal(refs[1].image_url.url, 'https://example.com/a.png');
});

check('too many references is an error, not a silent drop', () => {
  const capabilities = imageCapabilitiesFor(entry);
  capabilities.supports.referenceImages = { max: 1 };
  const result = normalizeImageRequest({
    model: 'm',
    prompt: 'p',
    input_references: [
      'data:image/png;base64,iVBORw0KGgo=',
      'data:image/png;base64,iVBORw0KGgo='
    ]
  }, { capabilities });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'input_references');
});

check('transparent background requires an alpha-capable format', () => {
  const result = normalizeImageRequest({
    model: 'm', prompt: 'p', background: 'transparent', output_format: 'jpeg'
  }, { capabilities: imageCapabilitiesFor(entry) });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'background');
});

check('provider routing is forwarded only when present', () => {
  const result = normalizeImageRequest({
    model: 'm', prompt: 'p', provider: { only: ['google-ai-studio'], allow_fallbacks: false }
  }, { capabilities: imageCapabilitiesFor(entry) });
  assert.deepEqual(result.request.provider, { only: ['google-ai-studio'], allow_fallbacks: false });
  const plain = normalizeImageRequest({ model: 'm', prompt: 'p' }, { capabilities: imageCapabilitiesFor(entry) });
  assert.equal('provider' in plain.request, false);
});

check('dynamic catalogue data refines capabilities', () => {
  const caps = imageCapabilitiesFor(entry, {
    architecture: { input_modalities: ['text', 'image'] },
    supported_parameters: {
      n: { max: 4 },
      resolution: { values: ['1K', '2K'] },
      seed: { type: 'boolean' }
    }
  });
  assert.equal(caps.supports.n.max, 4);
  assert.deepEqual(caps.supports.size.tiers, ['1K', '2K']);
  assert.equal(caps.supports.seed, true);

  const textOnly = imageCapabilitiesFor(entry, {
    architecture: { input_modalities: ['text'] }
  });
  assert.equal(textOnly.supports.referenceImages.max, 0);
});

check('the OpenRouter codec drops ext and forces a non-streaming request', () => {
  const body = openrouterImagesCodec.buildRequest({
    model: 'm',
    prompt: 'p',
    n: 2,
    size: '1024x1024',
    ext: { negative_prompt: 'x' },
    stream: true
  });
  assert.equal(body.stream, false);
  assert.equal('ext' in body, false);
  assert.equal(body.size, '1024x1024');
  assert.equal(body.n, 2);
});

check('responses are normalised to b64 with a media type and usage', () => {
  const result = normalizeImageResponse({
    created: 1,
    data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' }],
    usage: { prompt_tokens: 0, completion_tokens: 10, total_tokens: 10, cost: 0.04 }
  }, { protocol: OPENROUTER_IMAGE_PROTOCOL, requestedN: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.images[0].media_type, 'image/png');
  assert.equal(result.usage.image_count, 1);
  assert.equal(result.usage.cost, 0.04);
  assert.equal(result.usage.protocol, OPENROUTER_IMAGE_PROTOCOL);
});

check('fewer images than requested is a warning, an empty response is an error', () => {
  const partial = normalizeImageResponse({
    data: [{ b64_json: 'iVBORw0KGgo=' }]
  }, { requestedN: 2 });
  assert.equal(partial.ok, true);
  assert.equal(partial.warnings[0].code, 'fewer_images');

  const empty = normalizeImageResponse({ data: [] }, { requestedN: 1 });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, IMAGE_ERROR_CODES.EMPTY);
});

check('MIME detection and data URLs are stable', () => {
  assert.equal(mimeFromBase64('iVBORw0KGgoAAAANSUhEUg=='), 'image/png');
  assert.equal(mimeFromBase64('/9j/4AAQSkZJRg=='), 'image/jpeg');
  assert.equal(imageToDataUrl({ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }),
    'data:image/png;base64,iVBORw0KGgo=');
});

check('errors map to stable, non-retryable/retryable codes', () => {
  assert.equal(normalizeImageError({ status: 401, body: { error: { message: 'bad key' } } }).code, 'auth');
  assert.equal(normalizeImageError({ status: 429, body: {} }).code, 'rate_limit');
  assert.equal(normalizeImageError({ status: 429, body: {} }).retryable, true);
  assert.equal(normalizeImageError({
    status: 400,
    body: { error: { message: 'content policy violation' } }
  }).code, 'content_policy');
  assert.equal(normalizeImageError({ cancelled: true }).code, 'cancelled');
  assert.equal(normalizeImageError({ error: new Error('offline') }).code, 'network');
});

console.log(`\n${passed} checks passed.`);

