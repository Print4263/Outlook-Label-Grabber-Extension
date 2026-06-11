# Performance Diagnostic — Extract slowdown + Download Label lag
2026-06-11

Two complaints, two separate root-cause sets:

1. **Extract after "Use" is much slower than earlier builds** — caused by four pixel-pass
   features added Jun 9–11 (commits cc8822a, 0502679, 14ec7c3, 4f7334b), one of which
   (`extendThroughContent`) does a separate canvas readback **per scanline** and runs on
   every crop of every candidate.
2. **"Download Label" in the sidebar feels delayed vs Outlook's own download button** —
   the sidebar button is not a click, it's a relay: service-worker hop → tab focus →
   script injection → a whole-document DOM scan that reads `textContent` of every
   `span`/`div` in the Outlook app (tens of thousands of elements), with retry/poll
   waterfalls of fixed 400–850 ms waits on top. Outlook's native button is a direct
   click handler with none of that.

---

## Part 1 — Extract pipeline slowdown

### Timeline correlation

"Earlier builds" = before Jun 9. All of the following landed Jun 9–11:

| Commit | Date | What it added | Where it runs |
|---|---|---|---|
| `cc8822a` | Jun 9 | `eraseFaintRules` — 2 full-pixel passes (rows+cols) | **every rendered page** (pdf-processor `renderPageEntry`) |
| `0502679` | Jun 10 | `clampPaddingAtGaps` — extra readback + per-line scans | **every `cropCanvas` call** |
| `14ec7c3` | Jun 10 | `detectUprightFlip` — full-pixel barcode-band scan | **every final candidate** (via `orientLabelToPortrait`), incl. already-upright portrait labels (probe path) |
| `4f7334b` | Jun 10 | `extendThroughContent` — content rescue walk | **every `cropCanvas` call** |

### Cost analysis (worst offender first)

#### 1. `extendThroughContent` — per-scanline `getImageData` (crop-engine.js:287-350) — **dominant**

`rowHasContent(y)` / `colHasContent(x)` each call `ctx.getImageData(...)` for a
**single 1-px row or column**. Each `getImageData` is a synchronous canvas readback
with fixed overhead. The walk can cover up to 30% of the rect dimension per side
(`CONTENT_EXTEND_MAX_REACH_RATIO`), and bridging gaps means it keeps reading lines
even through content. On a page rendered at scale 3–4 (canvas ~2500×3300), a label
rect ~2000 px tall → up to ~600 readbacks per side × 4 sides ≈ **up to ~2,400
individual getImageData calls per crop**.

`cropCanvas` is called for every candidate every detector produces — dashed-border,
solid-border, trained-model, fold-here, embedded, keyword/text fallbacks, twin-split —
typically 5–15 crops per extraction. Estimated added wall time: **2–10+ s per extraction**.
This single change most plausibly explains "so much longer than earlier builds."

#### 2. `eraseFaintRules` on every rendered page (crop-engine.js:518-588, called from pdf-processor.js:374)

Two full passes (row classify + column classify, then erase) over each rendered page
canvas (~8 MP at render scale 3–4), with per-pixel luminance math, for **up to 6 pages**
(`MAX_RENDER_PAGES`). The dark-pixel early-bail helps on text lines, but white/faint
lines scan full length. Estimated ~50–200 ms per page × pages rendered.

#### 3. `detectUprightFlip` on every candidate (crop-engine.js:441-502, via app/crop.js `orientLabelToPortrait`)

`sidepanel.js extractSelectedFile` maps **all** candidates through
`orientLabelToPortrait`: each one decodes its base64 PNG to an `<img>`, redraws to a
canvas, and runs a full-pixel row-bits scan. Portrait labels don't skip it — they pay
the `drawRotated(img, 0)` probe + full scan too. And any label that does get rotated is
re-encoded with `canvas.toDataURL("image/png")` (PNG encode of a multi-MP image,
~100–300 ms each).

#### 4. `clampPaddingAtGaps` per crop (crop-engine.js:191-251)

One `getImageData` of the padded rect (fine) plus per-line JS scans of all four edge
walks. Moderate on its own; it stacks on #1 inside the same `cropCanvas` call.

#### 5. Pre-existing costs that now compound

- **ONNX inference is single-threaded** (`model-detector.js getSession`:
  `ort.env.wasm.numThreads = 1`) and `detectPages` runs inference on **every rendered
  page** (up to 6) at 960×960 — not just the page a detector flagged. When the ≥0.95
  early-exit doesn't fire (any border hit below 0.95, or `cropContainsBarcodeOrUnknown`
  fails), that's up to 6 single-threaded inferences. The threaded WASM binary
  (`ort-wasm-simd-threaded.jsep.wasm`) is already shipped but unused.
