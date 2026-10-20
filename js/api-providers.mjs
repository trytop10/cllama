/**
 * API provider catalogue and small pure helpers (zero dependencies).
 *
 * The `service` value is the *routing key* used by the AI clients and by
 * historical data (base / dsList / insightService / Skill dsService). It must
 * never be localised or renamed: only the human-readable label shown in the UI
 * changes. "Other" therefore stays the stored value even though the UI calls it
 * "OpenAI-compatible API".
 */

/**
 * Provider catalogue, in the order shown in the add/edit dialog.
 * `defaultUrl` is only a convenience default for new entries; entries that
 * already have a URL are never rewritten.
 */
export const PROVIDER_TYPES = [
  {
    service: 'ollama',
    labelKey: 'apiProviderOllama',
    defaultUrl: 'http://localhost:11434',
    protocol: 'ollama'
  },
  {
    service: 'OpenAI',
    labelKey: 'apiProviderOpenAI',
    defaultUrl: 'https://api.openai.com/v1/chat/completions',
    protocol: 'openai'
  },
  {
    service: 'OpenRouter',
    labelKey: 'apiProviderOpenRouter',
    defaultUrl: 'https://openrouter.ai/api/v1/chat/completions',
    protocol: 'openai',
    imageProtocol: 'openrouter-images',
    // OpenRouter exposes image generation through its dedicated Images API,
    // which is NOT the chat-completions URL. Keeping it next to the provider
    // meta means the settings dialog can fill the right default without
    // guessing by string replacement (see js/image-protocol.mjs).
    imageDefaultUrl: 'https://openrouter.ai/api/v1/images'
  },
  {
    service: 'Google',
    labelKey: 'apiProviderGoogle',
    defaultUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini'
  },
  {
    service: 'DeepSeek',
    labelKey: 'apiProviderDeepSeek',
    defaultUrl: 'https://api.deepseek.com/chat/completions',
    protocol: 'openai'
  },
  {
    service: 'Qwen',
    labelKey: 'apiProviderQwen',
    defaultUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    protocol: 'openai'
  },
  {
    service: 'ZhiPu',
    labelKey: 'apiProviderZhiPu',
    defaultUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    protocol: 'openai'
  },
  {
    service: 'Other',
    labelKey: 'apiProviderCompatible',
    defaultUrl: '',
    protocol: 'openai'
  }
];

/** Model kinds, in the order shown in the dialog. */
export const MODEL_TYPES = [
  { value: 'text', labelKey: 'modelTypeText' },
  { value: 'decision', labelKey: 'modelTypeDecision' },
  { value: 'image', labelKey: 'modelTypeImage' },
  { value: 'video', labelKey: 'modelTypeVideo' }
];

const PROVIDER_BY_SERVICE = new Map(PROVIDER_TYPES.map((item) => [item.service, item]));
const MODEL_TYPE_BY_VALUE = new Map(MODEL_TYPES.map((item) => [item.value, item]));
const LEGACY_MODEL_TYPES = new Map([
  ['chat', 'text'],
  ['reasoning', 'text']
]);

/**
 * Maps every stored/legacy model type to one of the current values.
 * @param {string} type - Stored model type
 * @returns {string} `text`, `decision`, `image` or `video`
 */
export function normalizeModelType(type) {
  if (MODEL_TYPE_BY_VALUE.has(type)) return type;
  return LEGACY_MODEL_TYPES.get(type) || 'text';
}

/** Whether a model type is answered by the text chat pipeline. */
export function isTextModelType(type) {
  const value = normalizeModelType(type);
  return value === 'text' || value === 'decision';
}

/** Whether a model type is answered by the image pipeline. */
export function isImageModelType(type) {
  return normalizeModelType(type) === 'image';
}

/** Whether a model type is a generation kind that is not implemented yet. */
export function isVideoModelType(type) {
  return normalizeModelType(type) === 'video';
}

/**
 * Default image-generation settings stored on a provider entry.
 * These are the values the OpenRouter codec knows how to apply; unsupported
 * fields are dropped or turned into warnings by the codec, never silently
 * forwarded to another provider.
 */
export const IMAGE_DEFAULTS = Object.freeze({
  size: 'auto',
  aspect_ratio: 'auto',
  resolution: 'auto',
  quality: 'auto',
  n: 1,
  background: 'auto',
  output_format: 'auto',
  seed: null
});

