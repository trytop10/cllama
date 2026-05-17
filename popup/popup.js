import { i18n, browser, isFirefox } from "../js/cllama.js";

document.getElementById('insightify').addEventListener('click',  async (e) => {
  e.preventDefault();
  openPage("/insightify/insightify.html", "Insightify");
  window.close();
});

document.getElementById('chat').addEventListener('click', async (e) => {
  e.preventDefault();  
  openPage("/chat/chat.html", "chat");
  window.close();
});

document.getElementById('settings').addEventListener('click', async (e) => {
  e.preventDefault();  
  browser.runtime.openOptionsPage();
  window.close();
});

async function openPage(url, title) {
 
  if(isFirefox) {
    var sidebar = browser.sidebarAction;
    var thatPanel = browser.runtime.getURL(url);
    sidebar.open();
    sidebar.setPanel({ panel: thatPanel });
    sidebar.setTitle({ title: "cllama-" + browser.i18n.getMessage(title) });
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

document.addEventListener("DOMContentLoaded", async () => {
  i18n();
});