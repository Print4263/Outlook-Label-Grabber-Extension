const OUTLOOK_ORIGINS = [
  "https://outlook.office.com",
  "https://outlook.office365.com",
  "https://outlook.live.com",
  "https://outlook.microsoft.com"
];
const POPOUT_PATH = "sidepanel.html";
const POPOUT_WIDTH_RATIO = 0.30;
const POPOUT_MIN_WIDTH = 520;
const POPOUT_MAX_WIDTH = 760;
const POPOUT_LAYOUT_STORAGE_KEY = "labelPopoutLayout";
let popoutWindowId = null;
let popoutOpenPromise = null;
let popoutLayoutSaveTimer = null;

function isOutlookUrl(url) {
  if (!url) return false;
  try {
    return OUTLOOK_ORIGINS.some((origin) => url.startsWith(origin));
  } catch (_) {
    return false;
  }
}

async function injectOutlookReader(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["outlook-reader.js"]
    });
  } catch (_) {
    // Tab may have navigated away or be a protected page — safe to ignore
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function getSideBySideBounds(anchorWindowId, existingPopout) {
  const fallback = {
    outlook: null,
    popout: { left: 880, top: 0, width: 500, height: 920 }
  };

  try {
    const anchor = anchorWindowId ? await chrome.windows.get(anchorWindowId) : null;
    if (!anchor?.width || !anchor?.height) return fallback;

    const existingLooksDocked = existingPopout?.width
      && Math.abs((anchor.left || 0) + anchor.width - (existingPopout.left || 0)) <= 16;
    const totalWidth = existingLooksDocked
      ? anchor.width + existingPopout.width
      : anchor.width;
    const totalHeight = Math.max(anchor.height, existingPopout?.height || 0);
    const popoutWidth = Math.round(clamp(totalWidth * POPOUT_WIDTH_RATIO, POPOUT_MIN_WIDTH, POPOUT_MAX_WIDTH));
    const outlookWidth = Math.max(640, totalWidth - popoutWidth);
    const left = Math.round(anchor.left || 0);
    const top = Math.round(anchor.top || 0);

    return {
      outlook: {
        left,
        top,
        width: outlookWidth,
        height: Math.round(totalHeight || anchor.height)
      },
      popout: {
        left: left + outlookWidth,
        top,
        width: popoutWidth,
        height: Math.round(totalHeight || anchor.height)
      }
    };
  } catch (_) {
    return fallback;
  }
}

async function getSavedPopoutBounds() {
  try {
    const data = await chrome.storage.local.get(POPOUT_LAYOUT_STORAGE_KEY);
    const bounds = data[POPOUT_LAYOUT_STORAGE_KEY];
    if (!bounds) return null;

    const width = Math.round(Number(bounds.width));
    const height = Math.round(Number(bounds.height));
    const left = Math.round(Number(bounds.left));
    const top = Math.round(Number(bounds.top));
    if (![left, top, width, height].every(Number.isFinite)) return null;
    if (width < 320 || height < 360) return null;

    return { left, top, width, height };
  } catch (_) {
    return null;
  }
}

async function savePopoutLayout(windowId) {
  if (!windowId) return;

  try {
    const win = await chrome.windows.get(windowId);
    if (!win || win.state === "minimized" || win.state === "fullscreen") return;
    await chrome.storage.local.set({
      [POPOUT_LAYOUT_STORAGE_KEY]: {
        left: Math.round(win.left || 0),
        top: Math.round(win.top || 0),
        width: Math.round(win.width || POPOUT_MIN_WIDTH),
        height: Math.round(win.height || 900),
        updatedAt: Date.now()
      }
    });
  } catch (_) {}
}

async function findExistingPopout() {
  const extensionUrl = chrome.runtime.getURL(POPOUT_PATH);

  if (popoutWindowId !== null) {
    try {
      const known = await chrome.windows.get(popoutWindowId, { populate: true });
      if (known?.tabs?.some((tab) => tab.url === extensionUrl)) return known;
    } catch (_) {
      popoutWindowId = null;
    }
  }

  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal", "popup"] });
    const existing = windows.find((win) => win.tabs?.some((tab) => tab.url === extensionUrl));
    if (existing?.id) popoutWindowId = existing.id;
    return existing || null;
  } catch (_) {
    return null;
  }
}

async function openOrPositionPopout(anchorWindowId) {
  if (!chrome.windows?.create) return;
  if (popoutOpenPromise) return popoutOpenPromise;

  popoutOpenPromise = openOrPositionPopoutOnce(anchorWindowId).finally(() => {
    popoutOpenPromise = null;
  });
  return popoutOpenPromise;
}