- Every `cropCanvas` result ends in `canvas.toDataURL("image/png")` — a synchronous PNG
  encode per candidate.
- `extractEmbeddedImages` calls `page.getOperatorList()` for up to 20 pages during the
  "cheap" text phase — forces a full parse of pages that may never render.

### Correction plan — extract

Ordered by payoff/risk. Detection RESULTS must not change for items 1–4 — these are
pure I/O-pattern fixes, verifiable with the Training Studio corpus
(dev/diag-labels, 58 PDFs): wins-by-detector tally and crop rects must be identical
before/after.

1. **Batch the readbacks in `extendThroughContent`** *(highest payoff, lowest risk)*.
   Read the four candidate scan bands (left/right/top/bottom reach regions) with one
   `getImageData` each — or better, reuse a cached full-page `ImageData` — and index
   into the buffer in `rowHasContent`/`colHasContent`. Same pixels, same answers,
   ~1000× fewer readbacks.
2. **Single shared pixel cache per canvas.** pdf-processor (`pixelsFor`) and
   label-detector (`getCanvasData`) each keep their own WeakMap; crop-engine re-reads
   raw pixels in `autoCropCanvas`, `clampPaddingAtGaps`, `extendThroughContent`, and
   `detectUprightFlip`. Move one WeakMap cache into crop-engine (or a tiny shared
   helper) and use it everywhere. Caveat: caches must snapshot **after**
   `eraseFaintRules` mutates the canvas at render time — current ordering already
   guarantees this; keep it.
3. **Run `detectUprightFlip` on a downscaled probe.** Barcode bands survive a 2–3×
   downscale easily (the thresholds are ratio-based); drawing the probe at ~700 px tall
   cuts the scan ~10×. Also skip the probe entirely for sources that can't be upside
   down (e.g. twin-split already crops portrait; model/border crops from an upright
   page render).
4. **Gate `eraseFaintRules` by page text.** The faint fold rules it targets exist on
   carrier "View/Print Label" sheets — pages whose text matches fold/carrier cues
   (`foldRatio !== null`, "view/print label", UPS CampusShip wording). Run it only
   there, or classify on a 2-px sample step first and only do the erase pass when a
   rule-like band was found.
5. **Scope the ONNX model to the pages that matter.** `detectPages` should infer only
   on (a) the page a border/embedded detector already flagged, plus (b) the
   top-priority text-scored page — not all 6. With the new `promoteModelOverBorder`
   logic the model's job is to refine the border-winning page, so that page is known
   before inference. Cuts worst case from 6 inferences to 1–2. *(This one can change
   results in rare multi-page cases — validate against the corpus.)*
6. **Try threaded ONNX.** The threaded WASM is already in `lib/`. MV3 extension pages
   can opt into cross-origin isolation via manifest `cross_origin_opener_policy` /
   `cross_origin_embedder_policy` keys; if isolation holds,
   `numThreads = Math.min(4, navigator.hardwareConcurrency)` is a 2–4× inference win.
   If isolation doesn't hold in the side panel, it silently stays single-threaded —
   safe to attempt.
7. **(Phase 2) Lazy-encode candidates.** Rank candidates on rects first; only
   `toDataURL` the top `getVariantLimit()` survivors instead of encoding every crop
   from every detector. Also consider `canvas.toBlob` (async) + object URLs for
   previews.
8. **Add stage timing to the debug report.** Wrap each cascade stage and crop call with
   `performance.now()` deltas, stored in `state.lastExtractionSummary.timings` so
   "Copy debug report" shows where time went. This catches the next regression the day
   it lands instead of after staff complain.

---

## Part 2 — "Download Label" button lag vs native Outlook button

### What actually happens on click

Native Outlook download button: one click → Outlook's own handler → download starts.
Sidebar button (sidepanel.js `grabOutlookAttachment`):

1. `chrome.runtime.sendMessage` → **MV3 service worker** (cold start ~100–500 ms if idle —
   registers idle constantly, so usually cold).
2. `findOutlookTab` queries all tabs; then `chrome.windows.update({focused})` +
   `chrome.tabs.update({active})` — a visible focus steal that itself reads as "lag."
3. `injectOutlookReader` runs `chrome.scripting.executeScript` **on every click**
   (the in-page guard makes it a no-op, but the round trip is paid every time) — then
   `tabs.sendMessage`.
4. Content script `grabLikelyLabelAttachment` → `findAttachmentCandidates()`:
   ```js
   document.querySelectorAll("button, a, [role='button'], [title], [aria-label], [data-testid], span, div")
   ```
   In the Outlook SPA this is routinely **10,000–40,000 elements**, and
   `attachmentFileName()` builds `element.textContent` for each one. `textContent` on
   container divs serializes the whole subtree, so the scan is effectively **O(N²) text
   traversal of the entire Outlook DOM** — hundreds of ms to seconds. (The 500-char cap
   is applied *after* the string is built, so it saves nothing.) If no candidate is
   found yet, this repeats up to 3 more times with 400 ms sleeps.
