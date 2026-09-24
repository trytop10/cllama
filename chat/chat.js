import { getService } from '../js/client/client.mjs';
import { chat, i18n, DB_KEY, getRuntimeConfig, setRuntimeConfig, abortSession, loadSkills, applySkillArguments, applyArtifact, loadPendingArtifact, loadPendingChoice, clearPendingChoice, removePendingDraft, artifactTargetLabel, parseChoiceOptions, collectArtifactDraftsDetailed, setPendingChoice, setPendingArtifact, recordUserAction, recordPageEvent } from '../js/cllama.js';
import { initMcpTools } from '../js/mcp.mjs';
import { browser } from '../js/browser.mjs';
import { marked } from '../js/marked.mjs';
import { copyToClipboard, thinkCollapseExpanded } from '../js/marked/copy.mjs';
import { exportFile, findMatchingParentNode, formatTimestamp, getQueryParam, replaceElementContent, replaceThinkTags, sendToContentScript } from '../js/util.js';

document.addEventListener("DOMContentLoaded", async () => {
    // API configuration settings
    let apiSettings = {
        temperature: 1,
        top_p: 0.9,
        think: false
    };

    // DOM element references
    const messagesContainer = document.getElementById('messages');
    const msgInput = document.getElementById('msgInput');
    const chatCategory = document.getElementById("chatCategory");
    const sendButton = document.getElementById("sendBtn");
    const cancelButton = document.getElementById("cancelBtn");
    const bFish = document.getElementById("b_fish");
    const bCollapseAll = document.getElementById("b_collapseAll");
    const bExpandAll = document.getElementById("b_expandAll");
    const skillPicker = document.getElementById("skillPicker");
    const skillBar = document.getElementById("skillBar");
    const skillNameSpan = document.getElementById("skillName");
    const bSkillSettings = document.getElementById("b_skillSettings");

    if (bSkillSettings) {
        bSkillSettings.title = browser.i18n.getMessage("expSkills") || 'Skills';
        // Open the standalone skill management page (breadcrumb links back here).
        bSkillSettings.addEventListener('click', (e) => {
            e.preventDefault();
            const ccId = getQueryParam("id");
            location.href = ccId ? `./skills.html?id=${ccId}` : './skills.html';
        });
    }
    
    if (bFish) {
        bFish.title = browser.i18n.getMessage("fish_title");
    }

    if (bCollapseAll) {
        bCollapseAll.addEventListener('click', (e) => {
            e.preventDefault();
            const messages = messagesContainer.querySelectorAll('.message');
            messages.forEach(msg => msg.classList.add('collapsed-message'));
        });
    }

    if (bExpandAll) {
        bExpandAll.addEventListener('click', (e) => {
            e.preventDefault();
            const messages = messagesContainer.querySelectorAll('.message');
            messages.forEach(msg => msg.classList.remove('collapsed-message'));
        });
    }
    
    // User-resizable message input. Height is changed by dragging the handle
    // that sits above the textarea (see #msgResizeHandle). The textarea height
    // is clamped between the current (default) height and 2/3 of the current
    // window height; window resize updates the upper bound live.
    function setupResizableInput() {
        if (!msgInput) return;
        const handle = document.getElementById('msgResizeHandle');
        const baseHeight = msgInput.offsetHeight || 60; // current (default) height
        let maxHeight = Math.max(baseHeight, Math.floor(window.innerHeight * 2 / 3));
        function applyInputLimits() {
            // "Max height = 2/3 of the current window height", never below the base.
            maxHeight = Math.max(baseHeight, Math.floor(window.innerHeight * 2 / 3));
            msgInput.style.minHeight = baseHeight + 'px';
            msgInput.style.maxHeight = maxHeight + 'px';
        }
        applyInputLimits();
        window.addEventListener('resize', applyInputLimits);

        if (!handle) return;
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startY = e.clientY;
            const startH = msgInput.offsetHeight;
            const onMove = (ev) => {
                // Grabbing the top edge: pulling it up grows the input,
                // pushing it down shrinks it.
                const dy = ev.clientY - startY;
                const h = Math.max(baseHeight, Math.min(maxHeight, startH - dy));
                msgInput.style.height = h + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'ns-resize';
        });
    }
    setupResizableInput();

    const ccId = getQueryParam("id");

    // State variables
    let stopFlag = true;
    let historyMessages = [];
    let responseId = null;
    let lastScrollTop = messagesContainer.scrollTop;
    let stopScrollFlag = false;
    let currentModel = "";
    let currentServiceConfig = null; // Currently active data source config from dsList
    let currentConfigurations = [];
    let apiSettingsPopover;
    let historyMemory = true;
    let activeSkill = null;    // Currently fixed skill (or null)
    let activeSkillArgs = '';  // Argument string captured when "/skill args..." ran
    let skillDisabled = true; // true => "No Skill (off)" mode: no Skill injection. This is the default state.
    let skills = [];           // All available skills
    let skillPickerOpen = false;
    let skillHighlight = -1;
    // Scenario samples the user closed in this page session, keyed by
    // "<scenarioId>:<sessionId>", so switching sessions back and forth does not
    // bring a dismissed hint back.
    const dismissedSamples = new Set();
    // When the current turn started: lets the page tell apart the cards the tools
    // created during this turn from cards left over from earlier turns.
    let turnStartedAt = 0;
    // The assistant bubble of the running turn (tool-step traces are attached to
    // it) and the page the turn was started from (handed to tools via ctx).
    let currentAssistantBlock = null;
    let turnPageUrl = null;
    let turnPageTitle = null;
    // Cached data source list, so the "@name" model override can be resolved
    // synchronously while typing/sending.
    let dsListCache = [];

    function generateMsgId(msgId) {
        return `msg_${msgId}`;
    }

    /**
     * Load the available skills from storage (and kick off MCP tool
     * registration in the background — chat() awaits the readiness promise
     * only when tools are actually needed, so startup is never blocked).
     */
    async function refreshSkills() {
        initMcpTools().catch(e => console.warn('[MCP] init failed:', e));
        skills = await loadSkills();
    }

    /**
     * React to Skill list changes made while this page stays open — either by
     * the model itself (save_skill tool, e.g. when a webpage is compiled into a
     * Skill) or by the Skill management page in another tab — so the "/" picker
     * and the status capsule stay in sync without a reload.
     * @param {Object} changes - Storage change payload
     * @param {string} area - Storage area name
     */
    function handleSkillStorageChange(changes, area) {
        if (area !== 'local' || !changes[DB_KEY.skillList]) return;
        refreshSkills().then(() => {
            // Keep the fixed Skill pointing at the fresh entry (its name or
            // description may have been edited), or drop it when it was deleted.
            if (activeSkill) {
                const still = skills.find(s => String(s.id) === String(activeSkill.id));
                if (still) activeSkill = still;
                else { activeSkill = null; activeSkillArgs = ''; }
            }
            closeSkillPicker();
            renderActiveSkillBar();
        });
    }

    /**
     * Update the skill status capsule. Three states: a fixed Skill
     * (activeSkill != null), "Auto" (activeSkill == null, model may self-select),
     * and "No Skill / off" (skillDisabled). Hidden entirely when there are no
     * configured Skills.
     */
    function renderActiveSkillBar() {
        if (!skillBar || !skillNameSpan) return;
        const clearSkillBtn = skillBar.querySelector("#clearSkill");
        const labelEl = skillBar.querySelector(".skill-bar-label");
        // No usable skills => the bar shows nothing, but it must keep its box in
        // the layout: hiding it with `display: none` would let the Skill settings
        // gear jump to the left end of the toolbar and sit lower than usual.
        if (!skills.length) {
            skillBar.classList.remove('d-none');
            skillBar.classList.add('d-flex', 'skill-bar-empty');
            return;
        }
        skillBar.classList.remove('d-none', 'skill-bar-empty');
        skillBar.classList.add('d-flex');

        if (skillDisabled) {
            if (labelEl) labelEl.style.display = '';
            skillNameSpan.textContent = browser.i18n.getMessage("skillNoSkill") || 'No Skill';
            skillBar.title = browser.i18n.getMessage("skillBarOffHint") || 'Skills are off. Click to pick one or enable Auto.';
            if (clearSkillBtn) clearSkillBtn.style.display = 'none';
        } else if (activeSkill) {
            if (labelEl) labelEl.style.display = '';
            skillNameSpan.textContent = activeSkill.name;
            skillBar.title = browser.i18n.getMessage("skillBarFixedHint") || 'AI will use this Skill';
            if (clearSkillBtn) clearSkillBtn.style.display = '';
        } else {
            // Auto mode: AI picks a Skill when relevant. Keep the same capsule
            // shape (icon prefix + status) as when a Skill is fixed.
            skillNameSpan.textContent = browser.i18n.getMessage("skillAutoSelect") || 'Auto-select Skill';
            skillBar.title = browser.i18n.getMessage("skillBarAutoHint") || 'AI will choose a Skill when relevant. Click to pick one.';
            if (clearSkillBtn) clearSkillBtn.style.display = 'none';
        }
    }

    /**
     * Show the skill picker filtered by the typed query.
     * @param {string} query - Text after the leading "/"
     */
    function openSkillPicker(query) {
        if (!skillPicker) return;
        const q = (query || '').toLowerCase();

        if (!skills.length) {
            skillPicker.innerHTML = `<div class="skill-picker-empty">${browser.i18n.getMessage("skillPickerEmpty")}</div>`;
            skillPicker.style.display = 'block';
            skillPickerOpen = true;
            skillHighlight = -1;
            return;
        }

        const matches = skills.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));

        if (!matches.length) {
            skillPicker.innerHTML = `<div class="skill-picker-empty">${browser.i18n.getMessage("skillPickerNoMatch")}</div>`;
            skillPicker.style.display = 'block';
            skillPickerOpen = true;
            skillHighlight = -1;
            return;
        }

        skillHighlight = -1;
        const isAutoState = !activeSkill && !skillDisabled;
        // State-control rows ("Auto" / "No Skill"). While in Auto + a typed query
        // we keep the list focused on matching Skills; otherwise expose the
        // controls so the user can switch mode.
        const autoRow =
            `<div class="skill-picker-item skill-picker-autoskill" data-auto="1">
                <span class="skill-picker-name">${browser.i18n.getMessage("skillAutoSelect") || "Let AI choose a Skill"}</span>
              </div>`;
        const offRow =
            `<div class="skill-picker-item skill-picker-autoskill" data-off="1">
                <span class="skill-picker-name">${browser.i18n.getMessage("skillNoSkill") || "No Skill"}</span>
              </div>`;
        let controls = '';
        if (!q || !isAutoState) {
            if (!isAutoState) controls += autoRow;   // already Auto => hide
            if (!skillDisabled) controls += offRow;  // already off => hide
        }
        skillPicker.innerHTML = controls + matches.map((s) =>
            `<div class="skill-picker-item" data-id="${s.id}">
                <span class="skill-picker-name">${s.name}</span>
                <span class="skill-picker-desc">${s.description || ''}</span>
            </div>`
        ).join('');
        skillPicker.style.display = 'block';
        skillPickerOpen = true;

        const autoEl = skillPicker.querySelector('[data-auto]');
        if (autoEl) {
            autoEl.addEventListener('mousedown', (e) => {
                e.preventDefault();
                clearActiveSkill();
            });
        }
        const offEl = skillPicker.querySelector('[data-off]');
        if (offEl) {
            offEl.addEventListener('mousedown', (e) => {
                e.preventDefault();
                disableSkills();
            });
        }
        skillPicker.querySelectorAll('.skill-picker-item[data-id]').forEach(el => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const id = el.getAttribute('data-id');
                const skill = skills.find(s => String(s.id) === String(id));
                if (skill) selectSkill(skill);
            });
        });
    }

    /**
     * Close the skill picker.
     */
    function closeSkillPicker() {
        if (!skillPicker) return;
        skillPicker.style.display = 'none';
        skillPicker.innerHTML = '';
        skillPickerOpen = false;
        skillHighlight = -1;
    }

    /**
     * Keep the highlighted item visible by scrolling the picker's own scroll
     * container so the active row is not hidden above / below the visible area.
     * The .skill-picker div is the scroll container (overflow-y: auto). Uses
     * getBoundingClientRect deltas so it works regardless of the offsetParent.
     * @param {HTMLElement} el - The highlighted .skill-picker-item element.
     */
    function scrollActiveSkillIntoView(el) {
        if (!skillPicker || !el) return;
        const crect = skillPicker.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        let dy = 0;
        if (er.top < crect.top) {
            // Item is above the visible area: scroll up to reveal it.
            dy = er.top - crect.top;
        } else if (er.bottom > crect.bottom) {
            // Item is below the visible area: scroll down to reveal it.
            dy = er.bottom - crect.bottom;
        }
        if (dy) skillPicker.scrollTop += dy;
    }

    /**
     * Highlight the item at the given index.
     */
    function setSkillHighlight(index) {
        if (!skillPicker) return;
        const items = skillPicker.querySelectorAll('.skill-picker-item');
        if (!items.length) return;
        skillHighlight = (index + items.length) % items.length;
        items.forEach((el, i) => {
            if (i === skillHighlight) el.classList.add('skill-picker-active');
            else el.classList.remove('skill-picker-active');
        });
        scrollActiveSkillIntoView(items[skillHighlight]);
    }

    /**
     * Prefill the input with a Skill's "starter" message (the request a user
     * most often sends to it), so selecting the Skill is enough — Enter can be
     * pressed right away. Skills without a starter keep the previous behaviour
     * (an empty input).
     * @param {Object} skill - The Skill being selected
     * @returns {string} The prefilled text ('' when the Skill has no starter)
     */
    function prefillStarter(skill) {
        const starter = typeof skill?.starter === 'string' ? skill.starter.trim() : '';
        if (!msgInput) return starter;
        msgInput.value = starter;
        // Caret at the end, so the text can be edited straight away.
        if (starter && typeof msgInput.setSelectionRange === 'function') {
            msgInput.setSelectionRange(starter.length, starter.length);
        }
        return starter;
    }

    /**
     * Activate a skill: clear the "/..." prefix from the input, or prefill it
     * with the skill's starter message when it declares one.
     */
    function selectSkill(skill) {
        activeSkill = skill;
        activeSkillArgs = '';
        skillDisabled = false;
        closeSkillPicker();
        renderActiveSkillBar();
        if (msgInput) {
            prefillStarter(skill);
            msgInput.focus();
        }
    }

    /**
     * Clear the currently active skill.
     */
    function clearActiveSkill() {
        activeSkill = null;
        activeSkillArgs = '';
        skillDisabled = false; // go back to Auto (model may self-select)
        // Drop a leftover "/..." draft used to open the picker (keep real text).
        if (msgInput && msgInput.value.startsWith('/')) msgInput.value = '';
        closeSkillPicker();
        renderActiveSkillBar();
    }

    /**
     * Switch to "No Skill (off)": no Skill index / tools are injected at all and
     * the model answers as a plain assistant until the user picks or enables Auto.
     */
    function disableSkills() {
        activeSkill = null;
        activeSkillArgs = '';
        skillDisabled = true;
        // Drop a leftover "/..." draft used to open the picker (keep real text).
        if (msgInput && msgInput.value.startsWith('/')) msgInput.value = '';
        closeSkillPicker();
        renderActiveSkillBar();
    }

    /**
     * Parse a draft that starts with "/" into an inline Skill command.
     * Format: "/skillname [args...]". Returns null when the first token does not
     * exactly match a known Skill (so fuzzy "/" autocomplete keeps working).
     * @param {string} text - The raw input draft.
     * @returns {null|{skill:Object, args:string}}
     */
    function parseSkillCommand(text) {
        if (!text) return null;
        const m = /^\/[ \t]*([^\s]+)[ \t]*(.*)$/.exec(text);
        if (!m) return null;
        const skill = skills.find(s => s.name.toLowerCase() === m[1].toLowerCase());
        return skill ? { skill, args: m[2] || '' } : null;
    }

    /**
     * Best-effort URL/title of the page the chat is working on, so tools receive
     * them through the tool context instead of guessing the active tab later.
     * @returns {Promise<{url: string|null, title: string|null}>}
     */
    async function getActiveTabInfo() {
        try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const tab = tabs?.[0];
            return { url: tab?.url || null, title: tab?.title || null };
        } catch (e) {
            return { url: null, title: null };
        }
    }

    /**
     * Parse a leading "@<data-source> " prefix, which runs this single message
     * against another configured data source (see chat()'s dsService option)
     * without touching the global model setting. Returns null when the text has
     * no prefix or the name does not match a configured data source.
     * @param {string} text - Raw input
     * @returns {Object|null} { name, rest } when matched
     */
    function parseServiceOverride(text) {
        if (!text) return null;
        const m = /^@([^\s@]+)[ \t]+([\s\S]*)$/.exec(text);
        if (!m) return null;
        const wanted = m[1].toLowerCase();
        const list = dsListCache;
        const entry = list.find(d =>
            String(d.name || '').toLowerCase() === wanted || String(d.service || '').toLowerCase() === wanted);
        if (!entry) return null;
        return { name: entry.name || entry.service, rest: m[2] };
    }

    /**
     * Commit the currently highlighted item of the skill picker (arrow navigation).
     */
    function commitHighlightedSkill() {
        const items = skillPicker.querySelectorAll('.skill-picker-item');
        if (skillHighlight >= 0 && items[skillHighlight]) {
            const el = items[skillHighlight];
            if (el.hasAttribute('data-auto')) {
                clearActiveSkill();
            } else if (el.hasAttribute('data-off')) {
                disableSkills();
            } else {
                const id = el.getAttribute('data-id');
                const skill = skills.find(s => String(s.id) === String(id));
                if (skill) selectSkill(skill);
            }
        }
    }

    /**
     * Called on input: open the "/" skill picker when appropriate.
     */
    function handleSkillInput() {
        const val = msgInput.value;
        // Only trigger when "/" is the very first character of the draft. The
        // query is the first token only, so "/name arg1 arg2" keeps matching
        // "name" (args are handled as an inline command on send).
        if (val.startsWith('/')) {
            const rest = val.slice(1).trimStart();
            const query = rest.split(/\s+/, 1)[0] || '';
            openSkillPicker(query);
        } else {
            closeSkillPicker();
        }
    }

    /**
     * Update resend button visibility for the last user message
     */
    function updateResendButtonVisibility() {
        const messageElements = messagesContainer.querySelectorAll('.user-message');
        messageElements.forEach(el => {
            const resendBtn = el.querySelector('.resend-message-btn');
            if (resendBtn) resendBtn.style.display = 'none';
        });

        if (historyMessages.length > 0 && stopFlag) {
            const lastMsg = historyMessages[historyMessages.length - 1];
            if (lastMsg.role === 'user') {
                const lastUserMsgEl = Array.from(messageElements).find(el => parseInt(el.dataset.timestamp, 10) === lastMsg.rtime);
                if (lastUserMsgEl) {
                    const resendBtn = lastUserMsgEl.querySelector('.resend-message-btn');
                    if (resendBtn) resendBtn.style.display = 'inline-block';
                }
            }
        }
    }

    function updateCollapseExpandButtonsState() {
        const messageElements = messagesContainer.querySelectorAll('.message');
        const count = messageElements.length;
        const isDisabled = count < 2;
        
        [bCollapseAll, bExpandAll].forEach(btn => {
            if (btn) {
                if (isDisabled) {
                    btn.style.opacity = '0.5';
                    btn.style.pointerEvents = 'none';
                } else {
                    btn.style.opacity = '1';
                    btn.style.pointerEvents = 'auto';
                }
            }
        });
    }

    /**
     * Send message: handle user input, add system prompts, call chat API
     */
    async function sendMessage() {
        // Inline "/skill [args...]" command: fix that Skill (sticky) and treat
        // everything after its name as the message / $ARGUMENTS. A bare "/skill"
        // with no args just activates the Skill and sends nothing.
        let rawMessage = msgInput.value;
        const cmd = parseSkillCommand(rawMessage);
        if (cmd) {
            activeSkill = cmd.skill;
            activeSkillArgs = cmd.args || '';
            skillDisabled = false; // adopting a Skill overrides "off"
            if (skillPickerOpen) closeSkillPicker();
            renderActiveSkillBar();
            if (!(cmd.args || '').trim()) {
                // Bare "/skill": there is nothing to send. Adopt the Skill and, when
                // it declares a starter message, prefill the input with it so the
                // next Enter sends that request instead of an empty message.
                prefillStarter(cmd.skill);
                return;
            }
            rawMessage = cmd.args;
            msgInput.value = cmd.args;
        }

        // Per-call model override: a leading "@<data-source> " runs this single
        // message on another configured model (chat()'s dsService option) and
        // leaves the global setting alone.
        let callDsService = null;
        const svcOverride = parseServiceOverride(rawMessage);
        if (svcOverride) {
            callDsService = svcOverride.name;
            rawMessage = svcOverride.rest;
            appendArtifactNote((browser.i18n.getMessage('modelOverrideNote') || 'This message runs on {name}.').replace('{name}', svcOverride.name), null);
        }

        const messageContent = rawMessage.trim();
        const rtime = Date.now();
        if (!messageContent) return;

        const currModelName = currentModel;

        msgInput.value = '';
        appendMessage(messageContent, 'self', rtime);
        historyMessages.push({ role: "user", content: messageContent, rtime });
        updateResendButtonVisibility();

        const assistantMsgBlock = appendMessage("", currModelName, rtime + 1, false);
        const assistantMsgDiv = assistantMsgBlock.querySelector(".message-text");
        currentAssistantBlock = assistantMsgBlock;
        replaceElementContent(assistantMsgDiv, "<img src='/images/thinking.webp' style='width:52px;height:52px;' />");

        // Merge file and text logic
        let imagesToSend = [];
        historyMessages.forEach(msg => {
            if (msg.role === 'user' && msg.fileInfo?.send) {
                imagesToSend.unshift(msg.content);
                msg.fileInfo.send = false;
            }
        });

        // Build messages for API
        let messagesForAPI = historyMemory 
            ? JSON.parse(JSON.stringify(historyMessages))
            : [JSON.parse(JSON.stringify(historyMessages[historyMessages.length - 1]))];

        // Attach files to last message
        if (imagesToSend.length > 0) {
            const lastApiMessage = messagesForAPI[messagesForAPI.length - 1];
            if (lastApiMessage.role === 'user') {
                lastApiMessage.images = imagesToSend;
            }
        }

        // Remove standalone file messages
        messagesForAPI = messagesForAPI.filter(msg => 
            !(msg.role === 'user' && (msg.fileInfo || msg.content.startsWith('<img')))
        );

        // Add system prompt based on chat category
        const activeChatScenarioId = ccId;
        if (activeChatScenarioId && activeChatScenarioId !== "0" && currentConfigurations.length > 0) {
            const config = currentConfigurations.find(c => String(c.id) === activeChatScenarioId);
            if (config?.prompt) {
                messagesForAPI.unshift({ role: "system", content: config.prompt });
            }
        }

        // Inject current webpage content for skills that need it (usePage)
        if (activeSkill?.usePage) {
            try {
                const pageInfo = await sendToContentScript({ action: "getPageInfo" });
                if (pageInfo && pageInfo.content) {
                    turnPageUrl = pageInfo.url || null;
                    messagesForAPI.unshift({
                        role: "user",
                        content: `[Current webpage]\nTitle: ${pageInfo.title || ''}\nURL: ${pageInfo.url || ''}\n\nContent:\n${pageInfo.content}\n\nAnswer the user's question based on the webpage content above.`
                    });
                }
            } catch (err) {
                // Expected when the active tab has no injected content script
                // (chrome:// / about: pages, the extension's own pages, PDF
                // viewer, or a tab that was just closed). This is not a real
                // failure: the skill simply proceeds without page content.
                // Only surface genuinely unexpected errors to the console.
                const errMsg = String((err && err.message) || err);
                const noContentScript =
                    /receiving end does not exist/i.test(errMsg) ||
                    /could not establish connection/i.test(errMsg);
                if (!noContentScript) {
                    console.warn("Failed to get page info for skill:", err);
                }
            }
        }

        turnStartedAt = Date.now();
        const activeTabInfo = await getActiveTabInfo();
        turnPageUrl = activeTabInfo.url;
        turnPageTitle = activeTabInfo.title;
        responseId = chat(messagesForAPI, {
            msgDiv: assistantMsgDiv,
            messages: messagesContainer,
            model: currModelName,
            temperature: apiSettings.temperature,
            top_p: apiSettings.top_p,
            think: apiSettings.think,
            activeSkill: activeSkill ? { ...activeSkill, prompt: applySkillArguments(activeSkill.prompt || '', activeSkillArgs) } : null,
            skills: skillDisabled ? [] : skills,
            // Where this turn runs from and which data source it uses; tools get
            // them through the tool context instead of guessing the active tab.
            sessionId: ccId || '0',
            pageUrl: turnPageUrl,
            pageTitle: turnPageTitle,
            dsService: callDsService,
            // Live trace of every tool step: failures are surfaced right in the
            // message (never silently summed up by the model).
            onToolStep: (step) => showToolStep(step),
            // Blank answer (empty text / undelivered tool call): say so instead of
            // leaving an empty bubble.
            onEmptyResponse: (info) => showEmptyResponseNotice(info),
            start: () => {
                stopFlag = false;
                setComponentState(true);
            },
            finish: (apiResultMessages) => {
                let assistantText = '';
                if (apiResultMessages?.length > 0) {
                    const assistantResponse = apiResultMessages[apiResultMessages.length - 1];
                    if (assistantResponse.role === 'assistant') {
                        assistantText = assistantResponse.content || '';
                        const assistantMessageToAdd = {
                            ...assistantResponse,
                            rtime: assistantResponse.rtime || Date.now(),
                            model: currModelName
                        };
                        historyMessages.push(assistantMessageToAdd);
                        
                        const pdiv = findMatchingParentNode(assistantMsgDiv, ".bot-message");
                        pdiv.dataset.timestamp = assistantMessageToAdd.rtime;
                        pdiv.querySelector(".copy-message-btn").setAttribute("data-flag", "true");
                        pdiv.querySelector(".delete-message-btn").setAttribute("data-flag", "true");
                    }
                }
                setAllFilesActivation(false);
                saveCurrentSession();
                setComponentState(false);
                enableToolRetries();
                // Turn the answer into clickable cards (option list / JSON drafts)
                // even when the model did not call the helper tools.
                offerCardsFromText(assistantText).catch((err) => console.warn('Failed to build cards from answer:', err));
                currentAssistantBlock = null;
            },
            stop: () => stopFlag,
            stopScroll: () => stopScrollFlag
        }).catch((e) => {
            if (e.name !== 'AbortError') {
                console.error('Chat error:', e);
                assistantMsgBlock.remove();
                displayMessage(browser.i18n.getMessage("cllamaError"), 'system-error-message');
                setAllFilesActivation(false);
                saveCurrentSession();
            }
            setComponentState(false);
            responseId = null;
            currentAssistantBlock = null;
            enableToolRetries();
        });
    }

    /**
     * No-op after a turn finished: failed tool steps offer a retry button only
     * once a new turn may be started.
     */
    function enableToolRetries() {
        messagesContainer.querySelectorAll('.tool-retry-btn').forEach(btn => { btn.disabled = false; });
    }

    /**
     * Set UI component state based on processing status
     */
    function setComponentState(processing) {
        if (processing) {
            sendButton.setAttribute("hidden", "true");
            cancelButton.removeAttribute("hidden");
            msgInput.disabled = true;
            stopFlag = false;
        } else {
            cancelButton.setAttribute("hidden", "true");
            sendButton.removeAttribute("hidden");
            msgInput.disabled = false;
            stopFlag = true;
            responseId = null;
        }
        updateResendButtonVisibility();
    }

    /**
     * Append message to chat interface
     */
    function escapeHTML(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }


    function appendMessage(messageText, sender, timestamp, flag = true, fileInfo = null) {
        const isSelf = sender === "self";
        const senderName = isSelf ? "" : sender;
        const senderClass = isSelf ? "user" : "bot";
        const rightClass = isSelf ? "rightClass" : "";
        const timeString = formatTimestamp(timestamp);

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${senderClass}-message`;
        messageDiv.dataset.timestamp = timestamp;

        let markdownSelf = isSelf ? "self-message" : "markdown-body";
        let divpre = isSelf ? "pre" : "div";
        let msgText = isSelf ? escapeHTML(messageText) : messageText;

        if (fileInfo?.type) {
            divpre = "div";
            markdownSelf = "";
            msgText = formatFileMessage(messageText, fileInfo);
        }

        messageDiv.innerHTML = `
            <div class="message-content ${rightClass}">
                <div class="message-header">
                    <span class="message-sender">${senderName}</span>
                    <span class="message-time">${timeString}</span>
                    ${fileInfo ? `<a href="#" class="activate-message-btn" data-flag="${flag}" style="margin-left: 5px;text-decoration: none;font-size: 10pt;" title="${browser.i18n.getMessage("activate")}">${fileInfo.send ? '☑' : '◻'}</a>` : ''}
                    <img src="/images/copy.svg" class="copy-message-btn" data-flag="${flag}" style="height:13px;" title="${browser.i18n.getMessage("copy")}" />
                    <img src="/images/clear.svg" class="delete-message-btn" data-flag="${flag}" style="height:13px;" title="${browser.i18n.getMessage("delete")}"/>
                    ${isSelf ? `<span class="resend-message-btn" style="cursor:pointer;display:none;margin-left:5px;font-size:13px;" title="${browser.i18n.getMessage("resend")}">↺</span>` : ''}
                </div>
                <${divpre} class="message-text ${markdownSelf}">${msgText}</${divpre}>
            </div>
        `;

        const msgTextEl = messageDiv.querySelector('.message-text');
        msgTextEl.addEventListener('click', (e) => {
            if (messageDiv.classList.contains('collapsed-message')) {
                e.stopPropagation();
                messageDiv.classList.remove('collapsed-message');
            }
        });

        attachMessageEventListeners(messageDiv, fileInfo);
        messagesContainer.appendChild(messageDiv);
        updateCollapseExpandButtonsState();

        if (!stopScrollFlag) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        return messageDiv;
    }

    /**
     * Format file message based on file type
     */
    function formatFileMessage(messageText, fileInfo) {
        const { name, type } = fileInfo;

        if (type.startsWith('image/')) {
            return `<a href="${messageText}" target="_blank"><img src="${messageText}" alt="${name}" style="max-width: 100%; max-height: 300px; border-radius: 5px;"></a>`;
        }

        const iconMap = {
            'application/pdf': 'file-pdf.svg',
            'video/': 'file-video.svg',
            'audio/': 'file-audio.svg'
        };

        const icon = Object.entries(iconMap).find(([key]) => type.startsWith(key))?.[1];
        const iconHtml = icon ? `<img src="../images/${icon}" class="filetype theme-icon-active">` : '';

        return `<a href="${messageText}" class="file-link" download="${name}" data-filename="${name}" data-filetype="${type}">
            ${iconHtml} ${name}
        </a>`;
    }

    /**
     * Attach event listeners to message elements
     */
    function attachMessageEventListeners(messageDiv, fileInfo) {
        const msgTextEl = messageDiv.querySelector('.message-text');
        if (msgTextEl) {
            msgTextEl.addEventListener('click', (e) => {
                if (messageDiv.classList.contains('collapsed-message')) {
                    e.stopPropagation();
                    messageDiv.classList.remove('collapsed-message');
                }
            });
        }

        const copyBtn = messageDiv.querySelector('.copy-message-btn');
        const deleteBtn = messageDiv.querySelector('.delete-message-btn');
        const activateBtn = messageDiv.querySelector('.activate-message-btn');
        const resendBtn = messageDiv.querySelector('.resend-message-btn');

        if (resendBtn) {
            resendBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retryLastUserMessage();
            });
        }

        copyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            const msgTimestamp = parseInt(messageDiv.dataset.timestamp, 10);
            const messageRecord = historyMessages.find(record => record.rtime === msgTimestamp);
            // Always allow copying: fall back to the rendered text when the
            // message is not in the history (e.g. failed/aborted responses).
            const textToCopy = messageRecord ? messageRecord.content : (msgTextEl?.innerText || '');

            if (textToCopy) {
                try {
                    await navigator.clipboard.writeText(textToCopy);
                    const originalTitle = copyBtn.title;
                    copyBtn.src = "/images/check.svg";
                    copyBtn.title = browser.i18n.getMessage("copied");
                    setTimeout(() => {
                        copyBtn.src = "/images/copy.svg";
                        copyBtn.title = originalTitle;
                    }, 1500);
                } catch (err) {
                    alert(browser.i18n.getMessage("replicationFailed"));
                }
            }
        });


        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            const confirmed = await confirmDialog(browser.i18n.getMessage("confirmDelete"));
            if (confirmed) {
                const msgTimestamp = parseInt(messageDiv.dataset.timestamp, 10);
                const existed = historyMessages.some(msg => msg.rtime === msgTimestamp);
                historyMessages = historyMessages.filter(msg => msg.rtime !== msgTimestamp);
                if (existed) saveCurrentSession();
                messageDiv.remove();
                updateResendButtonVisibility();
                updateCollapseExpandButtonsState();
            }
        });

        if (activateBtn) {
            activateBtn.addEventListener('click', async (e) => {
                if (activateBtn.getAttribute("data-flag") === "false") return;
                e.stopPropagation();

                const msgTimestamp = parseInt(messageDiv.dataset.timestamp, 10);
                const messageRecord = historyMessages.find(record => record.rtime === msgTimestamp);

                if (messageRecord?.fileInfo) {
                    messageRecord.fileInfo.send = !messageRecord.fileInfo.send;
                    activateBtn.textContent = messageRecord.fileInfo.send ? '☑' : '◻';
                }
            });
        }
    }

    function displayMessage(messageText, msgClass) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        messageDiv.innerHTML = `
            <div class="message-content ${msgClass}">
                <div class="message-info">${messageText}</div>
            </div>
        `;
        messagesContainer.appendChild(messageDiv);

        if (!stopScrollFlag) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        return messageDiv;
    }

    /**
     * Render the sample first message of a chat scenario, with a close button in
     * its top-right corner. The text stays selectable for copying (see
     * `.sample-message` in chat/chat.css).
     * @param {string} sampleText - The scenario's sample message
     * @param {string} key - Dismissal key ("<scenarioId>:<sessionId>")
     * @returns {HTMLElement|null} The rendered element, or null when dismissed
     */
    function showSampleMessage(sampleText, key) {
        if (!sampleText || dismissedSamples.has(key)) return null;

        const messageDiv = displayMessage(`${browser.i18n.getMessage("inputSample")} : ${sampleText}`, 'sample-message');
        const content = messageDiv.querySelector('.message-content');
        if (!content) return messageDiv;

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'sample-message-close';
        closeBtn.textContent = '×';
        const closeLabel = browser.i18n.getMessage("close") || 'Close';
        closeBtn.title = closeLabel;
        closeBtn.setAttribute('aria-label', closeLabel);
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dismissedSamples.add(key);
            messageDiv.remove();
        });
        content.appendChild(closeBtn);

        return messageDiv;
    }

    /**
     * Render the confirmation cards for drafts the model compiled from a page
     * (see the propose_artifact tool). Nothing is imported until the user clicks
     * Import — that is the guarantee that an import is always user-confirmed.
     */
    async function renderPendingArtifacts() {
        messagesContainer.querySelectorAll('.artifact-message').forEach(el => el.remove());
        const pending = await loadPendingArtifact();
        if (!pending) return;

        const drafts = pending.drafts || [];
        const rejected = pending.rejected || [];
        const wrap = document.createElement('div');
        wrap.className = 'message artifact-message';

        const card = document.createElement('div');
        card.className = 'message-content artifact-card';

        const header = document.createElement('div');
        header.className = 'artifact-card-header';
        const title = document.createElement('span');
        title.className = 'artifact-card-title';
        title.textContent = `${browser.i18n.getMessage('artifactPendingTitle') || 'Waiting for your confirmation'} (${drafts.length})`;
        // Only show the confirmation header when there is something to import.
        if (drafts.length) header.appendChild(title);

        if (drafts.length > 1) {
            const importAll = document.createElement('button');
            importAll.type = 'button';
            importAll.className = 'btn btn-sm btn-primary artifact-import-all';
            importAll.textContent = browser.i18n.getMessage('artifactImportAll') || 'Import all';
            importAll.addEventListener('click', () => handleArtifactAction(null, 'import'));
            header.appendChild(importAll);
        }
        card.appendChild(header);

        drafts.forEach((draft, index) => {
            const item = document.createElement('div');
            item.className = 'artifact-item';

            const head = document.createElement('div');
            head.className = 'artifact-item-head';
            const badge = document.createElement('span');
            badge.className = 'artifact-badge';
            badge.textContent = artifactTargetLabel(draft.target);
            const nameEl = document.createElement('strong');
            nameEl.className = 'artifact-item-name';
            nameEl.textContent = draft.name || '(unnamed)';
            head.appendChild(badge);
            head.appendChild(nameEl);
            item.appendChild(head);

            if (draft.summary) {
                const summary = document.createElement('div');
                summary.className = 'artifact-item-summary';
                summary.textContent = draft.summary;
                item.appendChild(summary);
            }

            const details = document.createElement('details');
            details.className = 'artifact-item-json';
            const detailsSummary = document.createElement('summary');
            detailsSummary.textContent = browser.i18n.getMessage('artifactShowContent') || 'Show content';
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(draft.payload, null, 2);
            details.appendChild(detailsSummary);
            details.appendChild(pre);
            item.appendChild(details);

            const actions = document.createElement('div');
            actions.className = 'artifact-item-actions';
            const importBtn = document.createElement('button');
            importBtn.type = 'button';
            importBtn.className = 'btn btn-sm btn-primary artifact-import-btn';
            importBtn.textContent = browser.i18n.getMessage('artifactImport') || 'Import';
            importBtn.addEventListener('click', () => handleArtifactAction(draft, 'import'));
            // Import again replacing an artifact with the same name: a duplicate
            // name is the most common reason an import is refused.
            const overwriteBtn = document.createElement('button');
            overwriteBtn.type = 'button';
            overwriteBtn.className = 'btn btn-sm btn-outline-primary artifact-overwrite-btn';
            overwriteBtn.textContent = browser.i18n.getMessage('artifactImportOverwrite') || 'Import (overwrite)';
            overwriteBtn.addEventListener('click', () => handleArtifactAction(draft, 'import', { overwrite: true }));
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-sm btn-outline-secondary artifact-cancel-btn';
            cancelBtn.textContent = browser.i18n.getMessage('artifactCancel') || 'Cancel';
            cancelBtn.addEventListener('click', () => handleArtifactAction(draft, 'cancel'));
            actions.appendChild(importBtn);
            actions.appendChild(overwriteBtn);
            actions.appendChild(cancelBtn);
            item.appendChild(actions);

            card.appendChild(item);
        });

        // Blocks that failed validation: show them with the reason instead of
        // dropping them, otherwise a failed import looks like "nothing happened".
        if (rejected.length) {
            const badTitle = document.createElement('div');
            badTitle.className = 'artifact-card-title artifact-rejected-title';
            badTitle.textContent = `${browser.i18n.getMessage('artifactRejectedTitle') || 'Could not be imported'} (${rejected.length})`;
            card.appendChild(badTitle);

            rejected.forEach((bad) => {
                const item = document.createElement('div');
                item.className = 'artifact-item artifact-item-rejected';

                const head = document.createElement('div');
                head.className = 'artifact-item-head';
                if (bad.target) {
                    const badge = document.createElement('span');
                    badge.className = 'artifact-badge';
                    badge.textContent = artifactTargetLabel(bad.target);
                    head.appendChild(badge);
                }
                const nameEl = document.createElement('strong');
                nameEl.className = 'artifact-item-name';
                nameEl.textContent = bad.name || '(unnamed)';
                head.appendChild(nameEl);
                item.appendChild(head);

                const reason = document.createElement('div');
                reason.className = 'artifact-item-summary artifact-item-reason';
                reason.textContent = bad.reason;
                item.appendChild(reason);

                if (bad.raw) {
                    const details = document.createElement('details');
                    details.className = 'artifact-item-json';
                    const summary = document.createElement('summary');
                    summary.textContent = browser.i18n.getMessage('artifactShowContent') || 'Show content';
                    const pre = document.createElement('pre');
                    pre.textContent = bad.raw;
                    details.appendChild(summary);
                    details.appendChild(pre);
                    item.appendChild(details);
                }
                card.appendChild(item);
            });
        }

        wrap.appendChild(card);
        messagesContainer.appendChild(wrap);
        if (!stopScrollFlag) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * Import or dismiss draft(s). A single draft object is handled on its own,
     * null means "all of them" (the Import all button in the card header).
     * @param {Object|null} draft - Draft to handle ({ target, payload, name }) or null for every draft
     * @param {string} action - 'import' | 'cancel'
     * @param {Object} [opts] - { overwrite: boolean } for the overwrite-import button
     */
    async function handleArtifactAction(draft, action, opts = {}) {
        // Every outcome of a card click is written to the audit trail: this path
        // is user-confirmed writing, not a tool call, so it would otherwise leave
        // no trace at all (see recordUserAction).
        const audit = (entry) => recordUserAction({
            sessionId: ccId || '0',
            ...entry
        }).catch((e) => console.warn('audit write failed:', e));

        const pending = await loadPendingArtifact();
        if (!pending) {
            // The card is gone (another window handled it, or it was replaced by a
            // newer proposal): say so instead of doing nothing silently.
            appendArtifactNote(browser.i18n.getMessage('artifactCardGone')
                || 'This card is no longer valid - the drafts were already handled or replaced.', false);
            await audit({ action: 'card_stale', ok: false, error: 'no pending drafts left' });
            return;
        }

        const all = pending.drafts || [];
        const draftList = draft === null ? all : [draft];
        const done = [];

        for (const target of draftList) {
            if (!target) continue;
            if (action !== 'import') {
                appendArtifactNote(`${browser.i18n.getMessage('artifactCancelled') || 'Cancelled'}: ${target.name}`, false);
                await audit({ action: 'cancel', ok: true, target: target.target, name: target.name });
                done.push(target);
                continue;
            }
            const overwrite = opts.overwrite === true || target.overwrite === true;
            try {
                const res = await applyArtifact(target.target, target.payload, { overwrite });
                if (res.ok) {
                    appendArtifactNote(`${browser.i18n.getMessage('artifactImported') || 'Imported'}: ${res.name} (${artifactTargetLabel(target.target)})`, true);
                    await audit({
                        action: overwrite ? 'import_overwrite' : 'import',
                        ok: true,
                        target: target.target,
                        name: res.name,
                        detail: res.action
                    });
                    done.push(target);
                } else {
                    const tpl = browser.i18n.getMessage('artifactImportFailed') || 'Import failed: {error}';
                    appendArtifactNote(tpl.replace('{error}', res.message), false);
                    await audit({
                        action: overwrite ? 'import_overwrite' : 'import',
                        ok: false,
                        target: target.target,
                        name: target.name,
                        error: res.message
                    });
                    // Keep the card so the user can retry, e.g. with "Import (overwrite)".
                    if (res.error && res.error !== 'exists') done.push(target);
                }
            } catch (e) {
                const tpl = browser.i18n.getMessage('artifactImportFailed') || 'Import failed: {error}';
                appendArtifactNote(tpl.replace('{error}', String(e?.message || e)), false);
                await audit({
                    action: overwrite ? 'import_overwrite' : 'import',
                    ok: false,
                    target: target.target,
                    name: target.name,
                    error: String(e?.message || e)
                });
            }
        }

        // Drop the handled drafts from the pending list (matched by target+name so
        // the card stays valid no matter how the list changed meanwhile).
        for (const t of done) {
            const live = (await loadPendingArtifact())?.drafts || [];
            const index = live.findIndex(d => d.name === t.name && d.target === t.target);
            if (index >= 0) await removePendingDraft(index);
        }
        renderPendingArtifacts();
    }

    /**
     * Leave a one-line trace in the chat after a confirmation card was handled.
     * @param {string} text - Text to show
     * @param {boolean|null} ok - true = success, false = failure, null = neutral
     */
    function appendArtifactNote(text, ok) {
        const note = document.createElement('div');
        note.className = 'message artifact-note' + (ok === false ? ' artifact-note-warn' : '');
        const inner = document.createElement('div');
        inner.className = 'artifact-note-text';
        inner.textContent = (ok === true ? '✅ ' : ok === false ? '🚫 ' : '') + text;
        note.appendChild(inner);
        messagesContainer.appendChild(note);
        if (!stopScrollFlag) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * React to drafts / option lists proposed while this page stays open (the
     * model stores them through propose_artifact / ask_user_choice) and to cards
     * handled elsewhere.
     * @param {Object} changes - Storage change payload
     * @param {string} area - Storage area name
     */
    function handleArtifactStorageChange(changes, area) {
        if (area !== 'local') return;
        if (changes[DB_KEY.pendingArtifact]) renderPendingArtifacts();
        if (changes[DB_KEY.pendingChoice]) renderPendingChoice();
    }

    /**
     * Render the clickable option list the model asked for (ask_user_choice), so
     * the user can pick by clicking instead of typing numbers. Confirming sends
     * the selection as the user's next message.
     */
    async function renderPendingChoice() {
        messagesContainer.querySelectorAll('.choice-message').forEach(el => el.remove());
        const pending = await loadPendingChoice();
        if (!pending) return;

        const wrap = document.createElement('div');
        wrap.className = 'message choice-message';

        const card = document.createElement('div');
        card.className = 'message-content choice-card';

        const header = document.createElement('div');
        header.className = 'choice-header';
        const title = document.createElement('span');
        title.className = 'choice-title';
        title.textContent = pending.question
            || `${browser.i18n.getMessage('choicePendingTitle') || 'Pick one or more'} (${pending.options.length})`;
        header.appendChild(title);

        const headerActions = document.createElement('div');
        headerActions.className = 'choice-header-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-sm btn-outline-secondary choice-cancel-btn';
        cancelBtn.textContent = browser.i18n.getMessage('artifactCancel') || 'Cancel';
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'btn btn-sm btn-primary choice-confirm-btn';
        confirmBtn.disabled = true;
        confirmBtn.textContent = browser.i18n.getMessage('choiceConfirm') || 'Confirm selection';
        headerActions.appendChild(cancelBtn);
        headerActions.appendChild(confirmBtn);
        header.appendChild(headerActions);
        card.appendChild(header);

        const hint = document.createElement('div');
        hint.className = 'choice-hint';
        hint.textContent = browser.i18n.getMessage('choiceMultiHint') || 'You can select several, then press Confirm.';
        card.appendChild(hint);

        const boxes = [];
        const syncConfirm = () => {
            const count = boxes.filter(b => b.checked).length;
            confirmBtn.disabled = count === 0;
            confirmBtn.textContent = count
                ? `${browser.i18n.getMessage('choiceConfirm') || 'Confirm selection'} (${count})`
                : (browser.i18n.getMessage('choiceConfirm') || 'Confirm selection');
        };

        pending.options.forEach((option, index) => {
            const label = document.createElement('label');
            label.className = 'choice-item';

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.className = 'form-check-input choice-item-check';
            box.addEventListener('change', () => {
                label.classList.toggle('choice-item-selected', box.checked);
                syncConfirm();
            });
            boxes.push(box);

            const body = document.createElement('span');
            body.className = 'choice-item-body';
            const head = document.createElement('span');
            head.className = 'choice-item-head';
            const nameEl = document.createElement('strong');
            nameEl.className = 'choice-item-title';
            nameEl.textContent = `${index + 1}. ${option.title}`;
            head.appendChild(nameEl);
            if (option.target) {
                const badge = document.createElement('span');
                badge.className = 'artifact-badge';
                badge.textContent = artifactTargetLabel(option.target);
                head.appendChild(badge);
            }
            body.appendChild(head);
            if (option.detail) {
                const detail = document.createElement('span');
                detail.className = 'choice-item-detail';
                detail.textContent = option.detail;
                body.appendChild(detail);
            }

            label.appendChild(box);
            label.appendChild(body);
            card.appendChild(label);
        });

        cancelBtn.addEventListener('click', async () => {
            appendArtifactNote(browser.i18n.getMessage('choiceCancelled') || 'Selection cancelled', false);
            await clearPendingChoice();
        });

        confirmBtn.addEventListener('click', async () => {
            const picked = pending.options
                .map((option, index) => ({ option, index }))
                .filter(({ index }) => boxes[index]?.checked)
                .map(({ option, index }) => `#${index + 1} ${option.title}${option.target ? ` (${artifactTargetLabel(option.target)})` : ''}`);
            if (!picked.length) return;

            const tpl = browser.i18n.getMessage('choiceSelectionMessage') || 'Build the following selected items: {items}';
            await clearPendingChoice();
            if (msgInput) {
                msgInput.value = tpl.replace('{items}', picked.join('; '));
                sendMessage();
            }
        });

        wrap.appendChild(card);
        messagesContainer.appendChild(wrap);
        if (!stopScrollFlag) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * Render the confirmation card for a side-effect tool the model wants to run
     * (writes user data / calls an external service). Nothing runs until the user
     * answers; dismissing it (or the timeout) means "no".
     */
    async function renderPendingToolConfirm() {
        messagesContainer.querySelectorAll('.tool-confirm-message').forEach(el => el.remove());
        const data = await browser.storage.local.get(DB_KEY.pendingToolConfirm);
        const pending = data[DB_KEY.pendingToolConfirm];
        if (!pending || pending.resolved) return;

        const wrap = document.createElement('div');
        wrap.className = 'message tool-confirm-message';
        const card = document.createElement('div');
        card.className = 'message-content tool-confirm-card';

        const header = document.createElement('div');
        header.className = 'choice-header';
        const title = document.createElement('span');
        title.className = 'choice-title';
        const titleTpl = browser.i18n.getMessage('toolConfirmTitle') || 'Confirm running "{tool}"?';
        title.textContent = titleTpl.replace('{tool}', pending.tool);
        header.appendChild(title);
        card.appendChild(header);

        const kind = document.createElement('div');
        kind.className = 'tool-confirm-kind';
        kind.textContent = pending.sideEffect === 'write'
            ? (browser.i18n.getMessage('toolSideEffectWrite') || 'This tool writes your data.')
            : (browser.i18n.getMessage('toolSideEffectExternal') || 'This tool calls an external service.');
        card.appendChild(kind);

        if (pending.skillName) {
            const from = document.createElement('div');
            from.className = 'tool-confirm-from';
            from.textContent = (browser.i18n.getMessage('toolConfirmSkill') || 'Requested by Skill: {name}').replace('{name}', pending.skillName);
            card.appendChild(from);
        }
        if (pending.argsPreview) {
            const args = document.createElement('code');
            args.className = 'tool-confirm-args';
            args.textContent = pending.argsPreview;
            card.appendChild(args);
        }

        const resolve = async (granted, always) => {
            await browser.storage.local.set({
                [DB_KEY.pendingToolConfirm]: { ...pending, resolved: true, granted, always: always === true }
            });
        };

        const actions = document.createElement('div');
        actions.className = 'artifact-item-actions';
        const allowBtn = document.createElement('button');
        allowBtn.type = 'button';
        allowBtn.className = 'btn btn-sm btn-primary';
        allowBtn.textContent = browser.i18n.getMessage('toolConfirmAllow') || 'Run once';
        allowBtn.addEventListener('click', () => resolve(true, false));

        const alwaysBtn = document.createElement('button');
        alwaysBtn.type = 'button';
        alwaysBtn.className = 'btn btn-sm btn-outline-primary';
        alwaysBtn.textContent = browser.i18n.getMessage('toolConfirmAlways') || 'Always allow in this chat';
        alwaysBtn.addEventListener('click', () => resolve(true, true));

        const denyBtn = document.createElement('button');
        denyBtn.type = 'button';
        denyBtn.className = 'btn btn-sm btn-outline-secondary';
        denyBtn.textContent = browser.i18n.getMessage('toolConfirmDeny') || 'Deny';
        denyBtn.addEventListener('click', () => resolve(false, false));

        actions.appendChild(allowBtn);
        actions.appendChild(alwaysBtn);
        actions.appendChild(denyBtn);
        card.appendChild(actions);
        wrap.appendChild(card);
        messagesContainer.appendChild(wrap);
        if (!stopScrollFlag) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * React to a side-effect confirmation request / answer (same tab or another
     * window). The running turn is waiting on this — see requestToolConfirmation.
     * @param {Object} changes - Storage change payload
     * @param {string} area - Storage area name
     */
    function handleToolConfirmStorageChange(changes, area) {
        if (area !== 'local') return;
        if (changes[DB_KEY.pendingToolConfirm]) renderPendingToolConfirm();
    }

    /**
     * Show one tool step of the running turn under the assistant bubble. This is
     * the explicit failure surface: a tool that failed (or was denied) stays
     * visible with its error text, even if the model's answer glides over it.
     * @param {Object} step - { tool, ok, denied?, ms?, error? }
     */
    function showToolStep(step) {
        if (!step || !currentAssistantBlock) return;
        const content = currentAssistantBlock.querySelector('.message-content');
        if (!content) return;
        let box = content.querySelector('.tool-steps');
        if (!box) {
            box = document.createElement('div');
            box.className = 'tool-steps';
            content.appendChild(box);
        }

        const chip = document.createElement('div');
        chip.className = 'tool-step' + (step.ok ? '' : ' tool-step-failed');
        const ms = typeof step.ms === 'number' ? ` · ${(step.ms / 1000).toFixed(1)}s` : '';
        const label = step.denied
            ? `${step.tool}${ms} — ${browser.i18n.getMessage('toolStepDenied') || 'not confirmed, skipped'}`
            : step.ok
                ? `${step.tool}${ms}`
                : `${step.tool}${ms} — ${browser.i18n.getMessage('toolStepFailed') || 'failed'}`;
        chip.textContent = (step.ok ? '✅ ' : (step.denied ? '🚫 ' : '⚠️ ')) + label;
        if (!step.ok && step.error) {
            // Keep the reason visible (truncated) and copyable on click.
            chip.title = String(step.error);
            const detail = document.createElement('span');
            detail.className = 'tool-step-error';
            detail.textContent = String(step.error).slice(0, 200);
            chip.appendChild(detail);
            chip.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(String(step.error));
                    appendArtifactNote(browser.i18n.getMessage('copied') || 'Copied', true);
                } catch (e) { /* clipboard can be unavailable */ }
            });
            // One-click retry: re-sends the last user message (enabled once the
            // turn has finished, i.e. when a new turn may be started).
            const retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.className = 'btn btn-sm btn-outline-secondary tool-retry-btn';
            retryBtn.textContent = `↺ ${browser.i18n.getMessage('resend') || 'Resend'}`;
            retryBtn.disabled = !stopFlag;
            retryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retryLastUserMessage();
            });
            chip.appendChild(retryBtn);
            // Import-related failures also leave a note in the chat: the chip can
            // be easy to miss, and "the import did nothing" must stay explicable.
            if (String(step.tool).startsWith('propose_artifact')) {
                appendArtifactNote(`${browser.i18n.getMessage('artifactImportFailed') || 'Import failed'}: ${String(step.error).slice(0, 300)}`, false);
            }
        }
        box.appendChild(chip);
        if (!stopScrollFlag) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    /**
     * Re-send the last user message (used by the ↺ button and by failed tool
     * steps). No-op while a turn is still running.
     */
    function retryLastUserMessage() {
        if (!stopFlag) return;
        const lastMsg = historyMessages[historyMessages.length - 1];
        if (!lastMsg || lastMsg.role !== 'user') return;
        const el = Array.from(messagesContainer.querySelectorAll('.user-message'))
            .find(node => parseInt(node.dataset.timestamp, 10) === lastMsg.rtime);
        msgInput.value = lastMsg.content;
        historyMessages = historyMessages.filter(msg => msg.rtime !== lastMsg.rtime);
        if (el) el.remove();
        sendMessage();
    }

    /**
     * Render every pending card (option list + artifact confirmations).
     */
    function renderPendingCards() {
        renderPendingChoice();
        renderPendingArtifacts();
        renderPendingToolConfirm();
    }

    /**
     * After an assistant turn, turn what the model wrote into clickable cards, so
     * the flow works even with models that never call ask_user_choice /
     * propose_artifact:
     *  - a numbered candidate list becomes a clickable option list;
     *  - fenced ```json draft block(s) become confirmation cards with Import.
     * Anything the tools already rendered for this same turn is left untouched.
     * @param {string} text - The assistant's final answer
     */
    async function offerCardsFromText(text) {
        if (!text) return;
        // A "builder"-like Skill: the page-builder itself, or any Skill that owns
        // the propose_artifact tool.
        const isBuilder = activeSkill?.id === 'page-builder' ||
            (Array.isArray(activeSkill?.tools) && activeSkill.tools.some(t => (t?.name || t) === 'propose_artifact'));
        const hasChoiceCue = /(请选择|选择哪|哪几项|选好后|回复编号|choose|pick|which (one|ones)|select)/i.test(text);

        // Option list (skip when the ask_user_choice tool did it in this turn).
        // Gated on a choice cue so ordinary answers never turn into a list.
        if (isBuilder || hasChoiceCue) {
            const choice = await loadPendingChoice();
            if (!(choice && choice.id >= turnStartedAt)) {
                const options = parseChoiceOptions(text);
                if (options.length) {
                    // Keep the options of an identical card instead of re-creating it.
                    const same = choice && choice.options.length === options.length &&
                        choice.options.every((o, i) => o.title === options[i].title);
                    if (!same) await setPendingChoice(options);
                }
            }
        }

        // Artifact drafts (skip when the propose_artifact tool did it this turn).
        // NOT gated on the choice cue: whenever the answer carries drafts, the
        // Import cards must appear — that is the whole import path, and dropping
        // them silently is what made "import" look broken.
        const pending = await loadPendingArtifact();
        if (!(pending && pending.id >= turnStartedAt)) {
            const { drafts, rejected } = collectArtifactDraftsDetailed(text);
            if (drafts.length || rejected.length) {
                const same = pending &&
                    (pending.drafts || []).length === drafts.length &&
                    (pending.drafts || []).every((d, i) => d.name === drafts[i].name && d.target === drafts[i].target) &&
                    (pending.rejected || []).length === rejected.length;
                if (!same) {
                    await setPendingArtifact(drafts, rejected);
                    // A turn whose answer was parsed into cards called no tool at
                    // all (the model just wrote JSON). Record the event, so the
                    // audit trail still shows how the cards came to be.
                    recordPageEvent({
                        action: 'parse_drafts',
                        count: drafts.length,
                        ok: true,
                        sessionId: ccId || '0',
                        detail: rejected.length ? `${rejected.length} rejected` : ''
                    }).catch((e) => console.warn('audit write failed:', e));
                }
            }
        }
    }

    /**
     * The model returned nothing usable (blank text, or a tool call the backend
     * never delivered). Say so in the bubble instead of leaving it empty.
     * @param {Object} info - { hadToolCalls }
     */
    function showEmptyResponseNotice(info = {}) {
        if (currentAssistantBlock) {
            const textDiv = currentAssistantBlock.querySelector('.message-text');
            if (textDiv) {
                textDiv.classList.remove('markdown-body');
                textDiv.textContent = browser.i18n.getMessage('emptyResponseNotice')
                    || 'The model returned no text.';
            }
        }
        const hint = browser.i18n.getMessage(info.hadToolCalls ? 'emptyResponseToolHint' : 'emptyResponseHint')
            || (info.hadToolCalls
                ? 'It answered with a tool call that could not be carried out. Try again, or switch to another model.'
                : 'This endpoint sent an empty answer. Try again, or switch to another model.');
        appendArtifactNote(hint, false);
    }

    messagesContainer.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('go-to-config')) {
            e.preventDefault();
            browser.runtime.openOptionsPage();
        }
    });

    messagesContainer.addEventListener('scroll', function() {
        const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
        const currentScrollTop = scrollTop;

        if (currentScrollTop < lastScrollTop && (scrollHeight - clientHeight - scrollTop > 20)) {
            stopScrollFlag = true;
        }
        lastScrollTop = currentScrollTop <= 0 ? 0 : currentScrollTop;

        const isAtBottom = Math.abs(scrollTop + clientHeight - scrollHeight) < 5;
        if (isAtBottom) {
            stopScrollFlag = false;
        }
    });

    // Skill picker keyboard navigation + send
    msgInput.addEventListener('input', handleSkillInput);

    msgInput.addEventListener('keydown', (e) => {
        if (skillPickerOpen) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSkillHighlight(skillHighlight + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSkillHighlight(skillHighlight - 1);
            } else if (e.key === 'Enter') {
                // An exact "/skillname [args]" command adopts the Skill and sends
                // the trailing text; otherwise Enter commits the highlighted pick.
                if (parseSkillCommand(msgInput.value)) {
                    e.preventDefault();
                    sendMessage();
                } else {
                    e.preventDefault();
                    commitHighlightedSkill();
                }
            } else if (e.key === 'Tab') {
                e.preventDefault();
                commitHighlightedSkill();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSkillPicker();
            }
            return;
        }

        if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
            // Allow line break
        } else if (e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
        }
    });

    // Skill bar: clear active skill / open picker
    if (skillBar) {
        const clearSkillBtn = skillBar.querySelector("#clearSkill");
        if (clearSkillBtn) clearSkillBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            clearActiveSkill();
        });
        // Clicking the bar toggles the picker; clicking again (or losing focus
        // to somewhere else) closes it.
        skillBar.addEventListener('click', (e) => {
            if (e.target.closest('#clearSkill')) return;
            if (skillPickerOpen) {
                closeSkillPicker();
            } else {
                openSkillPicker('');
            }
        });
    }

    // Close the skill picker when the user clicks / presses anywhere outside
    // of it (the skill bar itself toggles, so it is excluded here).
    document.addEventListener('mousedown', (e) => {
        if (!skillPickerOpen) return;
        if (skillPicker.contains(e.target) || skillBar.contains(e.target)) return;
        closeSkillPicker();
    });

    sendButton.addEventListener('click', (e) => {
        e.preventDefault();
        sendMessage();
    });

    cancelButton.addEventListener('click', async (e) => {
        e.preventDefault();
        stopFlag = true;
        if (responseId) {
            abortSession(responseId);
        }
        setComponentState(false);
    });

    document.getElementById("b_image").addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('imageUpload').click();
    });

    document.getElementById('imageUpload').addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        if (file.size > 1024 * 1024 * 5) {
            alert(browser.i18n.getMessage("fileTooLarge"));
            return;
        }

        const supportedTypes = ['application/pdf', 'video/', 'audio/', 'image/'];
        if (!supportedTypes.some(type => file.type.startsWith(type) || file.type === type)) {
            alert("Unsupported file format");
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const fileInfo = {
                name: file.name,
                type: file.type,
                size: file.size,
                send: true
            };
            const messageContent = e.target.result;
            const rtime = Date.now();
            appendMessage(messageContent, 'self', rtime, true, fileInfo);
            historyMessages.push({ role: "user", content: messageContent, rtime, fileInfo });
            saveCurrentSession();
        };
        reader.readAsDataURL(file);
    });

    if (bFish) {
        bFish.addEventListener('click', (e) => {
            e.preventDefault();
            bFish.classList.toggle('active-fish');
            saveFishIconState(bFish.classList.contains('active-fish'));
        });
    }

    chatCategory.addEventListener("change", (e) => {
        e.preventDefault();
        location.href = `./chat.html?id=${e.target.value}`;
    });

    document.getElementById("b_clear").addEventListener('click', async (e) => {
        if (!stopFlag) return;
        e.preventDefault();

        const confirmed = await confirmDialog(browser.i18n.getMessage('confirmClearChat'));
        if (!confirmed) return;

        const currentScenario = ccId || "0";
        const storageKey = `chatHistory_${currentScenario}`;

        browser.storage.local.get(storageKey, async (data) => {
            let scenarioData = data[storageKey] || {
                currentId: 0,
                history: [{ id: 0, name: browser.i18n.getMessage("defaultChatName") || "00", records: [] }]
            };

            const sessionIndexToDelete = scenarioData.history.findIndex(
                session => session.id === scenarioData.currentId
            );
            if (sessionIndexToDelete !== -1) {
                scenarioData.history.splice(sessionIndexToDelete, 1);
            }

            if (scenarioData.history.length === 0) {
                scenarioData.currentId = 0;
                scenarioData.history.push({
                    id: 0,
                    name: browser.i18n.getMessage("defaultChatName") || "00",
                    records: []
                });
            } else {
                scenarioData.currentId = scenarioData.history[scenarioData.history.length - 1].id;
            }

            await browser.storage.local.set({ [storageKey]: scenarioData });
            messagesContainer.innerText = "";
            historyMessages = [];
            loadChatHistory(currentScenario, scenarioData.currentId);
            updateChatRecordsList(scenarioData.history, scenarioData.currentId);
        });
    });

    document.getElementById("b_new").addEventListener('click', async (e) => {
        if (!stopFlag) return;
        e.preventDefault();
        if (historyMessages.length === 0) return;

        const currentScenario = ccId || "0";
        const storageKey = `chatHistory_${currentScenario}`;

        browser.storage.local.get(storageKey, async (data) => {
            let scenarioData = data[storageKey] || {
                currentId: 0,
                history: [{ id: 0, name: browser.i18n.getMessage("defaultChatName") || "00", records: [] }]
            };

            const currentIndex = scenarioData.history.findIndex(
                session => session.id === scenarioData.currentId
            );
            if (currentIndex !== -1) {
                scenarioData.history[currentIndex].records = [...historyMessages];
            } else {
                scenarioData.history.push({
                    id: scenarioData.currentId,
                    name: "Session " + scenarioData.currentId,
                    records: [...historyMessages]
                });
            }

            const newSessionId = scenarioData.history.length > 0
                ? Math.max(...scenarioData.history.map(s => s.id)) + 1
                : 1;
            const newSession = {
                id: newSessionId,
                name: (newSessionId < 10 ? "0" : "") + newSessionId,
                records: []
            };

            scenarioData.history.push(newSession);
            scenarioData.currentId = newSessionId;
            await browser.storage.local.set({ [storageKey]: scenarioData });

            messagesContainer.innerText = "";
            historyMessages = [];
            updateChatRecordsList(scenarioData.history, scenarioData.currentId);
            checkAndShowSampleMessage(currentScenario, scenarioData.currentId);
            renderPendingCards();

             updateCollapseExpandButtonsState();
        });       
    });

    async function loadChatHistory(scenarioId, sessionId) {
        const effectiveScenarioId = scenarioId || "0";
        const storageKey = `chatHistory_${effectiveScenarioId}`;

        browser.storage.local.get(storageKey, (data) => {
            let scenarioData = data[storageKey];

            if (!scenarioData?.history?.length) {
                scenarioData = {
                    currentId: 0,
                    history: [{ id: 0, name: browser.i18n.getMessage("defaultChatName") || "00", records: [] }]
                };
                browser.storage.local.set({ [storageKey]: scenarioData });
                sessionId = 0;
            }

            const session = scenarioData.history.find(s => s.id === sessionId);

            if (session) {
                messagesContainer.innerText = "";
                historyMessages = session.records ? [...session.records] : [];

                historyMessages.forEach((item) => {
                    const content = item.role === "user" 
                        ? item.content 
                        : marked.parse(item.content);
                    const role = item.role === "user" ? "self" : "assistant";
                    appendMessage(replaceThinkTags(content), item.model || role, item.rtime, true, item.fileInfo);
                });

                copyToClipboard(messagesContainer);
                thinkCollapseExpanded(messagesContainer);
                updateCollapseExpandButtonsState();

                if (scenarioData.currentId !== sessionId) {
                    scenarioData.currentId = sessionId;
                    browser.storage.local.set({ [storageKey]: scenarioData });
                }

                updateChatRecordsList(scenarioData.history, scenarioData.currentId);
                checkAndShowSampleMessage(effectiveScenarioId, sessionId);
                renderPendingCards();
                updateResendButtonVisibility();
            } else {
                const fallbackSession = scenarioData.history.find(s => s.id === 0) || scenarioData.history[0];
                if (fallbackSession) {
                    loadChatHistory(effectiveScenarioId, fallbackSession.id);
                } else {
                    messagesContainer.innerText = browser.i18n.getMessage("chatHistoryCorrupted") || "Chat history error";
                }
            }
        });
    }

    function updateChatRecordsList(sessionsArray, activeSessionId) {
        const chatRecordsDiv = document.getElementById("chat_records");
        const moreRecordsDropdown = document.getElementById("more_records_dropdown");
        const moreRecordsList = document.getElementById("more_records_list");
        if (!chatRecordsDiv) return;

        chatRecordsDiv.innerHTML = "";
        if (moreRecordsList) moreRecordsList.innerHTML = "";
        if (moreRecordsDropdown) moreRecordsDropdown.style.display = "none";

        if (!Array.isArray(sessionsArray) || sessionsArray.length === 0) {
            const noRecordsMsg = document.createElement('span');
            noRecordsMsg.className = 'text-muted small';
            noRecordsMsg.textContent = browser.i18n.getMessage("noChatHistorySessions") || "No chat sessions";
            chatRecordsDiv.appendChild(noRecordsMsg);
            return;
        }

        function createSessionButton(session, activeId, isDropdownItem = false) {
            const link = document.createElement("a");
            if (isDropdownItem) {
                link.className = `dropdown-item ${session.id === activeId ? 'active' : ''}`;
            } else {
                link.className = `btn btn-sm btn-outline-secondary mb-1 me-1 ${session.id === activeId ? 'active' : ''}`;
            }
            link.href = "#";
            link.textContent = session.name;
            link.dataset.sessionId = session.id;
            link.addEventListener('click', (e) => {
                if (!stopFlag) return;
                e.preventDefault();
                const targetSessionId = parseInt(e.currentTarget.dataset.sessionId, 10);
                if (targetSessionId !== activeId) {
                    loadChatHistory(ccId || "0", targetSessionId);
                }
            });
            return link;
        }

        // Initially enable wrapping to detect overflow
        chatRecordsDiv.style.flexWrap = "wrap";
        chatRecordsDiv.style.height = "auto";

        sessionsArray.forEach(session => {
            chatRecordsDiv.appendChild(createSessionButton(session, activeSessionId));
        });

        // Use a microtask to measure
        setTimeout(() => {
            const buttons = Array.from(chatRecordsDiv.children);
            if (buttons.length === 0) return;

            const firstBtnTop = buttons[0].offsetTop;
            let overflowIndex = -1;

            // Check which button starts a new line
            for (let i = 1; i < buttons.length; i++) {
                if (buttons[i].offsetTop > firstBtnTop) {
                    overflowIndex = i;
                    break;
                }
            }

            if (overflowIndex !== -1) {
                if (moreRecordsDropdown) {
                    moreRecordsDropdown.style.display = "block";
                    // If the dropdown itself now wraps, move the previous button too
                    if (moreRecordsDropdown.offsetTop > firstBtnTop && overflowIndex > 0) {
                        overflowIndex--;
                    }
                }

                // Move buttons from overflowIndex onwards to dropdown
                const toMove = sessionsArray.slice(overflowIndex);
                // Remove buttons from DOM
                for (let i = buttons.length - 1; i >= overflowIndex; i--) {
                    chatRecordsDiv.removeChild(buttons[i]);
                }
                // Add to dropdown
                toMove.forEach(session => {
                    const li = document.createElement("li");
                    li.appendChild(createSessionButton(session, activeSessionId, true));
                    moreRecordsList.appendChild(li);
                });
            }

            // Finally disable wrapping to keep them in one line
            chatRecordsDiv.style.flexWrap = "nowrap";
            chatRecordsDiv.style.height = "";
        }, 50); // Increased timeout slightly to ensure more reliable offsetTop measurement
    }

    function setAllFilesActivation(isActive) {
        historyMessages.forEach(msg => {
            if (msg.fileInfo) {
                msg.fileInfo.send = isActive;
            }
        });

        const messageElements = messagesContainer.querySelectorAll('.message');
        messageElements.forEach(msgElement => {
            const timestamp = parseInt(msgElement.dataset.timestamp, 10);
            const messageRecord = historyMessages.find(record => record.rtime === timestamp);
            if (messageRecord?.fileInfo) {
                const activateBtn = msgElement.querySelector('.activate-message-btn');
                if (activateBtn) {
                    activateBtn.textContent = isActive ? '☑' : '◻';
                }
            }
        });
    }

    function saveCurrentSession() {
        const currentScenario = ccId || "0";
        const storageKey = `chatHistory_${currentScenario}`;

        browser.storage.local.get(storageKey, async (data) => {
            let scenarioData = data[storageKey];
            if (!scenarioData?.history) {
                scenarioData = {
                    currentId: scenarioData?.currentId ?? 0,
                    history: []
                };
                if (!scenarioData.history.some(s => s.id === scenarioData.currentId)) {
                    const defaultSessionName = scenarioData.currentId === 0
                        ? (browser.i18n.getMessage("defaultChatName") || "00")
                        : "Session " + scenarioData.currentId;
                    scenarioData.history.push({ id: scenarioData.currentId, name: defaultSessionName, records: [] });
                }
            }

            const currentIndex = scenarioData.history.findIndex(
                session => session.id === scenarioData.currentId
            );
            if (currentIndex !== -1) {
                scenarioData.history[currentIndex].records = [...historyMessages];
            } else {
                const sessionName = scenarioData.currentId === 0
                    ? (browser.i18n.getMessage("defaultChatName") || "00")
                    : "Session " + scenarioData.currentId;
                scenarioData.history.push({
                    id: scenarioData.currentId,
                    name: sessionName,
                    records: [...historyMessages]
                });
                updateChatRecordsList(scenarioData.history, scenarioData.currentId);
            }
            await browser.storage.local.set({ [storageKey]: scenarioData });
        });
    }

    function checkAndShowSampleMessage(scenarioId, sessionId) {
        const activeChatType = ccId || "0";
        if (activeChatType !== "0" && currentConfigurations.length > 0) {
            const config = currentConfigurations.find(c => String(c.id) === activeChatType);
            if (config?.sample && historyMessages.length === 0) {
                // The sample is a dismissible hint: closed once per scenario +
                // session, it stays closed until the page is reloaded.
                showSampleMessage(config.sample, `${activeChatType}:${sessionId ?? 0}`);
            }
        }
    }

    async function confirmDialog(messageText) {
        return new Promise((resolve) => {
            resolve(window.confirm(messageText));
        });
    }

    async function saveFishIconState(isActive) {
        const storageKey = `${DB_KEY.fishIconActive}_${ccId || "0"}`;
        await browser.storage.local.set({ [storageKey]: isActive });
        historyMemory = !isActive;
    }

    async function loadFishIconState() {
        const storageKey = `${DB_KEY.fishIconActive}_${ccId || "0"}`;
        browser.storage.local.get(storageKey, function(result) {
            const isActive = result[storageKey] || false;
            if (bFish) {
                bFish.classList.toggle('active-fish', isActive);
            }
            historyMemory = !isActive;
        });
    }

    i18n();

    browser.storage.local.get(DB_KEY.apiConfig, function(result) {
        apiSettings = result[DB_KEY.apiConfig] || {
            temperature: 0.7,
            top_p: 0.9,
            think: false
        };
    });

    initializeApiSettingsPopover();

    function initializeApiSettingsPopover() {
        const apiSettingsBtn = document.getElementById("b_apiSettings");
        const popoverTemplate = `
        <div style="min-width: 250px;">
        <form id="api-settings-form-popover">
          <div class="mb-4">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <label for="temperatureInputPopover" class="form-label mb-0">${browser.i18n.getMessage("apiSettingsCreativityLabel")}</label>
              <span class="badge bg-primary rounded-pill" id="temperatureValueDisplayPopover">1.0</span>
            </div>
            <input type="range" class="form-range" id="temperatureInputPopover" step="0.1" min="0" max="2">
            <div class="text-muted small mt-1">${browser.i18n.getMessage("apiSettingsCreativityDesc")}</div>
          </div>
          <div class="mb-4">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <label for="topPInputPopover" class="form-label mb-0">${browser.i18n.getMessage("apiSettingsFocusLabel")}</label>
              <span class="badge bg-primary rounded-pill" id="topPValueDisplayPopover">1.0</span>
            </div>
            <input type="range" class="form-range" id="topPInputPopover" step="0.1" min="0" max="1">
            <div class="text-muted small mt-1">${browser.i18n.getMessage("apiSettingsFocusDesc")}</div>
          </div>
          <div class="mb-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="thinkModeTogglePopover">
              <label class="form-check-label" for="thinkModeTogglePopover">${browser.i18n.getMessage("thinkModeLabel")}</label>
            </div>
            <div class="text-muted small mt-1">${browser.i18n.getMessage("thinkModeDesc")}</div>
          </div>
          <div class="d-flex justify-content-end">
            <button type="button" class="btn btn-sm btn-secondary me-2" id="resetApiSettingsBtnPopover">${browser.i18n.getMessage("apiSettingsResetButton")}</button>
            <button type="button" class="btn btn-primary btn-sm" id="saveApiSettingsBtnPopover">${browser.i18n.getMessage("apiSettingsSaveButton")}</button>
          </div>
        </form>
        </div>`;

        if (!apiSettingsBtn) return;

        apiSettingsPopover = new bootstrap.Popover(apiSettingsBtn, {
            content: popoverTemplate,
            html: true,
            sanitize: false,
            placement: 'top',
            trigger: 'click focus',
        });

        apiSettingsBtn.addEventListener('shown.bs.popover', () => {
            const popoverBody = document.querySelector('.popover-body');
            if (!popoverBody) return;

            const tempInput = popoverBody.querySelector('#temperatureInputPopover');
            const tempValueDisplay = popoverBody.querySelector('#temperatureValueDisplayPopover');
            const topPIn = popoverBody.querySelector('#topPInputPopover');
            const topPValueDisplay = popoverBody.querySelector('#topPValueDisplayPopover');
            const thinkModeToggle = popoverBody.querySelector('#thinkModeTogglePopover');
            const saveBtn = popoverBody.querySelector('#saveApiSettingsBtnPopover');
            const resetBtn = popoverBody.querySelector('#resetApiSettingsBtnPopover');

            if (tempInput && tempValueDisplay) {
                tempInput.value = apiSettings.temperature;
                tempValueDisplay.textContent = parseFloat(tempInput.value).toFixed(1);
                tempInput.addEventListener('input', () => 
                    tempValueDisplay.textContent = parseFloat(tempInput.value).toFixed(1)
                );
            }

            if (topPIn && topPValueDisplay) {
                topPIn.value = apiSettings.top_p;
                topPValueDisplay.textContent = parseFloat(topPIn.value).toFixed(1);
                topPIn.addEventListener('input', () => 
                    topPValueDisplay.textContent = parseFloat(topPIn.value).toFixed(1)
                );
            }

            if (thinkModeToggle) {
                thinkModeToggle.checked = apiSettings.think;
            }

            if (saveBtn) saveBtn.addEventListener('click', saveApiSettingsFromPopover);
            if (resetBtn) resetBtn.addEventListener('click', resetAndSaveApiSettingsInPopover);
        });

        document.body.addEventListener('click', (event) => {
            const popoverElement = document.querySelector('.popover');
            if (popoverElement && 
                !popoverElement.contains(event.target) && 
                !apiSettingsBtn.contains(event.target)) {
                apiSettingsPopover?.hide();
            }
        });
    }

    function saveApiSettingsFromPopover() {
        const popoverBody = document.querySelector('.popover-body');
        if (!popoverBody) return;

        const tempInput = popoverBody.querySelector("#temperatureInputPopover");
        const topPInput = popoverBody.querySelector("#topPInputPopover");
        const thinkModeToggle = popoverBody.querySelector("#thinkModeTogglePopover");

        if (tempInput && topPInput && thinkModeToggle) {
            apiSettings = {
                temperature: parseFloat(tempInput.value),
                top_p: parseFloat(topPInput.value),
                think: thinkModeToggle.checked
            };
            browser.storage.local.set({ [DB_KEY.apiConfig]: apiSettings });
            apiSettingsPopover?.hide();
        }
    }

    async function resetAndSaveApiSettingsInPopover() {
        const defaultSettings = {
            temperature: 0.7,
            top_p: 0.9,
            think: false
        };
        apiSettings = { ...defaultSettings };

        const popoverBody = document.querySelector('.popover-body');
        if (popoverBody) {
            const tempInput = popoverBody.querySelector('#temperatureInputPopover');
            const tempValueDisplay = popoverBody.querySelector('#temperatureValueDisplayPopover');
            const topPIn = popoverBody.querySelector('#topPInputPopover');
            const topPValueDisplay = popoverBody.querySelector('#topPValueDisplayPopover');
            const thinkModeToggle = popoverBody.querySelector('#thinkModeTogglePopover');

            if (tempInput && tempValueDisplay) {
                tempInput.value = defaultSettings.temperature;
                tempValueDisplay.textContent = parseFloat(tempInput.value).toFixed(1);
            }
            if (topPIn && topPValueDisplay) {
                topPIn.value = defaultSettings.top_p;
                topPValueDisplay.textContent = parseFloat(topPIn.value).toFixed(1);
            }
            if (thinkModeToggle) {
                thinkModeToggle.checked = defaultSettings.think;
            }
        }
        browser.storage.local.set({ [DB_KEY.apiConfig]: apiSettings });
    }

    /**
     * Rebuild the scenario dropdown (chat category) from currentConfigurations,
     * keeping the scenario that is currently selected.
     */
    function renderChatCategory() {
        if (!chatCategory) return;
        // Which scenario must stay selected: the one in the URL always wins (a
        // fresh page load after switching scenarios), otherwise the current valid
        // selection, otherwise the default. The placeholder option in chat.html
        // carries no real value, so an unmatched value must never be trusted —
        // that would silently leave the browser's first option displayed.
        const current = String(chatCategory.value || '');
        const known = Array.from(chatCategory.options).some(o => o.value === current);
        const fromUrl = (ccId !== null && ccId !== undefined && ccId !== '') ? String(ccId) : null;
        const selected = fromUrl !== null ? fromUrl : (known && current ? current : "0");

        chatCategory.options.length = 0;
        chatCategory.options.add(new Option(browser.i18n.getMessage("chatOnly"), "0"));
        currentConfigurations.forEach(item => {
            chatCategory.options.add(new Option(item.name, String(item.id)));
        });
        // Assign the value once every option exists: the browser then shows the
        // matching entry (an unknown value leaves the first option selected).
        chatCategory.value = selected;
    }

    async function loadInitialConfigurations() {
        return new Promise((resolve) => {
            browser.storage.local.get(DB_KEY.chatTpaList, (sysp) => {
                currentConfigurations = sysp[DB_KEY.chatTpaList] || [{
                    id: 1,
                    name: browser.i18n.getMessage("directorExample1_name"),
                    prompt: browser.i18n.getMessage("directorExample1_prompt"),
                    sample: browser.i18n.getMessage("directorExample1_sample")
                }];

                if (!sysp[DB_KEY.chatTpaList] && currentConfigurations.length > 0) {
                    browser.storage.local.set({ [DB_KEY.chatTpaList]: currentConfigurations });
                }

                renderChatCategory();
                resolve();
            });
        });
    }

    /**
     * React to scenario changes made while this page stays open — typically the
     * model saving one through save_chat_scenario (see the "Scenario Builder"
     * default Skill) — so the dropdown updates without a reload.
     * @param {Object} changes - Storage change payload
     * @param {string} area - Storage area name
     */
    function handleScenarioStorageChange(changes, area) {
        if (area !== 'local' || !changes[DB_KEY.chatTpaList]) return;
        browser.storage.local.get(DB_KEY.chatTpaList, (sysp) => {
            currentConfigurations = sysp[DB_KEY.chatTpaList] || [];
            renderChatCategory();
        });
    }

    await loadInitialConfigurations();

    const initialScenarioId = ccId || "0";
    const initialStorageKey = `chatHistory_${initialScenarioId}`;

    const loadHistory = () => {
        return new Promise((resolve) => {
            browser.storage.local.get(initialStorageKey, async (data) => {
                let scenarioData = data[initialStorageKey];
                if (!scenarioData?.history?.length) {
                    scenarioData = {
                        currentId: 0,
                        history: [{ id: 0, name: browser.i18n.getMessage("defaultChatName") || "00", records: [] }]
                    };
                    await browser.storage.local.set({ [initialStorageKey]: scenarioData });
                }

                if (!scenarioData.history.some(s => s.id === scenarioData.currentId)) {
                    scenarioData.currentId = scenarioData.history[0]?.id ?? 0;
                }

                await loadChatHistory(initialScenarioId, scenarioData.currentId);
                updateChatRecordsList(scenarioData.history, scenarioData.currentId);
                updateResendButtonVisibility();
                resolve();
            });
        });
    };

    await loadHistory();
    await initializeModelSelection();

    /**
     * Populate the model dropdown for a given data source configuration
     * @param {Object} dsConfig - The data source config { service, apiUrl, apiKey, modelName }
     */
    async function populateModelList(dsConfig) {
        const modelListDiv = document.getElementById("modelList");
        const currentModelDisplay = document.getElementById("modelDropdown");
        if (modelListDiv) modelListDiv.textContent = "";

        if (!dsConfig || !dsConfig.apiUrl) {
            if (currentModelDisplay) currentModelDisplay.textContent = "--";
            return;
        }

        try {
            const serviceInstance = getService(
                dsConfig.service,
                dsConfig.apiUrl,
                dsConfig.apiKey
            );
            const models = await serviceInstance.getModels();

            // Use current modelName if present in the list, otherwise use the first model
            if (models.length > 0) {
                if (dsConfig.modelName && models.includes(dsConfig.modelName)) {
                    currentModel = dsConfig.modelName;
                } else {
                    currentModel = models[0];
                }
                if (currentModelDisplay) currentModelDisplay.textContent = currentModel;
            } else {
                currentModel = dsConfig.modelName || "";
                if (currentModelDisplay) currentModelDisplay.textContent = currentModel || "--";
            }

            if (modelListDiv) {
                models.forEach(modelName => {
                    const listItem = document.createElement("li");
                    const link = document.createElement("a");
                    link.className = "dropdown-item";
                    link.href = "#";
                    link.textContent = modelName;
                    link.addEventListener("click", (e) => {
                        e.preventDefault();
                        if (currentModelDisplay) currentModelDisplay.textContent = modelName;
                        currentModel = modelName;
                    });
                    listItem.appendChild(link);
                    modelListDiv.appendChild(listItem);
                });
            }
        } catch (error) {
            console.error("Failed to populate model list:", error);
            currentModel = dsConfig.modelName || "";
            if (currentModelDisplay) currentModelDisplay.textContent = currentModel || "Error";
        }
    }

    /**
     * Switch the active data source and refresh the model list
     * @param {Object} dsConfig - The new data source configuration
     */
    async function switchService(dsConfig) {
        if (!dsConfig) return;
        currentServiceConfig = dsConfig;
        setRuntimeConfig(dsConfig);
        await populateModelList(dsConfig);

        const serviceDropdown = document.getElementById("serviceDropdown");
        if (serviceDropdown) serviceDropdown.textContent = dsConfig.service;
    }

    /**
     * Build the service selector dropdown from the dsList
     * @param {Array} dsList - Array of data source configuration objects
     * @param {Object} baseConfig - The base/default configuration
     */
    function buildServiceSelector(dsList, baseConfig) {
        const serviceSelectDiv = document.getElementById("serviceSelectDiv");
        const serviceList = document.getElementById("serviceList");
        if (!serviceSelectDiv || !serviceList) return;

        serviceList.textContent = "";

        // Build a combined list: the base config first, then dsList entries
        const allServices = [baseConfig];
        dsList.forEach(item => {
            // Avoid duplicates with the base config
            if (item.service !== baseConfig.service || item.apiUrl !== baseConfig.apiUrl) {
                allServices.push(item);
            }
        });

        allServices.forEach((dsConfig, index) => {
            const listItem = document.createElement("li");
            const link = document.createElement("a");
            link.className = "dropdown-item";
            link.href = "#";
            link.textContent = dsConfig.service + (dsConfig.apiUrl ? " (" + dsConfig.apiUrl + ")" : "");
            link.addEventListener("click", (e) => {
                e.preventDefault();
                switchService(dsConfig);
            });
            listItem.appendChild(link);
            serviceList.appendChild(listItem);
        });

        serviceSelectDiv.style.display = "";
    }

    async function initializeModelSelection() {
        try {
            const runtimeConfig = await getRuntimeConfig();
            const dsList = runtimeConfig.dsList || [];
            dsListCache = dsList;

            // Build the service selector with the base config and dsList
            const baseConfig = {
                service: runtimeConfig.service,
                apiUrl: runtimeConfig.apiUrl,
                apiKey: runtimeConfig.apiKey,
                modelName: runtimeConfig.modelName
            };
            currentServiceConfig = baseConfig;

            buildServiceSelector(dsList, baseConfig);

            const serviceDropdown = document.getElementById("serviceDropdown");
            if (serviceDropdown) serviceDropdown.textContent = runtimeConfig.service || "N/A";

            if (!runtimeConfig.apiUrl) {
                const guidanceMsg = `${browser.i18n.getMessage("apiConfigGuidance")} <a href="#" class="go-to-config">${browser.i18n.getMessage("goToConfig")}</a>`;
                displayMessage(guidanceMsg, 'system-error-message');
            }

            await populateModelList(baseConfig);

        } catch (error) {
            console.error("Failed to initialize model selection:", error);
            const modelSelectDiv = document.getElementById("modelSelectDiv");
            if (modelSelectDiv) modelSelectDiv.style.display = "";
            const currentModelDisplay = document.getElementById("modelDropdown");
            if (currentModelDisplay) currentModelDisplay.textContent = "Error";
        }

        const modelSelectDiv = document.getElementById("modelSelectDiv");
        if (modelSelectDiv) modelSelectDiv.style.display = "";
    }

    refreshSkills().then(() => renderActiveSkillBar());
    // Keep the Skill list live: the model can create Skills at runtime through
    // the save_skill tool (see the "Page Builder" default Skill).
    browser.storage.onChanged.addListener(handleSkillStorageChange);
    // Same for chat scenarios created through save_chat_scenario.
    browser.storage.onChanged.addListener(handleScenarioStorageChange);
    // Show the pending cards: the clickable option list (ask_user_choice) and
    // the artifact confirmations (propose_artifact). Nothing is imported until
    // the user clicks Import on a card.
    browser.storage.onChanged.addListener(handleArtifactStorageChange);
    // Side-effect confirmation cards: a tool that writes data or calls an
    // external service waits here until the user answers.
    browser.storage.onChanged.addListener(handleToolConfirmStorageChange);
    renderPendingCards();
    loadFishIconState();
});
