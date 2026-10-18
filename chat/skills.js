import { i18n, loadSkills, saveSkills, getRuntimeConfig, loadMcpAppAutoRender, setMcpAppAutoRender, loadMcpAppDebug, setMcpAppDebug } from "../js/cllama.js";
import { providerLabel, apiEntryId, apiEntryDisplay, resolveApiEntry } from "../js/api-providers.mjs";
import { listTools } from "../js/skill-tools.mjs";
import { loadMcpServers, saveMcpServers, listMcpTools, initMcpTools } from "../js/mcp.mjs";
import { balert } from "../js/dialog.mjs";
import { browser } from '../js/browser.mjs';
import { escapeHtml, getQueryParam } from "../js/util.js";

let skillConfigurations = [];
let skillModal = null;
let editingTools = []; // [{ name, args }] rows being edited in the modal
let mcpConfigurations = [];
let mcpModal = null;
let mcpToolsModal = null;
let serviceEntries = []; // Data sources currently offered in the Skill editor
// Last successful "Test connection" result, kept for the copy button.
let lastMcpToolsPreview = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Breadcrumb link back to the chat page (keeps the chat scenario id).
  const ccId = getQueryParam("id");
  const crumbChat = document.getElementById('crumbChat');
  if (crumbChat) {
    crumbChat.textContent = browser.i18n.getMessage("chat") || 'Chat';
    crumbChat.href = ccId ? `./chat.html?id=${ccId}` : './chat.html';
  }

  // Skill management events
  document.getElementById('b_add_skill').addEventListener('click', showAddSkillForm);
  document.getElementById('b_add_tool').addEventListener('click', appendToolRow);
  document.getElementById('b_save_skill').addEventListener('click', saveSkillFromForm);

  // MCP server management events
  document.getElementById('b_add_mcp').addEventListener('click', showAddMcpForm);
  document.getElementById('b_save_mcp').addEventListener('click', saveMcpFromForm);
  document.getElementById('b_test_mcp').addEventListener('click', testMcpFromForm);
  document.getElementById('b_copy_mcp_tools').addEventListener('click', copyMcpToolsReport);

  // Per-Skill model override options (read-only view of the data source list).
  await buildServiceOptions();

  // Render immediately; register MCP tools in the background so a slow or
  // dead server never delays the page. Tool rows are re-read from listTools()
  // each time a Skill form opens, so late-registered tools appear there.
  initMcpTools().catch(e => console.warn('[MCP] init failed:', e));
  await initMcpList();

  // MCP App views: render them automatically, or keep every one of them behind
  // its own "render" button (see AGENTS.md §7.13).
  const autoRenderBox = document.getElementById('mcpAppAutoRender');
  if (autoRenderBox) {
    autoRenderBox.checked = await loadMcpAppAutoRender();
    autoRenderBox.addEventListener('change', () => setMcpAppAutoRender(autoRenderBox.checked));
  }

  // MCP App debugging: mirror each view's console into the chat page and show
  // its handshake timeline on the card (see AGENTS.md §7.13).
  const appDebugBox = document.getElementById('mcpAppDebug');
  if (appDebugBox) {
    appDebugBox.checked = await loadMcpAppDebug();
    appDebugBox.addEventListener('change', () => setMcpAppDebug(appDebugBox.checked));
  }
  document.getElementById('b_open_app_debug')?.addEventListener('click', () => {
    browser.tabs.create({ url: browser.runtime.getURL('viewer/mcp-app-debug.html') });
  });
  await initSkillList();
  i18n();
});

/**
 * Fill the per-Skill model dropdown from the configured data sources. The empty
 * first entry means "use the current model" (no override).
 */