5. If the chip has no visible download control, the fallback waterfall starts, each
   stage re-running full-document `querySelectorAll` + `textContent` every 80 ms:
   menu poll 650 ms → click-preview-and-wait 850 ms → preview menu 450 ms + 650 ms →
   three keyboard attempts at 500 ms each → last-chance page scan.
6. After the download finally starts, the sidebar's "Use" row only appears after
   `chrome.downloads.onCreated` + **800 ms** delay (or onChanged + 500 ms, or the
   350/900/1600 ms `scheduleFastDownloadChecks`), adding perceived lag to the next step.

Typical happy path: ~0.5–2 s behind the native button. Unhappy DOM (chip not in chip
form, virtualized list): 3–8 s.

### Correction plan — Download Label

1. **Scope and slim the candidate scan** *(biggest win)*. Search inside the reading
   pane only (`[data-app-section="ReadingPane"]`, `.ReadingPaneContent`,
   `[role="main"]` — same selector list the sender-reader already uses) and drop bare
   `span, div` from the selector in favor of attachment-shaped nodes:
   `[data-testid*='Attachment'], [class*='attachment'], [role='listitem'] a/button,
   [title], [aria-label], [download]`. Check `title`/`aria-label` attributes (cheap)
   before ever touching `textContent`, and only read `textContent` on elements with a
   small subtree (e.g. `element.querySelectorAll('*').length < 30` or
   `el.childElementCount` heuristics). Target: scan in <30 ms.
2. **Pre-index the attachment chip.** outlook-reader.js already has a MutationObserver
   on the reading pane for sender info. Extend it to locate and cache the attachment
   chip as the email renders. The click handler then starts from a cached element
   (validating `isConnected`) — near-instant response, and the 3×400 ms "not rendered
   yet" retry loop becomes unnecessary in the common case.
3. **Message first, inject on failure.** In background.js `grabOutlookLabelAttachment`,
   swap the order: try `tabs.sendMessage` immediately; only `executeScript` + retry on
   "no receiving end" error. Saves an executeScript round trip on every click after the
   first.
4. **Scope menu polls to the open menu.** `findOpenMenuDownloadAction` should query
   within `[role='menu']`/`.ms-Layer` surfaces, not the whole document, and the
   waterfall's fixed timeouts can drop (650→300 ms etc.) once each poll iteration is
   cheap and the chip is pre-indexed.
5. **Tighten download pickup.** Drop the `onCreated` callback delay 800→200 ms and
   `onChanged` 500→150 ms (the file exists by `onChanged: complete`; the long delays
   predate the event listeners). Optional UX win to discuss: when the grab response's
   `fileName` matches the new download, auto-run "Use" so staff don't click twice.
6. **Reconsider the focus steal.** The window-focus + tab-activate step makes the
   Outlook window jump before anything visible happens, which reads as lag. Test
   whether the grab works with the tab merely loaded (DOM clicks don't require focus;
   `isVisible` uses geometry, which is valid in inactive but rendered tabs). If Outlook
   virtualizes hidden tabs, keep activation but skip `windows.update({focused:true})`.
7. **Instrument it.** `LABEL_GRAB_DEBUG` already exists; add `performance.now()` stamps
   per stage (scan, target search, fallback stages) to the grab response so the
   sidepanel status/debug report can show "grab took 240 ms (scan 31 ms)".

---

## Verification

- **Extract:** run the Training Studio (dev/test.html) over dev/diag-labels before and
  after each change. Pass criteria: identical wins-by-detector tally and crop rects;
  per-stage timing (new instrumentation) shows the wins. Spot-check the four corpus
  shapes that motivated the new passes (UPS foldhere, Online Return Center, browser
  print-to-PDF, border-overrun labels) to confirm the features still fire.
- **Download Label:** with `LABEL_GRAB_DEBUG = true`, measure click→download-started on
  a real Outlook label email before/after. Target <300 ms happy path.

---

## Implementation status (2026-06-11)

Implemented and verified with `dev/perf-check.html` (12 corpus PDFs through the real
pipeline; same harness pattern as one-label.html):