const IMAGE_SIZE_PATTERN = /^(auto|\d{3,4}x\d{3,4}|512|768|1K|1\.5K|2K|4K)$/;
const IMAGE_ASPECT_PATTERN = /^(auto|\d{1,2}:\d{1,2})$/;
const IMAGE_RESOLUTION_VALUES = new Set(['auto', '512', '768', '1K', '1.5K', '2K', '4K']);
const IMAGE_QUALITY_VALUES = new Set(['auto', 'low', 'medium', 'high']);
const IMAGE_BACKGROUND_VALUES = new Set(['auto', 'transparent', 'opaque']);
const IMAGE_FORMAT_VALUES = new Set(['auto', 'png', 'jpeg', 'webp', 'svg']);

/**
 * Normalises the optional image settings of one provider entry. Unknown or
 * malformed values fall back to the documented default instead of being
 * forwarded to the API, where they would cause a 400.
 * @param {Object} [raw] - Stored `imageDefaults`
 * @returns {Object} Normalised settings
 */
export function normalizeImageDefaults(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const size = typeof source.size === 'string' ? source.size.trim() : '';
  const aspect = typeof source.aspect_ratio === 'string' ? source.aspect_ratio.trim() : '';
  const resolution = typeof source.resolution === 'string' ? source.resolution.trim() : '';
  const quality = typeof source.quality === 'string' ? source.quality.trim() : '';
  const background = typeof source.background === 'string' ? source.background.trim() : '';
  const format = typeof source.output_format === 'string' ? source.output_format.trim() : '';

  let n = Number(source.n);
  if (!Number.isFinite(n)) n = IMAGE_DEFAULTS.n;
  n = Math.min(10, Math.max(1, Math.round(n)));

  let seed = source.seed;
  if (seed === '' || seed === null || seed === undefined) {
    seed = null;
  } else {
    seed = Number(seed);
    if (!Number.isFinite(seed) || seed < 0) seed = null;
    else seed = Math.floor(seed);
  }

  return {
    size: IMAGE_SIZE_PATTERN.test(size) ? size : IMAGE_DEFAULTS.size,
    aspect_ratio: IMAGE_ASPECT_PATTERN.test(aspect) ? aspect : IMAGE_DEFAULTS.aspect_ratio,
    resolution: IMAGE_RESOLUTION_VALUES.has(resolution) ? resolution : IMAGE_DEFAULTS.resolution,
    quality: IMAGE_QUALITY_VALUES.has(quality) ? quality : IMAGE_DEFAULTS.quality,
    n,
    background: IMAGE_BACKGROUND_VALUES.has(background) ? background : IMAGE_DEFAULTS.background,
    output_format: IMAGE_FORMAT_VALUES.has(format) ? format : IMAGE_DEFAULTS.output_format,
    seed
  };
}


/**
 * Sorts model ids the way a model picker should show them: alphabetically,
 * case-insensitively, with numbers compared naturally (`qwen2.5` before
 * `qwen3`), and without duplicates. Every client's `getModels()` runs its
 * response through this so the settings datalist and the chat dropdown agree.
 * @param {Array<string>} names - Model ids as returned by the service
 * @returns {Array<string>} Deduplicated, naturally sorted ids
 */
