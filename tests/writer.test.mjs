// The writer, end to end: build a PDF, fill it, and read it back with pdf.js -
// the same engine Chrome uses to show it - so a test passes only if what was
// written is what a reader will see.
//
//     node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.self = globalThis;   // fontkit's UMD build attaches itself to `self`

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
const { PDFDocument, degrees, PDFName } = await import("../vendor/pdf-lib/pdf-lib.esm.min.js");
const { exportPdf, wrap } = await import("../js/writer.js");
const L = await import("../js/layout.js");

const FONT = new Uint8Array(readFileSync(ROOT + "vendor/fonts/RubikFill-Regular.ttf"));

// The expected baseline, derived HERE from the font file and CSS's rule (the
// content area is centred in the line box) - never from layout.js's own
// constant, or a wrong constant would agree with itself.
const fk = (await import("../js/fontkit.js")).default.create(FONT);
const os2 = fk["OS/2"];
const asc = os2.typoAscender / fk.unitsPerEm, desc = -os2.typoDescender / fk.unitsPerEm;
const EXPECTED_BASELINE = (1.25 - (asc + desc)) / 2 + asc;

/** What annotation appearances draw, as a reader SEES it: every run placed at
 *  its text-matrix position, then read top to bottom, left to right. */
async function appearanceText(doc, n = 1) {
  const ops = await (await doc.getPage(n)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  const runs = [];
  let x = 0, y = 0, form = 0;
  ops.fnArray.forEach((fn, i) => {
    const a = ops.argsArray[i];
    if (fn === pdfjs.OPS.paintFormXObjectBegin) form++;
    if (fn === pdfjs.OPS.setTextMatrix) { x = a[4]; y = a[5]; }
    if (fn === pdfjs.OPS.showText) {
      let s = "";
      for (const g of a[0]) s += typeof g === "number" ? "" : (g?.unicode ?? "");
      runs.push({ form, x, y, s });
    }
  });
  runs.sort((p, q) => p.form - q.form || q.y - p.y || p.x - q.x);
  return runs.map((r) => r.s).join("");
}
const W9 = ROOT + "tests/fixtures/irs-fw9.pdf";   // IRS form: public domain

async function blank({ rotate = 0, crop = null } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (rotate) page.setRotation(degrees(rotate));
  if (crop) page.setCropBox(...crop);
  return doc.save();
}

async function open(bytes) {
  return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

async function geometry(doc) {
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    out.push({ view: p.view, rotate: p.rotate });
  }
  return out;
}

async function fill(bytes, items, fields = []) {
  const doc = await open(bytes);
  const out = await exportPdf(bytes, { items, fields, pages: await geometry(doc) }, FONT);
  return open(out);
}

/** The page's text runs, as pdf.js extracts them (logical order). */
async function runs(doc, n = 1) {
  const tc = await (await doc.getPage(n)).getTextContent();
  return tc.items.filter((i) => i.str.trim());
}

// ------------------------------------------------------------------ bidi

test("a right-to-left line is reversed around its numbers, not through them", () => {
  assert.equal(L.visualLine("12 אב", true), "בא 12");
  assert.equal(L.visualLine("abc 12", false), "abc 12");
  assert.equal(L.isRtl("12/10/2026"), false);
  assert.equal(L.isRtl("שלום abc"), true);
  assert.equal(L.isRtl("abc שלום"), false);
});

// ------------------------------------------------------------------ text items

test("Hebrew with a number reads back in the order it was typed", async () => {
  const text = "כיתה ג 12";
  const doc = await fill(await blank(), [{ page: 0, kind: "text", x: 400, y: 100, size: 14, text }]);
  const got = (await runs(doc)).map((r) => r.str).join("");
  assert.equal(got.replace(/\s+/g, " ").trim(), text);
});

// A line mixing Hebrew, English and brackets is not asserted by reading it
// back: pdf.js's text EXTRACTION (what copy-paste uses) reorders mixed runs
// with its own heuristic and gets this one wrong whatever was written. What
// a reader SEES is the glyph order, which is this:
test("a mixed line is drawn in the Unicode algorithm's visual order", () => {
  assert.equal(L.visualLine("שם: ישראל לוי (12345) abc", true), "abc (12345) יול לארשי :םש");
});

test("a right-to-left item ENDS at its anchor; a left-to-right one starts there", async () => {
  const doc = await fill(await blank(), [
    { page: 0, kind: "text", x: 400, y: 100, size: 14, text: "שלום" },
    { page: 0, kind: "text", x: 100, y: 300, size: 14, text: "Hello" },
  ]);
  const [he, en] = await runs(doc);
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  // pdf.js reports the left end of the run and its baseline.
  const [hx, hy] = vp.convertToViewportPoint(he.transform[4], he.transform[5]);
  assert.ok(Math.abs(hx + he.width - 400) < 0.5, `right edge ${hx + he.width}`);
  assert.ok(Math.abs(hy - (100 + EXPECTED_BASELINE * 14)) < 0.05, `baseline ${hy}`);
  const [ex] = vp.convertToViewportPoint(en.transform[4], en.transform[5]);
  assert.ok(Math.abs(ex - 100) < 0.5, `left edge ${ex}`);
});

test("several lines go DOWN the page, each at the item's own anchor", async () => {
  const doc = await fill(await blank(), [
    { page: 0, kind: "text", x: 400, y: 100, size: 10, text: "שורה ראשונה\nשנייה" },
  ]);
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const [a, b] = (await runs(doc)).map((r) => {
    const [x, y] = vp.convertToViewportPoint(r.transform[4], r.transform[5]);
    return { str: r.str, right: x + r.width, y };
  });
  assert.equal(a.str, "שורה ראשונה");
  assert.equal(b.str, "שנייה");
  assert.ok(Math.abs(b.y - a.y - 10 * L.LINE_HEIGHT) < 0.5);
  assert.ok(Math.abs(a.right - 400) < 0.5 && Math.abs(b.right - 400) < 0.5);
});

for (const rotate of [0, 90, 180, 270]) {
  test(`page units map to the PDF exactly as pdf.js maps them (rotation ${rotate})`, async () => {
    const doc = await open(await blank({ rotate, crop: [30, 40, 500, 700] }));
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const m = L.viewTransform(page.view, page.rotate);
    for (const [x, y] of [[0, 0], [123.5, 77], [400, 20]]) {
      const [ex, ey] = vp.convertToPdfPoint(x, y);
      const [gx, gy] = L.toPdf(m, x, y);
      assert.ok(Math.abs(ex - gx) < 1e-6 && Math.abs(ey - gy) < 1e-6, `${x},${y}`);
    }
  });

  test(`text on a page rotated ${rotate} reads upright where it was placed`, async () => {
    const doc = await fill(await blank({ rotate }), [
      { page: 0, kind: "text", x: 300, y: 200, size: 12, text: "בדיקה 1" },
    ]);
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const [r] = await runs(doc);
    assert.equal(r.str, "בדיקה 1");
    // The run's direction on screen must be plain left-to-right (upright).
    const [x0, y0] = vp.convertToViewportPoint(r.transform[4], r.transform[5]);
    const [x1, y1] = vp.convertToViewportPoint(r.transform[4] + r.transform[0], r.transform[5] + r.transform[1]);
    assert.ok(x1 > x0 && Math.abs(y1 - y0) < 1e-6, "upright");
    assert.ok(Math.abs(y0 - (200 + EXPECTED_BASELINE * 12)) < 0.05, `baseline ${y0}`);
  });
}

test("a ✓ lands centred on its point, and adds no text", async () => {
  const doc = await fill(await blank(), [{ page: 0, kind: "check", x: 200, y: 150, size: 24 }]);
  assert.equal((await runs(doc)).length, 0);
  const ops = await (await doc.getPage(1)).getOperatorList();
  assert.ok(ops.fnArray.includes(pdfjs.OPS.constructPath) || ops.fnArray.includes(pdfjs.OPS.stroke));
});

// ------------------------------------------------------------------ signature

test("strokes become one smoothed path, and a single touch is a dot", () => {
  assert.equal(L.strokesPath([[0, 0, 10, 0, 20, 10]]), "M0 0Q10 0 15 5L20 10");
  assert.equal(L.strokesPath([[5, 5]]), "M5 5L5.1 5");
  assert.equal(L.strokesPath([[0, 0, 4, 4], [9, 9]]), "M0 0L4 4M9 9L9.1 9");
});

test("a signature is drawn centred on its point, at the width she chose", async () => {
  const sig = { w: 200, h: 50, width: 3, strokes: [[0, 25, 100, 0, 200, 25]] };
  const item = { page: 0, kind: "sign", x: 300, y: 200, w: 150, sig };
  const doc = await fill(await blank(), [item]);
  const ops = await (await doc.getPage(1)).getOperatorList();
  const transforms = ops.fnArray.map((fn, i) => fn === pdfjs.OPS.transform ? ops.argsArray[i] : null)
    .filter(Boolean);
  // drawSvgPath places the box's top-left corner, then scales (y flipped).
  const scale = 150 / 200, h = 50 * scale;
  const page = await doc.getPage(1);
  const [ex, ey] = page.getViewport({ scale: 1 }).convertToPdfPoint(300 - 75, 200 - h / 2);
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  assert.ok(transforms.some((t) => near(t[0], 1) && near(t[3], 1) && near(t[4], ex) && near(t[5], ey)),
            `corner at ${ex},${ey}: ${JSON.stringify(transforms)}`);
  assert.ok(transforms.some((t) => near(t[0], scale) && near(t[3], -scale)), "scaled to her width");
  assert.equal((await runs(doc)).length, 0, "a signature adds no text");
});

// ------------------------------------------------------------------ form fields

test("wrapping happens in LOGICAL order, so a sentence starts on the first line", async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit((await import("../js/fontkit.js")).default);
  const font = await doc.embedFont(FONT);
  const lines = wrap(font, "אחת שתיים שלוש ארבע חמש", 12, 70);
  assert.ok(lines.length > 1);
  assert.equal(lines[0].split(" ")[0], "אחת");
  assert.equal(lines.join(" "), "אחת שתיים שלוש ארבע חמש");
});

