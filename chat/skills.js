import { i18n, DB_KEY, loadSkills, saveSkills, loadSkillRuns, clearSkillRuns, filterSkillRuns, getRuntimeConfig } from "../js/cllama.js";
import { listTools } from "../js/skill-tools.mjs";
import { loadMcpServers, saveMcpServers, listMcpTools, initMcpTools } from "../js/mcp.mjs";
import { balert } from "../js/dialog.mjs";
import { browser } from '../js/browser.mjs';
import { getQueryParam } from "../js/util.js";

let skillConfigurations = [];
let skillModal = null;
let editingTools = []; // [{ name, args }] rows being edited in the modal
let mcpConfigurations = [];
let mcpModal = null;
let skillRunCache = []; // All audit records; the toolbar filters this list

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

  // Audit trail
  document.getElementById('b_clear_runs').addEventListener('click', async () => {
    await clearSkillRuns();
    renderSkillRuns();
  });
  // Filters apply live (no "apply" button): source, status, Skill and free text.
  ['runFilterOrigin', 'runFilterStatus', 'runFilterSkill'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', renderRunList);
  });
  document.getElementById('runFilterSearch')?.addEventListener('input', renderRunList);
  document.getElementById('b_reset_run_filters')?.addEventListener('click', resetRunFilters);

  // Per-Skill model override options (read-only view of the data source list).
  await buildServiceOptions();

  // Render immediately; register MCP tools in the background so a slow or
  // dead server never delays the page. Tool rows are re-read from listTools()
  // each time a Skill form opens, so late-registered tools appear there.
  initMcpTools().catch(e => console.warn('[MCP] init failed:', e));
  await initMcpList();
  await initSkillList();
  await renderSkillRuns();
  i18n();

  // Keep the audit trail live: a chat page in another window may record a run
  // while this page is open.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[DB_KEY.skillRuns]) renderSkillRuns();
  });
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
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = browser.i18n.getMessage('skillServiceDefault') || 'Use the current model';
  select.appendChild(none);
  list.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.name || d.service;
    opt.textContent = `${d.name || d.service} (${d.modelName || d.service})`;
    select.appendChild(opt);
  });
}

/**
 * Localized label for an audit action code (used by user/page records and by
 * steps that are UI actions rather than tool names).
 * @param {Object} entry - { action, count }
 * @returns {string} Human-readable label
 */
function runActionLabel(entry = {}) {
  const action = String(entry.action || '');
  if (action === 'parse_drafts') {
    const tpl = browser.i18n.getMessage('skillRunParsedDrafts') || 'Parsed {count} draft(s) from the answer';
    return tpl.replace('{count}', String(entry.count ?? ''));
  }
  const key = {
    import: 'artifactImport',
    import_overwrite: 'artifactImportOverwrite',
    cancel: 'artifactCancel',
    card_stale: 'skillRunCardStale'
  }[action];
  return (key && browser.i18n.getMessage(key)) || action || 'unknown';
}

/**
 * Read the audit trail, refresh the filter dropdowns and render the list.
 */
async function renderSkillRuns() {
  skillRunCache = await loadSkillRuns();
  renderRunSkillOptions();
  renderRunList();
}

/**
 * Fill the "Skill" filter with the Skills that actually appear in the trail,
 * keeping the current selection when it is still available.
 */
function renderRunSkillOptions() {
  const select = document.getElementById('runFilterSkill');
  if (!select) return;
  const previous = select.value || 'all';
  select.innerHTML = '';

  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = browser.i18n.getMessage('skillRunFilterAllSkills') || 'All Skills';
  select.appendChild(all);

  const names = [...new Set(skillRunCache.map((r) => r.skillName).filter(Boolean))].sort();
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = names.includes(previous) ? previous : 'all';
}

/**
 * Current filter values from the toolbar.
 * @returns {Object} { origin, status, skill, query }
 */
function readRunFilters() {
  return {
    origin: document.getElementById('runFilterOrigin')?.value || 'all',
    status: document.getElementById('runFilterStatus')?.value || 'all',
    skill: document.getElementById('runFilterSkill')?.value || 'all',
    query: document.getElementById('runFilterSearch')?.value || ''
  };
}

/**
 * Reset the toolbar to "show everything".
 */
function resetRunFilters() {
  const origin = document.getElementById('runFilterOrigin');
  const status = document.getElementById('runFilterStatus');
  const skill = document.getElementById('runFilterSkill');
  const search = document.getElementById('runFilterSearch');
  if (origin) origin.value = 'all';
  if (status) status.value = 'all';
  if (skill) skill.value = 'all';
  if (search) search.value = '';
  renderRunList();
}

/**
 * Apply the filters and render the matching records (newest first).
 */
