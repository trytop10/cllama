(function() {
    const EXTENSION_ROOT_ID = 'gemini-extension-root';
    const EXCLUDED_HOSTNAMES = ['fxdq.net'];
    const DRAG_THRESHOLD = 5;
    const TOUCH_DELAY = 200;
    const MAX_CONTENT_LENGTH = 5000;
    
    const isFirefox = navigator.userAgent.indexOf('Firefox') >= 0;

    // Prevent duplicate injection
    if (document.getElementById(EXTENSION_ROOT_ID)) return;
    if (EXCLUDED_HOSTNAMES.includes(window.location.hostname)) return;

    /**
     * Send message to background script with browser-specific handling
     */
    function sendMessageToBackground(message) {
        return new Promise((resolve, reject) => {
            if (isFirefox) {
                browser.runtime.sendMessage(message)
                    .then(resolve)
                    .catch(reject);
            } else {
                browser.runtime.sendMessage(message, response => {
                    if (browser.runtime.lastError) {
                        reject(browser.runtime.lastError);
                    } else {
                        resolve(response);
                    }
                });
            }
        });
    }

    /**
     * Listen for messages from the web page
     */
    window.addEventListener("message", (event) => {
        if (event.source !== window) return;

        const { type, payload } = event.data;

        if (type === "callImportInsightPrompt" || type === "callImportAIdirPrompt") {
            browser.runtime.sendMessage(
                {
                    action: type,
                    data: payload
                },
                (response) => {
                    window.postMessage(
                        {
                            type: "EXTENSION_RESPONSE",
                            payload: response
                        },
                        "*"
                    );
                }
            );
        }
    });

    /**
     * Listen for messages from background script
     */
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "process-insight-stream") {
            const { msgId, content } = request;
            const root = document.getElementById(EXTENSION_ROOT_ID);
            if (root) {
                const targetElement = root.shadowRoot.querySelector(`#${msgId}`);
                if (targetElement) {
                    targetElement.innerHTML = content.replace(/\n/g, '<br>');
                }
            }
        }
        return true;
    });

    // ================= UI Setup =================
    
    let host, shadow, container, wrapper, fab, menu, panel;

    function initializeUI() {
        if (document.getElementById(EXTENSION_ROOT_ID)) return;

        host = document.createElement('div');
        host.id = EXTENSION_ROOT_ID;
        document.body.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });

        injectStylesheets(shadow);
        const ui = createUIElements(shadow);
        container = ui.container;
        wrapper = ui.wrapper;
        fab = ui.fab;
        menu = ui.menu;
        panel = ui.panel;
        
        setupInteraction();
        
        // Restore FAB position from storage
        browser.storage.local.get(['fabPosition'], (result) => {
            if (result.fabPosition) {
                container.style.top = result.fabPosition.top;
                container.style.left = result.fabPosition.left;
                container.style.right = 'auto';
                container.style.bottom = 'auto';
            }
        });
    }

    // ================= State Management =================
    
    const state = {
        isMenuOpen: false,
        isDragging: false,
        touchTimer: null,
        dragState: {
            startX: 0,
            startY: 0,
            initialLeft: 0,
            initialTop: 0
        }
    };

    /**
     * Inject CSS stylesheets into shadow DOM
     */
    function injectStylesheets(shadow) {
        const stylesheets = ['/css/android.css', '/css/cllama.css', '/css/github-markdown-dark.css'];
        
        stylesheets.forEach(styleUrl => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = browser.runtime.getURL(styleUrl);
            shadow.appendChild(link);
        });
    }

    /**
     * Create all UI elements
     */
    function createUIElements(shadow) {
        const container = document.createElement('div');
        container.className = 'fab-container';

        const wrapper = document.createElement('div');
        wrapper.className = 'fab-wrapper';

        const fab = createFAB();
        const closeBtn = createCloseButton(host);
        const menu = createMenu();
        const panel = createPanel();

        wrapper.appendChild(closeBtn);
        wrapper.appendChild(fab);
        wrapper.appendChild(menu);
        container.appendChild(wrapper);
        
        shadow.appendChild(panel);
        shadow.appendChild(container);

        return { container, wrapper, fab, menu, panel };
    }

    /**
     * Create floating action button
     */
    function createFAB() {
        const fab = document.createElement('div');
        fab.className = 'fab';
        fab.innerHTML = `<img src="${browser.runtime.getURL('/logo/36.png')}" alt="Extension Logo" width="36" height="36">`;
        return fab;
    }

    /**
     * Create close button
     */
    function createCloseButton(host) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'close-plugin-btn';
        closeBtn.innerHTML = '×';
        closeBtn.title = 'Close';
        
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            host.remove();
        });
        
        closeBtn.addEventListener('touchend', (e) => {
            e.stopPropagation();
        });
        
        return closeBtn;
    }

    /**
     * Create menu with action buttons
     */
    function createMenu() {
        const menu = document.createElement('div');
        menu.className = 'menu';

        browser.storage.local.get('actionList', (actions) => {
            let actionDataList = actions['actionList'];
            
            if (!actionDataList?.length) {
                actionDataList = [{
                    id: 1,
                    name: browser.i18n.getMessage("summarizer"),
                    prompt: browser.i18n.getMessage("summaryPrompt")
                        .replaceAll("{localLanguage}", browser.i18n.getMessage("localLanguage"))
                }];
            }

            // Insight list button
            const insightListBtn = createMenuButton(
                'btn-insight-list',
                `📑 ${browser.i18n.getMessage('Insightify')}`,
                () => sendMessageToBackground({
                    action: 'openNewPage',
                    url: 'insightify/insightify.html'
                })
            );
            menu.appendChild(insightListBtn);

            // Dynamic action buttons
            actionDataList.forEach((item) => {
                const btn = createMenuButton(
                    `btn-action-${item.id}`,
                    `╰ ${item.name}`,
                    () => openPanel('analysis', { prompt: item.prompt, name: item.name })
                );
                menu.appendChild(btn);
            });

            // Chat button
            const chatBtn = createMenuButton(
                'btn-chat',
                `💬 ${browser.i18n.getMessage('chat')}`,
                () => sendMessageToBackground({
                    action: 'openNewPage',
                    url: '/chat/chat.html'
                })
            );
            menu.appendChild(chatBtn);

            // Settings button
            const settingsBtn = createMenuButton(
                'btn-settings',
                `⚙️ ${browser.i18n.getMessage('settings')}`,
                () => sendMessageToBackground({ action: 'openOptionsPage' })
            );
            menu.appendChild(settingsBtn);
        });

        return menu;
    }

    /**
     * Create individual menu button with event handlers
     */
    function createMenuButton(id, text, action) {
        const button = document.createElement('button');
        button.className = 'menu-btn';
        button.id = id;
        button.innerHTML = text;

        const handler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            action();
            toggleMenu(false);
        };

        button.addEventListener('click', handler);
        button.addEventListener('touchend', handler);

        return button;
    }

    /**
     * Create content display panel
     */
    function createPanel() {
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span id="panel-title">${browser.i18n.getMessage('Insightify')}</span>
                <button class="panel-close-btn" title="Close Panel">×</button>
            </div>
            <div class="panel-content markdown-body" id="panel-body"></div>
        `;

        const closeBtn = panel.querySelector('.panel-close-btn');
        closeBtn.onclick = () => panel.classList.remove('visible');

        return panel;
    }

    // ================= Interaction Logic =================

    function setupInteraction() {
        wrapper.addEventListener('touchstart', onTouchStart, { passive: true });
    }

    /**
     * Handle touch start event
     */
    function onTouchStart(e) {
        if (e.target.closest('.close-plugin-btn')) return;

        state.isDragging = false;
        const touch = e.touches[0];
        state.dragState.startX = touch.clientX;
        state.dragState.startY = touch.clientY;
        
        const rect = container.getBoundingClientRect();
        state.dragState.initialLeft = rect.left;
        state.dragState.initialTop = rect.top;

        state.touchTimer = setTimeout(() => {
            state.touchTimer = null;
        }, TOUCH_DELAY);

        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    }

    /**
     * Handle touch move event
     */
    function onTouchMove(e) {
        if (state.touchTimer) {
            clearTimeout(state.touchTimer);
            state.touchTimer = null;
        }

        const touch = e.touches[0];
        const deltaX = touch.clientX - state.dragState.startX;
        const deltaY = touch.clientY - state.dragState.startY;

        if (state.isDragging || Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD) {
            state.isDragging = true;
            if (e.cancelable) e.preventDefault();

            const rect = container.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width;
            const maxY = window.innerHeight - rect.height;

            let newLeft = state.dragState.initialLeft + deltaX;
            let newTop = state.dragState.initialTop + deltaY;

            // Constrain within viewport
            newLeft = Math.max(0, Math.min(newLeft, maxX));
            newTop = Math.max(0, Math.min(newTop, maxY));

            container.style.left = `${newLeft}px`;
            container.style.top = `${newTop}px`;
            container.style.right = 'auto';
            container.style.bottom = 'auto';
        }
    }

    /**
     * Handle touch end event
     */
    function onTouchEnd() {
        if (state.touchTimer) {
            clearTimeout(state.touchTimer);
            state.touchTimer = null;
            if (!state.isDragging) {
                toggleMenu();
            }
        }

        if (state.isDragging) {
            browser.storage.local.set({
                fabPosition: {
                    top: container.style.top,
                    left: container.style.left,
                }
            });
        }

        state.isDragging = false;
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
    }

    /**
     * Toggle menu visibility
     */
    function toggleMenu(forceState) {
        if (typeof forceState === 'boolean') {
            state.isMenuOpen = forceState;
        } else {
            state.isMenuOpen = !state.isMenuOpen;
        }

        if (state.isMenuOpen) {
            positionMenu();
            menu.classList.add('visible');
            container.classList.add('menu-open');
        } else {
            menu.classList.remove('visible');
            container.classList.remove('menu-open');
        }
    }

    /**
     * Position menu based on FAB location in viewport
     */
    function positionMenu() {
        const rect = container.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Horizontal alignment
        if (rect.left + rect.width / 2 < viewportWidth / 2) {
            container.classList.add('menu-on-right');
        } else {
            container.classList.remove('menu-on-right');
        }

        // Vertical alignment
        container.classList.remove('menu-align-top', 'menu-align-bottom');
        if (rect.top < viewportHeight / 3) {
            container.classList.add('menu-align-top');
        } else if (rect.bottom > viewportHeight * 2 / 3) {
            container.classList.add('menu-align-bottom');
        }
    }

    /**
     * Open panel with specified mode and action
     */
    function openPanel(mode, action) {
        const panelTitle = panel.querySelector('#panel-title');
        const panelBody = panel.querySelector('#panel-body');
        
        panel.classList.add('visible');
        toggleMenu(false);
        panelBody.innerHTML = '';

        if (mode === 'analysis') {
            panelTitle.textContent = action.name || browser.i18n.getMessage('Insightify');
            runAnalysis(action.prompt, panelTitle, panelBody);
        }
    }

    /**
     * Extract page content using Readability.js
     */
    function extractContent() {
        try {
            const documentClone = document.cloneNode(true);
            const reader = new Readability(documentClone);
            const article = reader.parse();

            if (article && article.textContent && article.textContent.trim().length > 0) {
                return article.textContent.trim();
            }
        } catch (e) {
            console.error("Readability parsing failed:", e);
        }
        return null;
    }

    /**
     * Run analysis on current page content
     */
    async function runAnalysis(prompt, panelTitle, panelBody) {
        const msgId = `msg_${Date.now()}`;
        panelBody.innerHTML = `<div id="${msgId}">${browser.i18n.getMessage('waitMessage')}</div>`;

        // Try Readability first, fallback to body.innerText
        let content = extractContent();
        if (!content) {
            console.warn("Readability extraction failed, falling back to body.innerText");
            content = document.body.innerText;
        }

        const doc = {
            title: `${panelTitle.textContent}:${document.title}`,
            content: content.substring(0, MAX_CONTENT_LENGTH),
            url: window.location.href
        };

        try {
            await sendMessageToBackground({
                action: 'process-insight',
                prompt: prompt,
                doc: doc,
                msgId: msgId
            });
        } catch (err) {
            const errorDiv = panel.querySelector(`#${msgId}`);
            if (errorDiv) {
                errorDiv.innerHTML = `Error: ${err.message}`;
            }
        }
    }

    // Delay initialization until the page is fully loaded
    if (document.readyState === 'complete') {
        initializeUI();
    } else {
        window.addEventListener('load', initializeUI);
    }

})();
