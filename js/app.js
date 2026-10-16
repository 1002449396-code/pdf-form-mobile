// The app shell: opening a file (picker or Android share sheet), the toolbar,
// and the offline service worker. Rendering lives in viewer.js.

import { Viewer } from "./viewer.js";

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
    // Shown without ".pdf": in a right-to-left line "טופס 101.pdf" comes out
    // as "pdf.101 טופס", and the extension tells her nothing anyway.
    $("doc-title").textContent = state.name.replace(/\.pdf$/i, "");
    $("page-count").textContent = n === 1 ? "עמוד אחד" : `${n} עמודים`;
    $("page-count").hidden = false;
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
  document.body.classList.remove("has-doc");
  $("empty").hidden = false;
  $("pages").hidden = true;
  $("toolbar").hidden = true;
  $("page-count").hidden = true;
  $("doc-title").textContent = "עורך טפסים";
}

async function askPassword(wasWrong) {
  return prompt(wasWrong ? "הסיסמה שגויה. נסה שוב:" : "הקובץ מוגן בסיסמה. הקלד אותה:");
}

function pickFile() { $("file-input").click(); }

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

// ------------------------------------------------------------------ toolbar

const ZOOM_STEP = 1.25;
$("btn-zoom-in").addEventListener("click", () => viewer.setZoom(viewer.zoom * ZOOM_STEP));
$("btn-zoom-out").addEventListener("click", () => viewer.setZoom(viewer.zoom / ZOOM_STEP));
$("btn-fit").addEventListener("click", () => viewer.setZoom(1));

// ------------------------------------------------------------------ offline

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("sw", err));
}

openShared();

// For checking the app in a desktop browser during development.
window.__openBytes = openBytes;
