// Everything she adds to the document, on screen: free text, ✓ marks and
// dates on any page, and the values of the form's own fields.
//
// The model is plain data - `items` and `values` - and the DOM is redrawn
// from it. Undo is a stack of snapshots of that data, nothing cleverer.
// Positions are in page units (see layout.js); the writer turns them into
// PDF coordinates when the file is saved.
//
// Text is shown and edited in ONE element (contenteditable), in the same font
// and line height the writer uses, so what she types is what gets saved.

import {
  FONT_FAMILY, FONT_URL, LINE_HEIGHT, CHECK_PATH, CHECK_STROKE, SIGN_WIDTH, isRtl, todayText,
  visualLine,
} from "./layout.js";
import { signatureSvg } from "./signature.js";

const TEXT_SIZE = 12;          // points, a new text item
const CHECK_SIZE = 14;         // points, side of a new ✓
const MIN_SIZE = 6, MAX_SIZE = 48;
const MIN_SIGN = 30, MAX_SIGN = 400;   // points, a signature's width
const SIZE_STEP = 1.15;
const DRAG_SLOP = 6;           // CSS px a finger may wander before a tap becomes a drag

let nextId = 1;

export class Editor {
  constructor(viewer, ui) {
    this.viewer = viewer;
    this.ui = ui;              // {toast, onToolChange(tool), onHistoryChange(canUndo)}
    this.tool = null;          // "text" | "check" | "date" | "sign" | "detail" | null
    this.items = [];
    this.values = {};          // field name -> value
    this.original = {};        // field name -> value as the file had it
    this.fields = [];          // widget descriptors (see _readFields)
    this.history = [];
    this.selected = null;      // item id
    this.editing = null;       // item id being typed into
    this.fontReady = loadFont();
    this._bar = this._makeBar();
    viewer.onPagesChanged = () => this.layout();
  }

  // ---------------------------------------------------------------- document

  /** Called after the viewer opened a file. */
  async attach() {
    this.reset();
    await this.fontReady;
    this.fields = await this._readFields();
    for (const f of this.fields) {
      if (!(f.name in this.values)) this.values[f.name] = f.value;
    }
    this.original = { ...this.values };
    this._buildFieldElements();
    this.layout();
  }

  reset() {
    this.items = [];
    this.values = {};
    this.original = {};
    this.fields = [];
    this.history = [];
    this.selected = null;
    this.editing = null;
    this._lastField = null;
    this.setTool(null);
    this.ui.onHistoryChange(false);
  }

  hasEdits() {
    return this.items.length > 0 ||
      Object.keys(this.values).some((k) => this.values[k] !== this.original[k]);
  }

  /** What the writer needs. Only fields she changed are listed: a field she
   *  never touched keeps the file's own appearance, byte for byte. */
  exportEdits() {
    this._finishEditing();
    const fields = [];
    for (const name of Object.keys(this.values)) {
      if (this.values[name] === this.original[name]) continue;
      const f = this.fields.find((x) => x.name === name);
      if (!f || f.readOnly) continue;
      const opt = f.options?.find((o) => o.value === this.values[name]);
      fields.push({ name, type: f.kind, value: this.values[name], display: opt?.label });
    }
    return {
      items: this.items.map((i) => ({ ...i })),
      fields,
      pages: this.viewer.pages.map((p) => ({ view: p.page.view, rotate: p.page.rotate })),
    };
  }

