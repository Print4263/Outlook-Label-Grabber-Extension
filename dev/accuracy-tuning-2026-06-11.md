# Accuracy tuning from the 81-correction fix report — 2026-06-11 (evening)

Input: the user's training-studio batch over 145 real files (`dev/fix-labels/`,
gitignored) with 81 tagged corrections (`dev/fix-report-current.json`).
Scoring: `dev/fix-check.html` runs the real pipeline per file and computes IoU
between the top candidate's final output rect (`label.sourceRect`, new) and the
corrected crop, in the correction's own coordinate space.

## Results (top-candidate IoU vs corrected crop)

| category         | n  | before | after | <0.5 before → after |
|------------------|----|--------|-------|---------------------|
| missed-label     | 28 | 0.535  | 0.874 | 10 → 0              |
| content-cut-off  | 12 | 0.589  | 0.888 | 6 → 0               |
| extra-whitespace | 24 | 0.651  | 0.918 | 3 → 0               |
| wrong-crop       | 1  | 0.626  | 0.919 | —                   |

Remaining under 0.7: `7052.jpg` (0.52), `IMG_0440.PNG` (0.58), `IMG_5789.jpeg`
(0.65) — phone photos where the ONNX model finds nothing usable (conf
0.09–0.18) or is borderline (0.655); the better crop is offered as variant 2–3.
These are model fine-tune candidates. `FESP` (0.71) wants the address block
above the dashed border annexed across a real white gap — deliberate non-goal
(the gap-stop is what protects multi-label sheets).

Wrong-variant files (no corrected rect): `Safari (2)`, `ReturnShippingLabel`,
`shippinglabel 2` ×2 all now top with the actual label page (was: hallucinated
border box on an instructions page). `Attachment-1` no longer twin-splits.

## What changed

**crop-engine.js**
- `cropCanvas`/`autoCropCanvas` outputs carry `sourceRect` (final crop rect in
  source coords) — diagnostics + studio scoring.
- `innerContentRect`: detected rects are SHRUNK to the content inside them
  before padding/rescue (model boxes, barcode-union and border rects all carry
  blank margins that scaled the printed label down). Opt out per call with
  `shrinkToContent: false`. Content overflowing the rect still gets rescued —
  it's contiguous through the old edge.
- `clampPaddingAtGaps`: blank padding is now trimmed to a small margin
  (max(12px, 0.6% min-dim)) past the farthest related content line; previously
  a fully-blank pad band was kept whole. Gap-stop semantics unchanged; content
  kept by the old behavior is still kept.
- `clampRectTopBelowBlockers` (mirror of the slip-header bottom clamp) for
  cut-line text; no horizontal-overlap requirement (single-column sheets print
  the cut line at the left margin).
- `detectUprightFlip` refactored over exported `barcodeBandStats(canvas)`
  → `{ mass, centroidRatio }`; `FLIP_MIN_MASS` exported.

**label-detector.js**
- Early-exit returns the ranked list computed so far (was: single candidate),
  and is skipped for tall page-filling border boxes (`isTallOverstuffedBorder`,
  h ≥ 1.65×w and ≥45% of page) — the image-only UPS View/Print sheets where the
  model must run.
- PNG/image path now goes through `rankedDetections` (model-over-border
  promotion etc. previously never ran for jpg/png).
- `promoteModelOverBorder`: relaxed gate for tall screenshots (page h ≥ 1.8×w,
  border output ≥85% of page, model conf ≥ 0.55).
- Solid-border: candidate boxes must pass per-edge SEGMENT continuity (every
  quarter of every edge ≥50% dark) — kills phantom boxes anchored on heading
  underlines/dividers whose sides are part-white; falls back to the old
  biggest-box pick when nothing qualifies.
- n-up duplicate sheets: model infers the top duplicate page (was: skipped
  entirely), so promotion applies to the winner (Ellie 0.32 → ~0.87).
- `labelTextScore` +1 for "CUT THIS LABEL / PLACE THIS LABEL / AFFIX THIS
  LABEL / ATTACH THIS LABEL" — multi-page return packets pair one label page
  with instruction pages whose hallucinated boxes otherwise outrank it.
- Model scope: pages DECLARING they carry the label narrow inference to
  themselves (plus pages with hard barcode/return-label cues — NOT the
  embeddedImageCount trigger, which every logo-bearing packet page sets).
  Brought the 5-page return packets from 5.2s back to ~3.9s.
- Text/embedded page fallbacks skipped when a strong (≥0.9, barcode-containing)
  rect-backed candidate exists — their whole-page candidates never outrank it,
  and the app's missing-page crop options cover those pages anyway.
- Border/model rects clamp TOP below cut-line text (Amazon ORC labels have no
  top border line; the right top edge is "below the Cut-this-label line").
- Local `clamp()` added (was a latent ReferenceError outside the sidepanel).

**model-detector.js**
- `MODEL_BOX_PADDING` 0.12 → 0.02: the fat pad annexed instruction text next to
  the label, which the downstream shrink can never remove (it's content).
- Model rect also clamps top below cut-line text.

**pdf-processor.js**
- `findCutLineRects` ("^cut this label") exported per page as `cutLineRects`
  (canvas coords), wired through both render paths.
- Twin-split guard: both bands must be label-plausible (aspect 0.42–2.4) and
  similar in area (≥60%) — a label + narrow side stub no longer splits.

**app/crop.js**
- `orientLabelToPortrait` portrait branch driven by `barcodeBandStats`: strong
  horizontal band → flip-180 only when it sits top-half (unchanged semantics);
  NO horizontal band → quarter-turn probe for sideways content. If a tight
  portrait label rect exists in the upright view, snap-crop it (rotated 4x6
  photographed with junk around). Otherwise (Amazon mobile labels: portrait-
  shaped artwork with sideways content) keep portrait — printing forces
  portrait and would squish a turned canvas — and only normalize the facing
  direction. Normal labels never pay the probe (their upright band is strong).

**dev/test.html** — studio scripts now load with a per-load cache buster: the
studio over plain http could silently batch-grade STALE cached detection
scripts (this is why today's fix report disagreed with the session baseline).

## Perf
Model padding cut + shrink pass don't add meaningful cost; the n-up change
adds ONE inference on duplicate sheets (was zero); tall-overstuffed border
pages now run the model (rare, was early-exit). Worst files on the 145-file
corpus: the three 5-page return packets at ~3.8–4.0s warm (1.8s of that is
pdf.js rendering 5 pages); everything else ≤ ~2.9s. Within the 5s bar.

## Live smoke test (store)
Reload extension → extract a real label → check variants/crop → Rotate/Crop →
print preview → Reprint last. The orientation path changed: verify a sideways
label still prints upright, and an Amazon mobile (sideways-art) label prints
filling the sheet.
