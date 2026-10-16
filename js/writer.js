// Builds the filled PDF: the ORIGINAL bytes, plus what she added on top
// (text, ✓, dates) and the values she typed into the form's own fields.
// Pure: bytes and edits in, bytes out - no DOM, so it runs under node:test.
//
// Two rules learned the hard way (the desktop editor's CLAUDE.md, and
// measured here again):
// - Hebrew is drawn in VISUAL order, one glyph at a time. fontkit's layout()
//   reverses a whole line it thinks is Hebrew - naively: "12 אב" comes out
//   "בא 21" - so we never let it see more than one character at a time.
// - A form field gets an appearance drawn in OUR Hebrew font. The default
//   appearance is Helvetica, which cannot encode Hebrew at all.

import {
  PDFDocument, PDFName, PDFHexString, PDFBool, PDFTextField, PDFCheckBox,
  PDFRadioGroup, PDFDropdown, LineCapStyle, LineJoinStyle, setLineJoin, rgb, degrees,
  beginMarkedContent, endMarkedContent, pushGraphicsState, popGraphicsState,
  rectangle, clip, endPath, beginText, endText, setFontAndSize, showText,
  setTextMatrix, setFillingColor,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import fontkit from "./fontkit.js";
import {
  LINE_HEIGHT, BASELINE, FONT_ASCENT, FONT_DESCENT, INK, CHECK_PATH, CHECK_STROKE,
  isRtl, visualLine, viewTransform, toPdf, screenAngle, strokesPath,
} from "./layout.js";

const INK_RGB = rgb(INK.r, INK.g, INK.b);
const FIELD_RGB = rgb(0, 0, 0);
const FIELD_PAD = 2;            // points of air inside a field's border

/**
 * @param {Uint8Array} original  the file as opened
 * @param {object} edits
 *   items:  [{page, kind:"text", x, y, size, text} | {page, kind:"check", x, y, size}
 *            | {page, kind:"sign", x, y, w, sig}]
 *           in page units (see layout.js); text x is the ANCHOR - the right
 *           edge of a right-to-left item, the left edge otherwise. A ✓ and a
 *           signature are placed by their CENTRE.
 *   fields: [{name, type, value}] - only fields she changed.
 *   pages:  [{view, rotate}] per page, from pdf.js
 * @param {Uint8Array} fontBytes  RubikFill-Regular.ttf
 */
export async function exportPdf(original, edits, fontBytes) {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  drawItems(doc, font, edits.items, edits.pages);
  if (edits.fields.length) fillFields(doc, font, edits.fields);
  return doc.save({ updateFieldAppearances: false });
}

/** pdf-lib cannot open an encrypted file - including the common "locked
 *  against editing" kind with no password to open. Its error has no class of
 *  its own that survives minification, so the message is the test. */
export function isEncryptedError(err) {
  return /is encrypted/i.test(err?.message || "");
}

/**
 * The fallback for a file pdf-lib cannot open: every page as a picture (what
 * the eye sees, rendered by pdf.js, which CAN read it), and everything she
 * added drawn on top as real text and lines. The form's fields are no longer
 * fields - the caller passes their values as ordinary items.
 * @param {Array<{jpeg: Uint8Array, w: number, h: number}>} images  per page,
 *        w/h in page units (the page as displayed)
 */
export async function exportImagePdf(images, items, fontBytes) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const pages = [];
  for (const { jpeg, w, h } of images) {
    const img = await doc.embedJpg(jpeg);
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    pages.push({ view: [0, 0, w, h], rotate: 0 });
  }
  drawItems(doc, font, items, pages);
  return doc.save();
}

function drawItems(doc, font, items, geometry) {
  const pages = doc.getPages();
  for (const item of items) {
    const page = pages[item.page];
    const geo = geometry[item.page];
    if (!page || !geo) continue;
    const m = viewTransform(geo.view, geo.rotate);
    if (item.kind === "text") drawTextItem(page, font, m, item);
    else if (item.kind === "check") drawCheckItem(page, m, item);
    else if (item.kind === "sign") drawSignItem(page, m, item);
  }
}

