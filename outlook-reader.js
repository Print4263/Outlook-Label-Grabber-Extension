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
  const LABEL_FILE_PATTERN = /\.(pdf|png|jpe?g|gif|webp|hei[cf])\b/i;
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

  // Watch for Outlook's SPA navigation and reading pane changes.
  // Observe the narrowest reading-pane container we can find instead of the
  // entire document.body subtree — Outlook mutates the whole app constantly,
  // and watching the reading pane cuts that noise dramatically. Falls back to
  // document.body until the pane renders, then upgrades; a navigation listener
  // re-binds if Outlook swaps the pane node out from under us.
  const READING_PANE_SELECTORS = [
    '[data-app-section="ReadingPane"]',
    '.ReadingPaneContent',
    '[role="main"]'
  ];

  let observer = null;
  let observedTarget = null;

  function findReadingPane() {
    for (const selector of READING_PANE_SELECTORS) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function attachObserver() {
    const target = findReadingPane() || document.body;
    if (observer && target === observedTarget && target.isConnected) return;
    if (observer) observer.disconnect();
    observedTarget = target;
    observer = new MutationObserver(handleMutation);
    observer.observe(target, { childList: true, subtree: true });
  }

  function handleMutation() {
    clearTimeout(retryTimer);
    retryCount = 0;
    // Background tabs don't need live sender reads — one read on the next
    // visibilitychange covers it. Keeps the extension's footprint in the
    // Outlook tab near zero while mail is syncing in the background.
    if (!document.hidden) scheduleRead();
    // Upgrade body -> reading pane once it renders, or re-bind if the
    // observed node was detached by an Outlook re-render. Only pay the
    // selector queries when the current target needs replacing.
    if (!observedTarget.isConnected || observedTarget === document.body) {
      attachObserver();
    }
  }

  attachObserver();

  // SPA navigation safety net: re-read and re-bind even if the pane node was
  // replaced (a swapped-out pane stops emitting mutations on its own).
  window.addEventListener("hashchange", () => { attachObserver(); scheduleRead(); });
  window.addEventListener("popstate", () => { attachObserver(); scheduleRead(); });
  // Catch up on whatever changed while the tab was hidden (reads are skipped
  // there — see handleMutation).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { attachObserver(); scheduleRead(); }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "grab-outlook-label-attachment") return false;

    grabLikelyLabelAttachment(message.chosenFileName)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, message: error?.message || "Could not inspect Outlook attachments." });
      });
    return true;
  });

  // --- Diagnostic logging for the "Download Label" grab -------------------
  // Set LABEL_GRAB_DEBUG to true to print grab diagnostics in the Outlook console.
  const LABEL_GRAB_DEBUG = false;
  const GRAB_MAX_RETRIES = 3;
  const GRAB_RETRY_DELAY_MS = 400;
  // A candidate at/above this score is "clearly label-like" (matched the label/carrier
  // hint pattern, or a PDF with nearby label cues). Two or more of these in one email
  // is genuine ambiguity worth a chooser; one strong + junk keeps the auto-pick.
  const STRONG_ATTACHMENT_SCORE = 5;
  function grabLog(...args) {
    if (LABEL_GRAB_DEBUG) console.log("[Label Extractor][grab]", ...args);
  }
  function describeEl(el) {
    if (!el) return "(none)";
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70);
    const cls = typeof el.className === "string" ? el.className.slice(0, 40) : "";
    const role = el.getAttribute?.("role");
    const testid = el.getAttribute?.("data-testid");
    return `<${(el.tagName || "?").toLowerCase()}`
      + `${role ? ` role=${role}` : ""}`
      + `${testid ? ` testid=${testid}` : ""}`
      + `${cls ? ` class="${cls}"` : ""}> "${text}"`;
  }
  // ------------------------------------------------------------------------

  async function grabLikelyLabelAttachment(chosenFileName) {
    // The attachment chip may not have rendered yet (common in the Outlook PWA
    // right after the email opens). Re-scan a few times before giving up — this
    // is a read-only DOM query with no side effects, so retrying is safe.
    let candidates = findAttachmentCandidates();
    for (let attempt = 1; attempt <= GRAB_MAX_RETRIES && !candidates.length; attempt += 1) {
      grabLog(`no candidates yet — retry ${attempt}/${GRAB_MAX_RETRIES} after ${GRAB_RETRY_DELAY_MS}ms`);
      await delay(GRAB_RETRY_DELAY_MS);
      candidates = findAttachmentCandidates();
    }

    grabLog(`found ${candidates.length} candidate(s):`);
    candidates.forEach((c, i) =>
      grabLog(`  #${i} score=${c.score} fileName="${c.fileName}" el=${describeEl(c.element)}`));

    if (!candidates.length) {
      grabLog("RESULT: no candidates — the attachment chip was not recognized in the DOM.");
      return { ok: false, message: "No PDF or image attachment found in the current Outlook email." };
    }

    // Multiple-attachment chooser: when the email has 2+ clearly label-like
    // attachments and the panel hasn't said which to grab, return the list instead
    // of guessing. A single strong candidate (or one label next to junk) keeps the
    // original auto-pick path untouched.
    if (!chosenFileName) {
      const strong = candidates.filter((candidate) => candidate.score >= STRONG_ATTACHMENT_SCORE);
      if (strong.length >= 2) {
        grabLog(`RESULT: ${strong.length} strong candidates — returning chooser.`);
        return {
          ok: true,
          needsChoice: true,
          choices: strong.slice(0, 5).map((candidate) => ({ fileName: candidate.fileName }))
        };
      }
    }

    // When staff explicitly chose a file, never substitute a different one: if it is
    // gone (the chip re-rendered), report that rather than downloading the wrong label.
    let best;
    if (chosenFileName) {
      best = candidates.find((candidate) => candidate.fileName === chosenFileName);
      if (!best) {
        return { ok: false, message: "That attachment is no longer listed - reopen the email and grab it again." };
      }
    } else {
      best = candidates[0];
    }
    grabLog("chosen candidate el =", describeEl(best.element));

    const target = await findDownloadTarget(best.element);
    if (target) {
      grabLog("RESULT: clicking download-action target =", describeEl(target));
      clickElement(target);
      return {
        ok: true,
        fileName: best.fileName,
        method: "download-action"
      };
    }
    grabLog("findDownloadTarget: no download control found in the chip or its menu.");

    // Strategies below this point OPEN Outlook UI (the attachment preview
    // overlay, or a menu via keyboard). Left open, the preview replaces the
    // reading-pane view — closing it later sometimes lands the user back in
    // the inbox instead of the open email. Always restore the reading view
    // after the download click has had a moment to register.
    const previewTarget = await openPreviewAndFindDownload(best.element);
    if (previewTarget) {
      grabLog("RESULT: clicking preview-download-action target =", describeEl(previewTarget));
      clickElement(previewTarget);
      restoreReadingViewSoon();
      return {
        ok: true,
        fileName: best.fileName,
        method: "preview-download-action"
      };
    }
    grabLog("openPreviewAndFindDownload: no download control found in the preview.");
    // The preview may be open with no usable download control — close it
    // before trying anything else so it can't swallow later clicks.
    await restoreReadingView();

    const keyboardTarget = await openAttachmentMenuWithKeyboard(best.element);
    if (keyboardTarget) {
      grabLog("RESULT: clicking keyboard-menu-download-action target =", describeEl(keyboardTarget));
      clickElement(keyboardTarget);
      restoreReadingViewSoon();
      return {
        ok: true,
        fileName: best.fileName,
        method: "keyboard-menu-download-action"
      };
    }
    grabLog("openAttachmentMenuWithKeyboard: no download control found.");
    await restoreReadingView();

    // Last resort: only controls inside an OPEN overlay/menu qualify. The old
    // document-wide scan could click an unrelated "Download"/"Save" control in
    // the mail surface — the prime suspect for surprise navigation.
    const lastChanceTarget = findOverlayDownloadAction();
    if (lastChanceTarget) {
      grabLog("RESULT: clicking overlay-download-action target =", describeEl(lastChanceTarget));
      clickElement(lastChanceTarget);
      restoreReadingViewSoon();
      return {
        ok: true,
        fileName: best.fileName,
        method: "overlay-download-action"
      };
    }
    grabLog("RESULT: attachment recognized but NO download control found by any strategy.");

    return {
      ok: false,
      fileName: best.fileName,
      message: "Found the attachment, but Outlook did not show a Download button in the chip or preview."
    };
  }

  // --- Reading-view restoration --------------------------------------------
  // The attachment preview is a full overlay; Outlook treats it as a
  // navigation state. Close it explicitly (close button first, Escape as the
  // fallback) so the user stays on the email they had open.
  const OVERLAY_SELECTOR = "[role='dialog'], [class*='lightbox' i], [class*='previewContainer' i], [data-app-section*='Preview' i]";
  const CLOSE_HINT_PATTERN = /^(close|back|dismiss)\b|(close|back to message)/i;

  function findOpenOverlay() {
    return Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).find(isVisible) || null;
  }

  async function restoreReadingView() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const overlay = findOpenOverlay();
      if (!overlay) return;
      const closeButton = Array.from(overlay.querySelectorAll("button, [role='button']"))
        .find((control) => isVisible(control) && CLOSE_HINT_PATTERN.test(
          (control.getAttribute("aria-label") || control.getAttribute("title") || control.textContent || "").trim()
        ));
      if (closeButton) {
        grabLog("restoreReadingView: clicking close button", describeEl(closeButton));
        clickElement(closeButton);
      } else {
        grabLog("restoreReadingView: no close button — sending Escape");
        sendEscape(overlay);
      }
      await delay(250);
    }
  }

  // After a successful download click, give Outlook a beat to register it
  // before tearing the preview down. Fire-and-forget: the grab response
  // doesn't need to wait for the view restore.
  function restoreReadingViewSoon() {
    setTimeout(() => { restoreReadingView().catch(() => {}); }, 450);
  }

  function sendEscape(overlay) {
    const target = (overlay && overlay.contains(document.activeElement) && document.activeElement)
      || overlay
      || document.body;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27
      }));
    }
  }

  // The old scan walked every span/div in the Outlook app and built textContent
  // for each — textContent on a container serializes its whole subtree, so the
  // click paid an O(N²) text traversal of the entire SPA (seconds on big
  // mailboxes). Scan only attachment-shaped elements inside the reading pane,
  // read the cheap attributes first, and only touch textContent on small
  // subtrees. Falls back to a document-wide scan when the pane scan finds
  // nothing, so unusual Outlook layouts still work.
  const ATTACHMENT_SCAN_SELECTOR = [
    "button", "a", "[role='button']",
    "[title]", "[aria-label]", "[download]",
    "[data-testid*='Attachment']", "[data-testid*='attachment']",
    "[class*='attachment']", "[class*='Attachment']"
  ].join(", ");
  const ATTACHMENT_TEXT_MAX_DESCENDANTS = 60;

  function findAttachmentCandidates() {
    const pane = findReadingPane();
    const candidates = collectAttachmentCandidates(pane || document.body);
    if (candidates.length || !pane) return candidates;
    return collectAttachmentCandidates(document.body);
  }

  function collectAttachmentCandidates(root) {
    const elements = Array.from(root.querySelectorAll(ATTACHMENT_SCAN_SELECTOR));
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
    const attrText = [
      element.getAttribute?.("title"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("download")
    ].filter(Boolean).join(" ");
    const fromAttr = matchLabelFileName(attrText);
    if (fromAttr) return fromAttr;
    if (element.getElementsByTagName && element.getElementsByTagName("*").length > ATTACHMENT_TEXT_MAX_DESCENDANTS) return "";
    return matchLabelFileName(spacedText(element));
  }

  // textContent concatenates adjacent nodes without whitespace ("label.pdf" +
  // "65 KB" -> "label.pdf65 KB"), which kills the \b in the filename pattern.
  // Join the text nodes with spaces instead. Only called on small subtrees.
  function spacedText(element) {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue.trim();
      if (value) parts.push(value);
    }
    return parts.join(" ");
  }

  function matchLabelFileName(text) {
    if (!text || text.length > 500 || !LABEL_FILE_PATTERN.test(text)) return "";
    const match = text.match(/[^\s"'<>:]+?\.(?:pdf|png|jpe?g|gif|webp|hei[cf])\b/i);
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
    // Prefer controls inside the open overlay (that's where the preview's
    // toolbar lives); fall back to the old document-wide scan for Outlook
    // layouts that dock the viewer outside a dialog role.
    const overlayHit = findOverlayDownloadAction();
    if (overlayHit) return overlayHit;
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

  // Replaces the old document-wide findAnyVisibleDownloadAction: only an open
  // overlay or menu is a safe place to click a "Download" control — anywhere
  // else risks hitting an unrelated control in the mail surface.
  function findOverlayDownloadAction() {
    const containers = Array.from(document.querySelectorAll(`${OVERLAY_SELECTOR}, [role='menu']`)).filter(isVisible);
    for (const container of containers) {
      const controls = Array.from(container.querySelectorAll("button, a, [role='button'], [role='menuitem']"));
      const hit = controls.find((control) => isVisible(control) && DOWNLOAD_HINT_PATTERN.test(controlText(control)));
      if (hit) return hit;
    }
    return null;
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
