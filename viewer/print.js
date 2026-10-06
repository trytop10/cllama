// viewer/print.js — Turns an exported document into a PDF the simple way: it
// replaces this page with the export and opens the browser's own print dialog,
// where "Save as PDF" is just another printer.
//
// The chat page (js/util.js openPrintView) stores the document under
// `pendingPrintHtml` *before* creating this tab, so no message round-trip and
// no tab-id dance is needed, and documents larger than a comfortable data URL
// are fine.
//
// This page is an extension page (never web-accessible) and it renders the
// document with document.write, so nothing from the export is executed as
// script: the exported HTML carries no script by design.
//
// NOTE: it is a module on purpose — the `browser` namespace comes from
// js/browser.mjs (the single source of truth). Picking the API by hand here is
// what made an earlier version print "Nothing to print." on Firefox: Firefox
// MV2 also exposes `chrome`, but that namespace is callback-based, so
// `await chrome.storage.local.get(key)` silently yields undefined.
import { browser } from '../js/browser.mjs';

const PRINT_STORAGE_KEY = 'pendingPrintHtml';

/** Time to let the freshly written document lay out before printing. */
const PRINT_DELAY_MS = 300;
/** Reads of the handover: the first one normally hits, the rest cover a race. */
const PRINT_READ_ATTEMPTS = 3;
const PRINT_READ_RETRY_MS = 150;

/** Promise-based sleep. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the document the chat page handed over for printing.
 * @returns {Promise<Object|null>} `{ htmlString, title }`, or null when absent
 */
async function readPendingDocument() {
  for (let attempt = 0; attempt < PRINT_READ_ATTEMPTS; attempt++) {
    try {
      const data = await browser.storage.local.get(PRINT_STORAGE_KEY);
      const payload = data?.[PRINT_STORAGE_KEY];
      if (payload?.htmlString) return payload;
    } catch (e) {
      console.error('Failed to read the document to print:', e);
      return null;
    }
    if (attempt < PRINT_READ_ATTEMPTS - 1) await sleep(PRINT_READ_RETRY_MS);
  }
  return null;
}

async function printDocument() {
  if (!browser?.storage?.local) {
    document.body.textContent = 'Printing is only available inside the extension.';
    return;
  }

  const payload = await readPendingDocument();

  // The handover is one-shot: never leave it behind for the next tab.
  browser.storage.local.remove(PRINT_STORAGE_KEY);

  if (!payload) {
    document.body.textContent = 'Nothing to print.';
    return;
  }

  document.title = payload.title || 'cllama';
  document.open();
  document.write(payload.htmlString);
  document.close();

  setTimeout(() => window.print(), PRINT_DELAY_MS);
}

printDocument().catch((e) => {
  console.error('Failed to prepare the document for printing:', e);
  document.body.textContent = 'Failed to prepare the document for printing.';
});

