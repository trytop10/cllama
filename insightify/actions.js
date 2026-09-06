import { i18n, DB_KEY } from '../js/cllama.js';
import { marked } from '../js/marked.mjs';
import { browser, isFirefox } from '../js/browser.mjs';
import { getLanguageCode, htmlEncode, replaceElementContent } from '../js/util.js';

document.addEventListener('DOMContentLoaded', () => {

  const configList = document.getElementById('config-list');
  const addConfigModal = new bootstrap.Modal(document.getElementById('addConfigModal'));
  const wordsRemaining = browser.i18n.getMessage("wordsRemaining");
  const parser = new DOMParser();

  let configurations = [];

  /**
   * Sets up character counters for input fields with maxlength attribute
   */
  function setupCharacterCounters() {
    document.querySelectorAll('#name, #prompt').forEach(input => {
      const counter = input.closest('.mb-3').querySelector('.character-counter');

      const updateCounter = () => {
        const remaining = input.getAttribute('maxlength') - input.value.length;
        counter.textContent = `${wordsRemaining}：${remaining}`;
        counter.style.color = remaining < 10 ? '#dc3545' : '#6c757d';
      };

      input.addEventListener('input', updateCounter);
      updateCounter();
    });
  }

  /**
   * Saves or updates an action configuration
   * @param {number} acId - Action ID (0 for new, positive for update)
   * @param {string} name - Action name
   * @param {string} prompt - Action prompt text
   */
  function saveActions(acId, name, prompt) {
    if (name.length <= 1 || prompt.length <= 1) {
      alert(browser.i18n.getMessage("requiredError"));
      return;
    }

    if (acId > 0) {
      // Update existing action
      const data = configurations.find(it => it.id === acId);
      if (data) {
        data.name = name;
        data.prompt = prompt;
        updateActionDOM(acId, name, prompt);
      } else {
        alert(browser.i18n.getMessage("noUpdateDataError"));
        return;
      }
    } else {
      // Create new action
      const data = { id: Date.now(), name, prompt };
      configurations.push(data);
      appendActionItem(data);
    }

    browser.storage.local.set({ [DB_KEY.actionList]: configurations });
  }

  /**
   * Updates the DOM elements for an existing action
   * @param {number} acId - Action ID
   * @param {string} name - New name
   * @param {string} prompt - New prompt
   */
  function updateActionDOM(acId, name, prompt) {
    const actionElement = document.getElementById(`ac_${acId}`);
    if (actionElement) {
      actionElement.querySelector('.card-title').innerText = name;
      replaceElementContent(actionElement.querySelector('.card-text'), prompt);
    }
  }

  /**
   * Resets the configuration form to empty state
   */
  function resetForm() {
    document.getElementById('add-config-form').reset();
    document.querySelectorAll('.character-counter').forEach(c => c.textContent = '');
  }

  /**
   * Creates HTML string for an action item card
   * @param {Object} item - Action item with id, name, and prompt
   * @returns {string} HTML string
   */
  function createItemHTML(item) {
    return `
      <div class="col-12" id="ac_${item.id}">
        <div class="config-card card mb-3">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <h5 class="card-title">${item.name}</h5>
              <div class="btn-group flex-shrink-0">
                <button class="btn btn-sm btn-outline-secondary" data-action="delete">✘</button>
                <button class="btn btn-sm btn-outline-secondary" data-action="edit">✍</button>
              </div>
            </div>
            <div class="card-text card-cust-height text-muted markdown-body">${htmlEncode(item.prompt)}</div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Appends an action item to the configuration list
   * @param {Object} item - Action item to append
   */
  function appendActionItem(item) {
    const itemHTML = createItemHTML(item);
    const doc = parser.parseFromString(itemHTML, 'text/html');
    const element = doc.body.firstChild.cloneNode(true);

    const buttons = element.getElementsByTagName('button');
    
    // Delete button
    buttons[0].addEventListener('click', () => handleDeleteAction(item.id));
    
    // Edit button
    buttons[1].addEventListener('click', () => handleEditAction(item));

    configList.appendChild(element);
  }

  /**
   * Handles action deletion
   * @param {number} itemId - ID of action to delete
   */
  function handleDeleteAction(itemId) {
    configurations = configurations.filter(it => it.id !== itemId);
    browser.storage.local.set({ [DB_KEY.actionList]: configurations });
    document.getElementById(`ac_${itemId}`).remove();
  }

  /**
   * Handles action editing
   * @param {Object} item - Action item to edit
   */
  function handleEditAction(item) {
    resetForm();
    document.getElementById('acId').value = item.id;
    document.getElementById('name').value = item.name;
    document.getElementById('prompt').value = item.prompt;
    addConfigModal.show();
    setTimeout(setupCharacterCounters, 100);
  }

  /**
   * Imports an action from external source
   * @param {Object} data - Action data with name and prompt
   * @returns {string} Source ID
   */
  function importActions(data) {
    saveActions(0, data.name, data.prompt);
    window.scrollTo(0, document.body.scrollHeight);
    return data.sid;
  }

  /**
   * Initializes the import button with appropriate link/handler
   */
  function setupImportButton() {
    const importButton = document.getElementById('b_import');
    const importURL = `https://fxdq.net/${getLanguageCode()}/insight.html`;

    if (isFirefox) {
      importButton.setAttribute('href', importURL);
    } else {
      importButton.addEventListener('click', (e) => {
        browser.tabs.create({ url: importURL });
        e.preventDefault();
      });
    }
  }

  /**
   * Loads saved configurations from storage
   */
  function loadConfigurations() {
    browser.storage.local.get(DB_KEY.actionList, (data) => {
      configurations = data[DB_KEY.actionList] || [];
      configurations.forEach(item => appendActionItem(item));
    });
  }

  // Event Listeners
  document.getElementById('save-config-btn').addEventListener('click', () => {
    const acId = parseInt(document.getElementById('acId').value.trim()) || 0;
    const name = document.getElementById('name').value.trim();
    const prompt = document.getElementById('prompt').value.trim();

    saveActions(acId, name, prompt);
    addConfigModal.hide();
    resetForm();
  });

  document.getElementById('add-config-btn').addEventListener('click', () => {
    resetForm();
    document.getElementById('acId').value = '';
    addConfigModal.show();
    setTimeout(setupCharacterCounters, 100);
  });

  // Message listener for external imports
  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'callImportInsightPrompt') {
      const result = importActions(request.data);
      sendResponse({ success: true, data: result });
    }
    return true;
  });

  // Initialize
  setupImportButton();
  loadConfigurations();
  i18n();
});