export function sortModelNames(names) {
  const unique = [...new Set((Array.isArray(names) ? names : [])
    .filter(Boolean)
    .map((name) => String(name)))];

  const collator = typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
    ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
    : null;

  unique.sort((a, b) => {
    if (collator) {
      const diff = collator.compare(a, b);
      if (diff !== 0) return diff;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return unique;
}

/**
 * Builds the `/models` URL for an OpenAI-compatible chat endpoint.
 *
 * OpenRouter's model catalogue defaults to `output_modalities=text`, which
 * hides image-only models (e.g. `qwen/qwen-image-3`) and video models (e.g.
 * `google/veo-3.1`). Asking for text, image and video explicitly keeps the
 * chat models and adds the generation models, without also pulling in
 * embeddings / rerank / speech / transcription endpoints. Other gateways
 * never receive the parameter, because unknown query fields may be rejected.
 * @param {string} endpoint - Chat completions endpoint (with or without `/chat/completions`)
 * @returns {string} Absolute models endpoint
 */
export function buildModelsEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();

  try {
    const url = new URL(raw);
    // Accept a chat-completions endpoint, a bare API base, or an already
    // complete models URL; only the first two need their path rewritten.
    const path = url.pathname.replace(/\/+$/, '');
    if (!/\/models$/.test(path)) {
      url.pathname = `${path.replace(/\/chat\/completions$/, '')}/models`;
    }

    if (/(^|\.)openrouter\.ai$/i.test(url.hostname)
      && !url.searchParams.has('output_modalities')) {
      url.searchParams.set('output_modalities', 'text,image,video');
    }
    return url.toString();
  } catch (error) {
    // Non-absolute endpoints keep the historic string concatenation.
    return `${raw.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')}/models`;
  }
}

/**
 * Returns the catalogue entry for a stored service key. Unknown legacy keys
 * (e.g. "Test", "Claude" from an old backup) are kept as-is so they stay
 * editable instead of being dropped.
 * @param {string} service - Stored service key
 * @returns {Object} Catalogue entry (possibly synthetic)
 */
export function getProviderMeta(service) {
  const known = PROVIDER_BY_SERVICE.get(service);
  if (known) return known;

  return {
    service,
    labelKey: '',
    defaultUrl: '',
    imageDefaultUrl: '',
    imageProtocol: '',
    protocol: service === 'ollama'
      ? 'ollama'
      : ((service === 'Google' || service === 'Test') ? 'gemini' : 'openai')
  };
}

/**
 * Human-readable provider label. The translator is usually
 * `browser.i18n.getMessage`; unknown services fall back to their raw key.
 * @param {string} service - Stored service key
 * @param {(key: string) => string} translate - Message lookup
 * @returns {string} Localised label
 */
export function providerLabel(service, translate) {
  const meta = getProviderMeta(service);
  if (meta.labelKey && typeof translate === 'function') {
    const text = translate(meta.labelKey);
    if (text) return text;
  }
  return service || '';
}

/**
 * Label for a model kind ("Text generation", "Decision", "Image generation").
 * @param {string} type - Stored model type
 * @param {(key: string) => string} translate - Message lookup
 * @returns {string} Localised label
 */
export function modelTypeLabel(type, translate) {
  const meta = MODEL_TYPE_BY_VALUE.get(normalizeModelType(type));
  if (meta && typeof translate === 'function') {
    const text = translate(meta.labelKey);
    if (text) return text;
  }
  return normalizeModelType(type);
}

/**
 * Generates a stable, unique id for one provider configuration. The list can
 * hold several configurations of the same provider type, so `service` alone is
 * no longer a unique key.
 * @returns {string} New id
 */
export function newApiEntryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `api-${crypto.randomUUID()}`;
  }
  return `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read-only key of a provider entry. Legacy entries (no id yet) fall back to
 * their service so old data keeps resolving before the next save migrates it.
 * @param {Object} entry - dsList entry
 * @returns {string} Entry key
 */
export function apiEntryId(entry) {
  if (!entry) return '';
  return entry.id || (entry.service ? `svc:${entry.service}` : '');
}

/**
 * Display label of one configuration: the localised provider type.
 * @param {Object} entry - dsList entry
 * @param {(key: string) => string} translate - Message lookup
 * @returns {string} Display label
 */
export function apiEntryLabel(entry, translate) {
  if (!entry) return '';
  return providerLabel(entry.service, translate) || entry.service || '';
}

/**
 * Display label with the model name appended, which is what makes two
 * configurations of the same provider distinguishable in a dropdown.
 * @param {Object} entry - dsList entry
 * @param {(key: string) => string} translate - Message lookup
 * @returns {string} Dropdown label
 */
export function apiEntryDisplay(entry, translate) {
  const label = apiEntryLabel(entry, translate);
  return entry && entry.modelName ? `${label} · ${entry.modelName}` : label;
}

/**
 * Finds the configuration a stored key refers to. New data stores the entry
 * id; older Skill/insight values store the service key or a display name, and
 * all three keep working.
 * @param {Array} list - dsList
 * @param {string} key - Entry id, name or service
 * @returns {Object|null} Matching entry
 */
export function resolveApiEntry(list, key) {
  if (!Array.isArray(list) || key == null || key === '') return null;
  const wanted = String(key);
  return list.find((entry) =>
    String(apiEntryId(entry)) === wanted
    || String(entry.id || '') === wanted
    || String(entry.name || '') === wanted
    || String(entry.service || '') === wanted
  ) || null;
}

/**
 * Normalises one stored data source without dropping unknown fields. New
 * capability fields are optional: a missing `supportsTools` means "not
 * declared", which keeps the historic auto-detection behaviour.
 * @param {Object} entry - Raw dsList entry
 * @returns {Object|null} Normalised copy, or null when unusable
 */
export function normalizeApiEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.service) return null;

  const out = { ...entry };
  out.id = typeof entry.id === 'string' ? entry.id.trim() : '';
  // `name` was removed from the data model (identity is `id`, display text is
  // provider type + model). Legacy references are migrated once by
  // `migrateLegacyReferences()`, so no compatibility field is kept here.
  delete out.name;
  out.service = String(entry.service);
  out.apiUrl = typeof entry.apiUrl === 'string' ? entry.apiUrl.trim() : '';
  // Image generation does not share the chat-completions endpoint (OpenRouter:
  // `/api/v1/images` vs `/api/v1/chat/completions`). It is a separate field so
  // switching model types never silently sends a request to the wrong path.
  out.imageApiUrl = typeof entry.imageApiUrl === 'string' ? entry.imageApiUrl.trim() : '';
  out.imageDefaults = normalizeImageDefaults(entry.imageDefaults);
  out.apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : '';
  out.modelName = typeof entry.modelName === 'string' ? entry.modelName.trim() : '';
  out.modelType = normalizeModelType(entry.modelType);
  out.multimodal = entry.multimodal === true;
  // Tri-state: only an explicit `true` is stored ("force native tools").
  // A missing value keeps the historic auto-detection path.
  if (entry.supportsTools === true) out.supportsTools = true;
  else delete out.supportsTools;

  return out;
}

/**
 * Normalises a whole dsList. Several configurations may share the same provider
 * type, so entries are deduplicated by id (never by service). Legacy entries
 * without an id get a deterministic id (`svc:<service>`, then `:2`, `:3`…), which
 * the next save persists.
 * @param {Array} list - Raw dsList
 * @returns {Array<Object>} Normalised entries
 */
export function normalizeApiList(list) {
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const entry = normalizeApiEntry(raw);
    if (!entry) continue;

    let id = entry.id || `svc:${entry.service}`;
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}:${n}`)) n++;
      id = `${id}:${n}`;
    }
    entry.id = id;
    seen.add(id);
    result.push(entry);
  }
  return result;
}