function renderRunList() {
  const container = document.getElementById('skillRunsContainer');
  if (!container) return;
  const count = document.getElementById('runFilterCount');

  if (!skillRunCache.length) {
    // Resolve the text directly (not through the `.i18n` class): this element is
    // created after the one-time i18n() pass, so a raw key would leak through.
    container.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'text-muted small';
    empty.textContent = browser.i18n.getMessage('skillRunsEmpty') || 'No runs recorded yet.';
    container.appendChild(empty);
    if (count) count.textContent = '';
    return;
  }

  const runs = filterSkillRuns(skillRunCache, readRunFilters());
  if (count) {
    const tpl = browser.i18n.getMessage('skillRunFilterCount') || '{shown} / {total}';
    count.textContent = tpl.replace('{shown}', String(runs.length)).replace('{total}', String(skillRunCache.length));
  }

  container.innerHTML = '';
  if (!runs.length) {
    const none = document.createElement('div');
    none.className = 'text-muted small';
    none.textContent = browser.i18n.getMessage('skillRunsNoMatch') || 'No record matches the filter.';
    container.appendChild(none);
    return;
  }

  // Newest first.
  runs.slice().reverse().forEach((run) => {
    const origin = run.origin || 'model';
    const item = document.createElement('div');
    item.className = 'skill-run'
      + (run.status === 'failed' ? ' skill-run-failed' : '')
      + (origin === 'model' ? '' : ` skill-run-${origin}`);

    const head = document.createElement('div');
    head.className = 'skill-run-head';
    const badge = run.status === 'failed' ? '⚠️' : run.status === 'aborted' ? '⏹️'
      : origin === 'model' ? '✅' : '🖐️';
    const when = new Date(run.time).toLocaleString();
    // Runs started by the model show which Skill ran; user/page records show the
    // action instead, so the timeline reads "who did what".
    const label = origin === 'model'
      ? (run.skillName || browser.i18n.getMessage('skillRunNoSkill') || 'No Skill')
      : `${browser.i18n.getMessage(origin === 'user' ? 'skillRunManual' : 'skillRunPage') || origin} · ${runActionLabel(run)}`;
    head.textContent = `${badge} ${label} · ${when}`;
    if (origin === 'model') head.textContent += ` · ${(run.duration / 1000).toFixed(1)}s`;
    if (run.model) head.textContent += ` · ${run.model}`;
    item.appendChild(head);

    const steps = document.createElement('ul');
    steps.className = 'skill-run-steps';
    (Array.isArray(run.steps) ? run.steps : []).forEach((s) => {
      const li = document.createElement('li');
      li.className = s.ok ? '' : 'skill-run-step-failed';
      const ms = typeof s.ms === 'number' ? ` (${(s.ms / 1000).toFixed(1)}s)` : '';
      li.textContent = `${s.ok ? '✓' : (s.denied ? '🚫' : '✗')} ${runActionLabel({ action: s.tool, count: run.count })}${ms}${s.argsPreview ? ` ${s.argsPreview}` : ''}`;
      if (!s.ok && s.error) {
        const err = document.createElement('div');
        err.className = 'skill-run-error';
        err.textContent = s.error;
        li.appendChild(err);
      }
      steps.appendChild(li);
    });
    if (!steps.children.length) {
      const li = document.createElement('li');
      li.className = 'text-muted';
      li.textContent = browser.i18n.getMessage('skillRunNoSteps') || 'No tool was called.';
      steps.appendChild(li);
    }
    item.appendChild(steps);
    container.appendChild(item);
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
  });
}

/**
 * Add a new empty tool row.
 */
function appendToolRow() {
  editingTools.push({ name: '', args: {} });
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
    ? skill.tools.map(t => ({ name: t.name || '', args: t.args || {}, blocked: t.blocked === true || (typeof t === 'string' && t.startsWith('!')) }))
    : [];
  renderToolRows();

  const manualOnlyInput = document.getElementById('skillManualOnlyInput');
  if (manualOnlyInput) manualOnlyInput.checked = skill ? skill.manualOnly === true : false;

  const serviceInput = document.getElementById('skillServiceInput');
  if (serviceInput) {
    const wanted = skill ? (skill.dsService || '') : '';
    serviceInput.value = wanted;
    // The stored data source may no longer exist: keep the value selectable.
    if (serviceInput.value !== wanted) {
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
      btn.textContent = '…';
      try {
        const tools = await listMcpTools(mcpConfigurations[index]);
        balert(browser.i18n.getMessage("mcpTestOk").replace('{count}', tools.length));
      } catch (e) {
        balert((browser.i18n.getMessage("mcpTestFail") || 'Failed') + ': ' + e.message);
      }
      btn.textContent = '🔌';
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
    }
  } else {
    mcpConfigurations.push({ id: `mcp_${Date.now()}`, name, url, headers, enabled });
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
  try {
    const tools = await listMcpTools({ name: name || 'test', url, headers });
    balert(browser.i18n.getMessage("mcpTestOk").replace('{count}', tools.length));
  } catch (e) {
    balert((browser.i18n.getMessage("mcpTestFail") || 'Failed') + ': ' + e.message);
  }
}
