// Renders a PDF with pdf.js, one <div class="page"> per page.
//
// Every page div is sized up front from the page's own dimensions, so the
// scroll height is right before anything is drawn; only pages near the
// viewport hold a canvas, so a 200-page file costs a few canvases, not 200.
//
// Each page div carries an empty .overlay - the layer the editing tools (next
// stage) put their boxes on. Its coordinates are CSS pixels of the page as
// shown; scaleOf() converts them to PDF points, which is what gets saved.

import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const PAGE_GAP = 12;          // matches .page margin-bottom in app.css
const SIDE_PAD = 8;           // CSS px left free on each side at "fit width"
// A canvas this large is the most a phone will reliably allocate; past it the
// page is drawn a little softer instead of not at all.
const MAX_CANVAS_PIXELS = 16_000_000;

export class Viewer {
  constructor(stage, pagesEl) {
    this.stage = stage;
    this.pagesEl = pagesEl;
    this.doc = null;
    this.pages = [];          // {div, canvas, overlay, w, h, rendered, task}
    this.zoom = 1;            // 1 = page width fills the screen
    this.onPagesChanged = () => {};
    this._observer = new IntersectionObserver(
      (entries) => this._onIntersect(entries),
      { root: stage, rootMargin: "150% 0px" });
    this._installPinch();
    window.addEventListener("resize", () => this._relayout(true));
  }

  /** Opens the file. `bytes` is copied: pdf.js takes ownership of what it is
   *  given, and the caller keeps the original for saving. */
  async open(bytes, askPassword) {
    await this.close();
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: new URL("../vendor/pdfjs/cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).href,
      isEvalSupported: false,
      enableXfa: false,
    });
    task.onPassword = async (update, reason) => {
      const pw = await askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
      if (pw === null) task.destroy(); else update(pw);
    };
    this._task = task;
    this.doc = await task.promise;

