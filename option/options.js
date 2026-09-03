import { defaultSettings, i18n, DB_KEY, loadSkills, saveSkills } from "../js/cllama.js";
import { listTools } from "../js/skill-tools.mjs";
import { getService } from "../js/client/client.mjs";
import { balert } from "../js/dialog.mjs";
import { exportFile } from "../js/util.js";

let dsList = []; // Data source list
let mflag = true; // Flag indicating if the model list needs to be refreshed
let ds = {}; // Current data source settings

const browser = typeof chrome !== 'undefined' ? chrome : browser;

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
  // Load the list of data sources
  await browser.storage.local.get(DB_KEY.dsList, (data) => {
    dsList = data[DB_KEY.dsList] || [];
    // Once dsList is loaded, get the base settings and populate the form
    browser.storage.local.get(DB_KEY.base, setFormValue);
  });

  initSkillList();
}

/**
 * Sets the form values based on the provided data.
 * @param {Object} data - Object containing form data.
 */
function setFormValue(data) {
  ds = data[DB_KEY.base] || defaultSettings;

  // If service and API URL are set, initialize the model list
  if(ds.service && ds.apiUrl)
    setModelList(ds.service, ds.apiUrl, ds.apiKey);
  else {
    ds.service = "ollama";
    ds.apiUrl = "http://localhost:11434";
  }
  
  // Iterate over the properties of the current data source settings
  for (const k of Object.keys(ds)) {
    if (k === "service") {
      const serviceRadio = document.getElementById(ds[k]);
      if (serviceRadio) serviceRadio.checked = true; // Check the radio button corresponding to the service
    } else {
      const field = document.getElementById(k);
      if (field) {
        if (field.type === 'checkbox') {
          field.checked = ds[k]; // Set checkbox state
        } else {
          field.value = ds[k]; // Set the value of other form fields
        }
      }
    }
  }

  // Update range slider badge display values
  const insightTempEl = document.getElementById('insightTemperature');
  const insightTempVal = document.getElementById('insightTemperatureValue');
  if (insightTempEl && insightTempVal) insightTempVal.textContent = parseFloat(ds.insightTemperature || 0.7).toFixed(1);
  const insightTopPEl = document.getElementById('insightTopP');
  const insightTopPVal = document.getElementById('insightTopPValue');
  if (insightTopPEl && insightTopPVal) insightTopPVal.textContent = parseFloat(ds.insightTopP || 0.9).toFixed(1);

  // Populate the service selection dropdown for the insight service
  populateServiceDropdowns();
  if (ds.insightService) {
    document.getElementById('insightService').value = ds.insightService;
  }

  const apiMsg = document.getElementById("api_msg");
  apiMsg.setAttribute("hidden", "true");
  if(ds.service=="Other" || ds.service=="Test"){
    apiMsg.removeAttribute("hidden");
    apiMsg.textContent = browser.i18n.getMessage(ds.service+"Desc");
  }
}

/**
 * Initializes the model name selection list for a given service.
 * @param {string} service - The type of service (e.g., "ollama", "Other").
 * @param {string} url - The API URL for the service.
 * @param {string} key - The API key for the service.
 */
async function setModelList(service, url, key) {
  try {
    const modelSelect = document.getElementById('modelName');
    modelSelect.length = 0; // Clear existing options in the dropdown

    // If the service is not "ollama" and the API key is empty, do not proceed.
    // Ollama typically runs locally and might not require an API key.
    if(service !== "ollama" && key.length < 1) {
       return;
    }
     
    // Fetch the list of models from the specified service
    const models = await getService(service, url, key).getModels();
    
    // Add each fetched model to the dropdown list
    models.forEach(model => {
      const option = new Option(model, model);
      modelSelect.add(option);
      // Select the model if it matches the currently saved model in ds
      if (ds?.modelName === model) {
        option.selected = true;
      }
    });
    mflag = false; // Reset the refresh flag as the model list has been updated
  } catch (error) {
    // Log an error if fetching the model list fails
    console.log(browser.i18n.getMessage("getModuleListFailMessage") + "\n" + error);
  }
}

/**
 * Populates the insight service dropdown from dsList.
 * Shows a guidance hint when no services are configured.
 */
function populateServiceDropdowns() {
  const insightSelect = document.getElementById('insightService');
  const insightHint = document.getElementById('insightSvcHint');

  if (insightSelect) insightSelect.innerHTML = '';

  if (dsList.length === 0) {
    if (insightHint) insightHint.classList.remove('d-none');
    return;
  }

  if (insightHint) insightHint.classList.add('d-none');

  dsList.forEach(item => {
    if (insightSelect) insightSelect.add(new Option(item.service, item.service));
  });
}

/**
 * Saves the API settings to browser local storage.
 */
