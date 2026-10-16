// The app shell: opening a file (picker or Android share sheet), the menu,
// the toolbar, keeping her work safe across a reload, and the offline service
// worker. Rendering lives in viewer.js, everything she adds in editor.js,
// saving in writer.js, signatures in signature.js.

import { Viewer } from "./viewer.js";
import { Editor } from "./editor.js";
import { pickSignature } from "./signature.js";
import { sheet, menuRow, ICONS } from "./ui.js";
import * as store from "./store.js";
import { buildPdf, pdfFile, canShareFiles, shareFile, downloadFile, printPdf } from "./output.js";

const $ = (id) => document.getElementById(id);

const state = {
  name: null,     // file name as she knows it
  bytes: null,    // the ORIGINAL file, untouched - what every save starts from
};

const viewer = new Viewer($("stage"), $("pages"));

// ------------------------------------------------------------------ toast

let toastTimer = 0;
export function toast(text, ms = 3000) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------------------------------------------ editor

const TOOL_HINTS = {
  text: "הקש על המקום בדף שבו לכתוב",
  check: "הקש על כל מקום שצריך בו ✓. לסיום — הקש שוב על \"וי\"",
  date: "הקש על המקום בדף שבו לשים את התאריך",
  sign: "הקש על המקום בדף שבו לשים את החתימה",
};

const editor = new Editor(viewer, {
  toast,
  onToolChange(tool) {
    for (const b of document.querySelectorAll("[data-tool]")) {
      b.classList.toggle("active", b.dataset.tool === tool);
    }
    if (tool) toast(TOOL_HINTS[tool], 4000);
    else $("toast").hidden = true;
  },
  onHistoryChange(canUndo) { $("btn-undo").disabled = !canUndo; },
});

for (const b of document.querySelectorAll("[data-tool]")) {
  b.addEventListener("click", () => {
    if (b.dataset.tool === "sign") chooseSignature();
    else editor.setTool(b.dataset.tool);
  });
}
$("btn-undo").addEventListener("click", () => editor.undo());

/** The signature button: pressed again while armed, it disarms. */
async function chooseSignature() {
  if (editor.tool === "sign") { editor.setTool(null); return; }
  const sig = await pickSignature();
  if (sig && state.bytes) editor.setTool("sign", sig);
  else if (sig) toast("החתימה נשמרה. פתח קובץ כדי להניח אותה.");
}

// ------------------------------------------------------------------ her work survives
//
// The open file and what she has filled in are kept in the phone's own
// storage, so a reload (a pull on the screen), a crash or a swiped-away app
// reopens exactly where she was. The file is written once when it opens; the
// draft whenever it changes. Closing the document clears both.

const SESSION_FILE = "session-file";
const SESSION_DRAFT = "session-draft";
let lastDraft = "";
let sessionSaved = true;     // false = storage refused; then warn before leaving

async function saveSessionFile() {
  lastDraft = "";
  sessionSaved = await store.put(SESSION_FILE, { name: state.name, bytes: state.bytes });
}

async function saveDraft() {
  if (!state.bytes) return;
  const json = JSON.stringify(editor.draft());
  if (json === lastDraft) return;
  lastDraft = json;
  sessionSaved = (await store.put(SESSION_DRAFT, json)) && sessionSaved;
}

async function clearSession() {
  lastDraft = "";
  await store.del(SESSION_FILE);
  await store.del(SESSION_DRAFT);
}

setInterval(saveDraft, 1500);
// Leaving the app (home button, switching apps) is the moment that matters.
document.addEventListener("visibilitychange", () => { if (document.hidden) saveDraft(); });
window.addEventListener("pagehide", saveDraft);

// Only if storage is NOT working is there anything to lose on leaving.
window.addEventListener("beforeunload", (e) => {
  if (!sessionSaved && editor.hasEdits()) { e.preventDefault(); e.returnValue = ""; }
});

async function restoreSession() {
  const file = await store.get(SESSION_FILE);
  if (!file?.bytes) return false;
  const draftJson = await store.get(SESSION_DRAFT);
  const ok = await openBytes(file.bytes, file.name, { keepSession: true });
  if (!ok) { await clearSession(); return false; }
  if (draftJson) {
    try { editor.restore(JSON.parse(draftJson)); lastDraft = draftJson; } catch { /* ignore */ }
  }
  if (editor.hasEdits()) toast("המסמך נפתח מחדש בדיוק במקום שעצרת");
  return true;
}

// ------------------------------------------------------------------ open

