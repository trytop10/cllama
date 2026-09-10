import { i18n, loadSkills, saveSkills } from "../js/cllama.js";
import { listTools } from "../js/skill-tools.mjs";
import { balert } from "../js/dialog.mjs";
import { browser } from '../js/browser.mjs';
import { getQueryParam } from "../js/util.js";

let skillConfigurations = [];
let skillModal = null;
let editingTools = []; // [{ name, args }] rows being edited in the modal

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

  await initSkillList();
  i18n();
});

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
        <div class="text-muted small">${s.description || ''}</div>
        ${Array.isArray(s.tools) && s.tools.length ? `<div class="text-muted small">🧰 ${s.tools.map(t => t.name || t).join(', ')}</div>` : ''}
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
    .map(item => ({ name: item.name, args: item.args || {} }));
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
  editingTools = skill && Array.isArray(skill.tools)
    ? skill.tools.map(t => ({ name: t.name || '', args: t.args || {} }))
    : [];
  renderToolRows();

  const title = document.getElementById('skillModalTitle');
  if (title) title.textContent = browser.i18n.getMessage(skill ? 'editSkill' : 'addSkill');

  ensureSkillModal().show();
}

/**
 * Read the skill editor modal and persist it.
 */
async function saveSkillFromForm() {
  const id = document.getElementById('skillId').value;
  const name = document.getElementById('skillNameInput').value.trim();
  const description = document.getElementById('skillDescInput').value.trim();
  const prompt = document.getElementById('skillPromptInput').value.trim();
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
    }
  } else {
    skillConfigurations.push({ id: `skill_${Date.now()}`, name, description, prompt, tools });
  }

  await saveSkills(skillConfigurations);
  ensureSkillModal().hide();
  renderSkillList();
  balert(browser.i18n.getMessage("saveSuccessMessage"));
}