async function buildServiceOptions() {
  const select = document.getElementById('skillServiceInput');
  if (!select) return;
  const config = await getRuntimeConfig();
  const list = config?.dsList || [];
  serviceEntries = list;
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = browser.i18n.getMessage('skillServiceDefault') || 'Use the current model';
  select.appendChild(none);
  list.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = apiEntryId(d) || d.service;
    opt.textContent = apiEntryDisplay(d, (key) => browser.i18n.getMessage(key))
      || `${providerLabel(d.service, (key) => browser.i18n.getMessage(key)) || d.service} (${d.modelName || d.service})`;
    select.appendChild(opt);
  });
}

/**
 * Lazily obtain the skill editor modal instance.
 * @returns {Object} Bootstrap modal instance
 */
function ensureSkillModal() {
  if (!skillModal) {
    skillModal = new bootstrap.Modal(document.getElementById('skillModal'));
  }
  return skillModal;
}

/**
 * Load skills and render the skill list.
 */
async function initSkillList() {
  skillConfigurations = await loadSkills();
  renderSkillList();
}

/**
 * Render the list of skills with edit / delete buttons.
 */
function renderSkillList() {
  const container = document.getElementById('skillListContainer');
  if (!container) return;

  if (!skillConfigurations.length) {
    container.innerHTML = `<div class="text-muted i18n">skillListEmpty</div>`;
    return;
  }

  container.innerHTML = skillConfigurations.map((s, index) => `
    <div class="list-group-item d-flex align-items-center py-2" data-index="${index}">
      <div class="flex-grow-1">
        <strong>${s.name}</strong>
        ${s.manualOnly ? `<span class="badge text-bg-secondary ms-1" title="${browser.i18n.getMessage("skillManualOnlyHint")}">${browser.i18n.getMessage("skillManualOnly")}</span>` : ''}
        <div class="text-muted small">${s.description || ''}</div>
        ${Array.isArray(s.tools) && s.tools.length ? `<div class="text-muted small">🧰 ${s.tools.filter(t => !t.blocked && !(typeof t === 'string' && t.startsWith('!'))).map(t => t.name || t).join(', ')}${s.tools.some(t => t.blocked || (typeof t === 'string' && t.startsWith('!'))) ? ` <span class="text-danger">🚫 ${s.tools.filter(t => t.blocked || (typeof t === 'string' && t.startsWith('!'))).map(t => (t.name || t).replace(/^!/, '')).join(', ')}</span>` : ''}</div>` : ''}
      </div>
      <div class="btn-group ms-2 flex-shrink-0">
        <button type="button" class="btn btn-sm btn-outline-secondary skill-edit-btn" title="${browser.i18n.getMessage("editSkill")}">✍</button>
        <button type="button" class="btn btn-sm btn-outline-secondary skill-delete-btn" title="${browser.i18n.getMessage("deleteSkill")}">✘</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.skill-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.closest('[data-index]').dataset.index, 10);
      showSkillForm(skillConfigurations[index]);
    });
  });

  container.querySelectorAll('.skill-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.closest('[data-index]').dataset.index, 10);
      skillConfigurations.splice(index, 1);
      await saveSkills(skillConfigurations);
      renderSkillList();
    });
  });
}

/**
 * Parse a raw argument input value into a JS value.
 * Empty string → undefined (excluded). Attempts JSON parsing, else keeps string.
 * @param {string} raw - Raw input text
 * @returns {*} Parsed value or undefined
 */
function parseArgValue(raw) {
  const v = (raw || '').trim();
  if (v === '') return undefined;
  try { return JSON.parse(v); } catch (e) { return v; }
}

/**
 * Format a stored argument value for display in an input box.
 * @param {*} value - Stored value
 * @returns {string} Display string
 */
function formatArgValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Build the HTML for the argument inputs of a tool (one input per declared parameter).
 * @param {Object} tool - Registered tool
 * @param {Object} args - Currently configured args
 * @returns {string} HTML string (empty if the tool declares no parameters)
 */
function toolParamsHtml(tool, args) {
  if (!tool || !tool.parameters || !tool.parameters.properties) return '';
  const props = tool.parameters.properties;
  const keys = Object.keys(props);
  if (!keys.length) return '';

  const argObj = args || {};
  return keys.map(key => {
    const prop = props[key] || {};
    return `
      <div class="tool-param-row mt-1">
        <label class="form-label small mb-0">${key} <span class="text-muted">(${prop.type || 'string'})</span></label>
        <input type="text" class="form-control form-control-sm tool-arg-input" data-key="${key}"
               placeholder="${prop.description || ''}" value="${formatArgValue(argObj[key])}">
      </div>
    `;
  }).join('');
}

/**
 * Update a single tool row's description and argument inputs (after the select changes).
 * @param {HTMLElement} rowEl - The row element
 * @param {number} index - Row index
 */
function updateRowParams(rowEl, index) {
  const tool = listTools().find(t => t.name === editingTools[index].name);
  const descEl = rowEl.querySelector('.tool-desc');
  if (descEl) descEl.textContent = tool ? toolDesc(tool) : '';
  const hintInput = rowEl.querySelector('.tool-hint-input');
  if (hintInput) hintInput.value = editingTools[index].hint || '';
  const paramWrap = rowEl.querySelector('.tool-param-wrap');
  if (paramWrap) paramWrap.innerHTML = toolParamsHtml(tool, editingTools[index].args || {});
}

/**
 * Localized label for a tool (uses i18nKey when available).
 * @param {Object} t - Registered tool
 * @returns {string}
 */
function toolLabel(t) {
  return t?.i18nKey ? (browser.i18n.getMessage(t.i18nKey) || t.name) : (t?.name || '');
}

/**
 * Localized description for a tool (uses i18nKey_desc when available).
 * @param {Object} t - Registered tool
 * @returns {string}
 */
function toolDesc(t) {
  return t?.i18nKey ? (browser.i18n.getMessage(t.i18nKey + '_desc') || t.description) : (t?.description || '');
}

/**
 * Render the tool rows (one row per configured tool).
 * Each row lets the user pick a tool, see its description, and fill one input
 * per declared parameter.
 */
function renderToolRows() {
  const container = document.getElementById('toolRows');
  if (!container) return;

  const tools = listTools();

  container.innerHTML = editingTools.map((item, index) => {
    const tool = tools.find(t => t.name === item.name);
    return `
      <div class="tool-row" data-index="${index}">
        <div class="d-flex align-items-center gap-2">
          <select class="form-select form-select-sm tool-select flex-grow-1">
            <option value="">${browser.i18n.getMessage("toolSelectPlaceholder")}</option>
            ${tools.map(t => `<option value="${t.name}" ${item.name === t.name ? 'selected' : ''}>${t.name}(${toolLabel(t)})</option>`).join('')}
          </select>
          <button type="button" class="btn btn-sm btn-compact btn-outline-danger tool-del-btn" title="${browser.i18n.getMessage("deleteSkill")}">×</button>
        </div>
        <div class="tool-desc text-muted small mt-1">${tool ? toolDesc(tool) : ''}</div>
        <input type="text" class="form-control form-control-sm tool-hint-input mt-1" maxlength="200"
               placeholder="${escapeHtml(browser.i18n.getMessage('skillToolHintPlaceholder') || '')}"
               value="${escapeHtml(item.hint || '')}">
        <div class="tool-param-wrap mt-1">${toolParamsHtml(tool, item.args)}</div>
      </div>
    `;
  }).join('');

  if (!editingTools.length) {
    container.innerHTML = `<div class="text-muted small">${browser.i18n.getMessage("toolRowsEmpty")}</div>`;
    return;
  }

  container.querySelectorAll('.tool-row').forEach(rowEl => {
    const index = parseInt(rowEl.dataset.index, 10);
    const select = rowEl.querySelector('.tool-select');
    const delBtn = rowEl.querySelector('.tool-del-btn');

    select.addEventListener('change', () => {
      editingTools[index].name = select.value;
      editingTools[index].args = {};
      // A hint describes ONE tool; keeping it after switching would lie.
      editingTools[index].hint = '';
      updateRowParams(rowEl, index);
    });

    delBtn.addEventListener('click', () => removeToolRow(index));
  });
}

/**
 * Sync the current argument input values back into editingTools.
 */
function syncArgsFromDom() {
  document.querySelectorAll('#toolRows .tool-row').forEach(rowEl => {
    const index = parseInt(rowEl.dataset.index, 10);
    const select = rowEl.querySelector('.tool-select');
    editingTools[index].name = select.value;
    const args = {};
    rowEl.querySelectorAll('.tool-arg-input').forEach(inp => {
      const val = parseArgValue(inp.value);
      if (val !== undefined) args[inp.dataset.key] = val;
    });
    editingTools[index].args = args;
    const hintInput = rowEl.querySelector('.tool-hint-input');
    editingTools[index].hint = hintInput ? hintInput.value.trim() : '';
  });
}

/**
 * Add a new empty tool row.
 */
function appendToolRow() {
  editingTools.push({ name: '', args: {}, hint: '' });
  renderToolRows();
}

/**
 * Remove the tool row at the given index.
 * @param {number} index - Row index
 */
function removeToolRow(index) {
  syncArgsFromDom(); // preserve other rows' inputs
  editingTools.splice(index, 1);
  renderToolRows();
}

/**
 * Collect the configured tools from the form rows.
 * @returns {Array<{name:string, args:Object}>}
 */
function collectToolsFromForm() {
  syncArgsFromDom();
  return editingTools
    .filter(item => item.name)
    .map(item => {
      const entry = { name: item.name, args: item.args || {} };
      if (item.hint) entry.hint = item.hint;
      if (item.blocked) entry.blocked = true;
      return entry;
    });
}

/**
 * Show the skill form for adding a new skill.
 */
function showAddSkillForm() {
  showSkillForm(null);
}

/**
 * Show the skill editor modal (populated for editing, or empty for adding).
 * @param {Object|null} skill - Skill to edit, or null to add
 */
function showSkillForm(skill) {
  document.getElementById('skillId').value = skill ? skill.id : '';
  document.getElementById('skillNameInput').value = skill ? skill.name : '';
  document.getElementById('skillDescInput').value = skill ? (skill.description || '') : '';
  document.getElementById('skillPromptInput').value = skill ? (skill.prompt || '') : '';
  const starterInput = document.getElementById('skillStarterInput');
  if (starterInput) starterInput.value = skill ? (skill.starter || '') : '';
  editingTools = skill && Array.isArray(skill.tools)
    ? skill.tools.map(t => ({
        name: t.name || '',
        args: t.args || {},
        hint: typeof t.hint === 'string' ? t.hint : '',
        blocked: t.blocked === true || (typeof t === 'string' && t.startsWith('!'))
      }))
    : [];
  renderToolRows();

  const manualOnlyInput = document.getElementById('skillManualOnlyInput');
  if (manualOnlyInput) manualOnlyInput.checked = skill ? skill.manualOnly === true : false;

  const serviceInput = document.getElementById('skillServiceInput');
  if (serviceInput) {
    const stored = skill ? (skill.dsService || '') : '';
    // Old Skills store the service key (or a display name); new ones store the
    // entry id. Resolve old values so the dropdown highlights the right entry.
    const resolved = stored ? resolveApiEntry(serviceEntries, stored) : null;
    const wanted = resolved ? apiEntryId(resolved) : stored;
    serviceInput.value = wanted;
    // The stored data source may no longer exist: keep the value selectable.
    if (serviceInput.value !== wanted && wanted) {
      const opt = document.createElement('option');
      opt.value = wanted;
      opt.textContent = wanted;
      serviceInput.appendChild(opt);
      serviceInput.value = wanted;
    }
  }

  const title = document.getElementById('skillModalTitle');
  if (title) title.textContent = browser.i18n.getMessage(skill ? 'editSkill' : 'addSkill');

  ensureSkillModal().show();
}

/**
 * Set or remove an optional Skill field so the stored object stays tidy.
 * @param {Object} skill - Skill object being saved
 * @param {string} key - Field name
 * @param {*} value - Field value; empty/false removes the field
 */
function setOptionalSkillField(skill, key, value) {
  if (value === undefined || value === null || value === '' || value === false) {
    delete skill[key];
  } else {
    skill[key] = value;
  }
}

/**
 * Read the skill editor modal and persist it.
 */
async function saveSkillFromForm() {
  const id = document.getElementById('skillId').value;
  const name = document.getElementById('skillNameInput').value.trim();
  const description = document.getElementById('skillDescInput').value.trim();
  const prompt = document.getElementById('skillPromptInput').value.trim();
  const starter = (document.getElementById('skillStarterInput')?.value || '').trim();
  const dsService = (document.getElementById('skillServiceInput')?.value || '').trim();
  const tools = collectToolsFromForm();

  if (!name || !prompt) {
    balert(browser.i18n.getMessage("requiredError"));
    return;
  }

  if (id) {
    const existing = skillConfigurations.find(s => String(s.id) === String(id));
    if (existing) {
      existing.name = name;
      existing.description = description;
      existing.prompt = prompt;
      existing.tools = tools;
      existing.manualOnly = document.getElementById('skillManualOnlyInput')?.checked === true;
      setOptionalSkillField(existing, 'starter', starter);
      setOptionalSkillField(existing, 'dsService', dsService);
      // usePage is not exposed in this form; editing must not drop it.
    }
  } else {
    const manualOnly = document.getElementById('skillManualOnlyInput')?.checked === true;
    const entry = { id: `skill_${Date.now()}`, name, description, prompt, tools };
    if (manualOnly) entry.manualOnly = true;
    setOptionalSkillField(entry, 'starter', starter);
    setOptionalSkillField(entry, 'dsService', dsService);
    skillConfigurations.push(entry);
  }

  await saveSkills(skillConfigurations);
  ensureSkillModal().hide();
  renderSkillList();
  balert(browser.i18n.getMessage("saveSuccessMessage"));
}

// ------------------- MCP server management -------------------

/**
 * Lazily obtain the MCP editor modal instance.
 * @returns {Object} Bootstrap modal instance
 */
function ensureMcpModal() {
  if (!mcpModal) {
    mcpModal = new bootstrap.Modal(document.getElementById('mcpModal'));
  }
  return mcpModal;
}

/**
 * Lazily create the MCP tool inspector modal.
 * @returns {bootstrap.Modal|null}
 */
function ensureMcpToolsModal() {
  if (!mcpToolsModal) {
    const el = document.getElementById('mcpToolsModal');
    if (!el) return null;
    mcpToolsModal = new bootstrap.Modal(el);
  }
  return mcpToolsModal;
}

/**
 * The `ui://` resource a tool declares, if any (both metadata spellings).
 * @param {Object} tool - Tool entry from `tools/list`
 * @returns {string} Resource URI or ''
 */
function uiResourceOf(tool) {
  return tool?._meta?.ui?.resourceUri || tool?._meta?.['ui/resourceUri'] || '';
}

/**
 * Compact parameter list: `name* (type), other (object)`.
 * @param {Object} tool - Tool entry from `tools/list`
 * @returns {string} Empty string when the tool declares no parameters
 */
function describeToolParams(tool) {
  const schema = tool?.inputSchema || tool?.parameters || {};
  const props = schema.properties || {};
  const keys = Object.keys(props);
  if (!keys.length) return '';
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return keys.map((key) => {
    const type = props[key]?.type || 'string';
    return `${key}${required.has(key) ? '*' : ''} (${type})`;
  }).join(', ');
}

/**
 * Localized annotation badges (read-only / destructive).
 * @param {Object} tool - Tool entry from `tools/list`
 * @returns {string[]} Labels
 */
function toolFlagLabels(tool) {
  const annotations = tool?.annotations || {};
  const flags = [];
  if (annotations.readOnlyHint === true) {
    flags.push(browser.i18n.getMessage('mcpToolReadOnly') || 'read-only');
  }
  if (annotations.destructiveHint === true) {
    flags.push(browser.i18n.getMessage('mcpToolDestructive') || 'destructive');
  }
  return flags;
}

/**
 * Render the tool list of one server into the inspector modal.
 * @param {Object} server - Server being inspected
 * @param {Array<Object>} tools - Result of listMcpTools()
 * @returns {void}
 */
function renderMcpToolsPreview(server, tools) {
  const summary = document.getElementById('mcpToolsSummary');
  const preview = document.getElementById('mcpToolsPreview');
  if (!summary || !preview) return;

  const list = Array.isArray(tools) ? tools : [];

  // Group counts: this is what decides whether "split by ui://" is worth it.
  const groupCounts = new Map();
  for (const tool of list) {
    const uri = uiResourceOf(tool);
    if (uri) groupCounts.set(uri, (groupCounts.get(uri) || 0) + 1);
  }
  const groupsHtml = groupCounts.size
    ? `<div class="mt-1">${[...groupCounts.entries()]
        .map(([uri, n]) => `<span class="badge text-bg-light border me-1">${escapeHtml(uri)} · ${n}</span>`)
        .join('')}</div>`
    : '';

  const foundText = list.length
    ? (browser.i18n.getMessage('mcpToolsFound') || 'Found {count} tools.').replace('{count}', list.length)
    : (browser.i18n.getMessage('mcpToolsEmpty') || 'This server returned no tools.');
  summary.innerHTML = `<div>${escapeHtml(foundText)}</div>${groupsHtml}`;

  if (!list.length) {
    preview.innerHTML = '';
    return;
  }

  const noUiLabel = browser.i18n.getMessage('mcpToolNoUi') || 'no UI';
  const paramsLabel = browser.i18n.getMessage('mcpToolParams') || 'Parameters:';

  preview.innerHTML = list.map((tool) => {
    const title = String(tool?.title || tool?.annotations?.title || '').trim();
    const desc = String(tool?.description || '').trim();
    const params = describeToolParams(tool);
    const uri = uiResourceOf(tool);
    const flags = toolFlagLabels(tool);
    return `
      <div class="mcp-tool-item">
        <div class="mcp-tool-head">
          <code>${escapeHtml(tool?.name || '')}</code>
          ${title ? `<span class="mcp-tool-title">${escapeHtml(title)}</span>` : ''}
          ${uri
            ? `<span class="badge text-bg-light border">${escapeHtml(uri)}</span>`
            : `<span class="text-muted small">${escapeHtml(noUiLabel)}</span>`}
          ${flags.map((flag) => `<span class="badge text-bg-warning">${escapeHtml(flag)}</span>`).join('')}
        </div>
        ${desc ? `<div class="small">${escapeHtml(desc)}</div>` : ''}
        ${params ? `<div class="small text-muted">${escapeHtml(paramsLabel)} ${escapeHtml(params)}</div>` : ''}
      </div>`;
  }).join('');
}

/**
 * Plain-text version of the inspector content, for copying into a bug report.
 * @param {Object} server - Server being inspected
 * @param {Array<Object>} tools - Tool list
 * @returns {string}
 */
function formatMcpToolsReport(server, tools) {
  const list = Array.isArray(tools) ? tools : [];
  const lines = [`${server?.name || ''} <${server?.url || ''}> — ${list.length} tools`, ''];
  for (const tool of list) {
    const uri = uiResourceOf(tool);
    const flags = toolFlagLabels(tool);
    const params = describeToolParams(tool);
    lines.push(`${tool?.name || ''}${flags.length ? ` [${flags.join(', ')}]` : ''}${uri ? ` [${uri}]` : ''}`);
    if (tool?.description) lines.push(`  ${String(tool.description).trim()}`);
    if (params) lines.push(`  params: ${params}`);
  }
  return lines.join('\n');
}

/**
 * Copy the current inspector report to the clipboard. The page is an extension
 * page opened by a click, so it carries the user gesture clipboard access needs.
 * @returns {Promise<void>}
 */
async function copyMcpToolsReport() {
  const btn = document.getElementById('b_copy_mcp_tools');
  if (!lastMcpToolsPreview) return;
  try {
    await navigator.clipboard.writeText(
      formatMcpToolsReport(lastMcpToolsPreview.server, lastMcpToolsPreview.tools)
    );
    if (btn) {
      btn.textContent = browser.i18n.getMessage('copied') || 'Copied';
      setTimeout(() => {
        btn.textContent = browser.i18n.getMessage('copy') || 'Copy';
      }, 1500);
    }
  } catch (e) {
    balert((browser.i18n.getMessage('replicationFailed') || 'Copy failed') + ': ' + (e?.message || e));
  }
}

/**
 * Open the tool inspector for a server and load its tools.
 * @param {Object} server - { name, url, headers }
 * @returns {Promise<void>}
 */
async function showMcpToolsPanel(server) {
  const modal = ensureMcpToolsModal();
  if (!modal) return;

  const titleEl = document.getElementById('mcpToolsModalTitle');
  const summary = document.getElementById('mcpToolsSummary');
  const preview = document.getElementById('mcpToolsPreview');
  const copyBtn = document.getElementById('b_copy_mcp_tools');

  if (titleEl) {
    titleEl.textContent = `${server?.name || ''} · ${browser.i18n.getMessage('mcpToolsPreview') || 'Tools'}`;
  }
  if (summary) summary.textContent = browser.i18n.getMessage('mcpToolsLoading') || 'Loading tools…';
  if (preview) preview.innerHTML = '';
  if (copyBtn) copyBtn.textContent = browser.i18n.getMessage('copy') || 'Copy';
  lastMcpToolsPreview = null;

  modal.show();

  try {
    const tools = await listMcpTools(server);
    lastMcpToolsPreview = { server, tools };
    renderMcpToolsPreview(server, tools);
  } catch (e) {
    if (summary) {
      const label = browser.i18n.getMessage('mcpToolsFailed') || 'Could not list tools';
      summary.innerHTML = `<span class="text-danger">${escapeHtml(label + ': ' + (e?.message || e))}</span>`;
    }
  }
}

/**
 * Load MCP servers and render the list.
 */
async function initMcpList() {
  mcpConfigurations = await loadMcpServers();
  renderMcpServers();
}

/**
 * Render the MCP server list with test / edit / delete buttons.
 */
function renderMcpServers() {
  const container = document.getElementById('mcpServersContainer');
  if (!container) return;

  if (!mcpConfigurations.length) {
    container.innerHTML = `<div class="text-muted small i18n">mcpServersEmpty</div>`;
    return;
  }

  container.innerHTML = mcpConfigurations.map((s, index) => `
    <div class="list-group-item d-flex align-items-center py-2" data-mcp-index="${index}">
      <div class="flex-grow-1">
        <strong>${s.name}</strong>
        ${s.enabled === false ? `<span class="badge text-bg-secondary ms-1">${browser.i18n.getMessage("mcpDisabled")}</span>` : ''}
        ${s.autoSkill === true ? `<span class="badge text-bg-info ms-1" title="${browser.i18n.getMessage("mcpAutoSkillHint")}">${browser.i18n.getMessage("mcpAutoSkillBadge")}</span>` : ''}
        <div class="text-muted small">${s.url}</div>
      </div>
      <div class="btn-group ms-2 flex-shrink-0">
        <button type="button" class="btn btn-sm btn-outline-secondary mcp-test-btn" title="${browser.i18n.getMessage("mcpTestBtn")}">🔌</button>
        <button type="button" class="btn btn-sm btn-outline-secondary mcp-edit-btn" title="${browser.i18n.getMessage("editSkill")}">✍</button>
        <button type="button" class="btn btn-sm btn-outline-secondary mcp-delete-btn" title="${browser.i18n.getMessage("deleteSkill")}">✘</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.mcp-test-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.closest('[data-mcp-index]').dataset.mcpIndex, 10);
      await showMcpToolsPanel(mcpConfigurations[index]);
    });
  });

  container.querySelectorAll('.mcp-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.closest('[data-mcp-index]').dataset.mcpIndex, 10);
      showMcpForm(mcpConfigurations[index]);
    });
  });

  container.querySelectorAll('.mcp-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.closest('[data-mcp-index]').dataset.mcpIndex, 10);
      mcpConfigurations.splice(index, 1);
      await saveMcpServers(mcpConfigurations);
      renderMcpServers();
    });
  });
}

/**
 * Show the MCP form for adding a new server.
 */
function showAddMcpForm() {
  showMcpForm(null);
}

/**
 * Show the MCP server editor modal (populated for editing, or empty for adding).
 * @param {Object|null} server - Server to edit, or null to add
 */
function showMcpForm(server) {
  document.getElementById('mcpServerId').value = server ? server.id : '';
  document.getElementById('mcpNameInput').value = server ? server.name : '';
  document.getElementById('mcpUrlInput').value = server ? server.url : '';
  document.getElementById('mcpHeadersInput').value = server && server.headers
    ? JSON.stringify(server.headers, null, 2) : '';
  document.getElementById('mcpEnabledInput').checked = server ? server.enabled !== false : true;
  // Automatic Skill: off unless the user opted in (a derived Skill, see
  // js/mcp-skills.mjs — it never appears in the Skill list below).
  document.getElementById('mcpAutoSkillInput').checked = server ? server.autoSkill === true : false;

  const title = document.getElementById('mcpModalTitle');
  if (title) title.textContent = browser.i18n.getMessage(server ? 'editSkill' : 'addMcpServer');

  ensureMcpModal().show();
}

/**
 * Read the headers textarea into an object. Empty input yields {}.
 * @param {string} raw - Raw JSON text
 * @returns {Object|null} Headers object, or null when the JSON is invalid
 */
function parseMcpHeaders(raw) {
  const v = (raw || '').trim();
  if (!v) return {};
  try {
    const obj = JSON.parse(v);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch (e) {
    return null;
  }
}

/**
 * Read the MCP editor modal and persist it, then re-register tools.
 */
async function saveMcpFromForm() {
  const id = document.getElementById('mcpServerId').value;
  const name = document.getElementById('mcpNameInput').value.trim();
  const url = document.getElementById('mcpUrlInput').value.trim();
  const headers = parseMcpHeaders(document.getElementById('mcpHeadersInput').value);
  const enabled = document.getElementById('mcpEnabledInput').checked;
  const autoSkill = document.getElementById('mcpAutoSkillInput').checked;

  if (!name || !url || headers === null) {
    balert(browser.i18n.getMessage("requiredError"));
    return;
  }

  if (id) {
    const existing = mcpConfigurations.find(s => String(s.id) === String(id));
    if (existing) {
      existing.name = name;
      existing.url = url;
      existing.headers = headers;
      existing.enabled = enabled;
      existing.autoSkill = autoSkill;
    }
  } else {
    mcpConfigurations.push({ id: `mcp_${Date.now()}`, name, url, headers, enabled, autoSkill });
  }

  await saveMcpServers(mcpConfigurations);
  // Re-register so new/changed servers are usable without a page reload.
  try { await initMcpTools(); } catch (e) { console.warn('[MCP] re-init failed:', e); }
  ensureMcpModal().hide();
  renderMcpServers();
}

/**
 * Test the server currently being edited (list its tools).
 */
async function testMcpFromForm() {
  const name = document.getElementById('mcpNameInput').value.trim();
  const url = document.getElementById('mcpUrlInput').value.trim();
  const headers = parseMcpHeaders(document.getElementById('mcpHeadersInput').value);
  if (!url || headers === null) {
    balert(browser.i18n.getMessage("requiredError"));
    return;
  }
  await showMcpToolsPanel({ name: name || 'test', url, headers });
}