async function openBytes(bytes, name, { keepSession = false } = {}) {
  try {
    const n = await viewer.open(bytes, askPassword);
    state.bytes = bytes;
    state.name = name || "מסמך.pdf";
    document.body.classList.add("has-doc");
    $("empty").hidden = true;
    $("pages").hidden = false;
    $("toolbar").hidden = false;
    $("btn-share").hidden = false;
    // Shown without ".pdf": in a right-to-left line "טופס 101.pdf" comes out
    // as "pdf.101 טופס", and the extension tells her nothing anyway.
    $("doc-title").textContent = state.name.replace(/\.pdf$/i, "");
    $("page-count").textContent = n === 1 ? "עמוד אחד" : `${n} עמודים`;
    $("page-count").hidden = false;
    await editor.attach();
    if (!keepSession) await saveSessionFile();
    return true;
  } catch (err) {
    console.error(err);
    // open() already closed the previous file, so do not leave its title and
    // toolbar standing over an empty screen.
    showEmpty();
    if (err?.name !== "PasswordException") toast("הקובץ לא נפתח. ייתכן שהוא לא קובץ PDF תקין.");
    return false;
  }
}

function showEmpty() {
  state.bytes = null;
  state.name = null;
  editor.reset();
  viewer.close();
  document.body.classList.remove("has-doc");
  $("empty").hidden = false;
  $("pages").hidden = true;
  $("toolbar").hidden = true;
  $("btn-share").hidden = true;
  $("page-count").hidden = true;
  $("doc-title").textContent = "עורך טפסים";
}

async function askPassword(wasWrong) {
  return prompt(wasWrong ? "הסיסמה שגויה. נסה שוב:" : "הקובץ מוגן בסיסמה. הקלד אותה:");
}

/** Opening another file, or closing this one, throws away what she filled
 *  in here - so ask. */
function mayDiscard(question) {
  return !editor.hasEdits() || confirm(question);
}

function pickFile() {
  if (mayDiscard("לפתוח קובץ אחר? מה שמילאת בקובץ הנוכחי ילך לאיבוד.")) $("file-input").click();
}

async function closeDocument() {
  if (!mayDiscard("לסגור את המסמך? מה שמילאת בו ילך לאיבוד.")) return;
  await clearSession();
  showEmpty();
}

$("btn-open-big").addEventListener("click", pickFile);
$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";          // picking the same file again must still fire
  if (!file) return;
  openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
});

// A file shared to the app from WhatsApp / mail arrives through the service
// worker (see sw.js), which parks it in a cache and reloads us with ?shared.
async function openShared() {
  if (!new URLSearchParams(location.search).has("shared")) return false;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("shared-file");
    const res = await cache.match("shared");
    if (!res) { toast("הקובץ ששותף לא הגיע. נסה לשתף שוב."); return false; }
    const name = decodeURIComponent(res.headers.get("X-File-Name") || "");
    const bytes = new Uint8Array(await res.arrayBuffer());
    await cache.delete("shared");
    return openBytes(bytes, name);
  } catch (err) {
    console.error(err);
    toast("הקובץ ששותף לא נפתח.");
    return false;
  }
}

// ------------------------------------------------------------------ the finished file

let busyTimer = 0;
async function withBusy(text, fn) {
  // Shown only if it takes a moment: a flash of "preparing" on a small
  // file is noise.
  busyTimer = setTimeout(() => { $("busy-text").textContent = text; $("busy").hidden = false; }, 250);
  try { return await fn(); }
  finally { clearTimeout(busyTimer); $("busy").hidden = true; }
}

// The same edits build the same file: share, then print, builds once.
let built = { key: null, value: null };
async function finishedFile() {
  const key = state.name + "\n" + JSON.stringify(editor.draft());
  if (built.key !== key) {
    const value = await withBusy("מכין את הקובץ…", () => buildPdf(state.bytes, viewer, editor));
    built = { key, value };
    if (value.asImages) {
      toast("הקובץ המקורי נעול לעריכה, ולכן העמודים נשמרו כתמונה איכותית. המילוי והחתימה נראים בדיוק כמו על המסך.", 7000);
    }
  }
  return built.value;
}

function fileName() {
  const n = state.name || "מסמך.pdf";
  return /\.pdf$/i.test(n) ? n : n + ".pdf";
}

async function guard(fn, what) {
  try { await fn(); }
  catch (err) {
    console.error(err);
    toast(`${what} נכשל. נסה שוב, ואם זה חוזר — סגור ופתח את האפליקציה.`, 6000);
  }
}

