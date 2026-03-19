/* ========================================================
   GitHub Action Manager – Background Service Worker
   ======================================================== */

// Listen for notifications from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: message.title || 'GitHub Action Manager',
      message: message.body || '',
    });
    sendResponse({ ok: true });
  }
  return true;
});
