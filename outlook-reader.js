// Guard against being injected twice (programmatic + declarative can both fire)
if (window.__labelExtractorOutlookReaderLoaded) {
  // Already running — do nothing
} else {
  window.__labelExtractorOutlookReaderLoaded = true;

  let debounceTimer = null;
  let retryTimer = null;
  let retryCount = 0;
  const MAX_RETRIES = 12;
  const RETRY_INTERVAL_MS = 1500;
  const LABEL_FILE_PATTERN = /\.(pdf|png|jpe?g|gif|hei[cf])\b/i;
  const ATTACHMENT_HINT_PATTERN = /(label|return|ship|shipping|ups|usps|fedex|dhl|tracking|postage|rma|narvar|amazon|ebay|etsy)/i;
  const DOWNLOAD_HINT_PATTERN = /(download|save as|save a copy|save to computer)/i;
  const MORE_ACTIONS_PATTERN = /(more|actions|options|menu|show more)/i;

  function readCurrentSender() {
    // Ordered by specificity — newer Outlook DOM first, older fallbacks last
    const nameSelectors = [
      '[data-testid="SenderPersona-primaryText"]',
      '[data-testid="SenderPersona"] .ms-Persona-primaryText',
      '[data-testid="RecipientWell-primaryText"]',
      '[aria-label^="From:"] .ms-Persona-primaryText',
      '[aria-label^="From"] .ms-TooltipHost',
      '[data-log-name="FRO"] .ms-Persona-primaryText',
      '[class*="senderText"]',
      '[class*="sender"] [class*="primaryText"]',
      '.ReadingPaneContent [role="heading"] ~ div .ms-Persona-primaryText',
      // Newer Fluent UI v9 Outlook selectors
      '[data-app-section="ReadingPane"] [data-testid*="sender"]',
      '[data-app-section="ReadingPane"] [class*="personaName"]'
    ];

    let senderName = null;
    for (const sel of nameSelectors) {
      try {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && text.length > 1) {
          senderName = text;
          break;
        }
      } catch (_) {}
    }

    if (!senderName) return false;

    const emailSelectors = [
      '[data-testid="SenderPersona"] [title*="@"]',
      '[data-testid="SenderPersona"] [data-email*="@"]',
      '[aria-label^="From:"] [title*="@"]',
      '[aria-label^="From"] [title*="@"]',
      '[data-app-section="ReadingPane"] [title*="@"]'
    ];

    let senderEmail = null;
    for (const sel of emailSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const candidate = el.getAttribute("title") || el.getAttribute("data-email") || el.textContent?.trim();
          if (candidate?.includes("@")) {
            senderEmail = candidate;
            break;
          }
        }
      } catch (_) {}
    }

    chrome.storage.session.set({
      outlookSender: { name: senderName, email: senderEmail, timestamp: Date.now() }
    }).catch(() => {});

    return true;
  }

  function scheduleRead() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      readCurrentSender();
    }, 600);
  }

  function retryUntilFound() {
    if (readCurrentSender()) {
      retryCount = 0;
      return;
    }
    retryCount++;
    if (retryCount < MAX_RETRIES) {
      retryTimer = setTimeout(retryUntilFound, RETRY_INTERVAL_MS);
    }
  }

  // Initial attempt — Outlook SPA may not have rendered the reading pane yet
  retryUntilFound();

  // Watch for Outlook's SPA navigation and reading pane changes
  const observer = new MutationObserver(() => {
    clearTimeout(retryTimer);
    retryCount = 0;
    scheduleRead();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "grab-outlook-label-attachment") return false;

    grabLikelyLabelAttachment()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, message: error?.message || "Could not inspect Outlook attachments." });
      });
    return true;
  });

  async function grabLikelyLabelAttachment() {
    const candidates = findAttachmentCandidates();
    if (!candidates.length) {
      return { ok: false, message: "No PDF or image attachment found in the current Outlook email." };
    }

    const best = candidates[0];
    const target = await findDownloadTarget(best.element);
    if (target) {
      clickElement(target);
      return {
        ok: true,
        fileName: best.fileName,
        method: "download-action"
      };
    }

    const previewTarget = await openPreviewAndFindDownload(best.element);
    if (previewTarget) {
      clickElement(previewTarget);
      return {
        ok: true,
        fileName: best.fileName,
        method: "preview-download-action"
      };
    }

    const keyboardTarget = await openAttachmentMenuWithKeyboard(best.element);
    if (keyboardTarget) {
      clickElement(keyboardTarget);
      return {
        ok: true,
        fileName: best.fileName,
        method: "keyboard-menu-download-action"
      };
    }

    const lastChanceTarget = findAnyVisibleDownloadAction();
    if (lastChanceTarget) {
      clickElement(lastChanceTarget);
      return {
        ok: true,
        fileName: best.fileName,
        method: "page-download-action"
      };
    }

    return {
      ok: false,
      fileName: best.fileName,
      message: "Found the attachment, but Outlook did not show a Download button in the chip or preview."
    };
  }

  function findAttachmentCandidates() {
    const elements = Array.from(document.querySelectorAll("button, a, [role='button'], [title], [aria-label], [data-testid], span, div"));
    const candidates = [];
    const seen = new Set();

    for (const element of elements) {
      const fileName = attachmentFileName(element);
      if (!fileName || seen.has(fileName)) continue;
      seen.add(fileName);
      candidates.push({
        element: clickableAttachmentElement(element),
        fileName,
        score: attachmentScore(fileName, element)
      });
    }

    return candidates
      .filter((candidate) => candidate.element)
      .sort((a, b) => b.score - a.score);
  }

  function attachmentFileName(element) {
    const text = [
      element.textContent,
      element.getAttribute?.("title"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("download")
    ].filter(Boolean).join(" ");
    if (!text || text.length > 500 || !LABEL_FILE_PATTERN.test(text)) return "";
    const match = text.match(/[^\s"'<>:]+?\.(?:pdf|png|jpe?g|gif|hei[cf])\b/i);
    return match ? match[0] : "";
  }

  function clickableAttachmentElement(element) {
    return element.closest?.("button, a, [role='button']")
      || element.closest?.("[data-testid*='Attachment'], [class*='attachment'], [class*='Attachment']")
      || element;
  }

  function attachmentScore(fileName, element) {
    let score = 0;
    if (/\.pdf$/i.test(fileName)) score += 4;
    if (ATTACHMENT_HINT_PATTERN.test(fileName)) score += 5;
    const nearbyText = nearbyAttachmentText(element);
    if (ATTACHMENT_HINT_PATTERN.test(nearbyText)) score += 3;
    if (DOWNLOAD_HINT_PATTERN.test(nearbyText)) score += 1;
    return score;
  }

  async function findDownloadTarget(attachmentElement) {
    const container = attachmentElement.closest?.("[role='listitem'], [data-testid*='Attachment'], [class*='attachment'], [class*='Attachment']")
      || attachmentElement.parentElement
      || attachmentElement;
    const controls = Array.from(container.querySelectorAll?.("button, a, [role='button']") || []);
    const visibleDownload = controls.find((control) => isVisible(control) && DOWNLOAD_HINT_PATTERN.test(controlText(control)))
      || controls.find((control) => control !== attachmentElement && /download/i.test(control.getAttribute?.("data-testid") || ""));
    if (visibleDownload) return visibleDownload;

    const menuButton = controls.find((control) => isVisible(control) && MORE_ACTIONS_PATTERN.test(controlText(control)))
      || controls.find((control) => isVisible(control) && /\.\.\.|⋯|…/.test(control.textContent || ""));
    if (menuButton) {
      clickElement(menuButton);
      const menuDownload = await waitForElement(findOpenMenuDownloadAction, 650);
      if (menuDownload) return menuDownload;
    }

    return null;
  }

  async function openPreviewAndFindDownload(attachmentElement) {
    clickElement(attachmentElement);
    let previewDownload = await waitForElement(findDocumentDownloadAction, 850);
    if (previewDownload) return previewDownload;

    const previewMenu = await waitForElement(findDocumentMoreActionsButton, 450);
    if (previewMenu) {
      clickElement(previewMenu);
      return waitForElement(findOpenMenuDownloadAction, 650);
    }

    return null;
  }

  async function openAttachmentMenuWithKeyboard(attachmentElement) {
    attachmentElement.focus?.();
    attachmentElement.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter"
    }));
    let menuDownload = await waitForElement(findOpenMenuDownloadAction, 500);
    if (menuDownload) return menuDownload;

    attachmentElement.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
      code: "ArrowDown",
      altKey: true
    }));
    menuDownload = await waitForElement(findOpenMenuDownloadAction, 500);
    if (menuDownload) return menuDownload;

    attachmentElement.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      view: window
    }));
    return waitForElement(findOpenMenuDownloadAction, 500);
  }

  function findDocumentDownloadAction() {
    const controls = Array.from(document.querySelectorAll("button, a, [role='button'], [role='menuitem']"));
    return controls.find((control) => isVisible(control) && DOWNLOAD_HINT_PATTERN.test(controlText(control)));
  }

  function findDocumentMoreActionsButton() {
    const controls = Array.from(document.querySelectorAll("button, a, [role='button']"));
    return controls.find((control) => isVisible(control) && MORE_ACTIONS_PATTERN.test(controlText(control)))
      || controls.find((control) => isVisible(control) && /\.\.\.|⋯|…/.test(control.textContent || ""));
  }

  function findOpenMenuDownloadAction() {
    const menuControls = Array.from(document.querySelectorAll("[role='menuitem'], [role='option'], button, a, [role='button']"));
    return menuControls.find((control) => isVisible(control) && DOWNLOAD_HINT_PATTERN.test(controlText(control)));
  }

  function findAnyVisibleDownloadAction() {
    const controls = Array.from(document.querySelectorAll("button, a, [role='button'], [role='menuitem']"));
    return controls.find((control) => isVisible(control) && DOWNLOAD_HINT_PATTERN.test(controlText(control)));
  }

  function clickElement(element) {
    element.scrollIntoView?.({ block: "center", inline: "center" });
    element.focus?.();
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  function isVisible(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none"
      && style.opacity !== "0";
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForElement(finder, timeoutMs, intervalMs = 80) {
    const startedAt = Date.now();
    let found = finder();
    while (!found && Date.now() - startedAt < timeoutMs) {
      await delay(intervalMs);
      found = finder();
    }
    return found || null;
  }

  function nearbyAttachmentText(element) {
    const container = element.closest?.("[role='listitem'], [data-testid*='Attachment'], [class*='attachment'], [class*='Attachment']")
      || element.parentElement
      || element;
    return controlText(container);
  }

  function controlText(element) {
    return [
      element.textContent,
      element.getAttribute?.("title"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("data-testid")
    ].filter(Boolean).join(" ");
  }
}