  /** For a file saved as pictures (writer.exportImagePdf): every field's
   *  CURRENT value as an ordinary item, since there are no fields any more.
   *  The pictures are rendered without fields, so ALL values are needed,
   *  changed or not. Placed the way the field shows it: one line centred
   *  vertically, Hebrew against the right edge. */
  fieldItems() {
    const out = [];
    for (const f of this.fields) {
      const v = this.values[f.name] ?? "";
      const { x, y, w, h } = f.rect;
      if (f.kind === "check" || f.kind === "radio") {
        if (v !== f.onValue) continue;     // each widget has its own "on" value
        out.push({ page: f.page, kind: "check", x: x + w / 2, y: y + h / 2, size: Math.min(w, h) * 0.85 });
        continue;
      }
      let text = f.kind === "choice" ? (f.options?.find((o) => o.value === v)?.label ?? v) : v;
      if (!text.trim()) continue;
      if (!f.multiline) text = text.replace(/\n/g, " ");
      const size = f.fontSize || Math.max(6, Math.min(12, (h - 4) / 1.2));
      const rtl = isRtl(text);
      const lines = text.split("\n").length;
      const top = f.multiline ? y + 2 : y + (h - size * LINE_HEIGHT * lines) / 2;
      // A text item is anchored where its writing STARTS: Hebrew at the
      // field's right edge, anything else at its left.
      out.push({ page: f.page, kind: "text", size, text, x: rtl ? x + w - 2 : x + 2, y: top });
    }
    return out;
  }

  // ---------------------------------------------------------------- draft
  // What app.js keeps in the phone's storage, so a reload or a closed app
  // brings her work back. Includes the text she is typing RIGHT NOW: an app
  // swiped away mid-word must not lose the word.

  draft() {
    const items = this.items.map((i) => ({ ...i }));
    if (this.editing != null) {
      const el = document.querySelector(`.item[data-id="${this.editing}"]`);
      const it = items.find((i) => i.id === this.editing);
      if (el && it) it.text = el.innerText.replace(/\s+$/, "");
    }
    return { items: items.filter((i) => i.kind !== "text" || i.text), values: { ...this.values } };
  }

  /** After attach(): put a saved draft back. Fields are matched by name, so a
   *  value for a field this file does not have is simply dropped. */
  restore(draft) {
    if (!draft) return;
    this.items = (draft.items || []).filter((i) => i.page < this.viewer.pages.length);
    for (const i of this.items) nextId = Math.max(nextId, i.id + 1);
    for (const [k, v] of Object.entries(draft.values || {})) if (k in this.values) this.values[k] = v;
    this._syncFieldElements();
    this.layout();
  }

  // ---------------------------------------------------------------- tools

  /** `payload` goes with "sign" (the signature the next tap places) and with
   *  "detail" (the text of one of her personal details). */
  setTool(tool, payload = null) {
    this.tool = this.tool === tool && !payload ? null : tool;
    this.pendingSig = this.tool === "sign" ? payload : null;
    this.pendingText = this.tool === "detail" ? payload : null;
    if ((this.tool === "sign" || this.tool === "detail") && !payload) this.tool = null;
    if (this.tool) this._select(null);
    document.body.classList.toggle("tool-armed", !!this.tool);
    this.ui.onToolChange(this.tool);
  }

  /** A tap on an empty spot of a page. */
  _onPageTap(index, x, y) {
    if (!this.tool) { this._select(null); return; }
    const tool = this.tool;
    this._checkpoint();
    if (tool === "check") {
      this.items.push({ id: nextId++, page: index, kind: "check", x, y, size: CHECK_SIZE });
      this.layout();
      return;     // ✓ stays armed: a form usually wants several
    }
    if (tool === "sign") {
      const item = { id: nextId++, page: index, kind: "sign", x, y, w: SIGN_WIDTH, sig: this.pendingSig };
      this.items.push(item);
      this.setTool(null);
      this._select(item.id);
      return;
    }
    const text = tool === "date" ? todayText() : tool === "detail" ? this.pendingText : "";
    const size = TEXT_SIZE;
    const item = { id: nextId++, page: index, kind: "text", x, y: y - size * LINE_HEIGHT / 2, size, text };
    this.items.push(item);
    this.setTool(null);
    if (tool === "date" || tool === "detail") { this._select(item.id); this.layout(); }
    else { this.layout(); this._edit(item.id, true); }
  }

