// Getting the finished file OUT: build it, then share it (WhatsApp, mail,
// Drive - the phone's own share sheet), save it to the phone, or print it.
// The file still never touches a server: sharing hands it to an app on the
// phone, which is the one she picks.

import { exportPdf, exportImagePdf, isEncryptedError } from "./writer.js";
import { FONT_URL } from "./layout.js";

const IMAGE_DPI = 150;       // a locked file's pages as pictures: sharp on paper, light enough for WhatsApp
const PRINT_DPI = 150;       // printing renders pictures too; paper needs no more
const JPEG_QUALITY = 0.82;

let fontBytes = null;
async function font() {
  fontBytes ??= new Uint8Array(await (await fetch(FONT_URL)).arrayBuffer());
  return fontBytes;
}

/**
 * The filled file. Resolves to {bytes, asImages}: asImages is true when the
 * original was locked and had to be rebuilt from pictures of its pages.
 */
export async function buildPdf(original, viewer, editor) {
  const edits = editor.exportEdits();
  try {
    return { bytes: await exportPdf(original, edits, await font()), asImages: false };
  } catch (err) {
    if (!isEncryptedError(err)) throw err;
  }
  // Locked: pdf.js can read it (it is showing it), pdf-lib cannot write it.
  const images = [];
  for (const p of viewer.pages) images.push({ jpeg: await renderJpeg(p.page, IMAGE_DPI), w: p.w, h: p.h });
  const items = [...editor.fieldItems(), ...edits.items];
  return { bytes: await exportImagePdf(images, items, await font()), asImages: true };
}

/** One page as a JPEG, WITHOUT its form fields (they come back as items). */
async function renderJpeg(page, dpi) {
  const pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
  const vp = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";                    // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, intent: "print",
                      annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", JPEG_QUALITY));
  canvas.width = canvas.height = 0;          // phones run out of canvas memory
  return new Uint8Array(await blob.arrayBuffer());
}

// ------------------------------------------------------------------ share / save

export function pdfFile(bytes, name) {
  return new File([bytes], name, { type: "application/pdf" });
}

export function canShareFiles(file) {
  return !!navigator.canShare?.({ files: [file] });
}

/** Resolves to "shared", "cancelled", or "unavailable" (no share sheet or the
 *  tap that asked for it went stale - the caller offers a fresh button). */
export async function shareFile(file) {
  if (!canShareFiles(file)) return "unavailable";
  try {
    await navigator.share({ files: [file], title: file.name });
    return "shared";
  } catch (err) {
    if (err?.name === "AbortError") return "cancelled";
    // NotAllowedError: the browser only shares from a FRESH tap, and
    // building a large file can outlast it.
    if (err?.name === "NotAllowedError") return "unavailable";
    throw err;
  }
}

/** Saves to the phone (on Android: the Downloads folder). */
export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ------------------------------------------------------------------ print
//
// The browser prints the PAGE, not a PDF - so the filled file is rendered to
// pictures, one per sheet, into a print-only area, and the page is printed.
// Rendered from the FINISHED bytes, so what prints is exactly what is shared.

export async function printPdf(bytes) {
  const pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(), isEvalSupported: false,
    cMapUrl: new URL("../vendor/pdfjs/cmaps/", import.meta.url).href, cMapPacked: true,
    standardFontDataUrl: new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).href,
  }).promise;
  const n = doc.numPages;
  // A previous print whose "afterprint" never came (some phones do not send
  // it) is still in the page - hidden on screen, but it would print twice.
  document.getElementById("print-area")?.remove();
  document.getElementById("print-style")?.remove();
  const area = document.createElement("div");
  area.id = "print-area";
  let landscape = 0;
  const urls = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    if (vp.width > vp.height) landscape++;
    const canvas = document.createElement("canvas");
    const pv = page.getViewport({ scale: PRINT_DPI / 72 });
    canvas.width = Math.floor(pv.width);
    canvas.height = Math.floor(pv.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // ENABLE: the saved file's own field appearances are what must print.
    await page.render({ canvasContext: ctx, viewport: pv, intent: "print",
                        annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", JPEG_QUALITY));
    canvas.width = canvas.height = 0;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const sheet = document.createElement("div");
    sheet.className = "print-sheet";
    const img = new Image();
    img.src = url;
    sheet.append(img);
    area.append(sheet);
  }
  await doc.destroy();
  // Paper orientation follows most of the pages.
  const style = document.createElement("style");
  style.id = "print-style";
  style.textContent = `@page { size: ${landscape > n / 2 ? "landscape" : "portrait"}; margin: 0; }`;
  document.head.append(style);
  document.body.append(area);
  await Promise.all([...area.querySelectorAll("img")].map((im) => im.decode().catch(() => {})));

  const cleanup = () => {
    area.remove();
    style.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
}