async function shareDoc() {
  await guard(async () => {
    const file = pdfFile((await finishedFile()).bytes, fileName());
    if (!canShareFiles(file)) {
      downloadFile(file);
      toast("השיתוף לא זמין כאן, אז הקובץ נשמר בהורדות של הטלפון.", 5000);
      return;
    }
    const r = await shareFile(file);
    // Building a large file can outlast the tap that asked for it, and the
    // browser only shares from a fresh one: offer a button that IS fresh.
    if (r === "unavailable") offerShare(file);
  }, "השיתוף");
}

function offerShare(file) {
  const body = document.createElement("div");
  body.className = "ready";
  body.innerHTML = `<p>הקובץ מוכן.</p><button type="button" class="primary">שיתוף</button>`;
  body.querySelector("button").addEventListener("click", async () => {
    close();
    await guard(async () => {
      if ((await shareFile(file)) === "unavailable") {
        downloadFile(file);
        toast("השיתוף לא הצליח, אז הקובץ נשמר בהורדות של הטלפון.", 5000);
      }
    }, "השיתוף");
  });
  const close = sheet({ title: fileName().replace(/\.pdf$/i, ""), body });
}

async function saveDoc() {
  await guard(async () => {
    downloadFile(pdfFile((await finishedFile()).bytes, fileName()));
    toast("הקובץ נשמר בהורדות של הטלפון", 4000);
  }, "השמירה");
}

async function printDoc() {
  await guard(async () => {
    const { bytes } = await finishedFile();
    await withBusy("מכין להדפסה…", () => printPdf(bytes));
  }, "ההדפסה");
}

$("btn-share").addEventListener("click", shareDoc);

// ------------------------------------------------------------------ menu

const ZOOM_STEP = 1.25;

function openMenu() {
  const body = document.createElement("div");
  body.className = "menu";
  const hasDoc = !!state.bytes;
  const run = (fn) => () => { close(); fn(); };

  if (hasDoc) {
    body.append(
      menuRow(ICONS.share, "שיתוף (וואטסאפ, מייל…)", run(shareDoc)),
      menuRow(ICONS.download, "שמירה בטלפון", run(saveDoc)),
      menuRow(ICONS.print, "הדפסה", run(printDoc)),
    );
    const sep = document.createElement("hr");
    sep.className = "menu-sep";
    body.append(sep);
  }

  body.append(menuRow(ICONS.open, hasDoc ? "פתיחת קובץ אחר" : "פתיחת קובץ", run(pickFile)));

  if (hasDoc) {
    const zoom = document.createElement("div");
    zoom.className = "menu-zoom";
    zoom.innerHTML = `<span>תצוגה</span>`;
    const zb = (icon, label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<svg viewBox="0 0 24 24">${icon}</svg><small></small>`;
      b.querySelector("small").textContent = label;
      b.addEventListener("click", fn);      // the menu stays open: press again
      return b;
    };
    zoom.append(
      zb(ICONS.zoomOut, "הקטנה", () => viewer.setZoom(viewer.zoom / ZOOM_STEP)),
      zb(ICONS.fit, "לרוחב", () => viewer.setZoom(1)),
      zb(ICONS.zoomIn, "הגדלה", () => viewer.setZoom(viewer.zoom * ZOOM_STEP)),
    );
    body.append(zoom);
  }

  body.append(menuRow(ICONS.sign, "החתימות שלי", run(() => {
    if (editor.tool === "sign") editor.setTool(null);
    chooseSignature();
  })));

  if (hasDoc) body.append(menuRow(ICONS.close, "סגירת המסמך", run(closeDocument), { danger: true }));

  const note = document.createElement("p");
  note.className = "menu-note";
  note.textContent = "הקבצים והחתימות נשמרים רק בטלפון הזה, ולא נשלחים לשום מקום.";
  body.append(note);

  const close = sheet({ title: hasDoc ? state.name.replace(/\.pdf$/i, "") : "עורך טפסים", body });
}

$("btn-menu").addEventListener("click", openMenu);

// ------------------------------------------------------------------ start

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("sw", err));
}

// A file shared to us wins; otherwise pick up where she left off.
(async () => {
  if (!(await openShared())) await restoreSession();
})();

// For checking the app in a desktop browser during development.
window.__openBytes = openBytes;
window.__editor = editor;
window.__exportPdf = async () => (await finishedFile()).bytes;
window.__built = () => built.value;