  /** The text field she was typing in a moment ago (the button she just
   *  tapped took its focus), or null. Asked once per tap: the next press of
   *  the button is about the page again, not about that field. */
  recentField() {
    const r = this._lastField;
    this._lastField = null;
    if (!r || Date.now() - r.at > 1500 || r.f.readOnly || !r.f.el?.isConnected) return null;
    return r.f;
  }

  /** Put text into a form field, as one undo step. Respects its length limit. */
  fillField(f, text) {
    if (!f.multiline) text = text.replace(/\n/g, " ");
    if (f.maxLen) text = text.slice(0, f.maxLen);
    this._checkpoint();
    this.values[f.name] = text;
    this._syncFieldElements();
  }

  // ---------------------------------------------------------------- undo

  _snapshot() {
    return JSON.stringify({ items: this.items, values: this.values });
  }

  /** Call BEFORE a change: the state to go back to. */
  _checkpoint(snap = this._snapshot()) {
    if (this.history[this.history.length - 1] === snap) return;
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.ui.onHistoryChange(true);
  }

  undo() {
    this._finishEditing();
    const snap = this.history.pop();
    if (!snap) return;
    const s = JSON.parse(snap);
    this.items = s.items;
    this.values = s.values;
    this.selected = null;
    this._syncFieldElements();
    this.layout();
    this.ui.onHistoryChange(this.history.length > 0);
  }

  // ---------------------------------------------------------------- layout

  /** Re-place everything at the current zoom. Cheap: a few dozen elements. */
  layout() {
    for (const [index, p] of this.viewer.pages.entries()) {
      const s = this.viewer.scaleOf(index);
      if (!p.overlay._wired) this._wireOverlay(p.overlay, index);
      // items: rebuilt (except the one being typed into, which keeps focus)
      for (const el of [...p.overlay.querySelectorAll(".item")]) {
        if (Number(el.dataset.id) !== this.editing) el.remove();
      }
      for (const item of this.items.filter((i) => i.page === index)) {
        let el = p.overlay.querySelector(`.item[data-id="${item.id}"]`);
        if (!el) { el = this._itemElement(item); p.overlay.append(el); }
        this._placeItem(el, item, s);
      }
      for (const f of this.fields.filter((f) => f.page === index)) this._placeField(f, s);
    }
    this._placeBar();
  }

  _placeItem(el, item, s) {
    el.classList.toggle("selected", item.id === this.selected);
    if (item.kind === "sign") {
      const w = item.w * s, h = w * item.sig.h / item.sig.w;
      Object.assign(el.style, { left: item.x * s - w / 2 + "px", top: item.y * s - h / 2 + "px",
                                width: w + "px", height: h + "px" });
      return;
    }
    if (item.kind === "check") {
      const side = item.size * s;
      Object.assign(el.style, { left: item.x * s - side / 2 + "px", top: item.y * s - side / 2 + "px",
                                width: side + "px", height: side + "px" });
      return;
    }
    const pageW = this.viewer.pages[item.page].w * s;
    const text = item.id === this.editing ? el.innerText : item.text;
    const rtl = text ? isRtl(text) : true;     // empty: Hebrew is what she will type
    el.dir = rtl ? "rtl" : "ltr";
    el.style.fontSize = item.size * s + "px";
    el.style.top = item.y * s + "px";
    // Anchored where she tapped: Hebrew grows leftwards from it, English rightwards.
    if (rtl) { el.style.right = pageW - item.x * s + "px"; el.style.left = "auto"; }
    else { el.style.left = item.x * s + "px"; el.style.right = "auto"; }
    el.classList.toggle("cells", !!item.cell);
    if (item.id === this.editing) {
      // Typing in box mode: plain text spread out roughly to the cells (a
      // contenteditable full of cells is no place to type). Equal-width
      // digits keep it close; the exact cells come back when she is done.
      el.style.letterSpacing = item.cell ? `${(item.cell - item.size * 0.6) * s}px` : "";
      return;
    }
    el.style.letterSpacing = "";
    if (item.cell) {
      // Exactly what writer.js draws: the line in visual order, one character
      // centred per cell, laid out left to right.
      el.dir = "ltr";
      const key = `${item.text}|${item.cell}`;
      if (el.dataset.cells !== key) {
        el.replaceChildren();
        item.text.split("\n").forEach((line, i) => {
          if (i) el.append(document.createElement("br"));
          for (const ch of visualLine(line, rtl)) {
            const c = document.createElement("span");
            c.className = "cell";
            c.textContent = ch;
            el.append(c);
          }
        });
        el.dataset.cells = key;
      }
      el.style.setProperty("--cell", item.cell * s + "px");
      return;
    }
    delete el.dataset.cells;
    if (el.textContent !== item.text || el.querySelector(".cell")) el.textContent = item.text;
  }