async function saveApiSettings() {
  const service = document.querySelector('input[name="service"]:checked').value;
  const apiUrl = document.getElementById('apiUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const modelName = document.getElementById('modelName').value.trim();

  // Validate required fields
  if (!apiUrl || !modelName) {
    balert(browser.i18n.getMessage("requiredError"));
    return false; // Prevent further execution if validation fails
  }

  const dsInfo = {
    service,    // The selected service type
    apiUrl,     // The API URL provided by the user
    apiKey,     // The API key provided by the user
    modelName   // The selected model name
  };

  // Update or add the data source in the dsList
  const existingDs = dsList.find(item => item.service === service);
  if (existingDs) {
    // If an existing data source for this service is found, update its properties
    Object.assign(existingDs, dsInfo);
  } else {
    // Otherwise, add a new data source to the list
    dsList.push(dsInfo);
  }

  // Update the global 'ds' (current data source settings) with the latest API information
  ds.service = service;
  ds.apiUrl = apiUrl;
  ds.apiKey = apiKey;
  ds.modelName = modelName;

  await browser.storage.local.set({ [DB_KEY.base]: ds });
  await browser.storage.local.set({ [DB_KEY.dsList]: dsList });

  // Refresh service dropdown in insight tab
  populateServiceDropdowns();
  if (ds.insightService) document.getElementById('insightService').value = ds.insightService;
  
  alert(browser.i18n.getMessage("saveSuccessMessage"));
}

/**
 * Saves insight settings to browser local storage.
 */
async function saveInsightSettings() {
  const insightService = document.getElementById('insightService').value;

  ds.insightService = insightService;
  ds.insightThink = document.getElementById('insightThink').checked;
  ds.insightTemperature = parseFloat(document.getElementById('insightTemperature').value);
  ds.insightTopP = parseFloat(document.getElementById('insightTopP').value);

  await browser.storage.local.set({[DB_KEY.base]: ds});
  alert(browser.i18n.getMessage("saveSuccessMessage"));
}

// ── Skill management ─────────────────────────────────────────────────────

let skillConfigurations = [];
let skillModal = null;
let editingTools = []; // [{ name, args }] rows being edited in the modal

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
        ${Array.isArray(s.tools) && s.tools.length ? `<div class="text-muted small">🧰 ${s.tools.join(', ')}</div>` : ''}
      </div>
      <div class="btn-group ms-2">
        <button type="button" class="btn btn-sm btn-outline-secondary skill-edit-btn">${browser.i18n.getMessage("editSkill")}</button>
        <button type="button" class="btn btn-sm btn-outline-danger skill-delete-btn">${browser.i18n.getMessage("deleteSkill")}</button>
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
 * Hide the skill editor modal.
 */
function hideSkillForm() {
  ensureSkillModal().hide();
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
  hideSkillForm();
  renderSkillList();
  alert(browser.i18n.getMessage("saveSuccessMessage"));
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
        // If "chatData" is selected, export all chat history entries
        for (const k of Object.keys(data)) {
          if(k.startsWith("chatHistory_")){
            expdata[k] = data[k];
          }
        }
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


document.getElementById('togglePassword').addEventListener('click', function() {
    // Toggle the input type between 'password' and 'text'
    const apiKeyInput = document.getElementById("apiKey");
    const type = apiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
    apiKeyInput.setAttribute('type', type);
    
    // Toggle the eye icon to show/hide password visibility
    if (type === 'password') {
      document.getElementById("eyeOrEyeslash").setAttribute("href", "#eye");
    } else {
      document.getElementById("eyeOrEyeslash").setAttribute("href", "#eye-slash");
    }
});


/**
 * Binds all event listeners to the DOM elements.
 */
function bindEventListeners() {
  
  // Set the refresh flag for model list when model-related fields change
  document.querySelectorAll(".mflag").forEach(elem => {
    elem.addEventListener('change', () => mflag = true);
  });

  // Refresh model list when the model selection dropdown gains focus, if mflag is true
  document.getElementById('modelName').addEventListener('focus', async () => {
    if (mflag) {
      const service = document.querySelector('input[name="service"]:checked').value;
      const apiUrl = document.getElementById('apiUrl').value;
      const apiKey = document.getElementById('apiKey').value;
      await setModelList(service, apiUrl, apiKey);
    }
  });

  // Event listeners for save buttons
  document.getElementById('b_save_api').addEventListener('click', saveApiSettings);
  document.getElementById('b_save_insight').addEventListener('click', saveInsightSettings);

  // Skill management events
  document.getElementById('b_add_skill').addEventListener('click', showAddSkillForm);
  document.getElementById('b_add_tool').addEventListener('click', appendToolRow);
  document.getElementById('b_save_skill').addEventListener('click', saveSkillFromForm);

  // Event listener for LLM type switching
  document.querySelectorAll(".llmtype").forEach(llm => {
    llm.addEventListener('click', () => {
      mflag = true; // Set refresh flag for model list
      const service = llm.getAttribute("for"); // Get the service name from the 'for' attribute
      const selectedDs = dsList.find(it => it.service === service);
      
      if (selectedDs) {
        // Merge the existing base settings (in global ds) with the selected service's settings
        const newBase = { ...ds, ...selectedDs };
        setFormValue({[DB_KEY.base]: newBase});
      } else {
        // If no existing data source, clear API key and model name, and set default API URL
        document.getElementById('apiUrl').value = llm.getAttribute("data-url");
        document.getElementById('apiKey').value = "";
        document.getElementById('modelName').innerHTML = ""; // Clear model dropdown
      }

      // Display or hide API message based on service type
      const apiMsg = document.getElementById("api_msg");
      apiMsg.setAttribute("hidden", "true");
      if(service === "Other" || service === "Test"){
        apiMsg.removeAttribute("hidden");
        apiMsg.textContent = browser.i18n.getMessage(service+"Desc");
      }
    });
  });

  // Event listener for the export data button
  document.getElementById('a_export').addEventListener('click', exportData);
  // Event listener for the import data button
  document.getElementById('b_upload').addEventListener('click', function(e){

    // Keys that are allowed to be imported from the JSON file
    const allowedDataKeys = ["base", "dsList", "actionList", "chatTpaList", "insightList", "urls", "skillList"];

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