async function formDoc() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField("name");
  name.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  const id = form.createTextField("id");
  id.setMaxLength(9);
  id.enableCombing();
  id.addToPage(page, { x: 50, y: 650, width: 180, height: 20 });
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.addToPage(page, { x: 50, y: 500, width: 150, height: 100 });
  const ok = form.createCheckBox("agree");
  ok.addToPage(page, { x: 50, y: 450, width: 15, height: 15 });
  return doc.save();
}

async function fieldValues(doc) {
  const out = {};
  for (const a of await (await doc.getPage(1)).getAnnotations()) {
    if (a.subtype === "Widget") out[a.fieldName] = a.fieldValue;
  }
  return out;
}

test("Hebrew in form fields is stored as typed, with an appearance in our font", async () => {
  const bytes = await formDoc();
  const doc = await fill(bytes, [], [
    { name: "name", type: "text", value: "כיתה ג 12" },
    { name: "id", type: "text", value: "123456789" },
    { name: "notes", type: "text", value: "שורה ארוכה מאוד שצריכה לעבור לשורה הבאה בתוך השדה" },
    { name: "agree", type: "check", value: "Yes" },
  ]);
  const v = await fieldValues(doc);
  assert.equal(v.name, "כיתה ג 12");
  assert.equal(v.id, "123456789");
  assert.equal(v.agree, "Yes");

  // What the appearance SHOWS. A mixed value is the test: pure Hebrew comes
  // out right by accident even from pdf-lib's default appearance (fontkit
  // reverses the whole line), but a reversed whole line turns 12 into 21.
  // And the ID's digits must sit in their cells left to right.
  const drawn = await appearanceText(doc);
  assert.ok(drawn.includes("12 ג התיכ"), `drawn: ${drawn}`);
  assert.ok(drawn.includes("123456789"), `drawn: ${drawn}`);

  // Read the raw file: our font is in each appearance, and nothing will ask
  // a viewer to regenerate it.
  const out = await PDFDocument.load(await (await import("../js/writer.js"))
    .exportPdf(bytes, { items: [], fields: [{ name: "name", type: "text", value: "שלום" }],
                        pages: [{ view: [0, 0, 612, 792], rotate: 0 }] }, FONT));
  const field = out.getForm().getTextField("name");
  const ap = field.acroField.getWidgets()[0].getNormalAppearance();
  const stream = out.context.lookup(ap);
  const fonts = stream.dict.lookup(PDFName.of("Resources")).lookup(PDFName.of("Font"));
  assert.ok(fonts.keys().some((k) => /Rubik/i.test(k.asString())), "appearance uses RubikFill");
  assert.equal(String(out.getForm().acroForm.dict.get(PDFName.of("NeedAppearances"))), "false");
});

