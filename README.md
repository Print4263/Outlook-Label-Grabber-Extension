# Outlook Label Grabber — Print4263

Chrome/Edge MV3 extension for grabbing and printing shipping labels from Outlook at The UPS Store #4263. Runs entirely on-device — no backend server, no API key, no internet required for detection.

## What It Does

- Adds a **Download Label** button to the open Outlook email; retries briefly when Outlook is still rendering the attachment chip.
- Falls back to **Recent downloads** when staff uses Outlook's own download button.
- Detects shipping labels from PDF, PNG, JPG, JPEG, GIF, WEBP, HEIC, and HEIF — HEIC/HEIF auto-convert to PNG.
- Handles phone screenshots and low-resolution images by upscaling to ~3000 px before analysis — hairline borders and dash patterns that would otherwise be invisible at native resolution are reliably detected.
- **Ranks results intelligently:** 4×6-shaped crops surface first; pure packing-slip, invoice, and order-summary pages are pushed to the bottom so the label is always the top pick.
- Detects labels placed sideways or rotated 90° and auto-orients them upright for correct 4×6 printing.
- Handles labels embedded as full-page images, label pages with border detectors, and the ONNX YOLO model as a refinement layer.
- **Reads the barcode on the grabbed label** fully on-device (zxing-wasm) — UPS 1Z, FedEx (PDF417 / Ground), and USPS IMpb (GS1) — and shows a **carrier + tracking-number badge** on the result; click the number to copy it. Carriers are check-digit validated where possible (jkeen `tracking_number_data`).
- **The variant whose barcode decodes to a real tracking number is floated to the top automatically** — the actual shipping label becomes the selected, previewed, and printed pick.
- Expands detected crop boxes outward to include barcodes and data-matrix codes that sit at the label's edge — nothing gets clipped.
- Crops hug the actual label content: blank whitespace bands are trimmed to a small margin, so the printed label fills the sheet without dead space.
- **Download Label keeps the open email open** — the reading view is restored after the download click; it no longer navigates back to the inbox.
- Shows results with **Rotate**, **Crop**, **Print**, and **Expand** actions.
- The on-screen 4×6 preview matches printed output — white is trimmed and the label fills the sheet — so staff can trust the preview without manual cropping.
- **Expand** loads the full source page for manual cropping when auto-detection comes up short.
- **Display size** control (collapsible, at the bottom) scales the whole panel for low-resolution register screens; auto-fits on first open and saves per device.

## Setup

1. Open Chrome (or Edge) and go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Enable **Allow access to file URLs** in the extension's details page.
5. Open Outlook in the same browser.

> After updating the code, reload the extension, then **close and reopen the panel/popout** — an open popout keeps running the old code until reopened.

## Workflow

1. Open the label email in Outlook.
2. Click **Download Label** in the extension panel.
3. If the button doesn't work, use Outlook's own download button — the panel picks up the file automatically.
4. Click **Use** on the result, or the top candidate loads automatically.
5. Review the label. Use **Crop**, **Rotate**, or **Expand** if needed.
6. Click **Print**.
7. Click **Clear** before the next customer.

## Display size

On low-resolution register screens (e.g. 720p), open **Display size** at the bottom of the panel:

- Drag the slider or use **−/+** to scale the panel.
- Click **Fit** to auto-size it to the current window.

The setting is saved per device only.

## Project structure

| Path | Purpose |
|---|---|
| `sidepanel.html` / `sidepanel.js` | Main UI — state, rendering, print/extract orchestration |
| `app/print.js` | Monochrome conversion, print HTML, print window flow |
| `app/downloads.js` | Recent-downloads list, intake, Use/Show/Clear/preview |
| `app/crop.js` | Crop editor, auto-orient, rotate-to-portrait |
| `app/detect.js` | Turns detector output into ranked candidates |
| `detection/label-detector.js` | Detection cascade and candidate generation |
| `detection/pixel-analysis.js` | Cached border and barcode pixel scans used by the detection cascade |
| `detection/detector-ranking.js` | Candidate ordering, additive score breakdown, and 4x6 shape scoring |
| `detection/candidate-selection.js` | Post-detection filtering and winner-promotion policy |
| `detection/barcode-confirmation.js` | Candidate barcode confirmation, metadata enrichment, and near-tie reranking |
| `detection/barcode-decoder.js` | On-device barcode decode (zxing-wasm) → carrier + tracking-number classification, GS1/IMpb field parse |
| `detection/pdf-processor.js` | pdf.js page render, cut-line detection, twin-split guard |
| `detection/png-processor.js` | Image decode, upscale to ~3000 px for phone screenshots |
| `detection/crop-engine.js` | White-trim, content rescue, gap clamp, orientation probe |
| `detection/carrier-utils.js` | Shared text-based carrier guesses used by PDF/model ranking |
| `detection/page-text-cues.js` | Pure page text-layer classification (order-details, instruction/label cues, online-return, Fashion Nova) shared across detectors |
| `detection/model-detector.js` | ONNX YOLO inference (fallback / refinement layer) |
| `models/shipping-label.onnx` | On-device YOLO model (~10 MB) |
| `lib/` | pdf.js, ONNX Runtime, heic2any, zxing-wasm reader, ts-tracking-number bundle |
| `lib/label-drag-data.js` | Shared drag payload parser for panel drops and page drag capture |
| `config.js` | Upload limits, supported types, barcode-decode flags (`BARCODE.ENRICH` / `RERANK`) |
| `background.js` | Service worker — event-driven only, no polling |
| `outlook-reader.js` | Outlook content script — sender read, Download Label grab, reading-view restore |
| `page-label-drag.js` | Drag-to-panel support |
| `dev/test.html` | Training Studio entry point (not shipped) |
| `dev/studio/` | Studio modules: pipeline runner, wins-by-detector stats, per-label trace log, 4×6 preview, fix-report export, barcode A/B compare |
| `dev/detector-stack.js` | Shared canonical detection script loader for every dev harness page — one place to add a new detection module (mirrors the production `sidepanel.html` order) |
| `dev/fix-check.html` | IoU scoring harness — runs real pipeline vs. tagged corrections |
| `dev/one-label.html` | Single-label probe — runs one corpus file through the real pipeline and renders top candidates |
| `dev/crop-diag.html` | Crop diagnostic harness — scans a corpus for crop-edge clipping and crop quality issues |
| `dev/model-vs-border.html` | Detector comparison harness — previews current border winner versus forced trained-model crops |
| `dev/bundled-fixtures-harness.js` | Console smoke helper for `dev/test.html` — runs the bundled no-PII fixtures and returns a compact detector-health summary |
| `dev/single-fixture-harness.js` | Staged-file diagnostic for `dev/test.html` — runs one `_diag` PDF/image, captures the real trace, and renders every raw candidate |

