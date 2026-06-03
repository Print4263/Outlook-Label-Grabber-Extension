# Domain Expansion: Print Label (Local)

Microsoft Edge MV3 extension for extracting and printing shipping labels. Runs entirely on-device with no backend server and no API key.

## What It Does

- Adds a large Download Label button for the open Outlook email.
- Retries briefly when Outlook is still rendering an email's attachment chip.
- Keeps Recent downloads as a backup when staff uses Outlook's normal download button.
- Detects shipping labels from PDF, PNG, JPG, JPEG, GIF, HEIC, and HEIF files using local detection (HEIC/HEIF are converted to PNG automatically).
- Detects labels even when they are placed sideways or rotated 90° in the source PDF (common on UPS and return labels).
- Auto-orients results upright so sideways labels print correctly as 4x6 without manual rotation.
- Shows label results with rotate, crop, print, and expand actions.
- **Expand** loads the full source page so you can crop to the label yourself when auto-detection comes up short.
- Prints in 4x6 label mode.
- **Display size** control (collapsible, at the bottom) scales the whole panel for low-resolution register screens. It auto-fits to the window on first open and remembers the setting per device.
- Includes Staff mode by default and Lab mode for debug details.

## Setup

1. Open Edge and go to `edge://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this extension folder.
5. Enable **Allow access to file URLs** in the extension details page.
6. Open Outlook in Edge or the Outlook PWA.

> After updating the code, reload the extension at `edge://extensions`, then **close and reopen the panel/popout** — an already-open popout keeps running the old code until it is reopened.

## Workflow

1. Open the label email in Outlook.
2. Click **Download Label** in the extension.
3. If that does not work, use Outlook's own download button.
4. The side panel detects the new download. Click **Use** if needed.
5. Review the label. Use **Crop**, **Rotate**, or **Expand** if needed.
6. Click **Print**.
7. Click **Clear** before the next customer's label.

## Display size (low-resolution screens)

If the panel looks clipped or too large on a register screen (for example a 720p display), open the **Display size** section at the bottom:

- Drag the slider or use **−/+** to scale the whole panel.
- Click **Fit** to auto-size it to the current window.

The chosen size is saved on that device only and is applied before the panel paints, so each register can have its own setting without affecting other PCs.

## Project structure

The UI runs from `sidepanel.html`, which loads a lean core (`sidepanel.js` — state, init, event wiring, rendering, and the extraction/print orchestration) plus four focused, plain-script modules under `app/`: `app/print.js` (monochrome conversion + print HTML + the print window flow), `app/downloads.js` (the Recent-downloads list, intake, and Use/Show/Clear/preview actions), `app/crop.js` (the crop editor plus image transforms like auto-orient and rotate-to-portrait), and `app/detect.js` (turning local-detector output into ranked label candidates and fallbacks). These are classic (non-module) scripts that share global scope, so they behave exactly as the original single file. The on-device detection engine lives in `detection/` (`label-detector.js`, `pdf-processor.js`, `png-processor.js`, `crop-engine.js`, `model-detector.js`), third-party libraries in `lib/` (pdf.js, ONNX Runtime, heic2any), the ONNX model in `models/`, the service worker in `background.js`, and the Outlook/page content scripts in `outlook-reader.js` and `page-label-drag.js`. The `dev/` folder holds the detection test harness and sample fixtures and is not part of the shipped extension.

## Notes

- No backend server. No API key. No internet required for detection.
- File URL access is required for the extension to load files directly from Recent downloads.
- The auto-clear warning countdown is 60 seconds.
- The ONNX detection model loads on first use (not at panel open) to keep startup fast.
