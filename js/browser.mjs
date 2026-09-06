// js/browser.mjs — Single source of truth for the extension API namespace and Firefox detection.
// Zero-dependency "leaf" module: do NOT import anything else here.
//
// Firefox vs Chrome is detected via the user agent. We must NOT use the presence of
// `globalThis.browser` to decide, because modern Chrome (MV3) also injects a `browser`
// namespace, and whether `chrome` exists on Firefox MV2 varies by context/plugin shims.
//
// Firefox: native Promise-based `browser` global is used. Chrome: canonical `chrome`.
// Callers doing Promise-style `await` should work on Firefox (native browser returns
// Promises) and on Chrome (chrome.* supports Promises in MV3).
const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.indexOf('Firefox') >= 0;

// Firefox: native Promise-based `browser`. Chrome (any MV): canonical `chrome`.
const browser = isFirefox
  ? (typeof globalThis !== 'undefined' && globalThis.browser && globalThis.browser.storage
      ? globalThis.browser
      : (typeof chrome !== 'undefined' ? chrome : null))
  : (typeof chrome !== 'undefined' ? chrome
      : (typeof globalThis !== 'undefined' && globalThis.browser && globalThis.browser.storage
          ? globalThis.browser : null));

export { browser, isFirefox };
export default browser;