// ------------------------------------------------------------------ items

/** Hex glyph codes for a string, in exactly the order given. */
function encodeVisual(font, visual) {
  let hex = "";
  for (const ch of visual) hex += font.encodeText(ch).asString();
  return PDFHexString.of(hex);
}

function widthOf(font, text, size) {
  let w = 0;
  for (const ch of text) w += font.widthOfTextAtSize(ch, size);
  return w;
}

function drawTextItem(page, font, m, item) {
  const text = item.text || "";
  if (!text.trim()) return;
  const rtl = isRtl(text);
  const angle = screenAngle(m);
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const key = page.node.newFontDictionary(font.name, font.ref);
  page.node.normalize();

  const ops = [pushGraphicsState(), beginText(), setFillingColor(INK_RGB),
               setFontAndSize(key, item.size)];
  text.split("\n").forEach((line, i) => {
    if (!line) return;
    const visual = visualLine(line, rtl);
    const w = widthOf(font, visual, item.size);
    const left = rtl ? item.x - w : item.x;
    const baseline = item.y + (i * LINE_HEIGHT + BASELINE) * item.size;
    const [px, py] = toPdf(m, left, baseline);
    ops.push(setTextMatrix(cos, sin, -sin, cos, px, py), showText(encodeVisual(font, visual)));
  });
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

function drawCheckItem(page, m, item) {
  // item.x/y is the CENTRE; the path lives on a 24-unit box.
  const half = item.size / 2;
  const [px, py] = toPdf(m, item.x - half, item.y - half);
  page.node.normalize();
  page.drawSvgPath(CHECK_PATH, {
    x: px, y: py, scale: item.size / 24, rotate: degrees(screenAngle(m)),
    borderColor: INK_RGB, borderWidth: CHECK_STROKE, borderLineCap: LineCapStyle.Round,
  });
}

function drawSignItem(page, m, item) {
  // item.x/y is the CENTRE, item.w the width in page units; the strokes live
  // in the signature's own units (sig.w x sig.h).
  const sig = item.sig;
  if (!sig?.strokes?.length) return;
  const scale = item.w / sig.w;
  const h = sig.h * scale;
  const [px, py] = toPdf(m, item.x - item.w / 2, item.y - h / 2);
  page.node.normalize();
  // Round joins as well as caps - a pen has no corners. drawSvgPath has no
  // join option, so it is set in a graphics state of our own around it.
  page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
  page.drawSvgPath(strokesPath(sig.strokes), {
    x: px, y: py, scale, rotate: degrees(screenAngle(m)),
    borderColor: INK_RGB, borderWidth: sig.width, borderLineCap: LineCapStyle.Round,
  });
  page.pushOperators(popGraphicsState());
}

// ------------------------------------------------------------------ form

function fillFields(doc, font, changes) {
  const form = doc.getForm();
  for (const { name, value, display } of changes) {
    let field;
    try { field = form.getField(name); } catch { continue; }   // gone / renamed
    if (field instanceof PDFTextField) {
      field.acroField.setValue(PDFHexString.fromText(value));
      field.updateAppearances(font, textProvider(value, field));
    } else if (field instanceof PDFDropdown) {
      // /V holds the option's export value; the box shows its label.
      field.acroField.setValue(PDFHexString.fromText(value));
      field.updateAppearances(font, textProvider(display ?? value, null));
    } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
      // setValue checks the name against the field's own "on" states and
      // sets /AS on every widget; "Off" is always allowed.
      try { field.acroField.setValue(PDFName.of(value)); } catch (err) { console.warn(name, err); }
    }
  }
  // Our appearances are the truth: a viewer must not regenerate them in a
  // font of its own choosing, and an XFA layer would ignore them entirely.
  form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.False);
  form.deleteXFA();
}