  _itemElement(item) {
    const el = document.createElement("div");
    el.className = "item " + item.kind;
    el.dataset.id = String(item.id);
    if (item.kind === "check") {
      el.innerHTML = `<svg viewBox="0 0 24 24"><path d="${CHECK_PATH}" stroke-width="${CHECK_STROKE}"/></svg>`;
    } else if (item.kind === "sign") {
      el.innerHTML = signatureSvg(item.sig);
    } else {
      el.textContent = item.text;
    }
    this._wireItem(el);
    return el;
  }

  // ---------------------------------------------------------------- items: input

  _wireOverlay(overlay, index) {
    overlay._wired = true;
    // `click`, not pointer events: the browser only fires it for a tap that
    // did not turn into a scroll or a pinch, which is exactly the rule wanted.
    overlay.addEventListener("click", (e) => {
      if (e.target !== overlay) return;
      if (this.editing) { this._finishEditing(); return; }
      const r = overlay.getBoundingClientRect();
      const s = this.viewer.scaleOf(index);
      this._onPageTap(index, (e.clientX - r.left) / s, (e.clientY - r.top) / s);
    });
  }

  _wireItem(el) {
    let start = null;
    el.addEventListener("pointerdown", (e) => {
      const id = Number(el.dataset.id);
      if (id === this.editing) return;          // let the caret move
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      const item = this._item(id);
      start = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y, snap: this._snapshot(), moved: false };
    });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      start.moved = true;
      const item = this._item(Number(el.dataset.id));
      const s = this.viewer.scaleOf(item.page);
      item.x = start.ix + dx / s;
      item.y = start.iy + dy / s;
      this._selected(item.id);
      this._placeItem(el, item, s);
      this._placeBar();
    });
    const end = () => {
      if (!start) return;
      const { moved, snap } = start;
      start = null;
      const id = Number(el.dataset.id);
      if (moved) { this._checkpoint(snap); return; }
      // A tap: the first selects, a second on a selected text item edits it.
      const item = this._item(id);
      if (this.selected === id && item.kind === "text") this._edit(id, false);
      else this._select(id);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", () => { start = null; });
  }

  _item(id) { return this.items.find((i) => i.id === id); }

  _selected(id) { this.selected = id; }

  _select(id) {
    if (this.editing && this.editing !== id) this._finishEditing();
    this.selected = id;
    this.layout();
  }

  _edit(id, isNew) {
    const item = this._item(id);
    const p = this.viewer.pages[item.page];
    const el = p.overlay.querySelector(`.item[data-id="${id}"]`);
    if (!el) return;
    this.selected = id;
    this.editing = id;
    this._editStart = { snap: isNew ? null : this._snapshot(), text: item.text };
    if (el.dataset.cells != null) { el.textContent = item.text; delete el.dataset.cells; }  // cells -> plain
    el.contentEditable = "plaintext-only";
    el.classList.add("editing");
    el.oninput = () => this._placeItem(el, item, this.viewer.scaleOf(item.page));
    el.onblur = () => this._finishEditing();
    el.focus();
    placeCaretAtEnd(el);
    this.layout();
  }

  _finishEditing() {
    const id = this.editing;
    if (id == null) return;
    this.editing = null;
    const item = this._item(id);
    const el = document.querySelector(`.item[data-id="${id}"]`);
    if (el) {
      el.contentEditable = "false";
      el.classList.remove("editing");
      el.oninput = el.onblur = null;
    }
    if (!item) return;
    const text = (el ? el.innerText : item.text).replace(/\s+$/, "");
    const { snap, text: before } = this._editStart || {};
    if (!text) {
      // Emptied: the item goes. A brand-new empty one leaves no undo step.
      this.items = this.items.filter((i) => i.id !== id);
      if (snap) this._checkpoint(snap);
      this.selected = null;
    } else if (text !== before) {
      if (snap) this._checkpoint(snap);
      item.text = text;
    }
    this.layout();
  }

  // ---------------------------------------------------------------- the bar
  // Floats above the selected item: edit, smaller, bigger, delete.

  _makeBar() {
    const bar = document.createElement("div");
    bar.className = "item-bar";
    bar.hidden = true;
    bar.innerHTML = `
      <div class="bar-row">
        <button type="button" data-act="edit">עריכה</button>
        <button type="button" data-act="smaller" aria-label="הקטנה">A−</button>
        <button type="button" data-act="bigger" aria-label="הגדלה">A+</button>
        <button type="button" data-act="cells" aria-label="תיבות - כל תו בתיבה משלו">תיבות</button>
        <button type="button" data-act="delete" class="danger">מחיקה</button>
      </div>
      <label class="bar-cells" hidden><span>רוחב תיבה</span>
        <input type="range" step="0.1"></label>`;
    // pointerdown + preventDefault keeps the keyboard up while typing - but
    // not on the slider, which needs the touch to move.
    bar.addEventListener("pointerdown", (e) => { if (e.target.type !== "range") e.preventDefault(); });

    // The cell-width slider: one undo step per drag, live on the page.
    const range = bar.querySelector('input[type="range"]');
    let dragSnap = null;
    range.addEventListener("pointerdown", () => { dragSnap = this._snapshot(); });
    range.addEventListener("input", () => {
      const item = this._item(this.selected);
      if (!item?.cell) return;
      if (dragSnap) { this._checkpoint(dragSnap); dragSnap = null; }
      item.cell = Number(range.value);
      this.layout();
    });
    range.addEventListener("change", () => { dragSnap = null; });

    bar.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      const item = this._item(this.selected);
      if (!act || !item) return;
      if (act === "edit") { this._edit(item.id, false); return; }
      if (act === "cells") {
        this._checkpoint();
        // On: start near the letters' own width, so nothing jumps; then she
        // widens it until the characters sit in the form's boxes.
        item.cell = item.cell ? null : Math.round(item.size * 0.8 * 10) / 10;
        this.layout();
        return;
      }
      if (act === "delete") {
        if (this.editing === item.id) this.editing = null;
        this._checkpoint();
        this.items = this.items.filter((i) => i.id !== item.id);
        this.selected = null;
        this.layout();
        return;
      }
      const f = act === "bigger" ? SIZE_STEP : 1 / SIZE_STEP;
      if (item.kind === "sign") {
        const w = Math.min(MAX_SIGN, Math.max(MIN_SIGN, item.w * f));
        if (w === item.w) return;
        this._checkpoint();
        item.w = w;            // centred, so it grows around its middle
        this.layout();
        return;
      }
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, item.size * f));
      if (size === item.size) return;
      if (this.editing !== item.id) this._checkpoint();
      else if (this._editStart && !this._editStart.sized) {
        // Resizing while typing: one undo step for the size, taken now.
        this._checkpoint(this._editStart.snap ?? this._snapshot());
        this._editStart.sized = true;
      }
      // Keep the middle of the first line where it was.
      if (item.kind === "text") item.y += (item.size - size) * LINE_HEIGHT / 2;
      item.size = size;
      this.layout();
    });
    return bar;
  }

  _placeBar() {
    const bar = this._bar;
    const item = this._item(this.selected);
    if (!item) { bar.hidden = true; return; }
    const p = this.viewer.pages[item.page];
    const el = p?.overlay.querySelector(`.item[data-id="${item.id}"]`);
    if (!el) { bar.hidden = true; return; }
    if (bar.parentElement !== p.overlay) p.overlay.append(bar);
    bar.querySelector('[data-act="edit"]').hidden = item.kind !== "text" || this.editing === item.id;
    // "A" is about letters; a ✓ or a signature just gets smaller or bigger.
    const isText = item.kind === "text";
    bar.querySelector('[data-act="smaller"]').textContent = isText ? "A−" : "−";
    bar.querySelector('[data-act="bigger"]').textContent = isText ? "A+" : "+";
    const cellsBtn = bar.querySelector('[data-act="cells"]');
    cellsBtn.hidden = !isText;
    cellsBtn.classList.toggle("on", !!item.cell);
    const cells = bar.querySelector(".bar-cells");
    cells.hidden = !(isText && item.cell);
    if (!cells.hidden) {
      const r = cells.querySelector("input");
      r.min = String(Math.round(item.size * 0.4 * 10) / 10);
      r.max = String(Math.round(item.size * 4 * 10) / 10);
      if (document.activeElement !== r) r.value = String(item.cell);
    }
    bar.hidden = false;
    // Above the item, kept inside the page; below it when there is no room.
    const pw = p.overlay.clientWidth;
    const top = el.offsetTop - bar.offsetHeight - 8;
    const left = Math.min(Math.max(0, el.offsetLeft + el.offsetWidth / 2 - bar.offsetWidth / 2),
                          Math.max(0, pw - bar.offsetWidth));
    bar.style.left = left + "px";
    bar.style.top = (top >= 0 ? top : el.offsetTop + el.offsetHeight + 8) + "px";
  }

  // ---------------------------------------------------------------- form fields

  async _readFields() {
    const out = [];
    for (const [index, p] of this.viewer.pages.entries()) {
      let annots = [];
      try { annots = await p.page.getAnnotations({ intent: "display" }); } catch { /* none */ }
      const vp = p.page.getViewport({ scale: 1 });
      for (const a of annots) {
        if (a.subtype !== "Widget" || !a.fieldName) continue;
        if (a.hidden || (a.annotationFlags & 0b100010)) continue;   // Hidden | NoView
        let kind = null;
        if (a.fieldType === "Tx") kind = "text";
        else if (a.fieldType === "Btn" && a.checkBox) kind = "check";
        else if (a.fieldType === "Btn" && a.radioButton) kind = "radio";
        else if (a.fieldType === "Ch" && a.combo) kind = "choice";
        if (!kind) continue;      // push buttons, signature boxes, list boxes
        const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
        const rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
        let value = a.fieldValue ?? "";
        if (Array.isArray(value)) value = value[0] ?? "";
        if (kind === "check" && value !== a.exportValue) value = "Off";
        out.push({
          page: index, name: a.fieldName, kind, rect, value: String(value),
          onValue: kind === "check" ? a.exportValue : kind === "radio" ? a.buttonValue : null,
          multiline: !!a.multiLine, comb: a.comb ? a.maxLen : 0, maxLen: a.maxLen || 0,
          align: a.textAlignment || 0, fontSize: a.defaultAppearanceData?.fontSize || 0,
          readOnly: !!a.readOnly,
          options: a.options?.map((o) => ({ value: o.exportValue, label: o.displayValue })),
          el: null,
        });
      }
    }
    return out;
  }

  _buildFieldElements() {
    for (const f of this.fields) {
      const overlay = this.viewer.pages[f.page].overlay;
      let el;
      if (f.kind === "check" || f.kind === "radio") {
        el = document.createElement("button");
        el.type = "button";
        el.className = "field f-" + f.kind;
        el.innerHTML = f.kind === "check"
          ? `<svg viewBox="0 0 24 24"><path d="${CHECK_PATH}" stroke-width="${CHECK_STROKE}"/></svg>`
          : "<span></span>";
        el.addEventListener("click", () => {
          if (f.readOnly) return;
          this._checkpoint();
          const on = this.values[f.name] === f.onValue;
          // A ✓ toggles; a radio button only ever selects (as on paper).
          this.values[f.name] = f.kind === "check" && on ? "Off" : f.onValue;
          this._syncFieldElements();
        });
      } else if (f.kind === "choice") {
        el = document.createElement("select");
        el.className = "field f-choice";
        for (const o of f.options || []) el.add(new Option(o.label, o.value));
        el.addEventListener("focus", () => { el._snap = this._snapshot(); });
        el.addEventListener("change", () => {
          this._checkpoint(el._snap);
          this.values[f.name] = el.value;
          this._syncFieldElements();
        });
      } else {
        el = document.createElement(f.multiline ? "textarea" : "input");
        if (!f.multiline) el.type = "text";
        el.className = "field f-text" + (f.comb ? " comb" : "");
        el.dir = f.comb ? "ltr" : "auto";
        el.spellcheck = false;
        el.autocomplete = "off";
        if (f.maxLen) el.maxLength = f.maxLen;
        el.addEventListener("focus", () => {
          el._snap = this._snapshot();
          this._select(null);
          this._lastField = { f, at: Infinity };
        });
        // Tapping a toolbar button takes the focus first: remember the field a
        // moment longer, so "פרטים" can fill the field she was in.
        el.addEventListener("blur", () => { if (this._lastField?.f === f) this._lastField.at = Date.now(); });
        el.addEventListener("input", () => {
          this.values[f.name] = el.value;
          // Same field on another widget (a name repeated on page 2) follows.
          for (const g of this.fields) if (g !== f && g.name === f.name && g.el) g.el.value = el.value;
        });
        el.addEventListener("change", () => {
          if (el._snap && JSON.parse(el._snap).values[f.name] !== el.value) this._checkpoint(el._snap);
          el._snap = this._snapshot();
        });
      }
      el.disabled = f.readOnly;
      el.setAttribute("aria-label", f.name);
      f.el = el;
      overlay.append(el);
    }
    this._syncFieldElements();
  }

  _syncFieldElements() {
    for (const f of this.fields) {
      const v = this.values[f.name] ?? "";
      if (f.kind === "check" || f.kind === "radio") f.el.classList.toggle("on", v === f.onValue);
      else if (f.el.value !== v) f.el.value = v;
    }
  }

  _placeField(f, s) {
    const el = f.el;
    if (!el) return;
    const { x, y, w, h } = f.rect;
    Object.assign(el.style, { left: x * s + "px", top: y * s + "px", width: w * s + "px", height: h * s + "px" });
    if (f.kind === "text" || f.kind === "choice") {
      // The form's own size when it names one; "auto" fills the box's height.
      const pt = f.fontSize || Math.min(12, (h - 4) / 1.2);
      el.style.fontSize = Math.max(6, pt) * s + "px";
      el.style.textAlign = f.align === 1 ? "center" : f.align === 2 ? "right" : "";
      if (f.comb) {
        const cell = (w * s) / f.comb;
        const digit = measure("0", pt * s);
        el.style.letterSpacing = cell - digit + "px";
        el.style.paddingLeft = (cell - digit) / 2 + "px";
        el.style.paddingRight = "0";
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

async function loadFont() {
  try {
    const face = new FontFace(FONT_FAMILY, `url(${FONT_URL})`);
    await face.load();
    document.fonts.add(face);
  } catch (err) {
    console.error("font", err);
  }
}

let ctx = null;
function measure(text, px) {
  ctx ??= document.createElement("canvas").getContext("2d");
  ctx.font = `${px}px ${FONT_FAMILY}`;
  return ctx.measureText(text).width;
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