| Change | File | Verified |
|---|---|---|
| Batched readbacks in `extendThroughContent` + `clampPaddingAtGaps` | crop-engine.js | yes — identical candidates |
| Shared `pixelsFor` snapshot cache across crop-engine / label-detector / pdf-processor (invalidated by `eraseFaintRules`) | all three | yes |
| Reading-pane-scoped attachment scan, attribute-first matching, descendant cap | outlook-reader.js | yes — iframe simulation, 5 scenarios |
| Message-first / inject-on-failure | background.js | parse-checked (needs live Outlook smoke test) |
| Download pickup delays 800→300 ms, 500→150 ms | app/downloads.js | parse-checked |
| Per-stage extraction timings in debug report | sidepanel.js | parse-checked |

**Results, 12-file corpus run (model warm, per-file detection wall time):** every
candidate — reason, confidence, page, size, crop rect — byte-identical to the
pre-change baseline. Total 72.3 s → 30.0 s (2.4×). Extremes: viewlabel 10.1→3.1 s,
Ellie 6-up 16.3→6.9 s, 1Z2AD 5.4→1.0 s, Online Return Center 3.8→0.9 s. Baseline
times kept in dev/perf-baseline-times.txt.

During testing the iframe simulation caught (and we fixed) a regression in the new
scan: chips whose filename exists only as inner-span text were missed because
`textContent` concatenates adjacent nodes without whitespace ("label.pdf65 KB"),
breaking the `\b` in the filename pattern — solved with `spacedText()` (text nodes
joined with spaces).

Deliberately NOT done (deferred, higher risk):
- ONNX threading via manifest COOP/COEP — `require-corp` could break the `file://`
  fetches the Use button depends on; needs its own test pass.
- Scoping model inference to flagged pages — can change results on multi-page PDFs.
- Gating `eraseFaintRules` by text cues — could change crops on non-UPS sheets.
- Lazy candidate encoding (skip `toDataURL` for losers) — plumbing refactor.

Remaining live-extension smoke test after reload: open panel, Download Label from a
real Outlook email, Use → extract → print preview; check lab-mode debug report shows
`timings`.

---

## Round 2 (2026-06-11 evening) — model scoping + lazy encode + orient-from-canvas

Goal: every extract under 5 s without changing detection results. Measured first
(perf-check.html now records per-stage timings via the trace sink + the model's
argmax page): after Round 1, the ONNX stage was 60–80 % of every slow file —
~0.7 s per page, run on every rendered page, sequentially after the heuristics.

| Change | Commit | Verified |
|---|---|---|
| Scope ONNX inference to pages that matter (`modelInferencePageScope` in label-detector; `detectPages(pages, pageIndexes)`) — rect-backed candidate pages + embedded-label-looking pages; n-up duplicate sheets (same border rect on 3+ pages) skip the model entirely; no candidates → all pages as before | 25e9786 | full 60-PDF corpus |
| Lazy PNG encode: `canvasToLabel` dataUrl is a cached getter + carries the canvas; `localDetectionToLabel` base64 lazy (`defineLazyBase64`); losers cut by the variant limit never encode | 0b0e7da | full 60-PDF corpus |
| Orientation pass draws from `label.sourceCanvas` (no base64 decode per candidate, no probe copy for canvas-backed portrait labels); rotated labels re-encode lazily | 0b0e7da | corpus + parse-check |
| `addMissingPageCropOptions` builds fallbacks only for kept missing pages (same sort+limit selection) | 0b0e7da | parse-check |

**Identity bar:** candidates byte-identical (reason/conf/page/size/rect, top 20) on
58/60 files; the 2 Ellie n-up files lose only their last-place trained-model
candidate (conf 0.924 but below 6 dashed @0.97 + 6 solid @0.90 — position 19,
outside the 6-variant UI limit, never shown). The Online Return Center (5)
borderless-label page is exactly why the scope includes embedded-label-looking
pages — its visible model candidate is unchanged.

**Numbers (full 60-file corpus, model warm):** 93.6 s → 65.5 s. Ellie 6-up
6.0 → 1.3 s, ORC (4) 3.0 → 1.6 s, orc9 2.8 → 1.5 s, viewlabel 2.0 → 1.8 s.
Worst file is now fashion.pdf at 2.7 s, and >half of that is pdf.js page
rendering (processMs), not detection.

**Rejected on purpose:** downscaling the `detectUprightFlip` probe — its
FLIP_MIN_TRANSITIONS/FLIP_MIN_MASS thresholds are absolute, so a smaller probe
could change flip decisions. ONNX COOP/COEP threading stays deferred (file://
fetch risk, needs its own live pass).

**Trade-off:** shown candidates retain their crop canvas (`sourceCanvas`) until
Clear — tens of MB while results are on screen, in exchange for skipped
encodes/decodes. Auto-clear already bounds the window.

Live smoke test after reload (not yet done): Outlook → Download Label → Use →
extract (check debug-report timings) → Rotate/Crop on one candidate → print
preview → Reprint last. A landscape-source label should still come out upright.
