// Her signatures: drawn once with a finger, kept in the phone, placed with a
// tap. Stored as vector strokes (layout.strokesPath), never as a picture.

import * as store from "./store.js";
import { sheet, ICONS } from "./ui.js";
import { INK, strokesPath } from "./layout.js";

const KEY = "signatures";
const MAX_SAVED = 8;
const PEN = 3;            // stroke width, CSS px of the pad
const MIN_STEP = 1.2;     // drop samples closer than this - a finger at rest jitters

export async function loadSignatures() {
  const list = await store.get(KEY);
  return Array.isArray(list) ? list : [];
}

async function saveSignatures(list) {
  return store.put(KEY, list);
}

/** SVG markup of a signature, for previews and for the page. */
export function signatureSvg(sig) {
  return `<svg viewBox="0 0 ${sig.w} ${sig.h}" preserveAspectRatio="xMidYMid meet">` +
    `<path d="${strokesPath(sig.strokes)}" fill="none" stroke="${INK.css}" stroke-width="${sig.width}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * Asks which signature to use. Resolves to a signature, or null.
 * With none saved yet, goes straight to the pad.
 */
export async function pickSignature() {
  const list = await loadSignatures();
  if (!list.length) return drawNew(list);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const body = document.createElement("div");
    body.className = "sig-grid";
    const render = () => {
      body.replaceChildren();
      for (const entry of list) {
        const card = document.createElement("div");
        card.className = "sig-card";
        const use = document.createElement("button");
        use.type = "button";
        use.className = "sig-use";
        use.innerHTML = signatureSvg(entry.sig);
        use.setAttribute("aria-label", "שימוש בחתימה הזו");
        use.addEventListener("click", () => { finish(entry.sig); close(false); });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sig-del";
        del.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.trash}</svg>`;
        del.setAttribute("aria-label", "מחיקת החתימה");
        del.addEventListener("click", async () => {
          if (!confirm("למחוק את החתימה הזו מהטלפון? חתימות שכבר הונחו במסמך לא ייפגעו.")) return;
          list.splice(list.indexOf(entry), 1);
          await saveSignatures(list);
          // The last one gone: straight to the pad, which REPLACES this sheet
          // (closing first would race the back button - see ui.sheet).
          if (!list.length) { finish(await drawNew(list)); return; }
          render();
        });
        card.append(use, del);
        body.append(card);
      }
      if (list.length < MAX_SAVED) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "sig-card sig-add";
        add.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.plus}</svg><span>חתימה חדשה</span>`;
        add.addEventListener("click", async () => finish(await drawNew(list)));
        body.append(add);
      }
    };
    render();
    const close = sheet({ title: "בחירת חתימה", body, onClose: () => finish(null) });
  });
}

/** Opens the pad; a saved drawing is added to `list` and returned. */
async function drawNew(list) {
  const sig = await openPad();
  if (!sig) return null;
  list.unshift({ id: Date.now(), sig });
  list.length = Math.min(list.length, MAX_SAVED);
  if (!(await saveSignatures(list))) {
    alert("לא ניתן לשמור את החתימה בטלפון (ייתכן שהדפדפן במצב פרטי). אפשר להשתמש בה עכשיו, אבל היא לא תישמר לפעם הבאה.");
  }
  return sig;
}

// ------------------------------------------------------------------ the pad

function openPad() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    const body = document.createElement("div");
    body.className = "pad";
    body.innerHTML = `
      <div class="pad-area">
        <canvas></canvas>
        <div class="pad-line"></div>
        <div class="pad-hint">חותמים כאן עם האצבע</div>
      </div>
      <div class="pad-actions">
        <button type="button" data-act="clear">ניקוי</button>
        <button type="button" data-act="cancel">ביטול</button>
        <button type="button" data-act="save" class="primary" disabled>שמירה</button>
      </div>`;
    const area = body.querySelector(".pad-area");
    const canvas = body.querySelector("canvas");
    const saveBtn = body.querySelector('[data-act="save"]');
    const hint = body.querySelector(".pad-hint");
    const strokes = [];       // CSS px of the pad
    let current = null;
    let ctx = null;

    const close = sheet({
      title: "חתימה חדשה", body, full: true, onClose: () => finish(null),
      // A back gesture with ink on the pad asks; an empty pad just closes.
      keep: () => strokes.length > 0 && !confirm("לצאת בלי לשמור את החתימה?"),
    });

    const fit = () => {
      const r = area.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.lineWidth = PEN;
      ctx.strokeStyle = INK.css;
      redraw();
    };
    const redraw = () => {
      saveBtn.disabled = strokes.length === 0;
      hint.hidden = strokes.length > 0;
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.stroke(new Path2D(strokesPath(strokes)));
    };
    // Now, not on the next frame: a finger that lands before that frame (or a
    // page in the background, where frames do not come at all) must still
    // draw. Again on the next frame, once the sheet's layout has settled.
    fit();
    requestAnimationFrame(fit);
    // Turning the phone to landscape gives a wider pad. The strokes are kept
    // in pad pixels, so they stay where they were drawn.
    const onResize = () => requestAnimationFrame(fit);
    window.addEventListener("resize", onResize);

    const point = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // Capture keeps the stroke when the finger slides off the pad. It
      // THROWS for a pointer that is already gone (a very quick tap), and a
      // throw here would lose the stroke - so it is best effort.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      current = point(e);
      strokes.push(current);
      redraw();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!current) return;
      // The samples the browser merged into this event, for a smooth line.
      // The list can come back EMPTY (it does for synthetic events), so the
      // event itself is the fallback, not an afterthought.
      const merged = e.getCoalescedEvents?.() ?? [];
      const events = merged.length ? merged : [e];
      for (const ev of events) {
        const [x, y] = point(ev);
        const n = current.length;
        if (Math.hypot(x - current[n - 2], y - current[n - 1]) < MIN_STEP) continue;
        current.push(x, y);
      }
      redraw();
    });
    const end = () => { current = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    body.querySelector(".pad-actions").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "clear") { strokes.length = 0; redraw(); }
      else if (act === "cancel") { window.removeEventListener("resize", onResize); close(); }
      else if (act === "save" && strokes.length) {
        window.removeEventListener("resize", onResize);
        finish(normalise(strokes));
        close(false);
      }
    });
  });
}

/** Crop to the ink (plus half a pen of air) and move to (0,0). */
function normalise(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]);
      y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]);
    }
  }
  const pad = PEN / 2 + 1;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const r = (n) => Math.round(n * 10) / 10;
  return {
    w: r(x1 - x0), h: r(y1 - y0), width: PEN,
    strokes: strokes.map((s) => s.map((v, i) => r(i % 2 ? v - y0 : v - x0))),
  };
}
