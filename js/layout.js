// What the screen and the saved PDF must agree on: text direction, the visual
// order of a line, where a line's baseline sits, and how a point on the
// screen maps to a point in the PDF. The editor (what she sees) and the
// writer (what gets saved) both import this, so the two cannot drift.

import bidiFactory from "../vendor/bidi/bidi.min.mjs";

const bidi = bidiFactory();

export const FONT_FAMILY = "RubikFill";
export const FONT_URL = new URL("../vendor/fonts/RubikFill-Regular.ttf", import.meta.url).href;

// Line height as a multiple of the font size, on screen (CSS line-height) and
// in the PDF alike.
export const LINE_HEIGHT = 1.25;

// RubikFill's metrics (units per em 1000; hhea == OS/2 typo, USE_TYPO_METRICS
// set, so every browser lays it out with exactly these): ascent 935, descent
// 250. CSS centres the font's content area (ascent + descent) in the line box,
// so the baseline sits this far below the top of a line, in font sizes.
// Measured with fontkit; re-measure if the font file ever changes.
const ASCENT = 0.935;
const DESCENT = 0.25;
export const BASELINE = (LINE_HEIGHT - (ASCENT + DESCENT)) / 2 + ASCENT;
export const FONT_ASCENT = ASCENT;
export const FONT_DESCENT = DESCENT;

// Fill ink: the desktop editor's "דיו מילוי וחתימה".
export const INK = { r: 0x1A / 255, g: 0x3A / 255, b: 0x8F / 255, css: "#1A3A8F" };

/** True when the paragraph reads right to left: decided by its first strong
 *  character, as the Unicode algorithm (and `dir="auto"`) does. A line with
 *  no letters at all (a date, a phone number) is left to right. */
export function isRtl(text) {
  if (!text) return false;
  return bidi.getEmbeddingLevels(text, "auto").paragraphs[0]?.level === 1;
}

/** One line in the order its glyphs are drawn, left to right - which is what
 *  a PDF needs. Mirrors brackets. The base direction is the PARAGRAPH's, so
 *  that a line of digits inside a Hebrew paragraph keeps its place. */
export function visualLine(line, rtl) {
  if (!line) return "";
  const levels = bidi.getEmbeddingLevels(line, rtl ? "rtl" : "ltr");
  return bidi.getReorderedString(line, levels);
}

// ------------------------------------------------------------------ geometry
//
// The editor stores every position in "page units": CSS pixels of the page as
// pdf.js shows it at scale 1 - so rotation is already applied, and the origin
// is the top-left corner of what she sees. These two functions are pdf.js's
// own PageViewport transform (scale 1), written out so the writer can use it
// without pdf.js; tests check them against pdf.js for all four rotations.

/** The 2x3 matrix taking a PDF point to page units. `view` is the page's
 *  visible box [x0, y0, x1, y1] (pdf.js page.view), `rotate` its /Rotate. */
export function viewTransform(view, rotate) {
  const [x0, y0, x1, y1] = view;
  const r = ((rotate % 360) + 360) % 360;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let a, b, c, d;
  if (r === 90) { a = 0; b = 1; c = 1; d = 0; }
  else if (r === 180) { a = -1; b = 0; c = 0; d = 1; }
  else if (r === 270) { a = 0; b = -1; c = -1; d = 0; }
  else { a = 1; b = 0; c = 0; d = -1; }
  let ox, oy;
  if (a === 0) { ox = Math.abs(cy - y0); oy = Math.abs(cx - x0); }
  else { ox = Math.abs(cx - x0); oy = Math.abs(cy - y0); }
  return [a, b, c, d, ox - a * cx - c * cy, oy - b * cx - d * cy];
}

/** Page units -> PDF point. */
export function toPdf(m, x, y) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const px = (d * (x - e) - c * (y - f)) / det;
  const py = (a * (y - f) - b * (x - e)) / det;
  return [px, py];
}

/** The angle, in degrees counter-clockwise in PDF space, of the page's
 *  "rightwards" on screen - what text and drawings must be rotated by so they
 *  read upright on a rotated page. 0 on an ordinary page. */
export function screenAngle(m) {
  const [x0, y0] = toPdf(m, 0, 0);
  const [x1, y1] = toPdf(m, 1, 0);
  return Math.round(Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI);
}

// The ✓ mark, drawn as a path on a 24x24 box (no font needed - Rubik has no
// ✓ glyph). The same path is used on screen and in the PDF.
export const CHECK_PATH = "M4.5 12.5 L9.5 17.5 L19.5 6.5";
export const CHECK_STROKE = 3;   // in the 24-unit box

/** Today as the school writes it: 16/10/2026. */
export function todayText(now = new Date()) {
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${now.getFullYear()}`;
}