    for (let i = 1; i <= this.doc.numPages; i++) {
      const page = await this.doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.index = String(i - 1);
      const overlay = document.createElement("div");
      overlay.className = "overlay";
      const no = document.createElement("div");
      no.className = "page-no";
      no.textContent = `${i} מתוך ${this.doc.numPages}`;
      div.append(overlay, no);
      this.pagesEl.append(div);
      this.pages.push({ page, div, overlay, canvas: null, w: vp.width, h: vp.height,
                        rendered: 0, task: null });
    }
    this.zoom = 1;
    this._relayout(false);
    this.stage.scrollTo(0, 0);
    for (const p of this.pages) this._observer.observe(p.div);
    return this.doc.numPages;
  }

  async close() {
    for (const p of this.pages) {
      this._observer.unobserve(p.div);
      p.task?.cancel();
    }
    this.pages = [];
    this.pagesEl.replaceChildren();
    if (this._task) { await this._task.destroy(); this._task = null; }
    this.doc = null;
  }

  setZoom(z, anchor) {
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (!this.pages.length || Math.abs(z - this.zoom) < 0.001) return;
    // Keep the point under `anchor` (screen coords; default: screen centre)
    // where it is, so zooming does not throw her to another part of the page.
    const r = this.stage.getBoundingClientRect();
    const ax = anchor ? anchor.x - r.left : r.width / 2;
    const ay = anchor ? anchor.y - r.top : r.height / 2;
    // (The fixed gaps between pages do not scale, so this is off by a few
    // pixels per page above the anchor - not worth a page-by-page walk.)
    const docX = (this.stage.scrollLeft + ax) / this.zoom;
    const docY = (this.stage.scrollTop + ay) / this.zoom;
    this.zoom = z;
    this._relayout(false);
    this.stage.scrollLeft = docX * this.zoom - ax;
    this.stage.scrollTop = docY * this.zoom - ay;
  }

  /** Width in CSS px that one PDF point is shown at. */
  scaleOf(index) { return this._cssWidth(this.pages[index]) / this.pages[index].w; }

  // ---------------------------------------------------------------- layout

  _availWidth() { return Math.max(100, this.stage.clientWidth - 2 * SIDE_PAD); }

  _widest() { return Math.max(...this.pages.map((p) => p.w)); }

  /** Every page is shown at ONE scale - the widest page fills the screen at
   *  zoom 1 - so a narrower page looks narrower, as it does on paper. */
  _cssWidth(p) { return (this._availWidth() * this.zoom) * (p.w / this._widest()); }

  _relayout(keepScroll) {
    if (!this.pages.length) return;
    const top = this.stage.scrollTop / (this.stage.scrollHeight || 1);
    let maxW = 0;
    for (const p of this.pages) {
      const w = Math.round(this._cssWidth(p));
      const h = Math.round(w * p.h / p.w);
      p.div.style.width = w + "px";
      p.div.style.height = h + "px";
      p.div.style.marginBottom = PAGE_GAP + "px";
      maxW = Math.max(maxW, w);
      p.rendered = 0;               // stale at the new size
    }
    // Wider than the screen: give the strip its full width so it scrolls
    // sideways and the left edge is reachable.
    this.pagesEl.style.width = (maxW + 2 * SIDE_PAD) + "px";
    this.pagesEl.style.minWidth = "100%";
    if (keepScroll) this.stage.scrollTop = top * this.stage.scrollHeight;
    for (const p of this.pages) if (p.visible) this._render(p);
    this.onPagesChanged();
  }

  // ---------------------------------------------------------------- render

  _onIntersect(entries) {
    for (const e of entries) {
      const p = this.pages[Number(e.target.dataset.index)];
      if (!p) continue;
      p.visible = e.isIntersecting;
      if (p.visible) this._render(p);
      else this._release(p);
    }
  }

  _release(p) {
    p.task?.cancel();
    p.task = null;
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    p.rendered = 0;
  }

  async _render(p) {
    const cssW = parseFloat(p.div.style.width);
    let scale = (cssW / p.w) * (window.devicePixelRatio || 1);
    const pixels = (p.w * scale) * (p.h * scale);
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    if (p.rendered === scale) return;
    p.task?.cancel();

    // Draw into a fresh canvas and swap it in only when done: the old one
    // stays on screen meanwhile, so zooming never flashes a white page.
    const canvas = document.createElement("canvas");
    const vp = p.page.getViewport({ scale });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = p.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
    p.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.error(err);
      return;
    }
    if (p.task !== task) return;
    p.task = null;
    if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); }
    p.div.prepend(canvas);
    p.canvas = canvas;
    p.rendered = scale;
  }

  // ---------------------------------------------------------------- pinch

  /** Two-finger zoom. While the fingers move the strip is only stretched with
   *  a CSS transform (cheap); the real re-layout and re-render happen once,
   *  when they lift. The browser's own pinch is switched off in app.css
   *  (touch-action) because it would scale the toolbars too. */
  _installPinch() {
    let start = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    this.stage.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 2 || !this.pages.length) return;
      const r = this.pagesEl.getBoundingClientRect();
      const m = mid(e.touches);
      start = { d: dist(e.touches), m, factor: 1 };
      this.pagesEl.style.transformOrigin = `${m.x - r.left}px ${m.y - r.top}px`;
    }, { passive: true });

    this.stage.addEventListener("touchmove", (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      let f = dist(e.touches) / start.d;
      f = Math.min(MAX_ZOOM / this.zoom, Math.max(MIN_ZOOM / this.zoom, f));
      start.factor = f;
      this.pagesEl.style.transform = `scale(${f})`;
    }, { passive: false });

    const end = () => {
      if (!start) return;
      const { factor, m } = start;
      start = null;
      this.pagesEl.style.transform = "";
      this.setZoom(this.zoom * factor, m);
    };
    this.stage.addEventListener("touchend", end);
    this.stage.addEventListener("touchcancel", end);
  }
}
