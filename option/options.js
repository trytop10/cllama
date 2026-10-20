import { defaultSettings, i18n, DB_KEY } from "../js/cllama.js";
import { getService, getImageServiceInstance } from "../js/client/client.mjs";
import { balert, confirm } from "../js/dialog.mjs";
import { browser } from '../js/browser.mjs';
import { escapeHtml, exportFile, formatBytes, getStorageUsage } from "../js/util.js";
import {
  PROVIDER_TYPES,
  MODEL_TYPES,
  getProviderMeta,
  providerLabel,
  modelTypeLabel,
  newApiEntryId,
  apiEntryDisplay,
  resolveApiEntry,
  findDefaultEntry,
  normalizeApiList,
  normalizeApiEntry,
  normalizeImageDefaults,
  entryFromConfig,
  isDefaultEntry,
  isTextModelType,
  isImageModelType,
  isVideoModelType,
  migrateLegacyReferences
} from "../js/api-providers.mjs";

let dsList = []; // Data source list (one entry per provider)
let ds = { ...defaultSettings }; // Base settings (the default provider lives here)
let providerModal = null; // Bootstrap modal instance
let editingId = null; // Entry id currently being edited (null = adding)
let modelFetchRequested = false; // Avoid re-fetching on every focus

/** Short i18n lookup with a fallback (empty string is never useful here). */
const msg = (key, fallback = '') => browser.i18n.getMessage(key) || fallback;
/** Translator for the pure helpers in api-providers.mjs. */
const translate = (key) => browser.i18n.getMessage(key);

document.addEventListener('DOMContentLoaded', async () => {
  // Load language-specific stylesheet for German (longer labels)
  if (browser.i18n.getUILanguage().startsWith('de')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'options-l.css';
    document.head.appendChild(link);
  }

  await initPage();  // Initialize the page
  bindEventListeners(); // Bind event listeners
  i18n(); // Initialize i18n for the page
});

/**
 * Initializes page data by loading settings from browser storage.
 */
