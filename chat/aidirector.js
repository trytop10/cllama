import { i18n, DB_KEY } from '../js/cllama.js';
import { marked } from '../js/marked.mjs';
import { browser, isFirefox } from '../js/browser.mjs';
import { getLanguageCode, htmlEncode, replaceElementContent } from '../js/util.js';

document.addEventListener('DOMContentLoaded', () => {

    const configList = document.getElementById('config-list');
    const addConfigModal = new bootstrap.Modal(document.getElementById('addConfigModal'));
    const wordsRemaining = browser.i18n.getMessage("wordsRemaining");
    
    let configurations = [];
    const parser = new DOMParser();

    /**
     * Setup character counters for input fields with maxlength attribute
     */
    function setupCharacterCounters() {
        document.querySelectorAll('#name, #prompt, #sample').forEach(input => {
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
     * Truncate text to specified length
     */
    function truncatePrompt(text, maxLength = 100) {
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    }

    /**
     * Save configuration handler
     */
    document.getElementById('save-config-btn').addEventListener('click', () => {
        const aidId = document.getElementById("aidId").value.trim() * 1;
        const name = document.getElementById('name').value.trim();
        const prompt = document.getElementById('prompt').value.trim();
        const sample = document.getElementById('sample').value.trim();
        
        if (name.length > 0 && prompt.length > 1) {
            if (aidId > 0) {
                // Update existing configuration
                const data = configurations.find(it => it.id === aidId);
                if (data) {
                    data.name = name;
                    data.prompt = prompt;
                    data.sample = sample || "";
                    
                    const targetDom = document.getElementById("sp_" + aidId);
                    if (targetDom) {
                        targetDom.querySelector(".card-title").innerText = name;
                        replaceElementContent(targetDom.querySelector(".card-text"), prompt);
                        targetDom.querySelector(".card-sample").innerText = sample;
                    }
                } else {
                    alert(browser.i18n.getMessage("noUpdateDataError"));
                }
            } else {
                // Create new configuration
                const acId = Date.now();
                const data = { id: acId, name, prompt, sample };
                configurations.push(data);
                appendConfigItem(data);
            }
            
            browser.storage.local.set({ [DB_KEY.chatTpaList]: configurations });
            addConfigModal.hide();
            resetForm();
        } else {
            alert(browser.i18n.getMessage("requiredError"));
        }
    });

    /**
     * Reset form fields and counters
     */
    function resetForm() {
        document.getElementById('add-config-form').reset();
        document.querySelectorAll('.character-counter').forEach(c => c.textContent = '');
    }

    /**
     * Initialize add configuration modal
     */
    document.getElementById('add-config-btn').addEventListener('click', () => {
        resetForm();
        document.getElementById("aidId").value = "";
        addConfigModal.show();
        setTimeout(setupCharacterCounters, 100);
    });

    /**
     * Append configuration item to the list
     */
    function appendConfigItem(item) {
        const itemStr = createItemHTML(item);
        const doc = parser.parseFromString(itemStr, 'text/html').body.firstChild.cloneNode(true);
        
        // Delete button handler
        doc.getElementsByTagName("button")[0].addEventListener('click', () => {
            configurations = configurations.filter(it => it.id !== item.id);
            document.getElementById("sp_" + item.id).remove();
            browser.storage.local.remove("chatHistory_" + item.id);
            browser.storage.local.set({ [DB_KEY.chatTpaList]: configurations });
        });
        
        // Edit button handler
        doc.getElementsByTagName("button")[1].addEventListener('click', () => {
            resetForm();
            document.getElementById("aidId").value = item.id;
            document.getElementById('name').value = item.name;
            document.getElementById('prompt').value = item.prompt;
            document.getElementById('sample').value = item.sample || "";
            addConfigModal.show();
            setTimeout(setupCharacterCounters, 100);
        });
        
        configList.appendChild(doc);
    }

    /**
     * Create HTML string for configuration item card
     */
    function createItemHTML(item) {
        const sample = item.sample || "";
        return `
            <div class="col-12" id="sp_${item.id}">
                <div class="config-card card mb-3">
                    <div class="card-body">
                        <div class="d-flex justify-content-between align-items-center mb-2">
                            <h3 class="card-title">${item.name}</h3>
                            <div class="btn-group flex-shrink-0">
                                <button class="btn btn-sm btn-outline-secondary">✘</button>
                                <button class="btn btn-sm btn-outline-secondary">✍</button>
                            </div>
                        </div>
                        <div class="card-text text-muted card-cust-height markdown-body">${htmlEncode(item.prompt)}</div>
                        <div class="card-sample">${sample}</div>
                    </div>
                </div>
            </div>
        `;
    }
    
    /**
     * Load configurations from storage
     */
    browser.storage.local.get(DB_KEY.chatTpaList, (sysp) => {
        configurations = sysp[DB_KEY.chatTpaList] || [];
        configurations.forEach(item => appendConfigItem(item));
    });

    i18n();

    /**
     * Setup import link behavior based on browser
     */
    const importButton = document.getElementById("b_import");
    if (isFirefox) {
        importButton.setAttribute("href", "https://fxdq.net/" + getLanguageCode() + "/aidir.html");
    } else {
        importButton.addEventListener('click', (e) => {
            browser.tabs.create({ url: "https://fxdq.net/" + getLanguageCode() + "/aidir.html" });
            e.preventDefault();
        });
    }

    /**
     * Handle import prompt message from content script
     */
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "callImportAIdirPrompt") {
            const result = importPromptData(request.data);
            sendResponse({ success: true, data: result });
        }
        return true;
    });
  
    /**
     * Import external prompt configuration
     */
    function importPromptData(sourceData) {
        const acId = Date.now();
        const data = {
            id: acId,
            name: sourceData.name,
            prompt: sourceData.prompt,
            sample: sourceData.sample
        };
        
        if (sourceData.metac && sourceData.metac.length > 1) {
            data.metac = sourceData.metac;
        }
        
        configurations.push(data);
        appendConfigItem(data);
        window.scrollTo(0, document.body.scrollHeight);

        browser.storage.local.set({ [DB_KEY.chatTpaList]: configurations });

        return sourceData.sid;
    }
});