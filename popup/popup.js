import { i18n } from "../js/cllama.js";
import { browser, isFirefox } from "../js/browser.mjs";

document.getElementById('insightify').addEventListener('click', (e) => {
  e.preventDefault();
  openPage("/insightify/insightify.html", "Insightify");
  window.close();
});

document.getElementById('chat').addEventListener('click', (e) => {
  e.preventDefault();
  openPage("/chat/chat.html", "chat");
  window.close();
});

document.getElementById('settings').addEventListener('click', (e) => {
  e.preventDefault();  
  browser.runtime.openOptionsPage();
  window.close();
});

function openPage(url, title) {
 
  if(isFirefox) {
    const sidebar = browser.sidebarAction;
    const fail = (err) => console.error("[cllama] sidebarAction:", err);
    const thatPanel = browser.runtime.getURL(url);
    sidebar.setPanel({ panel: thatPanel }).catch(fail); 
    sidebar.setTitle({ title: "cllama-" + browser.i18n.getMessage(title) }).catch(fail);   
    sidebar.open().catch(fail);    
  } else {
    browser.tabs.query({active: true, currentWindow: true}, (tabs) => {
      browser.sidePanel.setOptions({
        enabled: true,
        path: url,
        tabId: tabs[0].id
      });
      browser.sidePanel.open({tabId: tabs[0].id});
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  i18n();
});