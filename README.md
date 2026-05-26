# Domain Expansion: Print Label (Local)

Microsoft Edge MV3 extension for extracting and printing shipping labels. Runs entirely on-device with no backend server and no API key.

## What It Does

- Adds a large Download Label button for the open Outlook email.
- Keeps Recent downloads as a backup when staff uses Outlook's normal download button.
- Detects shipping labels from PDF, PNG, JPG, JPEG, and GIF files using local detection.
- Shows label results with rotate, crop, print, and expand actions.
- Prints in 4x6 label mode.
- Includes Staff mode by default and Lab mode for debug details.

## Setup

1. Open Edge and go to `edge://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this extension folder.
5. Enable **Allow access to file URLs** in the extension details page.
6. Open Outlook in Edge or the Outlook PWA.

## Workflow

1. Open the label email in Outlook.
2. Click **Download Label** in the extension.
3. If that does not work, use Outlook's own download button.
4. The side panel detects the new download. Click **Use** if needed.
5. Review the label. Use **Crop**, **Rotate**, or **Expand** if needed.
6. Click **Print**.
7. Click **Clear** before the next customer's label.

## Notes

- No backend server. No API key. No internet required for detection.
- File URL access is required for the extension to load files directly from Recent downloads.
- The auto-clear warning countdown is 60 seconds.