/** An appearance provider for a field holding `value`: our font, our bidi,
 *  our alignment. Same drawing for every widget of the field. */
function textProvider(value, textField) {
  return (field, widget, font) => {
    const r = widget.getRectangle();
    const w = r.width, h = r.height;
    const multiline = textField?.isMultiline?.() ?? false;
    const comb = textField?.isCombed?.() ? textField.getMaxLength() : 0;
    let size = daSize(widget, field) || autoSize(font, value, w, h, multiline);
    const rtl = isRtl(value);
    // TextAlignment: 0 left, 1 centre, 2 right. A Hebrew value is set right
    // whatever the field says: a "left" field is the form designer's default,
    // not a decision, and left-aligned Hebrew reads as broken.
    const quad = textField ? textField.getAlignment() : 0;
    const key = PDFName.of(font.name);

    const ops = [beginMarkedContent("Tx"), pushGraphicsState(),
                 rectangle(1, 1, Math.max(0, w - 2), Math.max(0, h - 2)), clip(), endPath(),
                 beginText(), setFillingColor(FIELD_RGB), setFontAndSize(key, size)];
    const lineAt = (visual, x, y) => ops.push(setTextMatrix(1, 0, 0, 1, x, y),
                                              showText(encodeVisual(font, visual)));

    if (comb) {
      // One character per cell. A right-to-left value fills from the right.
      const cell = w / comb;
      const chars = [...value];
      const y = (h - (FONT_ASCENT + FONT_DESCENT) * size) / 2 + FONT_DESCENT * size;
      chars.forEach((ch, i) => {
        const slot = rtl ? comb - 1 - i : i;
        const cw = widthOf(font, ch, size);
        lineAt(ch, slot * cell + (cell - cw) / 2, y);
      });
    } else {
      const lines = multiline ? wrap(font, value, size, w - 2 * FIELD_PAD) : [value.replace(/\n/g, " ")];
      const lh = size * LINE_HEIGHT;
      // Single line: centred vertically. Several: from the top.
      let y = multiline
        ? h - FIELD_PAD - BASELINE * size
        : (h - (FONT_ASCENT + FONT_DESCENT) * size) / 2 + FONT_DESCENT * size;
      for (const line of lines) {
        // Every wrapped line takes the PARAGRAPH's direction, as on screen.
        const visual = visualLine(line, rtl);
        const lw = widthOf(font, visual, size);
        let x;
        if (quad === 1) x = (w - lw) / 2;
        else if (rtl || quad === 2) x = w - FIELD_PAD - lw;
        else x = FIELD_PAD;
        lineAt(visual, x, y);
        y -= lh;
      }
    }
    ops.push(endText(), popGraphicsState(), endMarkedContent());
    return ops;
  };
}

/** The font size written in the field's /DA, if it names one (0 = auto). */
function daSize(widget, field) {
  const da = widget.getDefaultAppearance?.() || field.acroField.getDefaultAppearance?.() || "";
  const m = /([\d.]+)\s+Tf/.exec(da);
  const n = m ? parseFloat(m[1]) : 0;
  return n > 0 ? n : 0;
}

/** "Auto" size: as large as fits, never above 12. */
function autoSize(font, value, w, h, multiline) {
  let size = multiline ? 10 : Math.min(12, (h - 2 * FIELD_PAD) / (FONT_ASCENT + FONT_DESCENT));
  if (!multiline) {
    const lw = widthOf(font, value, 1);
    if (lw > 0) size = Math.min(size, (w - 2 * FIELD_PAD) / lw);
  }
  return Math.max(4, size);
}

/** Word wrap in LOGICAL order (wrapping visual text would put the end of a
 *  Hebrew sentence on the first line). Hard line breaks are kept. */
export function wrap(font, text, size, width) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && widthOf(font, next.trimEnd(), size) > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = next;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
