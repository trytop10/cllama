import { getService } from '../js/client/client.mjs';
import { chat, i18n, DB_KEY, browser, getRuntimeConfig, abortSession } from '../js/cllama.js';
import { marked } from '../js/marked.mjs';
import { copyToClipboard, thinkCollapseExpanded } from '../js/marked/copy.mjs';
import { exportFile, findMatchingParentNode, formatTimestamp, getQueryParam, replaceElementContent, replaceThinkTags } from '../js/util.js';

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
    
    const ccId = getQueryParam("id");

    // State variables
    let stopFlag = true;
    let historyMessages = [];
    let responseId = null;
    let lastScrollTop = messagesContainer.scrollTop;
    let stopScrollFlag = false;
    let currentModel = "";
    let currentConfigurations = [];
    let apiSettingsPopover;
    let historyMemory = true;

    function generateMsgId(msgId) {
        return `msg_${msgId}`;
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
        const messageContent = msgInput.value.trim();
        const rtime = Date.now();
        if (!messageContent) return;

        const currModelName = currentModel;

        msgInput.value = '';
        appendMessage(messageContent, 'self', rtime);
        historyMessages.push({ role: "user", content: messageContent, rtime });
        updateResendButtonVisibility();

        const assistantMsgBlock = appendMessage("", currModelName, rtime + 1, false);
        const assistantMsgDiv = assistantMsgBlock.querySelector(".message-text");
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

        responseId = chat(messagesForAPI, {
            msgDiv: assistantMsgDiv,
            messages: messagesContainer,
            model: currModelName,
            temperature: apiSettings.temperature,
            top_p: apiSettings.top_p,
            think: apiSettings.think,
            start: () => {
                stopFlag = false;
                setComponentState(true);
            },
            finish: (apiResultMessages) => {
                if (apiResultMessages?.length > 0) {
                    const assistantResponse = apiResultMessages[apiResultMessages.length - 1];
                    if (assistantResponse.role === 'assistant') {
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
        });
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
                if (!stopFlag) return;
                
                const msgTimestamp = parseInt(messageDiv.dataset.timestamp, 10);
                const messageRecord = historyMessages.find(record => record.rtime === msgTimestamp);
                if (messageRecord) {
                    msgInput.value = messageRecord.content;
                    historyMessages = historyMessages.filter(msg => msg.rtime !== msgTimestamp);
                    messageDiv.remove();
                    sendMessage();
                }
            });
        }

        copyBtn.addEventListener('click', async (e) => {
            if (copyBtn.getAttribute("data-flag") === "false") return;
            e.stopPropagation();

            const msgTimestamp = parseInt(messageDiv.dataset.timestamp, 10);
            const messageRecord = historyMessages.find(record => record.rtime === msgTimestamp);

            if (messageRecord) {
                try {
                    await navigator.clipboard.writeText(messageRecord.content);
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
            if (deleteBtn.getAttribute("data-flag") === "false") return;
            e.stopPropagation();

            const confirmed = await confirmDialog(browser.i18n.getMessage("confirmDelete"));
            if (confirmed) {
                const msgTimestamp = parseInt(messageDiv.dataset.timestamp, 10);
                historyMessages = historyMessages.filter(msg => msg.rtime !== msgTimestamp);
                saveCurrentSession();
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

    msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
            // Allow line break
        } else if (e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
        }
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

        if (file.size > 1024 * 1024) {
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
                displayMessage(`${browser.i18n.getMessage("inputSample")} : ${config.sample}`, 'sample-message');
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
              <label class="form-check-label" for="thinkModeTogglePopover">Think Mode</label>
            </div>
            <div class="text-muted small mt-1">Thinking models, Ollama version 0.9 or newer.</div>
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

                chatCategory.options.length = 0;
                chatCategory.options.add(new Option(browser.i18n.getMessage("chatOnly"), "0"));

                currentConfigurations.forEach(item => {
                    const opt = new Option(item.name, String(item.id));
                    if (ccId && String(item.id) === ccId) {
                        opt.selected = true;
                    }
                    chatCategory.options.add(opt);
                });
                resolve();
            });
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

    async function initializeModelSelection() {
        const modelListDiv = document.getElementById("modelList");
        const currentModelDisplay = document.getElementById("modelDropdown");
        if (modelListDiv) modelListDiv.textContent = "";

        try {
            const runtimeConfig = await getRuntimeConfig();
            if (currentModelDisplay) currentModelDisplay.textContent = runtimeConfig.modelName;

            const modelServerDisplay = document.getElementById("modelServer");
            if (modelServerDisplay) modelServerDisplay.textContent = runtimeConfig.service || "N/A";
            currentModel = runtimeConfig.modelName;

            if (!runtimeConfig.apiUrl) {
                const guidanceMsg = `${browser.i18n.getMessage("apiConfigGuidance")} <a href="#" class="go-to-config">${browser.i18n.getMessage("goToConfig")}</a>`;
                displayMessage(guidanceMsg, 'system-error-message');
                return;
            }

            const serviceInstance = getService(
                runtimeConfig.service,
                runtimeConfig.apiUrl,
                runtimeConfig.apiKey
            );
            const models = await serviceInstance.getModels();

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
            console.error("Failed to initialize model list:", error);
            if (currentModelDisplay) currentModelDisplay.textContent = "Error";
            const modelServerDisplay = document.getElementById("modelServer");
            if (modelServerDisplay) modelServerDisplay.textContent = "N/A";
        }

        const modelSelectDiv = document.getElementById("modelSelectDiv");
        if (modelSelectDiv) modelSelectDiv.style.display = "";
    }

    loadFishIconState();
});
