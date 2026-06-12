# Image-to-PDF conversion evaluation — 2026-06-11

Question: should JPEG/PNG/WEBP/screenshot inputs be converted to PDF before
analysis? **No — but the one real effect PDF conversion would have (resolution
normalization) is worth having, so it's now done directly in png-processor.**

## Why PDF conversion itself is a no-op (or worse) for this pipeline

- The pipeline is pixel-based end to end: pdf.js RASTERIZES every PDF page to
  a canvas before any detector runs. An image wrapped in a PDF comes back out
  as… the same pixels, after an encode + parse + render round trip.
- There is no OCR step that prefers PDFs: page "text" comes from the PDF's
  embedded text objects. An image-wrapped PDF has none, so text-based
  detectors gain nothing.
- Barcode detection and orientation detection read pixels; identical either way.
- JPEG re-encoding into a PDF container can only lose quality; the round trip
  costs time and memory.

## The one real difference: render resolution

pdf-processor renders pages at scale `min(4, max(3, 1200/pageWidthPt))` — an
image-wrapped PDF would effectively be processed at ~2-3x the image's native
pixels. That part IS valuable: hairline label borders and dash patterns on
phone screenshots are 1-2px at native resolution, at or below the border
detectors' sampling steps.

Measured on the 26-image corpus (direct vs 2.25x upscaled, IoU vs the user's
corrected crops on the 19 scored files):

- 7052.jpg: 0.52 -> 0.74 (+0.22) in the controlled test (knife-edge: 2.25x
  finds the dashes, 2.27x in production does not — left as a model fine-tune
  candidate)
- IMG_0440.PNG: 0.58 -> 0.68 (+0.10) — holds in production
- Most others: +0.01..+0.03; IMG_9725 -0.07 (detector flip, still 0.85)
- Cost: ~+30% per image (~700 -> ~900 ms) — images are the fastest inputs

## Implementation

`png-processor.process` now upscales images whose processed width is under
2400px to a ~3000px target (max 3x, max 20MP), with high-quality smoothing —
the same pixels a PDF render would produce, with no container round trip.
Everything downstream is scale-agnostic (rects live in processed-canvas
coordinates; print rescales to 203 DPI).

Final image-corpus score after implementation: mean IoU 0.825 (was 0.815
native), no file regressed below its previous bucket, worst file 975 ms.
