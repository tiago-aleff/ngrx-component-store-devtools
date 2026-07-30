/**
 * Popup script - queries the background for current tab status.
 */
(function () {
  const devtoolsDot = document.getElementById('devtools-dot');
  const devtoolsStatus = document.getElementById('devtools-status');
  const extDot = document.getElementById('ext-dot');
  const extStatus = document.getElementById('ext-status');
  const storeCountEl = document.getElementById('store-count');

  function updateUI(payload) {
    const { status, storeCount } = payload;

    // Store count
    storeCountEl.textContent = storeCount || '0';

    // Extension status
    switch (status) {
      case 'connected':
        extDot.className = 'status-dot active';
        extStatus.textContent = 'Active';
        devtoolsDot.className = 'status-dot active';
        devtoolsStatus.textContent = 'Detected';
        break;
      case 'scanning':
        extDot.className = 'status-dot scanning';
        extStatus.textContent = 'Scanning...';
        devtoolsDot.className = 'status-dot active';
        devtoolsStatus.textContent = 'Detected';
        break;
      case 'no_devtools':
        extDot.className = 'status-dot error';
        extStatus.textContent = 'Waiting';
        devtoolsDot.className = 'status-dot error';
        devtoolsStatus.textContent = 'Not Found';
        break;
      case 'no_stores_found':
        extDot.className = 'status-dot inactive';
        extStatus.textContent = 'No stores found';
        devtoolsDot.className = 'status-dot active';
        devtoolsStatus.textContent = 'Detected';
        break;
      default:
        extDot.className = 'status-dot inactive';
        extStatus.textContent = 'Inactive';
        devtoolsDot.className = 'status-dot inactive';
        devtoolsStatus.textContent = 'Unknown';
    }
  }

  // Get current tab and query status
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.runtime.sendMessage(
        { type: 'GET_STATUS', tabId: tabs[0].id },
        (response) => {
          if (response) {
            updateUI(response);
          } else {
            updateUI({ status: 'inactive', storeCount: 0 });
          }
        }
      );
    }
  });
})();
