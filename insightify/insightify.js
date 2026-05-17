import { processInsight, i18n, DB_KEY, getRuntimeConfig } from '../js/cllama.js';
import { balert, confirm } from '../js/dialog.mjs';
import { marked } from '../js/marked.mjs';
import { copyToClipboard, thinkCollapseExpanded } from '../js/marked/copy.mjs';
import { addClass, hasClass, isMobile, removeClass, replaceElementContent, replaceThinkTags, sendToContentScript } from "../js/util.js";

export const browser = typeof chrome !== 'undefined' ? chrome : browser;
export const isFirefox = navigator.userAgent.indexOf('Firefox') >= 0;

document.addEventListener("DOMContentLoaded", () => {
    const summaryList = document.getElementById("summaryList");
    const actionList = document.getElementById("actions");

    let insightList = [];
    const parser = new DOMParser();
    const MAX_INSIGHTS = 100; // Maximum number of insights to store

    if (isMobile()) {
        actionList.style.display = "none";
    }

    /**
     * Initialize and load saved insights from storage
     */
    function loadInsights() {
        browser.storage.local.get(DB_KEY.insightList, (summaries) => {
            insightList = summaries[DB_KEY.insightList] || [];
            if (!insightList.length) return;

            insightList.forEach((item) => {
                const itemStr = replaceThinkTags(createItemHTML(item));
                const doc = parser.parseFromString(itemStr, 'text/html');
                const sumDiv = doc.body.firstChild.cloneNode(true);
                setupInsightCard(false, sumDiv);
                summaryList.insertBefore(sumDiv, summaryList.children[0]);
            });
        });
    }

    /**
     * Create HTML string for insight card
     */
    function createItemHTML(item) {
        const [date, time] = item.ctime.split(' ');
        return `
            <div class="summary-card mb-2">
                <a href="#" data-href="${item.url}" class="entry-title" title="${item.title}">${item.title}</a>
                <div id="${item.msgId}" class="insightifyHBody summary-content markdown-body">${marked.parse(item.content)}</div>
                <div class="row insightifyHBody">
                    <div class="col">
                        <small class="timestamp">${date} ${time}</small>
                    </div>
                    <div class="col">
                        <a href="#" data-id="${item.msgId}" class="trash text-end">
                            <svg class="bi me-2" style="height:0.85em;">
                                <use href="#svg_trash"></use>
                            </svg>
                        </a>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Setup title click behavior to toggle visibility or open link
     */
    function setupTitleBehavior(isNew, cardElement) {
        const titleLink = cardElement.querySelector("a.entry-title");

        if (!isNew) {
            cardElement.querySelectorAll(".insightifyHBody").forEach(hb => hb.style.display = "none");
            addClass(titleLink, "title-mask");
        }

        titleLink.addEventListener("click", (e) => {
            e.preventDefault();
            
            if (hasClass(titleLink, "title-mask")) {
                // Expand to show content
                cardElement.querySelectorAll(".insightifyHBody").forEach(hb => hb.style.display = "");
                removeClass(titleLink, "title-mask");
            } else {
                // Open URL in new tab
                browser.tabs.create({ url: titleLink.getAttribute("data-href") });
            }
        });
    }

    /**
     * Bind delete functionality to trash icon
     */
    function bindDeleteAction(cardElement) {
        const trashIcon = cardElement.querySelector(".trash");
        const insightId = trashIcon.getAttribute("data-id");
        trashIcon.style.display = "block";

        trashIcon.addEventListener("click", async (e) => {
            e.preventDefault();
            insightList = insightList.filter(it => it.msgId !== insightId);
            await browser.storage.local.set({ [DB_KEY.insightList]: insightList });
            cardElement.remove();
        });
    }

    /**
     * Setup all features for an insight card
     */
    function setupInsightCard(isNew, cardElement) {
        copyToClipboard(cardElement);
        thinkCollapseExpanded(cardElement);
        bindDeleteAction(cardElement);
        setupTitleBehavior(isNew, cardElement);
    }

    /**
     * Load and initialize action buttons
     */
    function loadActions() {
        browser.storage.local.get(DB_KEY.actionList, (actions) => {
            let actionDataList = actions[DB_KEY.actionList];
            
            if (!actionDataList?.length) {
                actionDataList = [{
                    id: 1,
                    name: browser.i18n.getMessage("summarizer"),
                    prompt: browser.i18n.getMessage("summaryPrompt")
                        .replaceAll("{localLanguage}", browser.i18n.getMessage("localLanguage"))
                }];
                browser.storage.local.set({ [DB_KEY.actionList]: actionDataList });
            }
            
            actionDataList.forEach(item => appendActionButton(item));
        });
    }

    /**
     * Create and append an action button
     */
    function appendActionButton(action) {
        const buttonHTML = `<a id="ac_${action.id}" href="#" class="btn btn-sm btn-outline-primary b_action i18n">${action.name}</a>`;
        const doc = parser.parseFromString(buttonHTML, 'text/html');
        actionList.appendChild(doc.body.firstChild.cloneNode(true));
        
        const actionButton = document.getElementById(`ac_${action.id}`);
        actionButton.addEventListener('click', () => handleActionClick(action, actionButton));
    }

    /**
     * Handle action button click to process page insight
     */
    async function handleActionClick(action, buttonElement) {
        try {
            const runtimeConfig = await getRuntimeConfig();
            if (!runtimeConfig || !runtimeConfig.apiUrl) {
                const confirmed = await confirm(`${browser.i18n.getMessage("apiConfigGuidance")}`, {
                    okText: browser.i18n.getMessage("goToConfig")
                });
                if (confirmed) {
                    browser.runtime.openOptionsPage();
                }
                return;
            }

            const response = await sendToContentScript({ action: "getPageInfo" });
            
            if (!response?.title || !response?.content) {
                balert(browser.i18n.getMessage("insightifyPageError1"));
                return;
            }

            addClass(buttonElement, "disabled");

            const msgId = `msg_${Date.now()}`;
            const item = {
                url: response.url,
                title: `${action.name} : ${response.title.replaceAll("\"", "'")}`,
                content: `<strong>${browser.i18n.getMessage("waitMessage")}</strong>`,
                ctime: new Date().toLocaleString(),
                msgId
            };

            const itemHTML = createItemHTML(item);
            const doc = parser.parseFromString(itemHTML, 'text/html');
            const newCard = doc.body.firstChild.cloneNode(true);
            summaryList.insertBefore(newCard, summaryList.children[0]);

            await processInsight(action.prompt, response, msgId, {
                finish: (summary) => {
                    item.content = summary;
                    
                    // Keep only last MAX_INSIGHTS items
                    if (insightList.length >= MAX_INSIGHTS) {
                        insightList.shift();
                    }
                    
                    insightList.push(item);
                    browser.storage.local.set({ [DB_KEY.insightList]: insightList });
                    removeClass(buttonElement, "disabled");
                    setupInsightCard(true, newCard);
                },
                error: (err, id) => {
                    removeClass(buttonElement, "disabled");
                    if (err.name !== 'AbortError') {
                        console.error('ProcessInsight error:', err);
                        replaceElementContent(
                            document.getElementById(msgId),
                            browser.i18n.getMessage("cllamaError")
                        );
                    }
                }
            });

        } catch (err) {
            balert(browser.i18n.getMessage("insightifyPageError2"));
            console.error('Action click error:', err);
            removeClass(buttonElement, "disabled");
        }
    }

    // Initialize
    loadInsights();
    loadActions();
    i18n();
});