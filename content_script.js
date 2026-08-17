const browser = (typeof chrome !== 'undefined') ? chrome : (typeof browser !== 'undefined') ? browser : null;

/**
 * Extract page content using Readability.js
 */
function extractContentWithReadability() {
    try {
        const documentClone = document.cloneNode(true);
        const reader = new Readability(documentClone);
        const article = reader.parse();

        if (article && article.textContent && article.textContent.trim().length > 0) {
            return {
                title: article.title || document.title,
                content: article.textContent.trim()
            };
        }
    } catch (e) {
        console.error("Readability parsing failed:", e);
    }
    return null;
}

/**
 * Extract page content based on custom CSS selectors, or use Readability as fallback
 */
function getPageInfo() {
    return new Promise((resolve) => {
        const url = window.location.href;

        browser.storage.local.get("urls", (urlsResult) => {
            const configurations = urlsResult.urls || [];

            // Check if there's a matching CSS selector configuration
            for (const item of configurations) {
                if (url.startsWith(item.url)) {
                    let content = "";
                    const elements = document.body.querySelectorAll(item.cssSelector);

                    elements.forEach((element) => {
                        content += element.innerText + " ";
                    });

                    if (content.trim().length > 0) {
                        resolve({
                            title: document.title,
                            content,
                            url
                        });
                        return;
                    }

                    console.error(`No content found with CSS selector [${item.cssSelector}], falling back to Readability`);
                    break;
                }
            }

            // No CSS selector configured or selector found nothing — use Readability
            const readabilityResult = extractContentWithReadability();
            if (readabilityResult) {
                resolve({
                    title: readabilityResult.title,
                    content: readabilityResult.content,
                    url
                });
                return;
            }

            // Ultimate fallback to full body text
            console.warn("Readability extraction failed or returned empty, falling back to body.innerText");
            resolve({
                title: document.title,
                content: document.body.innerText,
                url
            });
        });
    });
}

/**
 * Handle page info request with browser-specific response
 */
function handlePageInfoRequest(sendResponse) {
    getPageInfo()
        .then(data => sendResponse(data))
        .catch(error => sendResponse({ success: false, error: error.toString() }));
    return true; // Keep channel open for async response
}

/**
 * Message listener for extension commands
 */
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case "getPageInfo":
            return handlePageInfoRequest(sendResponse);
    }
});

/**
 * Listen for messages from page scripts
 */
window.addEventListener("message", (event) => {
    // Only accept messages from same window
    if (event.source !== window) return;

    const { type, payload } = event.data;

    // Handle import requests from page
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