## Detection pipeline

The detector runs a deterministic cascade in priority order:

1. Embedded USPS / full-page image labels (highest confidence — early-exits when a strong match is found)
2. Dashed-border and solid-border frames (per-edge segment continuity check filters phantom boxes from heading underlines)
3. Fold-here / label-sized heuristics
4. ONNX YOLO model (refinement / fallback)
5. Keyword, barcode, and text fallbacks

Results are ranked by a composite score: label shape (4×6 gets a boost; extreme aspect ratios a penalty), barcode containment, carrier text, and packing-slip/invoice page penalty (−2 for pure order pages without label cues). The top candidate is presented first.

## Carrier & tracking

After ranking, the top candidate's barcode is decoded on-device (zxing-wasm) and classified:

- **UPS** 1Z (Code128 / MaxiCode), **FedEx** (structured PDF417 + the 30–34 digit ship barcode → last-12 tracking), **USPS** IMpb (GS1 `(420)ZIP(94)…`), plus Amazon TBA and DHL.
- Carriers are check-digit validated against the community `tracking_number_data` set when the code is a single clean tracking number; structured / multi-field codes (FedEx PDF417, USPS GS1) are parsed directly.
- Dense codes that get lost in a full-page scan (FedEx PDF417, wide USPS IMpb) are re-read from a tight, native-resolution crop of each detected barcode region.
- The result shows a **carrier + tracking badge** (click to copy), and the variant that decodes to a real tracking number is promoted to the top — the carrier's own barcode is the strongest evidence of the true label.
- Controlled by `config.js` → `BARCODE`: `ENRICH` (on by default) stamps carrier/tracking metadata only and never changes which page is chosen; `RERANK` (off) lets a decoded carrier promote a near-tie candidate. Added latency is ~40 ms.

## Training Studio

`dev/test.html` runs the real detection pipeline against a local folder of labels. It requires the extension to be loaded (ONNX and pdf.js workers need `chrome.runtime`). Features:

- Per-file trace: cascade stages, early-exit reason, ONNX prediction, full score breakdown
- Wins-by-detector tally
- Inline 4×6 preview at 203 DPI (landscape/oversize warnings)
- Tagged fix-report export (category + note + corrected crop rect) → `dev/fix-report-current.json`
- **Barcode A/B** — runs the set twice (barcode-decode off vs. on) and charts the delta: confident carriers, tracking numbers read, validated codes, and any reranks
- `dev/fix-check.html` harness re-runs the pipeline and scores IoU of the top candidate's output vs. each correction
- A `file://` guard warns when the studio is opened directly (pdf.js / ONNX can't load) — it must be served over http

The training corpus (`dev/samples/`, `dev/fix-labels/`) and reports are gitignored (customer PII).

## Performance notes

- The ONNX model loads on first use, not at panel open.
- Model inference scope is narrowed to pages with label-like candidates — on clean labels with a confident deterministic hit the model never runs.
- Single-page PDFs detect **once**, not twice — a redundant in-`process()` detection pass that the caller always re-ran (and discarded) was removed, cutting ~30–45 % off single-label grabs (e.g. 1.65 s → 0.93 s) with identical results.
- PNG/JPEG processing: upscale adds ~30% time on images only (was the fastest path); PDFs are unaffected.
- All heavy work (pdf.js render, ONNX, pixel scans) runs in the popout's own renderer process — nothing in the extension can delay Outlook's inbox rendering or mail delivery.
- The Outlook content script does nothing while the Outlook tab is hidden (catches up on tab focus).

## Notes

- No backend. No API key. No internet required.
- File URL access required for loading files from Recent downloads.
- Auto-clear warning countdown: 60 seconds.
- Lab mode: available for debug details alongside the default Staff mode.
