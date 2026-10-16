// Bottom sheets: the phone's natural menu - it rises from where the thumb is,
// and a tap outside or the back button closes it.

let open = null;   // the sheet on screen now; one at a time

/**
 * Shows a sheet and returns a function that closes it.
 * @param {object} o  {title, body: Element, onClose?, full?: boolean, keep?: () => boolean}
 *   full - takes the whole screen (the signature pad needs every pixel)
 *   keep - asked when the BACK button/gesture closes the sheet; true keeps it
 *          open. Android's back gesture is a swipe from the screen edge, and
 *          a signature that starts near the edge is exactly that swipe.
 */
export function sheet({ title, body, onClose, full = false, keep = null }) {
  // Replacing a sheet (the signature picker opening the pad) REUSES its
  // history entry. Going back and pushing again would not work: back() is
  // asynchronous and would pop the NEW entry, closing the new sheet at once.
  const replacing = !!open;
  open?.close(false, false, true);
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  const panel = document.createElement("section");
  panel.className = "sheet" + (full ? " sheet-full" : "");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  if (title) {
    const h = document.createElement("h2");
    h.className = "sheet-title";
    h.textContent = title;
    panel.append(h);
  }
  panel.append(body);
  backdrop.append(panel);
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("shown"));

  // Android's back button closes the sheet instead of leaving the app.
  if (!replacing) history.pushState({ sheet: true }, "");
  const onPop = () => {
    if (keep?.()) { history.pushState({ sheet: true }, ""); return; }   // stays open
    close(true, true);
  };
  window.addEventListener("popstate", onPop);

  let closed = false;
  function close(notify = true, fromBack = false, keepHistory = false) {
    if (closed) return;
    closed = true;
    window.removeEventListener("popstate", onPop);
    if (!fromBack && !keepHistory && history.state?.sheet) history.back();
    backdrop.remove();
    if (open?.close === close) open = null;
    if (notify) onClose?.();
  }
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  open = { close };
  return close;
}

/** A row in a menu sheet: icon (inner SVG markup), label, action. */
export function menuRow(icon, label, onClick, { danger = false, disabled = false } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "menu-row" + (danger ? " danger" : "");
  b.disabled = disabled;
  b.innerHTML = `<svg viewBox="0 0 24 24">${icon}</svg><span></span>`;
  b.querySelector("span").textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

export const ICONS = {
  open: '<path d="M4 20h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-3H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1z"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  sign: '<path d="M3 17c3-1 4-9 7-9 2 0 0 7 2 7s2-3 4-3 2 2 5 2"/><path d="M3 21h18"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M8 11h6"/><path d="M11 8v6"/><path d="m20 20-3.5-3.5"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M8 11h6"/><path d="m20 20-3.5-3.5"/>',
  fit: '<path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
};
