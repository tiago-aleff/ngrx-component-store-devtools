/**
 * Content Script
 * Injects the page-level script that patches ComponentStore.
 * This runs in the content script context but injects into the page context
 * so it can access the Angular/ngrx runtime.
 */
(function () {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject/patch-component-store.js');
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
})();

/**
 * Listen for messages from the injected script to relay store info to popup.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data && event.data.type === 'NGRX_CS_DEVTOOLS_STATUS') {
    chrome.runtime.sendMessage(event.data);
  }
});
