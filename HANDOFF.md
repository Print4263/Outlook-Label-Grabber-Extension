# Handoff

## Current state

The optional Multi-Label Queue has been ported to `main` in Extension AIO. It stays off by default and only activates when staff clicks the launcher.

## What changed

- Moved the inactive `Multi-Label Queue` trigger into the Recent downloads header next to `Clear list`, and removed the separate launcher panel.
- Added queue mode UI with active-state styling, queue count, clear, print, and exit controls.
- Added queue-ready print batching so several reviewed labels open in one print job.
- Kept the normal single-label workflow unchanged unless queue mode is explicitly activated.

## Verification

- Added queue unit tests at `dev/print-queue-tests.js`.
- Added print-document tests at `dev/print-output-tests.js`.
- Updated the production print flow to support both single-label and batched queue jobs.

## Notes

- Historical June 11 diagnostic notes in `dev/*.md` were left untouched because they are archived analysis, not living state.
- The queue stays disabled until a staff member clicks the launcher.