async function initPage() {
  const data = await browser.storage.local.get([DB_KEY.dsList, DB_KEY.base, DB_KEY.skillList]);
  const rawList = Array.isArray(data[DB_KEY.dsList]) ? data[DB_KEY.dsList] : [];
  const rawBase = data[DB_KEY.base] && typeof data[DB_KEY.base] === 'object' ? data[DB_KEY.base] : {};
  const rawSkills = Array.isArray(data[DB_KEY.skillList]) ? data[DB_KEY.skillList] : null;
  // One-time upgrade of legacy name/service based references to entry ids.
  // The same helper runs in js/cllama.js, so opening the options page is not
  // required for the migration to happen.
  const migration = migrateLegacyReferences({ base: rawBase, dsList: rawList, skillList: rawSkills });
  dsList = normalizeApiList(migration.dsList);
  ds = { ...defaultSettings, ...(migration.base || rawBase) };

  // Legacy entries have no id. Persist the generated ones so the same
  // configuration keeps its identity across reloads and can be referenced by
  // `base.dsId` / `insightService`. Also normalise legacy model types.
  let listDirty = migration.changed.dsList || rawList.length !== dsList.length || rawList.some((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    if (!entry.id) return true;
    return !MODEL_TYPES.some((item) => item.value === entry.modelType);
  });
  let baseDirty = migration.changed.base;
  if (migration.changed.skillList && Array.isArray(migration.skillList)) {
    await browser.storage.local.set({ [DB_KEY.skillList]: migration.skillList });
  }

  // Model types that were merged into "text generation" (chat/reasoning).
  if (ds.modelType !== undefined && !MODEL_TYPES.some((item) => item.value === ds.modelType)) {
    ds.modelType = 'text';
    baseDirty = true;
  }

  let defaultEntry = findDefaultEntry(dsList, ds);

  // Legacy installs may only have `base` and no matching dsList entry. Show it
  // as a provider so it can be edited like any other, and persist the migration.
  if (!defaultEntry && ds.service) {
    const baseEntry = entryFromConfig(ds, ds.dsId || newApiEntryId());
    if (baseEntry) {
      dsList.push(baseEntry);
      defaultEntry = baseEntry;
      listDirty = true;
    }
  }

  // If there is no default but providers exist, adopt the first one. Otherwise
  // chat/insight would have no configuration at all after importing a partial
  // backup. `base` stays the single source of truth for the default.
  if (!defaultEntry && !ds.service && dsList.length > 0) {
    defaultEntry = dsList[0];
    applyDefaultFromEntry(defaultEntry);
    baseDirty = true;
  }

  if (defaultEntry) {
    if (!ds.service) {
      // `dsId` identified the entry but the rest of `base` is missing: rebuild
      // the full default configuration from it.
      applyDefaultFromEntry(defaultEntry);
      baseDirty = true;
    } else {
      // `base` is what chat/insight actually use, so when an old backup has a
      // stale duplicate in dsList the default row must show the real values.
      let changed = false;
      for (const key of ['apiUrl', 'imageApiUrl', 'imageDefaults', 'apiKey', 'modelName', 'modelType', 'multimodal', 'supportsTools']) {
        if (!Object.prototype.hasOwnProperty.call(rawBase, key)) continue;
        const same = key === 'imageDefaults'
          ? JSON.stringify(normalizeImageDefaults(defaultEntry[key])) === JSON.stringify(normalizeImageDefaults(rawBase[key]))
          : defaultEntry[key] === rawBase[key];
        if (!same) {
          defaultEntry[key] = rawBase[key];
          changed = true;
        }
      }
      if (changed) {
        const normalized = normalizeApiEntry(defaultEntry);
        const index = dsList.findIndex((entry) => entry.id === defaultEntry.id);
        if (index >= 0) dsList[index] = normalized;
        else dsList.push(normalized);
        defaultEntry = normalized;
        listDirty = true;
      }
    }
    if (ds.modelType === undefined) {
      ds.modelType = defaultEntry.modelType;
      baseDirty = true;
    }
    if (ds.dsId !== defaultEntry.id) {
      ds.dsId = defaultEntry.id;
      baseDirty = true;
    }
  }

  // Migrate an old `insightService` (service key or name) to the entry id.
  // `_getInsightClientAndData` also accepts old keys directly, so this is only
  // needed to make the dropdown point at the right row.
  if (ds.insightService) {
    const byId = dsList.some((entry) => entry.id === ds.insightService);
    if (!byId) {
      const resolved = resolveApiEntry(dsList, ds.insightService);
      if (resolved) {
        ds.insightService = resolved.id;
        baseDirty = true;
      } else {
        delete ds.insightService;
        baseDirty = true;
      }
    }
  }

  if (listDirty) {
    await browser.storage.local.set({ [DB_KEY.dsList]: dsList });
  }
  if (baseDirty) {
    await browser.storage.local.set({ [DB_KEY.base]: ds });
  }

  renderProviderList();
  populateServiceDropdowns();
  setInsightFormValues();
}

/**
 * Paints the provider list. The default entry is the one mirrored in `base`.
 */
function renderProviderList() {
  const list = document.getElementById('apiProviderList');
  const empty = document.getElementById('apiProviderEmpty');
  if (!list || !empty) return;

  list.textContent = '';
  list.classList.toggle('d-none', dsList.length === 0);
  empty.classList.toggle('d-none', dsList.length > 0);

  dsList.forEach((entry) => list.appendChild(renderProviderRow(entry)));
}

/**
 * Builds one row of the provider list.
 * @param {Object} entry - Normalised dsList entry
 * @returns {HTMLElement} Row element
 */
