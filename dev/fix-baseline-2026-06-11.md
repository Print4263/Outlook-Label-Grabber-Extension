# Fix-report baseline (before tuning) — 2026-06-11

Scored with dev/fix-check.html against fix-report-current.json (81 corrections,
70 with corrected rects). IoU of pipeline top candidate's final output rect vs
the user's corrected crop, in the correction's own coordinate space.

## By category (top-candidate IoU)
- missed-label:     n=28 mean 0.535 (10 under 0.5)
- content-cut-off:  n=13 mean 0.589 (6 under 0.5)
- extra-whitespace: n=26 mean 0.651 (3 under 0.5)
- wrong-crop:       n=1  0.626
- bad-rotation:     n=1 scored 0.872 (rest have no rect)
- untagged:         n=1  0.993

## Key findings
1. cover=1.0 on nearly every scored file: the pipeline over-includes, almost
   never cuts. The excess is (a) blank padding kept by clampPaddingAtGaps when
   the pad band is blank (it only clamps at unrelated content), and (b) blank
   margins inside the detection rect itself (model boxes especially: 12% model
   pad + 12% crop pad).
2. trained-model now tops many files in this corpus (promoteModelOverBorder) —
   the user's studio batch apparently ran with stale cached scripts, because the
   report says solid-border chose, but current code already promotes the model
   on those files. Model boxes are well-placed but bloated.
3. PNG/image path (detectAllPngCandidates) never runs rankedDetections — no
   model-over-border promotion on jpg/png screenshots.
4. Ellie n-up: model skip leaves solid-border instruction box on top (0.315).
5. eBay family: user extends label region LEFT past a white gutter (sideways
   strip at x≈283..422). Needs visual check; rescue stops at the gap.
6. wrong-variant-chosen files (ReturnShippingLabel, shippinglabel 2 x2,
   Safari (2)): dashed-border 0.97 early-exits the whole cascade; single
   candidate. corrected=null so no target rect; needs visual check.
7. FESP: corrected crop reaches y=0 (address block above the dashed border,
   beyond a sustained white gap). True annexation case; deliberate non-goal?
