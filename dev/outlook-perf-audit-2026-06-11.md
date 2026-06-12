# Outlook responsiveness & email-delivery audit — 2026-06-11

Question: can anything in this extension delay Outlook email delivery, inbox
refresh, or new-message visibility? Verdict up front: **no mechanism in the
extension can delay mail delivery or sync**, and the few things that run on
Outlook's main thread are micro-cost — now further reduced (changes below).

## Where the work runs

| component | process | when it runs |
|---|---|---|
| pdf.js render, ONNX inference, pixel scans, PNG encode | popout window (sidepanel.html) — its own renderer process | only during an extract |
| background.js service worker | extension service worker | event-driven only |
| outlook-reader.js | Outlook tab | mutation-debounced sender read + on-demand grab |
| page-label-drag.js | every tab | one `dragstart` listener; idle otherwise |

All detection/OCR-class work happens in the popout's process. Chrome gives the
popout window its own renderer; nothing it does (even 100% CPU during an
extract) can block Outlook's main thread, DOM updates, or websocket delivery.

## Email delivery specifically

New-mail delivery is Outlook's own server push (websocket). The extension has
no `webRequest`/proxy permissions, makes **zero network requests** during
normal operation (model + libs ship in the bundle), and registers no service
worker on Outlook's origin. There is no code path that could delay a message
reaching the inbox.

Inbox *rendering* is Outlook's main thread. The extension's entire footprint
there is `outlook-reader.js`:

- One MutationObserver scoped to the reading pane (body only until the pane
  first renders). Observer callbacks run after Outlook's DOM updates paint —
  they cannot delay them.
- The callback is `clearTimeout` + a 600 ms debounce; the actual sender read
  (~16 `querySelector` calls, sub-millisecond) runs once per settled change.
- The attachment scan runs only when the user clicks Download Label, is
  scoped to the reading pane, and caps per-element text reads (the old
  O(N²) whole-app text traversal was fixed in a prior round).
- No intervals, no polling. Startup does at most 12 sender-read retries
  (1.5 s apart) then stops.

## Changes made in this audit

1. **Hidden-tab skip**: sender reads are skipped entirely while the Outlook
   tab is hidden; one catch-up read fires on `visibilitychange`. While mail
   syncs in a background tab, the extension now does ~nothing.
2. **Cheaper mutation handler**: the reading-pane re-query (3 selectors per
   mutation batch) now only runs when the observed node is gone or we're
   still on the body fallback.
3. **Download Label safety** (see below) also removes the document-wide
   control scan from the last-resort path.

## Download Label navigation fix

The grab strategy chain could open Outlook's attachment **preview overlay**
(clicking the chip, or sending Enter to it) and left it open — closing it
later sometimes lands in the inbox instead of the open email. The last-resort
strategy could also click *any* visible "Download/Save" control on the page.

Fixed:
- After any preview/keyboard strategy (success or failure), the reader now
  **restores the reading view**: clicks the overlay's Close button, or sends
  Escape, retrying up to 3 times (450 ms after a successful download click so
  the download registers first).
- The last-resort scan only considers controls inside an open overlay/menu
  (`[role=dialog]`, `[role=menu]`, lightbox/preview containers) — it can no
  longer click unrelated controls in the mail surface.
- The preview-toolbar lookup prefers overlay-scoped controls before the
  document-wide fallback.
- New grab method label `overlay-download-action` (replaces
  `page-download-action`) shows up in grab responses for diagnosis.

## Residual notes

- `chrome.windows.update(focused)` + `tabs.update(active)` in the background
  grab handler intentionally bring Outlook forward (the DOM must be visible to
  click). This focus shift is by design, not the navigation bug.
- Browser-level background-tab throttling affects timers, not websocket
  delivery; with the hidden-tab skip the extension no longer schedules timers
  in hidden Outlook tabs at all.