function renderProviderRow(entry) {
  const isDefault = isDefaultEntry(entry, ds);
  const label = providerLabel(entry.service, translate) || entry.service;

  const row = document.createElement('div');
  row.className = 'api-provider-item' + (isDefault ? ' is-default' : '');
  row.dataset.id = entry.id;
  row.dataset.service = entry.service;

  const avatar = document.createElement('div');
  avatar.className = 'api-provider-avatar';
  avatar.textContent = (label[0] || '?').toUpperCase();

  const main = document.createElement('div');
  main.className = 'api-provider-main';

  const name = document.createElement('div');
  name.className = 'api-provider-name';
  const nameText = document.createElement('span');
  nameText.textContent = label;
  name.appendChild(nameText);
  if (isDefault) {
    const badge = document.createElement('span');
    badge.className = 'badge text-bg-primary api-default-badge';
    badge.textContent = msg('apiDefaultBadge', 'Default');
    name.appendChild(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'api-provider-meta';
  meta.appendChild(document.createTextNode(entry.modelName || '—'));
  meta.appendChild(document.createTextNode(' · '));
  const typeBadge = document.createElement('span');
  typeBadge.className = `api-type-badge api-type-${entry.modelType}`;
  typeBadge.textContent = modelTypeLabel(entry.modelType, translate);
  meta.appendChild(typeBadge);
  if (entry.multimodal) meta.appendChild(makeCap(msg('apiMultimodal', 'Multimodal')));
  if (entry.supportsTools) meta.appendChild(makeCap(msg('apiSupportsTools', 'Tools')));

  main.appendChild(name);
  main.appendChild(meta);

  const endpoint = document.createElement('div');
  endpoint.className = 'api-provider-endpoint';
  const endpointText = isImageModelType(entry.modelType)
    ? (entry.imageApiUrl || '')
    : (entry.apiUrl || '');
  endpoint.textContent = endpointText;
  endpoint.title = endpointText;
  main.appendChild(endpoint);

  const actions = document.createElement('div');
  actions.className = 'api-provider-actions';

  const defaultBtn = makeIconButton('#star', msg('apiSetDefault', 'Set as default'), () => setDefaultProvider(entry.id));
  defaultBtn.classList.add('api-default-btn');
  defaultBtn.classList.toggle('is-default', isDefault);
  defaultBtn.setAttribute('aria-pressed', String(isDefault));
  defaultBtn.disabled = isDefault;

  const editBtn = makeIconButton('#pencil', msg('apiEditProvider', 'Edit provider'), () => openProviderModal(entry.id));
  const deleteBtn = makeIconButton('#trash', msg('apiDeleteProvider', 'Delete provider'), () => deleteProvider(entry.id));
  deleteBtn.classList.add('text-danger');

  actions.appendChild(defaultBtn);
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  row.appendChild(avatar);
  row.appendChild(main);
  row.appendChild(actions);
  return row;
}

/**
 * Small capability chip shown in the provider meta line.
 * @param {string} text - Chip label
 * @returns {HTMLElement} Chip element
 */
function makeCap(text) {
  const cap = document.createElement('span');
  cap.className = 'api-cap';
  cap.textContent = text;
  return cap;
}

/**
 * Icon-only action button (tooltip + accessible name, no text).
 * @param {string} iconId - SVG symbol id (with leading #)
 * @param {string} label - Tooltip / aria-label
 * @param {Function} onClick - Click handler
 * @returns {HTMLButtonElement} Button element
 */
function makeIconButton(iconId, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = `<svg class="api-icon"><use href="${iconId}"></use></svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}


/**
 * Opens the add/edit dialog.
 * @param {string|null} id - Entry id to edit, or null to add one
 */
function openProviderModal(id) {
  editingId = id || null;
  const entry = id ? dsList.find((item) => item.id === id) : null;

  if (entry) {
    fillProviderForm(entry, true);
  } else {
    // Several configurations of the same provider are allowed, so "add" always
    // starts from the first provider type (the user can switch it freely).
    const serviceKey = PROVIDER_TYPES[0].service;
    fillProviderForm({
      id: newApiEntryId(),
      service: serviceKey,
      apiUrl: getProviderMeta(serviceKey).defaultUrl || '',
      apiKey: '',
      modelName: '',
      modelType: 'text'
    }, false);
  }

  ensureProviderModal().show();
}

/** Values offered by the image-defaults selects. */
const IMAGE_SELECT_VALUES = {
  imageSize: ['auto', '512', '768', '1K', '1.5K', '2K', '4K', '1024x1024', '1536x1024', '1024x1536', '2048x2048'],
  imageAspectRatio: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'],
  imageQuality: ['auto', 'low', 'medium', 'high'],
  imageOutputFormat: ['auto', 'png', 'jpeg', 'webp'],
  imageBackground: ['auto', 'transparent', 'opaque']
};

/**
 * Fills the static option lists once. Labels stay untranslated for concrete
 * values ("1024x1024", "png"…); "auto" is the only word needing translation.
 */
function ensureImageSelectOptions() {
  for (const [id, values] of Object.entries(IMAGE_SELECT_VALUES)) {
    const select = document.getElementById(id);
    if (!select || select.options.length) continue;
    values.forEach((value) => {
      select.add(new Option(value === 'auto' ? msg('imageOptionAuto', 'Auto') : value, value));
    });
  }
}

/**
 * Shows the image rows only for image models, and the "not implemented" hint
 * for video models. The endpoint field also gets a sensible default when empty.
 */
function updateModelTypeVisibility() {
  const type = document.getElementById('apiModelType').value;
  const service = document.getElementById('apiProviderType').value;
  const isImage = isImageModelType(type);
  const isVideo = isVideoModelType(type);

  document.getElementById('imageApiUrlRow').classList.toggle('d-none', !isImage);
  document.getElementById('imageDefaultsRow').classList.toggle('d-none', !isImage);
  document.getElementById('videoUnsupportedHint').classList.toggle('d-none', !isVideo);

  const imageUrl = document.getElementById('imageApiUrl');
  const meta = getProviderMeta(service);
  if (isImage && !imageUrl.value.trim()) {
    imageUrl.value = meta.imageDefaultUrl || '';
  }

  // Switching an image-only entry back to text leaves the chat URL empty; fill
  // the provider default instead of forcing the user to paste the same URL.
  const textUrl = document.getElementById('apiUrl');
  if (!isImage && !isVideo && textUrl && !textUrl.value.trim()) {
    textUrl.value = meta.defaultUrl || '';
  }
}

/**
 * Fills every field of the dialog.
 * @param {Object} entry - Provider data
 * @param {boolean} isEdit - Whether this is an edit
 */
function fillProviderForm(entry, isEdit) {
  const form = document.getElementById('apiProviderForm');
  const typeSelect = document.getElementById('apiProviderType');
  const modelTypeSelect = document.getElementById('apiModelType');

  typeSelect.innerHTML = '';
  PROVIDER_TYPES.forEach((item) => {
    typeSelect.add(new Option(providerLabel(item.service, translate), item.service));
  });
  // Unknown legacy providers (e.g. "Test") stay editable instead of being lost.
  if (entry.service && !PROVIDER_TYPES.some((item) => item.service === entry.service)) {
    typeSelect.add(new Option(entry.service, entry.service));
  }
  typeSelect.value = entry.service;
  form.dataset.lastService = entry.service;

  if (modelTypeSelect.options.length === 0) {
    MODEL_TYPES.forEach((item) => {
      modelTypeSelect.add(new Option(modelTypeLabel(item.value, translate), item.value));
    });
  }
  modelTypeSelect.value = entry.modelType || 'text';

  ensureImageSelectOptions();
  const meta = getProviderMeta(entry.service);
  document.getElementById('imageApiUrl').value = entry.imageApiUrl
    || (isImageModelType(entry.modelType) ? (meta.imageDefaultUrl || '') : '');
  const imageDefaults = normalizeImageDefaults(entry.imageDefaults);
  document.getElementById('imageSize').value = imageDefaults.size;
  document.getElementById('imageAspectRatio').value = imageDefaults.aspect_ratio;
  document.getElementById('imageQuality').value = imageDefaults.quality;
  document.getElementById('imageOutputFormat').value = imageDefaults.output_format;
  document.getElementById('imageBackground').value = imageDefaults.background;
  document.getElementById('imageCount').value = String(imageDefaults.n);
  document.getElementById('imageSeed').value = imageDefaults.seed === null ? '' : String(imageDefaults.seed);

  document.getElementById('apiUrl').value = entry.apiUrl
    || (isEdit ? '' : getProviderMeta(entry.service).defaultUrl || '');
  document.getElementById('apiKey').value = entry.apiKey || '';
  document.getElementById('apiKey').setAttribute('type', 'password');
  document.getElementById('eyeOrEyeslash').setAttribute('href', '#eye');
  document.getElementById('modelName').value = entry.modelName || '';
  document.getElementById('modelNameList').innerHTML = '';
  document.getElementById('modelFetchStatus').textContent = '';
  document.getElementById('apiMultimodal').checked = entry.multimodal === true;
  document.getElementById('apiSupportsTools').checked = entry.supportsTools === true;

  form.classList.remove('was-validated');
  modelFetchRequested = false;
  updateModelTypeVisibility();

  const title = isEdit ? msg('apiEditProviderTitle', 'Edit API provider') : msg('apiAddProviderTitle', 'Add API provider');
  document.getElementById('apiProviderModalTitle').textContent = title;
}

/** Keeps the URL field useful when the provider type changes. */
function onProviderChanged() {
  const form = document.getElementById('apiProviderForm');
  const select = document.getElementById('apiProviderType');
  const urlInput = document.getElementById('apiUrl');
  const previous = getProviderMeta(form.dataset.lastService || '');
  const next = getProviderMeta(select.value);
  const current = urlInput.value.trim();

  if (!current || current === previous.defaultUrl) {
    urlInput.value = next.defaultUrl || '';
  }

  const imageUrlInput = document.getElementById('imageApiUrl');
  if (imageUrlInput) {
    const imageCurrent = imageUrlInput.value.trim();
    if (!imageCurrent || imageCurrent === (previous.imageDefaultUrl || '')) {
      imageUrlInput.value = next.imageDefaultUrl || '';
    }
  }

  form.dataset.lastService = select.value;
  modelFetchRequested = false;
  updateModelTypeVisibility();
  document.getElementById('modelNameList').innerHTML = '';
  document.getElementById('modelFetchStatus').textContent = '';
}


/**
 * Loads the model list into the datalist. Typing a model name manually always
 * remains possible, so a provider that does not expose /models is not a dead end.
 */
async function fetchModelList() {
  const service = document.getElementById('apiProviderType').value;
  const url = document.getElementById('apiUrl').value.trim();
  const key = document.getElementById('apiKey').value.trim();
  const status = document.getElementById('modelFetchStatus');
  const datalist = document.getElementById('modelNameList');
  const button = document.getElementById('b_fetch_models');

  if (!url) {
    status.textContent = msg('apiModelsFailed');
    return;
  }

  modelFetchRequested = true;
  button.disabled = true;
  status.textContent = msg('apiModelsLoading');

  try {
    const modelType = document.getElementById('apiModelType').value;
    let models = [];
    if (isImageModelType(modelType)) {
      // Image models live on a different endpoint (OpenRouter: /images/models),
      // so the text client's /models list would be the wrong catalogue.
      const imageClient = getImageServiceInstance({
        service,
        modelType,
        imageApiUrl: document.getElementById('imageApiUrl').value.trim(),
        apiUrl: url,
        apiKey: key
      });
      const catalogue = await imageClient.getImageModels(true);
      models = catalogue.ids;
    } else {
      const client = getService(service, url, key);
      models = await client.getModels(true);
    }
    const names = [...new Set((models || []).filter(Boolean).map(String))];

    datalist.innerHTML = '';
    names.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      datalist.appendChild(option);
    });

    // Convenience only: never overwrite what the user already typed.
    const modelInput = document.getElementById('modelName');
    if (!modelInput.value.trim() && names.length > 0) {
      modelInput.value = names[0];
    }

    status.textContent = msg('apiModelsLoaded', '{count} models loaded').replace('{count}', String(names.length));
  } catch (error) {
    console.error('Failed to load models:', error);
    status.textContent = msg('apiModelsFailed');
  } finally {
    button.disabled = false;
  }
}

/**
 * Saves the dialog: adds a provider, or updates the one being edited. The
 * default provider is mirrored into `base` (still the single source of truth).
 * @param {Event} event - Submit event
 */
async function saveProvider(event) {
  event.preventDefault();

  const form = document.getElementById('apiProviderForm');
  const service = document.getElementById('apiProviderType').value;
  const apiUrl = document.getElementById('apiUrl').value.trim();
  const imageApiUrl = document.getElementById('imageApiUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const modelName = document.getElementById('modelName').value.trim();
  const modelType = document.getElementById('apiModelType').value;

  // An image entry needs its images endpoint, not the chat-completions URL;
  // a text entry needs the chat URL. Requiring both would force users to fill a
  // field that is never used.
  const requiredEndpoint = isImageModelType(modelType) ? (imageApiUrl || apiUrl) : apiUrl;
  if (!service || !requiredEndpoint || !modelName || !form.checkValidity()) {
    form.classList.add('was-validated');
    balert(msg('requiredError'));
    return;
  }

  const editingEntry = editingId
    ? dsList.find((item) => item.id === editingId)
    : null;
  const wasDefault = editingEntry ? isDefaultEntry(editingEntry, ds) : false;

  const entry = normalizeApiEntry({
    // Keep every field of the entry being edited (id, and capability flags the
    // dialog does not expose) instead of rebuilding it from the form alone.
    ...editingEntry,
    id: editingId || newApiEntryId(),
    service,
    apiUrl,
    imageApiUrl,
    imageDefaults: {
      size: document.getElementById('imageSize').value,
      aspect_ratio: document.getElementById('imageAspectRatio').value,
      quality: document.getElementById('imageQuality').value,
      n: Number(document.getElementById('imageCount').value),
      output_format: document.getElementById('imageOutputFormat').value,
      background: document.getElementById('imageBackground').value,
      seed: document.getElementById('imageSeed').value === ''
        ? null
        : Number(document.getElementById('imageSeed').value)
    },
    apiKey,
    modelName,
    modelType,
    multimodal: document.getElementById('apiMultimodal').checked,
    supportsTools: document.getElementById('apiSupportsTools').checked || undefined
  });

  // Add mode always appends: several configurations of the same provider type
  // are legitimate (different endpoints, keys or models).
  const index = editingId
    ? dsList.findIndex((item) => item.id === editingId)
    : -1;

  if (index >= 0) dsList.splice(index, 1, entry);
  else dsList.push(entry);

  if (!ds.service || wasDefault || dsList.length === 1) {
    applyDefaultFromEntry(entry);
  }

  await browser.storage.local.set({ [DB_KEY.base]: ds, [DB_KEY.dsList]: dsList });

  ensureProviderModal().hide();
  renderProviderList();
  populateServiceDropdowns();
  setInsightFormValues();
  balert(msg('saveSuccessMessage'));
}

/**
 * Copies one provider entry into `base` (the default configuration).
 * @param {Object} entry - Normalised dsList entry
 */
function applyDefaultFromEntry(entry) {
  if (!entry) return;
  ds.dsId = entry.id;
  ds.service = entry.service;
  ds.apiUrl = entry.apiUrl || '';
  ds.imageApiUrl = entry.imageApiUrl || '';
  ds.imageDefaults = normalizeImageDefaults(entry.imageDefaults);
  ds.apiKey = entry.apiKey || '';
  ds.modelName = entry.modelName || '';
  ds.modelType = entry.modelType || 'text';
  ds.multimodal = entry.multimodal === true;
  if (entry.supportsTools === true) ds.supportsTools = true;
  else delete ds.supportsTools;
}

/**
 * Marks a provider as default. Only `base` changes; dsList is untouched.
 * @param {string} id - Entry id
 */
async function setDefaultProvider(id) {
  const entry = dsList.find((item) => item.id === id);
  if (!entry) return;

  applyDefaultFromEntry(entry);
  await browser.storage.local.set({ [DB_KEY.base]: ds });
  renderProviderList();
  populateServiceDropdowns();
  setInsightFormValues();
}

/**
 * Deletes a provider. If it was the default, the first remaining provider is
 * promoted (or the default fields are cleared when none are left).
 * @param {string} id - Entry id
 */
async function deleteProvider(id) {
  const entry = dsList.find((item) => item.id === id);
  if (!entry) return;

  const name = escapeHtml(apiEntryDisplay(entry, translate) || entry.service);
  const ok = await confirm(msg('apiDeleteProviderConfirm', 'Delete provider "{name}"?').replace('{name}', name), {
    title: msg('apiDeleteProvider', 'Delete provider'),
    okText: msg('delete', 'Delete'),
    cancelText: msg('cancel', 'Cancel')
  });
  if (!ok) return;

  const wasDefault = isDefaultEntry(entry, ds) || ds.dsId === id;
  dsList = dsList.filter((item) => item.id !== id);

  if (wasDefault) {
    if (dsList.length > 0) {
      applyDefaultFromEntry(dsList[0]);
    } else {
      ['dsId', 'service', 'apiUrl', 'imageApiUrl', 'imageDefaults', 'apiKey', 'modelName', 'modelType', 'multimodal', 'supportsTools']
        .forEach((key) => delete ds[key]);
    }
  }

  // Do not leave the insight tab pointing at a provider that no longer exists.
  if (ds.insightService === id || dsList.length === 0) delete ds.insightService;

  await browser.storage.local.set({ [DB_KEY.base]: ds, [DB_KEY.dsList]: dsList });
  renderProviderList();
  populateServiceDropdowns();
  setInsightFormValues();
}

/**
 * Ensures the Bootstrap modal instance exists.
 * @returns {Object} Modal instance
 */
function ensureProviderModal() {
  if (!providerModal) {
    providerModal = new bootstrap.Modal(document.getElementById('apiProviderModal'));
  }
  return providerModal;
}

/**
 * Fills the insight tab controls from the base settings.
 */
function setInsightFormValues() {
  const think = document.getElementById('insightThink');
  if (think) think.checked = ds.insightThink === true;

  const temp = document.getElementById('insightTemperature');
  if (temp) temp.value = Number.isFinite(Number(ds.insightTemperature)) ? Number(ds.insightTemperature) : 0.7;
  const tempValue = document.getElementById('insightTemperatureValue');
  if (temp && tempValue) tempValue.textContent = parseFloat(temp.value).toFixed(1);

  const topP = document.getElementById('insightTopP');
  if (topP) topP.value = Number.isFinite(Number(ds.insightTopP)) ? Number(ds.insightTopP) : 0.9;
  const topPValue = document.getElementById('insightTopPValue');
  if (topP && topPValue) topPValue.textContent = parseFloat(topP.value).toFixed(1);

  const insightSelect = document.getElementById('insightService');
  if (insightSelect) insightSelect.value = ds.insightService || '';
}

/**
 * Populates the insight provider dropdown from dsList. The first entry means
 * "same as default", so clearing the choice stays possible.
 */
function populateServiceDropdowns() {
  const insightSelect = document.getElementById('insightService');
  const insightHint = document.getElementById('insightSvcHint');
  if (!insightSelect) return;

  insightSelect.innerHTML = '';
  insightSelect.add(new Option(msg('apiUseDefaultProvider', 'Same as default'), ''));

  // Insight is a text pipeline: never offer an image/video entry, or the
  // request would be sent to an endpoint that cannot answer it.
  const textEntries = dsList.filter((item) => isTextModelType(item.modelType));
  textEntries.forEach((item) => {
    insightSelect.add(new Option(apiEntryDisplay(item, translate) || item.service, item.id));
  });

  const known = textEntries.some((item) => item.id === ds.insightService);
  insightSelect.value = known ? ds.insightService : '';

  const empty = dsList.length === 0;
  insightSelect.disabled = empty;
  if (insightHint) insightHint.classList.toggle('d-none', !empty);
}

/**
 * Saves insight-specific settings to browser local storage.
 */
async function saveInsightSettings() {
  const insightService = document.getElementById('insightService').value;

  if (insightService) ds.insightService = insightService;
  else delete ds.insightService;

  ds.insightThink = document.getElementById('insightThink').checked;
  ds.insightTemperature = parseFloat(document.getElementById('insightTemperature').value);
  ds.insightTopP = parseFloat(document.getElementById('insightTopP').value);

  await browser.storage.local.set({ [DB_KEY.base]: ds });
  balert(msg('saveSuccessMessage'));
}

/**
 * Show how much `storage.local` the extension uses in total (settings, insights,
 * chat history, skills…), under the export controls. Only the used amount is
 * shown — the browser does not expose its own quota.
 */
async function renderStorageUsage() {
  const el = document.getElementById('storageUsage');
  if (!el) return;
  const bytes = await getStorageUsage();
  if (bytes == null) {
    el.textContent = '';
    return;
  }
  const tpl = browser.i18n.getMessage('storageUsage') || 'Local storage used: {size}';
  el.textContent = tpl.replace('{size}', formatBytes(bytes));
  // Highlight once the data gets large (the manifests request unlimitedStorage, so
  // this is a "you may want to export/clean up" nudge, not a hard limit).
  el.classList.toggle('text-danger', bytes > 8 * 1024 * 1024);
}

/**
 * Exports selected data from browser local storage to a JSON file.
 */
async function exportData() {
  // Get all checked export options
  const selectedOptions = Array.from(
    document.querySelectorAll('input[name="exportOptions"]:checked')
  ).map(checkbox => checkbox.value);

  // If no options are selected, show an error message
  if (selectedOptions.length === 0) {
    balert(browser.i18n.getMessage("exportOptionEmptyError"));
    return;
  }

  // Retrieve all data from local storage
  await browser.storage.local.get(null, function(data){
    let expdata = {};

    // Process selected options for export
    selectedOptions.forEach(o => {
      if(o === "chatData"){
        // If "chatData" is selected, export all chat history entries and the
        // bookmarked answers (a favourite is a snapshot of its own, so it must
        // travel with the backup or it would be lost on restore).
        for (const k of Object.keys(data)) {
          if(k.startsWith("chatHistory_")){
            expdata[k] = data[k];
          }
        }
        expdata[DB_KEY.chatBookmarks] = data[DB_KEY.chatBookmarks] || [];
      } else if(o === "base"){
        // If "base" is selected, export base settings and data source list
        expdata[o] = data[o];
        expdata["dsList"] = data["dsList"];
      } else {
        // Export other selected keys directly
        expdata[o] = data[o];
      }
    });
    
    // Convert the collected data to a JSON string and export it as a file
    const dbdata = JSON.stringify(expdata, null, 2);
    exportFile(dbdata, "json", "db.json");
  });
}


/**
 * Shows / hides the API key in the provider dialog.
 */
function togglePasswordVisibility() {
  const apiKeyInput = document.getElementById('apiKey');
  const type = apiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
  apiKeyInput.setAttribute('type', type);

  document.getElementById('eyeOrEyeslash')
    .setAttribute('href', type === 'password' ? '#eye' : '#eye-slash');
}



/**
 * Binds all event listeners to the DOM elements.
 */
function bindEventListeners() {
  // Provider list: add + dialog actions
  document.getElementById('b_add_api').addEventListener('click', () => openProviderModal(null));
  document.getElementById('apiProviderForm').addEventListener('submit', saveProvider);
  document.getElementById('apiProviderType').addEventListener('change', onProviderChanged);
  document.getElementById('apiModelType').addEventListener('change', updateModelTypeVisibility);
  document.getElementById('togglePassword').addEventListener('click', togglePasswordVisibility);
  document.getElementById('b_fetch_models').addEventListener('click', fetchModelList);

  // Fetch the model list when the field gains focus (once per dialog opening).
  document.getElementById('modelName').addEventListener('focus', () => {
    if (!modelFetchRequested) fetchModelList();
  });

  // Event listener for the insight save button
  document.getElementById('b_save_insight').addEventListener('click', saveInsightSettings);

  // Event listener for the export data button
  document.getElementById('a_export').addEventListener('click', exportData);
  // Show how much local data the extension holds (all of it: settings, insights,
  // chat history, skills…), next to where the user backs that data up.
  renderStorageUsage();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') renderStorageUsage();
  });
  // Event listener for the import data button
  document.getElementById('b_upload').addEventListener('click', function(e){

    // Keys that are allowed to be imported from the JSON file
    const allowedDataKeys = ["base", "dsList", "actionList", "chatTpaList", "insightList", "urls", "skillList", "mcpServers", DB_KEY.chatBookmarks];

    const fileInput = document.getElementById('jsonFile');
    const file = fileInput.files[0];

    // Validate if a file is selected and if it's a JSON file
    if (!file || !file.name.endsWith('.json')) {
      balert(browser.i18n.getMessage("importFileTypeError")); // Assuming an i18n message for file type error
      return;
    }
  
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const jsonData = JSON.parse(e.target.result);
        let importData = {};

        // Filter and collect only allowed data keys for import
        for (const k of Object.keys(jsonData)) {
          if(allowedDataKeys.includes(k) || k.startsWith("chatHistory_")){
            importData[k] = jsonData[k];
          }
        }

        // If no valid data was found for import, show an error
        if(Object.keys(importData).length === 0){
          balert(browser.i18n.getMessage("importFailMsg1"));   
          return;
        }

        // Store the imported data in browser local storage
        await browser.storage.local.set(importData);
        balert(browser.i18n.getMessage("importSuccessMessage"));      
        await initPage(); // Reload page data to reflect imported settings
      } catch (error) {
        // Handle parsing or storage errors during import
        balert(browser.i18n.getMessage("importFailMessage") + "\n" + error);
      }
    };
    reader.readAsText(file); // Read the selected file as text
  });

  // Range slider live display updates for insight options
  ['insightTemperature', 'insightTopP'].forEach(id => {
    const slider = document.getElementById(id);
    const badge = document.getElementById(id + 'Value');
    if (slider && badge) {
      slider.addEventListener('input', () => badge.textContent = parseFloat(slider.value).toFixed(1));
    }
  });

  // Event listener for file input change to display selected file name
  document.getElementById('jsonFile').addEventListener('change', function() {
    const fileNameDiv = document.getElementById('fileName');
    if (this.files.length > 0) {
        fileNameDiv.textContent = `${browser.i18n.getMessage("selectedFile")}: ${this.files[0].name}`; // Assuming an i18n message for "Selected File"
    } else {
        fileNameDiv.textContent = '';
    }
  });
}
