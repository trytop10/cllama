import { i18n, DB_KEY } from '../js/cllama.js';
import { browser } from '../js/browser.mjs';
import { replaceElementContent } from '../js/util.js';

document.addEventListener('DOMContentLoaded', function () {

    const configList = document.getElementById('config-list');
    const addConfigBtn = document.getElementById('add-config-btn');
    const saveConfigBtn = document.getElementById('save-config-btn');
    const addConfigModal = new bootstrap.Modal(document.getElementById('addConfigModal'));
    const urlInput = document.getElementById('url');
    const cssSelectorInput = document.getElementById('css-selector');

    var configurations = [];
    const parser = new DOMParser();

    addConfigBtn.addEventListener('click', () => {
        addConfigModal.show();
    });

    saveConfigBtn.addEventListener('click', (e) => {
        const url = urlInput.value;
        const cssSelector = cssSelectorInput.value;

        if(!url.startsWith("http://") && !url.startsWith("https://")){
            alert(browser.i18n.getMessage("urlPrefixError"));
            e.preventDefault();
        }

        if (url && cssSelector) {
            var ucId = new Date().getTime();
            var data = { url: url, cssSelector: cssSelector, id: ucId };

            configurations.push(data);
            append(data);
            browser.storage.local.set({ [DB_KEY.urls]: configurations });

            urlInput.value = '';
            cssSelectorInput.value = '';
            addConfigModal.hide();
        }
    });


    browser.storage.local.get(DB_KEY.urls, function (urls) {
        configurations = urls[DB_KEY.urls];
        if (!configurations) configurations = [];
        for (var item of configurations) {
            append(item);
        }
    });

    function append(item){
        const itemStr = createItemStr(item);
        const doc = parser.parseFromString(itemStr, 'text/html').body.getElementsByTagName("tr")[0].cloneNode(true);
        doc.getElementsByTagName("button")[0].addEventListener('click', () => {
            configurations = configurations.filter(it=>it.id!=item.id);
            browser.storage.local.set({[DB_KEY.urls]: configurations });
            document.getElementById("cu_"+item.id).remove();
        });
        configList.appendChild(doc);
    }

    function createItemStr(item) {
        var itemStr = `
        <table>
            <tr id="cu_${item.id}">
                <td>${item.url}</td>
                <td>${item.cssSelector}</td>
                <td class="ucaction">
                    <button class="btn btn-danger btn-sm delete">一</button>
                </td>
            </tr>
        </table>
        `;
        return itemStr;
    }

    i18n();
});