/**
 * Builds a dsList entry from a base configuration (legacy data may only have
 * `base` and no dsList entry for it).
 * @param {Object} config - Base settings
 * @param {string} [id] - Optional id for the new entry
 * @returns {Object|null} Normalised entry
 */
export function entryFromConfig(config, id = '') {
  if (!config || !config.service) return null;
  return normalizeApiEntry({
    id: id || config.dsId || '',
    service: config.service,
    apiUrl: config.apiUrl,
    imageApiUrl: config.imageApiUrl,
    imageDefaults: config.imageDefaults,
    apiKey: config.apiKey,
    modelName: config.modelName,
    modelType: config.modelType,
    multimodal: config.multimodal,
    supportsTools: config.supportsTools
  });
}

/**
 * Whether an entry is the default one. `base` remains the single source of
 * truth for compatibility with every existing call site.
 *
 * New data stores `base.dsId`; older data has no id and is matched by service
 * (plus URL/model when available, so several configs of one provider can be
 * distinguished after the first migration).
 * @param {Object} entry - dsList entry
 * @param {Object} base - Base settings
 * @returns {boolean} True when this entry is the default provider
 */
export function isDefaultEntry(entry, base) {
  if (!entry || !base || !entry.service) return false;
  if (base.dsId && entry.id) return base.dsId === entry.id;
  if (entry.service !== base.service) return false;

  const sameUrl = !base.apiUrl || !entry.apiUrl || base.apiUrl === entry.apiUrl;
  const sameModel = !base.modelName || !entry.modelName || base.modelName === entry.modelName;
  return sameUrl && sameModel;
}

/**
 * Finds the entry mirrored in `base`.
 * @param {Array} list - dsList
 * @param {Object} base - Base settings
 * @returns {Object|null} Default entry
 */
