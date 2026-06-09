(function () {
  "use strict";
  const Studio = window.Studio;
  if (!Studio) return;

  // True print geometry for the store's thermal labels: 4×6 inches at 203 DPI.
  const DPI = 203;
  const PAGE_W = 4 * DPI;   // 812
  const PAGE_H = 6 * DPI;   // 1218

  let overlay = null, pageEl = null, imgEl = null, infoEl = null, fitBtn = null;
  let zoomMode = "fit";     // "fit" | "actual"
  let rotation = 0;         // degrees, for inspection
  let current = null;       // { candidate, cardModel }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "preview-overlay";
    overlay.innerHTML = `
      <div class="preview-shell">
        <div class="preview-toolbar">
          <strong>In-store preview</strong>
          <span class="preview-spec">4.00 × 6.00 in · ${PAGE_W}×${PAGE_H}px @ ${DPI} DPI</span>
          <button type="button" data-act="fit">Actual size (100%)</button>
          <button type="button" data-act="rotate">Rotate 90°</button>
          <span class="preview-info"></span>
          <button type="button" data-act="close" class="preview-close">Close ✕</button>
        </div>
        <div class="preview-scroll">
          <div class="preview-page">
            <div class="preview-ruler-h"></div>
            <div class="preview-ruler-v"></div>
            <img class="preview-img" alt="label as printed">
          </div>
        </div>
      </div>`;
    document.body.append(overlay);
    pageEl = overlay.querySelector(".preview-page");
    imgEl = overlay.querySelector(".preview-img");
    infoEl = overlay.querySelector(".preview-info");
    fitBtn = overlay.querySelector('[data-act="fit"]');

    overlay.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (act === "close" || e.target === overlay) close();
      else if (act === "fit") { zoomMode = zoomMode === "fit" ? "actual" : "fit"; layout(); }
      else if (act === "rotate") { rotation = (rotation + 90) % 360; render(); }
    });
    document.addEventListener("keydown", (e) => {
      if (overlay.classList.contains("open") && e.key === "Escape") close();
    });
  }

  function open(candidate, cardModel) {
    if (!candidate?.label?.dataUrl) return;
    ensureOverlay();
    current = { candidate, cardModel };
    rotation = 0;
    render();
    overlay.classList.add("open");
  }

  function render() {
    const label = current.candidate.label;
    imgEl.src = label.dataUrl;
    const lw = Number(label.width || 0), lh = Number(label.height || 0);
    // Effective dimensions after inspection rotation.
    const rotated = rotation % 180 !== 0;
    const ew = rotated ? lh : lw, eh = rotated ? lw : lh;
    const landscape = ew > eh;
    const fitsW = ew <= PAGE_W + 2, fitsH = eh <= PAGE_H + 2;
    infoEl.innerHTML =
      `label ${lw}×${lh}px` + (rotation ? ` (rotated ${rotation}°)` : "") +
      ` · ${(ew / DPI).toFixed(2)}×${(eh / DPI).toFixed(2)} in` +
      (landscape ? ` · <span class="preview-warn">LANDSCAPE — would rotate to print</span>` : "") +
      (!fitsW || !fitsH ? ` · <span class="preview-warn">larger than 4×6 — will scale to fit</span>` : "");
    imgEl.style.transform = `rotate(${rotation}deg)`;
    layout();
  }

  function layout() {
    const scrollH = overlay.querySelector(".preview-scroll").clientHeight || window.innerHeight * 0.8;
    const scale = zoomMode === "fit" ? Math.min(1, (scrollH - 40) / PAGE_H) : 1;
    pageEl.style.width = `${PAGE_W * scale}px`;
    pageEl.style.height = `${PAGE_H * scale}px`;
    fitBtn.textContent = zoomMode === "fit" ? "Actual size (100%)" : "Fit to screen";
  }

  function close() {
    if (overlay) overlay.classList.remove("open");
    current = null;
  }

  function bindThumb(img, candidate, cardModel) {
    img.style.cursor = "zoom-in";
    img.addEventListener("click", () => open(candidate, cardModel));
  }

  Studio.preview = { open, bindThumb };

  window.addEventListener("resize", () => { if (overlay?.classList.contains("open")) layout(); });
})();
