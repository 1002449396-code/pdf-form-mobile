// The app shell: opening a file (picker or Android share sheet), the toolbar,
// and the offline service worker. Rendering lives in viewer.js, everything
// she adds in editor.js, saving in writer.js.

import { Viewer } from "./viewer.js";
import { Editor } from "./editor.js";

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
  b.addEventListener("click", () => editor.setTool(b.dataset.tool));
}
$("btn-undo").addEventListener("click", () => editor.undo());

// Closing the tab or the app with unsaved work asks first.
window.addEventListener("beforeunload", (e) => {
  if (editor.hasEdits()) { e.preventDefault(); e.returnValue = ""; }
});

// ------------------------------------------------------------------ open

async function openBytes(bytes, name) {
  try {
    const n = await viewer.open(bytes, askPassword);
    state.bytes = bytes;
    state.name = name || "מסמך.pdf";
    document.body.classList.add("has-doc");
    $("empty").hidden = true;
    $("pages").hidden = false;
    $("toolbar").hidden = false;
    $("btn-zoom-in").hidden = $("btn-zoom-out").hidden = false;
    // Shown without ".pdf": in a right-to-left line "טופס 101.pdf" comes out
    // as "pdf.101 טופס", and the extension tells her nothing anyway.
    $("doc-title").textContent = state.name.replace(/\.pdf$/i, "");
    $("page-count").textContent = n === 1 ? "עמוד אחד" : `${n} עמודים`;
    $("page-count").hidden = false;
    await editor.attach();
  } catch (err) {
    console.error(err);
    // open() already closed the previous file, so do not leave its title and
    // toolbar standing over an empty screen.
    showEmpty();
    if (err?.name === "PasswordException") return;   // she pressed ביטול
    toast("הקובץ לא נפתח. ייתכן שהוא לא קובץ PDF תקין.");
  }
}

function showEmpty() {
  state.bytes = null;
  state.name = null;
  editor.reset();
  document.body.classList.remove("has-doc");
  $("empty").hidden = false;
  $("pages").hidden = true;
  $("toolbar").hidden = true;
  $("page-count").hidden = true;
  $("btn-zoom-in").hidden = $("btn-zoom-out").hidden = true;
  $("doc-title").textContent = "עורך טפסים";
}

async function askPassword(wasWrong) {
  return prompt(wasWrong ? "הסיסמה שגויה. נסה שוב:" : "הקובץ מוגן בסיסמה. הקלד אותה:");
}

/** Opening another file throws away what she filled in here - so ask. */
function mayReplace() {
  return !editor.hasEdits() ||
    confirm("לפתוח קובץ אחר? מה שמילאת בקובץ הנוכחי לא נשמר וילך לאיבוד.");
}

function pickFile() { if (mayReplace()) $("file-input").click(); }

$("btn-open").addEventListener("click", pickFile);
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
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("shared-file");
    const res = await cache.match("shared");
    if (!res) { toast("הקובץ ששותף לא הגיע. נסה לשתף שוב."); return; }
    const name = decodeURIComponent(res.headers.get("X-File-Name") || "");
    const bytes = new Uint8Array(await res.arrayBuffer());
    await cache.delete("shared");
    openBytes(bytes, name);
  } catch (err) {
    console.error(err);
    toast("הקובץ ששותף לא נפתח.");
  }
}

// ------------------------------------------------------------------ zoom

const ZOOM_STEP = 1.25;
$("btn-zoom-in").addEventListener("click", () => viewer.setZoom(viewer.zoom * ZOOM_STEP));
$("btn-zoom-out").addEventListener("click", () => viewer.setZoom(viewer.zoom / ZOOM_STEP));

// ------------------------------------------------------------------ offline

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("sw", err));
}

openShared();

// For checking the app in a desktop browser during development. Saving gets
// its own buttons in the next stage; until then it is reachable only here.
window.__openBytes = openBytes;
window.__editor = editor;
window.__exportPdf = async () => {
  const { exportPdf } = await import("./writer.js");
  const { FONT_URL } = await import("./layout.js");
  const font = new Uint8Array(await (await fetch(FONT_URL)).arrayBuffer());
  return exportPdf(state.bytes, editor.exportEdits(), font);
};