test("the W-9: a real form's text field and a ✓ whose 'on' value is '1', not 'Yes'",
  { skip: !existsSync(W9) && "W-9 test file not on this machine" }, async () => {
  const bytes = new Uint8Array(readFileSync(W9));
  const before = await open(bytes);
  const widgets = (await (await before.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Widget");
  const text = widgets.find((a) => a.fieldType === "Tx" && !a.readOnly);
  const box = widgets.find((a) => a.checkBox);
  assert.equal(box.exportValue, "1");
  const doc = await fill(bytes, [], [
    { name: text.fieldName, type: "text", value: "ישראל ישראלי" },
    { name: box.fieldName, type: "check", value: box.exportValue },
  ]);
  const v = await fieldValues(doc);
  assert.equal(v[text.fieldName], "ישראל ישראלי");
  assert.equal(v[box.fieldName], "1");
});

// ------------------------------------------------------------------ locked files

test("a file locked against editing is recognised, not mistaken for a broken one", async () => {
  const locked = new Uint8Array(readFileSync(ROOT + "tests/fixtures/locked-w9.pdf"));
  const doc = await open(locked);   // pdf.js reads it: no password to open
  const { isEncryptedError } = await import("../js/writer.js");
  await assert.rejects(
    exportPdf(locked, { items: [], fields: [], pages: await geometry(doc) }, FONT),
    (err) => isEncryptedError(err));
  assert.equal(isEncryptedError(new Error("Invalid PDF structure")), false);
});

test("the picture fallback keeps the page size and writes her text where it was", async () => {
  const { exportImagePdf } = await import("../js/writer.js");
  const jpeg = new Uint8Array(readFileSync(ROOT + "tests/fixtures/page.jpg"));
  const out = await exportImagePdf([{ jpeg, w: 612, h: 792 }, { jpeg, w: 792, h: 612 }],
    [{ page: 1, kind: "text", x: 500, y: 100, size: 14, text: "בדיקה" }], FONT);
  const doc = await open(out);
  assert.equal(doc.numPages, 2);
  const p2 = await doc.getPage(2);
  assert.deepEqual(p2.view, [0, 0, 792, 612]);
  const ops = await p2.getOperatorList();
  assert.ok(ops.fnArray.includes(pdfjs.OPS.paintImageXObject), "the page picture");
  const [r] = await runs(doc, 2);
  assert.equal(r.str, "בדיקה");
  const vp = p2.getViewport({ scale: 1 });
  const [x, y] = vp.convertToViewportPoint(r.transform[4], r.transform[5]);
  assert.ok(Math.abs(x + r.width - 500) < 0.05 && Math.abs(y - (100 + EXPECTED_BASELINE * 14)) < 0.05);
});
