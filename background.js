/**
 * Background Service Worker
 * Relays messages between content scripts and the popup.
 */

let tabStatuses = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NGRX_CS_DEVTOOLS_STATUS') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId) {
      tabStatuses[tabId] = message.payload;

      // Update badge
      const count = message.payload.storeCount;
      if (count > 0) {
        chrome.action.setBadgeText({ text: String(count), tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#7B1FA2', tabId });
      } else {
        chrome.action.setBadgeText({ text: '', tabId });
      }
    }
  }

  if (message.type === 'GET_STATUS') {
    const tabId = message.tabId;
    sendResponse(tabStatuses[tabId] || { status: 'inactive', storeCount: 0 });
  }

  return true;
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStatuses[tabId];
});