async function openOrPositionPopoutOnce(anchorWindowId) {
  // If the window already exists, leave it exactly where it is.
  const existing = await findExistingPopout();
  if (existing?.id) {
    popoutWindowId = existing.id;
    return;
  }

  // Race-condition guard: check once more before creating.
  const racedExisting = await findExistingPopout();
  if (racedExisting?.id) {
    popoutWindowId = racedExisting.id;
    return;
  }

  const savedPopoutBounds = await getSavedPopoutBounds();
  const bounds = await getSideBySideBounds(anchorWindowId, null);
  const popoutBounds = savedPopoutBounds || bounds.popout;

  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL(POPOUT_PATH),
      type: "popup",
      left: popoutBounds.left,
      top: popoutBounds.top,
      width: popoutBounds.width,
      height: popoutBounds.height,
      focused: false
    });
    popoutWindowId = created?.id || null;
  } catch (_) {}
}

function openPopoutForOutlook(tab) {
  const tabId = tab?.id;
  if (!tabId) return;
  injectOutlookReader(tabId);
  openOrPositionPopout(tab.windowId);
}

async function findOutlookTab(preferredWindowId) {
  const tabs = await chrome.tabs.query({});
  const outlookTabs = tabs.filter((tab) => isOutlookUrl(tab.url));
  if (!outlookTabs.length) return null;
  return outlookTabs.find((tab) => tab.active && (!preferredWindowId || tab.windowId === preferredWindowId))
    || outlookTabs.find((tab) => !preferredWindowId || tab.windowId === preferredWindowId)
    || outlookTabs[0];
}

async function grabOutlookLabelAttachment(sender) {
  const tab = await findOutlookTab(sender?.tab?.windowId);
  if (!tab?.id) throw new Error("Open the label email in Outlook first.");

  try {
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) {}

  await injectOutlookReader(tab.id);

  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "grab-outlook-label-attachment" });
  } catch (_) {
    await injectOutlookReader(tab.id);
    return chrome.tabs.sendMessage(tab.id, { type: "grab-outlook-label-attachment" });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "reset-label-popout-layout") {
    chrome.storage.local.remove(POPOUT_LAYOUT_STORAGE_KEY)
      .then(async () => {
        const bounds = message.bounds;
        if (popoutWindowId && bounds) {
          try {
            await chrome.windows.update(popoutWindowId, {
              left: Math.round(bounds.left),
              top: Math.round(bounds.top),
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
              state: "normal",
              focused: true
            });
          } catch (_) {}
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, message: error?.message || "Could not reset layout." }));
    return true;
  }

  if (message?.type === "grab-outlook-label-attachment") {
    grabOutlookLabelAttachment(sender)
      .then((response) => sendResponse(response?.ok ? response : {
        ok: false,
        message: response?.message || "No label attachment found in the current Outlook email."
      }))
      .catch((error) => sendResponse({
        ok: false,
        message: error?.message || "Could not ask Outlook for the attachment."
      }));
    return true;
  }

  if (message?.type !== "open-label-popout") return false;

  openOrPositionPopout(sender?.tab?.windowId)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, message: error?.message || "Could not open popout." }));
  return true;
});

// Inject on navigation complete — covers both browser tabs and PWA app windows.
// Only open/position the popout when it doesn't already exist; subsequent Outlook
// navigations only need the reader injected, not a window reposition.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isOutlookUrl(tab.url)) {
    injectOutlookReader(tabId);
    if (popoutWindowId === null) {
      openOrPositionPopout(tab.windowId);
    }
  }
});

// Inject reader into every open Outlook tab on load, but open the popout only once
// (for the first matching tab) to avoid repeated repositioning on startup.
chrome.tabs.query({}, (tabs) => {
  let popoutOpened = false;
  for (const tab of tabs) {
    if (isOutlookUrl(tab.url)) {
      injectOutlookReader(tab.id);
      if (!popoutOpened) {
        openOrPositionPopout(tab.windowId);
        popoutOpened = true;
      }
    }
  }
});

chrome.windows?.onRemoved?.addListener((windowId) => {
  if (windowId === popoutWindowId) popoutWindowId = null;
});

chrome.windows?.onBoundsChanged?.addListener((win) => {
  if (win?.id === popoutWindowId) {
    clearTimeout(popoutLayoutSaveTimer);
    popoutLayoutSaveTimer = setTimeout(() => savePopoutLayout(win.id), 500);
  }
});
