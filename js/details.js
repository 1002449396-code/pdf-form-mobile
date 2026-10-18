// Her personal details - name, ID number, phone, address... - typed once,
// kept in the phone, and put on a form with one tap. The same thing every
// form asks for, so it should never be typed twice.
//
// Stored as a list of {label, value}. The labels start as the usual ones
// and she may rename, add or remove; an empty value is simply not offered.

import * as store from "./store.js";
import { sheet, ICONS } from "./ui.js";

const KEY = "details";
const MAX_DETAILS = 20;

// What Israeli forms ask for most. `mode` only chooses the phone's keyboard.
const DEFAULTS = [
  { label: "שם מלא", value: "" },
  { label: "שם פרטי", value: "" },
  { label: "שם משפחה", value: "" },
  { label: "תעודת זהות", value: "", mode: "numeric" },
  { label: "טלפון", value: "", mode: "tel" },
  { label: "כתובת", value: "" },
  { label: "דוא\"ל", value: "", mode: "email" },
  { label: "תאריך לידה", value: "" },
];

export async function loadDetails() {
  const list = await store.get(KEY);
  return Array.isArray(list) ? list : DEFAULTS.map((d) => ({ ...d }));
}

function filled(list) {
  return list.filter((d) => d.value.trim());
}

/**
 * Asks which detail to put on the form. Resolves to its text, or null.
 * With nothing filled in yet it goes straight to filling them in: a list of
 * empty labels has nothing to tap.
 */
export async function pickDetail() {
  let list = await loadDetails();
  if (!filled(list).length) {
    const r = await editDetails(list, { chained: true });
    if (!r) return null;
    if (!filled(r.list).length) { r.close(); return null; }
    list = r.list;
  }
  return showList(list);
}

/** The list sheet. It REPLACES whatever sheet is open (the edit form), which
 *  is why the form does not close itself first: closing goes back in history
 *  asynchronously, and that late "back" would close this sheet (see ui.js). */
function showList(list) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const body = document.createElement("div");
    body.className = "det-list";
    for (const d of filled(list)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "det-use";
      b.innerHTML = `<small></small><bdi></bdi>`;
      b.querySelector("small").textContent = d.label;
      b.querySelector("bdi").textContent = d.value;
      b.addEventListener("click", () => { finish(d.value); close(false); });
      body.append(b);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "menu-row";
    edit.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.edit}</svg><span>עריכת הפרטים שלי</span>`;
    edit.addEventListener("click", async () => {
      const r = await editDetails(list, { chained: true });
      if (!r) { finish(null); return; }
      // Back from editing: offer the list again, with what she just typed.
      if (!filled(r.list).length) { r.close(); finish(null); return; }
      finish(await showList(r.list));
    });
    body.append(edit);
    const close = sheet({ title: "הפרטים שלי — הקש כדי להוסיף לטופס", body, onClose: () => finish(null) });
  });
}

/**
 * The form where she types her details. Resolves to {list, close} once saved,
 * or null if she backed out. With `chained` the form stays on screen after
 * saving, for the caller to replace with the next sheet (or to `close`).
 */
export function editDetails(list, { chained = false } = {}) {
  const rows = (list ?? DEFAULTS).map((d) => ({ ...d }));
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const body = document.createElement("form");
    body.className = "det-form";
    body.noValidate = true;
    const listEl = document.createElement("div");
    listEl.className = "det-rows";
    let dirty = false;

    const rowEl = (d) => {
      const row = document.createElement("div");
      row.className = "det-row";
      const label = document.createElement("input");
      label.className = "det-label";
      label.value = d.label;
      label.setAttribute("aria-label", "שם הפרט");
      label.placeholder = "שם הפרט";
      const value = document.createElement("input");
      value.className = "det-value";
      value.value = d.value;
      value.dir = "auto";
      value.autocomplete = "off";
      value.spellcheck = false;
      if (d.mode === "email") value.type = "email";
      else if (d.mode) value.inputMode = d.mode;
      value.setAttribute("aria-label", d.label || "ערך");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "det-del";
      del.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.trash}</svg>`;
      del.setAttribute("aria-label", "הסרת הפרט");
      del.addEventListener("click", () => {
        rows.splice(rows.indexOf(d), 1);
        row.remove();
        dirty = true;
        addBtn.hidden = rows.length >= MAX_DETAILS;
      });
      label.addEventListener("input", () => { d.label = label.value; dirty = true; });
      value.addEventListener("input", () => { d.value = value.value; dirty = true; });
      // The keyboard covers the bottom of the screen: bring the box up.
      value.addEventListener("focus", () => setTimeout(() => row.scrollIntoView({ block: "center" }), 300));
      row.append(label, value, del);
      return row;
    };
    for (const d of rows) listEl.append(rowEl(d));

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "det-add";
    addBtn.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.plus}</svg><span>פרט נוסף</span>`;
    addBtn.hidden = rows.length >= MAX_DETAILS;
    addBtn.addEventListener("click", () => {
      const d = { label: "", value: "" };
      rows.push(d);
      const el = rowEl(d);
      listEl.append(el);
      el.querySelector(".det-label").focus();
      addBtn.hidden = rows.length >= MAX_DETAILS;
    });

    const note = document.createElement("p");
    note.className = "menu-note";
    note.textContent = "הפרטים נשמרים רק בטלפון הזה, ולא נשלחים לשום מקום.";

    const actions = document.createElement("div");
    actions.className = "pad-actions";
    actions.innerHTML = `<button type="button" data-act="cancel">ביטול</button>` +
      `<button type="submit" class="primary">שמירה</button>`;
    actions.querySelector('[data-act="cancel"]').addEventListener("click", () => close());

    body.addEventListener("submit", async (e) => {
      e.preventDefault();
      const clean = rows
        .map((d) => ({ ...d, label: d.label.trim(), value: d.value.trim() }))
        .filter((d) => d.label || d.value)
        .map((d) => ({ ...d, label: d.label || "פרט" }));
      if (!(await store.put(KEY, clean))) {
        alert("לא ניתן לשמור את הפרטים בטלפון (ייתכן שהדפדפן במצב פרטי). אפשר להשתמש בהם עכשיו, אבל הם לא יישמרו לפעם הבאה.");
      }
      dirty = false;
      if (!chained) close(false);
      finish({ list: clean, close: () => close(false) });
    });

    const scroll = document.createElement("div");
    scroll.className = "det-scroll";
    scroll.append(listEl, addBtn, note);
    body.append(scroll, actions);
    const close = sheet({
      title: "הפרטים שלי", body, full: true, onClose: () => finish(null),
      // Back gesture with unsaved typing: ask, rather than throw it away.
      keep: () => dirty && !confirm("לצאת בלי לשמור את השינויים?"),
    });
  });
}