export function findDefaultEntry(list, base) {
  if (!Array.isArray(list) || !base) return null;
  if (base.dsId) {
    const byId = list.find((entry) => entry.id === base.dsId);
    if (byId) return byId;
    // A stale dsId (entry removed, backup edited) must not block the legacy
    // service/URL/model match below.
  }
  if (!base.service) return null;

  return list.find((entry) => {
    if (entry.service !== base.service) return false;
    const sameUrl = !base.apiUrl || !entry.apiUrl || base.apiUrl === entry.apiUrl;
    const sameModel = !base.modelName || !entry.modelName || base.modelName === entry.modelName;
    return sameUrl && sameModel;
  }) || null;
}
/**
 * One-time upgrade of legacy references to the id-based data model.
 *
 * Older versions identified a provider by its `service` key and kept an optional
 * display `name`; Skills stored that name (or the service key) in `dsService`,
 * the insight tab stored it in `insightService`, and the default provider was
 * mirrored into `base` without an id. This function converts all of those to
 * entry ids and then drops the legacy `name`/`dsName` fields, so the stored data
 * matches the current model. It is idempotent: running it on already-migrated
 * data changes nothing (all `changed` flags stay false).
 *
 * @param {{base?: Object, dsList?: Array, skillList?: Array}} data - Stored data
 * @returns {{base: Object|null, dsList: Array, skillList: Array|null, changed: {base: boolean, dsList: boolean, skillList: boolean}}}
 *   Migrated copies plus which storages need to be written back.
 */
export function migrateLegacyReferences({ base, dsList, skillList } = {}) {
  const nextBase = base && typeof base === 'object' && Object.keys(base).length ? { ...base } : null;
  const list = Array.isArray(dsList)
    ? dsList.map((entry) => (entry && typeof entry === 'object' ? { ...entry } : entry))
    : [];
  const nextSkills = Array.isArray(skillList)
    ? skillList.map((skill) => (skill && typeof skill === 'object' ? { ...skill } : skill))
    : null;
  const changed = { base: false, dsList: false, skillList: false };

  // 1) Every entry gets a stable id (legacy entries had none).
  const idSet = new Set();
  list.forEach((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.service) return;
    let id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) id = `svc:${entry.service}`;
    if (idSet.has(id)) {
      let n = 2;
      while (idSet.has(`${id}:${n}`)) n++;
      id = `${id}:${n}`;
    }
    if (entry.id !== id) {
      entry.id = id;
      changed.dsList = true;
    }
    idSet.add(id);
  });

  // 2) Legacy value → id maps, built *before* the names are dropped. Ambiguous
  //    values (two entries sharing a name or a provider type) stay untouched:
  //    guessing could bind a Skill to the wrong model, while `resolveApiEntry`
  //    still accepts the old value at runtime.
  const nameToId = new Map();
  const serviceToId = new Map();
  const ambiguousNames = new Set();
  const ambiguousServices = new Set();
  list.forEach((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.id) return;
    const legacyName = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (legacyName) {
      if (nameToId.has(legacyName) && nameToId.get(legacyName) !== entry.id) ambiguousNames.add(legacyName);
      else nameToId.set(legacyName, entry.id);
    }
    const service = String(entry.service || '');
    if (service) {
      if (serviceToId.has(service) && serviceToId.get(service) !== entry.id) ambiguousServices.add(service);
      else serviceToId.set(service, entry.id);
    }
  });
  ambiguousNames.forEach((key) => nameToId.delete(key));
  ambiguousServices.forEach((key) => serviceToId.delete(key));

  const toId = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    if (idSet.has(text)) return text;
    if (nameToId.has(text)) return nameToId.get(text);
    if (serviceToId.has(text)) return serviceToId.get(text);
    return '';
  };

  // 3) `base` (the default configuration) points at an entry id only.
  if (nextBase) {
    if (!nextBase.dsId) {
      const match = findDefaultEntry(list, nextBase);
      if (match) {
        nextBase.dsId = match.id;
        changed.base = true;
      }
    } else {
      const id = toId(nextBase.dsId);
      if (id && id !== nextBase.dsId) {
        nextBase.dsId = id;
        changed.base = true;
      }
    }
    if (nextBase.insightService) {
      const id = toId(nextBase.insightService);
      if (id && id !== nextBase.insightService) {
        nextBase.insightService = id;
        changed.base = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(nextBase, 'dsName')) {
      delete nextBase.dsName;
      changed.base = true;
    }
  }

  // 4) Skills bind to an entry id.
  if (nextSkills) {
    nextSkills.forEach((skill) => {
      if (!skill || typeof skill !== 'object' || !skill.dsService) return;
      const id = toId(skill.dsService);
      if (id && id !== skill.dsService) {
        skill.dsService = id;
        changed.skillList = true;
      }
    });
  }

  // 5) The legacy display name is gone from the stored entries.
  list.forEach((entry) => {
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'name')) {
      delete entry.name;
      changed.dsList = true;
    }
  });

  return { base: nextBase, dsList: list, skillList: nextSkills, changed };
}
