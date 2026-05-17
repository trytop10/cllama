import { defaultSettings, i18n, DB_KEY } from "../js/cllama.js";
import { getService } from "../js/client/client.mjs";
import { balert } from "../js/dialog.mjs";
import { exportFile } from "../js/util.js";

let dsList = []; // Data source list
let mflag = true; // Flag indicating if the model list needs to be refreshed
let ds = {}; // Current data source settings

const browser = typeof chrome !== 'undefined' ? chrome : browser;

document.addEventListener('DOMContentLoaded', async () => {
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
      if (field) field.value = ds[k]; // Set the value of other form fields
    }
  }

  // Populate the service selection dropdowns for translation and insight services
  const tranServiceSelect = document.getElementById('tranService');
  const insightServiceSelect = document.getElementById('insightService');
  tranServiceSelect.innerHTML = ''; // Clear existing options
  insightServiceSelect.innerHTML = ''; // Clear existing options
  dsList.forEach(item => {
    const option1 = new Option(item.service, item.service);
    const option2 = new Option(item.service, item.service);
    tranServiceSelect.add(option1);
    insightServiceSelect.add(option2);
  });

  if (ds.tranService) {
    tranServiceSelect.value = ds.tranService;
  }
  if (ds.insightService) {
    insightServiceSelect.value = ds.insightService;
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
  
  alert(browser.i18n.getMessage("saveSuccessMessage"));
}

/**
 * Saves other general settings to browser local storage.
 */
async function saveOtherSettings() {
  const tranPrompt = document.getElementById('tranPrompt').value.trim();
  const tranService = document.getElementById('tranService').value;
  const insightService = document.getElementById('insightService').value;

  // Validate required field
  if (!tranPrompt) {
    balert(browser.i18n.getMessage("requiredError"));
    return false; // Prevent further execution if validation fails
  }

  // Update the global 'ds' (current data source settings) with other settings
  ds.tranPrompt = tranPrompt;
  ds.tranService = tranService;
  ds.insightService = insightService;

  await browser.storage.local.set({[DB_KEY.base]: ds});
  
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
  document.getElementById('b_save_other').addEventListener('click', saveOtherSettings);

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
    const allowedDataKeys = ["base", "dsList", "actionList", "chatTpaList", "insightList", "urls"];

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
