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
  if (sig.type === "image") {
    return `<svg viewBox="0 0 ${sig.w} ${sig.h}" preserveAspectRatio="xMidYMid meet">` +
      `<image href="${sig.png}" width="${sig.w}" height="${sig.h}"/></svg>`;
  }
  return `<svg viewBox="0 0 ${sig.w} ${sig.h}" preserveAspectRatio="xMidYMid meet">` +
    `<path d="${strokesPath(sig.strokes)}" fill="none" stroke="${INK.css}" stroke-width="${sig.width}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * Asks which signature to use. Resolves to a signature, or null. With none
 * saved yet it still opens here: there are two ways to make one (draw it, or
 * take it from a picture) and she should see both.
 */
export async function pickSignature() {
  const list = await loadSignatures();
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
          render();
        });
        card.append(use, del);
        body.append(card);
      }
      if (list.length < MAX_SAVED) {
        const add = (icon, label, make) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "sig-card sig-add";
          b.innerHTML = `<svg viewBox="0 0 24 24">${icon}</svg><span></span>`;
          b.querySelector("span").textContent = label;
          b.addEventListener("click", async () => {
            const sig = await make();
            // Backing out of the PHOTO PICKER leaves this list on screen (no
            // sheet replaced it): stay usable rather than answering for it.
            if (!sig && body.isConnected) return;
            finish(await keep(list, sig));
          });
          body.append(b);
        };
        add(ICONS.plus, "ציור חתימה", openPad);
        add(ICONS.image, "חתימה מתמונה", fromPicture);
      } else {
        const p = document.createElement("p");
        p.className = "sig-full";
        p.textContent = `שמורות ${MAX_SAVED} חתימות. כדי להוסיף חדשה, מחקו אחת קודם.`;
        body.append(p);
      }
    };
    render();
    const close = sheet({ title: "בחירת חתימה", body, onClose: () => finish(null) });
  });
}

/** A new signature (drawn or from a picture) is added to `list` and returned. */
async function keep(list, sig) {
  if (!sig) return null;
  list.unshift({ id: Date.now(), sig });
  list.length = Math.min(list.length, MAX_SAVED);
  if (!(await saveSignatures(list))) {
    alert("לא ניתן לשמור את החתימה בטלפון (ייתכן שהדפדפן במצב פרטי). אפשר להשתמש בה עכשיו, אבל היא לא תישמר לפעם הבאה.");
  }
  return sig;
}

// ------------------------------------------------------------------ from a picture
//
// A photo of a signature on paper, or a scanned/PNG file. The paper goes
// transparent and the ink stays, so it sits on a form like ink, not like a
// white sticker. A slider decides how much counts as "paper" - a photo taken
// in a dim room has grey paper, and only she can tell where the ink starts.

const PICTURE_WORK = 1400;   // longest side processed (a 12MP photo is overkill)
const PICTURE_KEEP = 900;    // width kept: sharp on paper, ~100KB in storage

function fromPicture() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";     // Android offers the camera here as well
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch { alert("לא ניתן לפתוח את התמונה הזו. נסו תמונה אחרת (JPG או PNG)."); resolve(null); return; }
      resolve(await reviewPicture(bmp));
    });
    input.click();
  });
}

function reviewPicture(bmp) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    // Work copy, scaled down once.
    const k = Math.min(1, PICTURE_WORK / Math.max(bmp.width, bmp.height));
    const W = Math.max(1, Math.round(bmp.width * k)), H = Math.max(1, Math.round(bmp.height * k));
    const work = document.createElement("canvas");
    work.width = W; work.height = H;
    const wctx = work.getContext("2d", { willReadFrequently: true });
    wctx.drawImage(bmp, 0, 0, W, H);
    bmp.close?.();
    const src = wctx.getImageData(0, 0, W, H);
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      lum[i] = 0.299 * src.data[p] + 0.587 * src.data[p + 1] + 0.114 * src.data[p + 2];
    }
    const paper = percentile(lum, 0.9);   // most of a signature photo is paper

    const body = document.createElement("div");
    body.className = "pad";
    body.innerHTML = `
      <div class="pic-area"><canvas></canvas><p class="pic-empty" hidden>לא נמצאה חתימה בתמונה. הקטינו את ניקוי הרקע בסרגל.</p></div>
      <label class="pic-slider"><span>ניקוי רקע</span>
        <input type="range" min="0" max="100" value="40" step="1"></label>
      <div class="pad-actions">
        <button type="button" data-act="cancel">ביטול</button>
        <button type="button" data-act="save" class="primary">שמירה</button>
      </div>`;
    const shown = body.querySelector("canvas");
    const slider = body.querySelector("input");
    const saveBtn = body.querySelector('[data-act="save"]');
    const empty = body.querySelector(".pic-empty");
    let result = null;

    const run = () => {
      result = removePaper(src, lum, paper, Number(slider.value));
      const ok = !!result;
      saveBtn.disabled = !ok;
      empty.hidden = ok;
      shown.hidden = !ok;
      if (ok) {
        shown.width = result.width; shown.height = result.height;
        shown.getContext("2d").drawImage(result, 0, 0);
      }
    };
    let pending = false;
    slider.addEventListener("input", () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; run(); });
    });
    run();

    const close = sheet({ title: "חתימה מתמונה", body, full: true, onClose: () => finish(null) });
    body.querySelector(".pad-actions").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "cancel") close();
      else if (act === "save" && result) {
        const k2 = Math.min(1, PICTURE_KEEP / result.width);
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(result.width * k2));
        out.height = Math.max(1, Math.round(result.height * k2));
        out.getContext("2d").drawImage(result, 0, 0, out.width, out.height);
        finish({ type: "image", w: out.width, h: out.height, png: out.toDataURL("image/png") });
        close(false);
      }
    });
  });
}

/** The ink, on transparency, cropped to itself - or null if nothing is left.
 *  level 0..100: how much of the lighter tones counts as paper. */
export function removePaper(src, lum, paper, level) {
  const { width: W, height: H } = src;
  const cut = paper * (0.95 - 0.004 * level);      // lighter than this = paper
  const soft = Math.max(8, cut * 0.25);            // a soft edge, like real ink
  const out = new ImageData(W, H);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      const a = Math.min(1, Math.max(0, (cut - lum[i]) / soft));
      if (a <= 0) continue;
      // Slightly darker than the photo: a phone camera greys out a pen.
      out.data[p] = src.data[p] * 0.8;
      out.data[p + 1] = src.data[p + 1] * 0.8;
      out.data[p + 2] = src.data[p + 2] * 0.8;
      out.data[p + 3] = Math.round(a * 255);
      if (a > 0.2) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
  }
  if (x1 < 0) return null;
  const pad = 4;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const full = document.createElement("canvas");
  full.width = W; full.height = H;
  full.getContext("2d").putImageData(out, 0, 0);
  const crop = document.createElement("canvas");
  crop.width = x1 - x0 + 1; crop.height = y1 - y0 + 1;
  crop.getContext("2d").drawImage(full, -x0, -y0);
  return crop;
}

function percentile(values, q) {
  // A histogram, not a sort: two million pixels, 256 bins.
  const bins = new Uint32Array(256);
  for (const v of values) bins[Math.min(255, v | 0)]++;
  let need = values.length * q;
  for (let b = 0; b < 256; b++) { need -= bins[b]; if (need <= 0) return b; }
  return 255;
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
