/**
 * Browser-side helpers for SorareInside modal capture (stringified for Playwright evaluate).
 * Full shot = pitch + Bench + DNP only; green shot = pitch only.
 */

/** Shared DOM helpers injected into page.evaluate IIFEs. */
export const SI_DOM_HELPERS = `
  const looksGreen = (el) => {
    if (el instanceof HTMLCanvasElement) {
      const r = el.getBoundingClientRect();
      return r.width >= 180 && r.height >= 200;
    }
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor || "";
    let m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/i);
    if (m) {
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
      const a = m[4] == null ? 1 : Number(m[4]);
      if (a >= 0.25 && g > r + 8 && g > b + 8 && g >= 35 && r <= 140 && b <= 140) return true;
    }
    m = bg.match(/hsla?\\((\\d+(?:\\.\\d+)?)\\s*,\\s*(\\d+(?:\\.\\d+)?)%\\s*,\\s*(\\d+(?:\\.\\d+)?)%/i);
    if (m) {
      const h = Number(m[1]), s = Number(m[2]), l = Number(m[3]);
      if (h >= 70 && h <= 170 && s >= 15 && l >= 8 && l <= 55) return true;
    }
    const bi = cs.backgroundImage || "";
    if (/url\\(|gradient/i.test(bi)) return true;
    const cls = String(el.className || "");
    if (/pitch|field|turf|formation|lineup-board|green/i.test(cls)) return true;
    return false;
  };
  const hasGreenSurface = (el) => {
    if (looksGreen(el)) return true;
    for (const child of el.querySelectorAll("div, section, article, canvas, svg")) {
      if (!(child instanceof HTMLElement)) continue;
      const r = child.getBoundingClientRect();
      if (r.width * r.height < 12_000) continue;
      if (looksGreen(child)) return true;
    }
    return false;
  };
  const percentCount = (el) =>
    (el.innerText || "").match(/\\b\\d{1,3}\\s*%/g)?.length || 0;
  const isBloated = (el) => {
    const t = el.innerText || "";
    return (
      /Starting\\s*%\\s*Key/i.test(t) ||
      /Bench Players/i.test(t) ||
      /DNP Players/i.test(t) ||
      /Conversation/i.test(t) ||
      /\\bComments\\b/i.test(t) ||
      /Injuries\\s*&\\s*Recovery/i.test(t) ||
      /Team Analysis/i.test(t) ||
      /Potential Factors/i.test(t) ||
      /Set your username/i.test(t)
    );
  };
  const hasPitchChrome = (el) => {
    const t = el.innerText || "";
    return (
      /SorareInside/i.test(t) ||
      /RELIABILITY/i.test(t) ||
      /\\bHIGH\\b|\\bMEDIUM\\b|\\bLOW\\b/i.test(t)
    );
  };
  const findTightPitch = (scope) => {
    const candidates = [];
    for (const el of scope.querySelectorAll("div, section, article, canvas")) {
      if (!(el instanceof HTMLElement)) continue;
      if (getComputedStyle(el).display === "none") continue;
      if (isBloated(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 150) continue;
      if (rect.width > 1400 || rect.height > 1600) continue;
      const pct = percentCount(el);
      const green = hasGreenSurface(el);
      const chrome = hasPitchChrome(el);
      // Allow green/chrome pitches even when % are painted (not in text).
      if (pct < 3 && !green && !chrome) continue;
      const area = Math.max(rect.width * rect.height, 1);
      const ratio = rect.height / Math.max(rect.width, 1);
      candidates.push({
        el, pct, area, ratio, green, chrome,
        w: rect.width, h: rect.height,
      });
    }
    if (!candidates.length) return { el: null, sample: [] };
    const scoreOf = (c) =>
      (c.green ? 500_000 : 0) +
      (c.chrome ? 200_000 : 0) +
      c.pct * 80_000 +
      (c.pct / c.area) * 2e9 -
      c.area * 0.05 +
      (c.ratio > 0.75 && c.ratio < 2.0 ? 30_000 : 0);
    let pool = candidates.filter((c) => c.green || c.chrome);
    if (!pool.length) {
      pool = candidates.filter(
        (c) => c.pct >= 5 && c.h >= 200 && c.h <= 1000 && c.w >= 180 && c.w <= 1000,
      );
    }
    if (!pool.length) pool = candidates.filter((c) => c.pct >= 5);
    if (!pool.length) pool = candidates;
    pool.sort((a, b) => scoreOf(b) - scoreOf(a));
    return {
      el: pool[0].el,
      sample: pool.slice(0, 5).map((c) => ({
        pct: c.pct,
        w: Math.round(c.w),
        h: Math.round(c.h),
        green: c.green,
        chrome: c.chrome,
      })),
    };
  };
  const ownText = (el) => {
    let t = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) t += node.textContent || "";
    }
    return t.replace(/\\s+/g, " ").trim();
  };
  const findSectionByHeading = (root, re) => {
    const nodes = root.querySelectorAll(
      "h1,h2,h3,h4,h5,strong,p,span,div,button,label",
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      if (getComputedStyle(el).display === "none") continue;
      const direct = ownText(el);
      const full = String(el.textContent || "").replace(/\\s+/g, " ").trim();
      const t = direct && direct.length <= 40 ? direct : full;
      if (!re.test(t) || t.length > 48) continue;
      let best = el.parentElement instanceof HTMLElement ? el.parentElement : el;
      let cur = best;
      for (let i = 0; i < 12 && cur && cur !== root; i++) {
        const imgs = cur.querySelectorAll("img").length;
        const textLen = (cur.innerText || "").length;
        if (imgs >= 2 || textLen > t.length + 40) best = cur;
        const parent = cur.parentElement;
        if (!parent || parent === root) break;
        // Stop before swallowing the whole modal column.
        if (parent.parentElement === root) break;
        cur = parent;
      }
      return best;
    }
    return null;
  };
`;

export const SI_PREPARE_MODAL_SCRIPT = `(() => {
  const root = document.querySelector(
    "[data-modal-content], .mantine-Modal-content",
  );
  if (!(root instanceof HTMLElement)) return { error: "modal-not-found" };

  const patches = [];
  const patch = (el) => {
    if (!(el instanceof HTMLElement) || patches.some((p) => p.el === el)) return;
    patches.push({ el, prev: el.getAttribute("style") });
  };
  const set = (el, props) => {
    if (!(el instanceof HTMLElement)) return;
    patch(el);
    for (const key of Object.keys(props)) {
      el.style.setProperty(key, props[key], "important");
    }
  };
  const hide = (el) => set(el, { display: "none" });

  ${SI_DOM_HELPERS}

  const hideNoiseSections = () => {
    const noise =
      /^(Comments|Updates|Conversation|Team Analysis|Starting\\s*%\\s*Key|Potential Factors|What does it Mean|Injuries|Set your username|Expert)$/i;
    for (const el of root.querySelectorAll(
      "button, [role='tab'], a, div, span, p, strong, h1, h2, h3, h4, h5",
    )) {
      if (!(el instanceof HTMLElement)) continue;
      const t = ownText(el) || String(el.textContent || "").replace(/\\s+/g, " ").trim();
      if (!noise.test(t) || t.length > 60) continue;
      // Never hide Bench / DNP / pitch keepers.
      if (el.closest("[data-si-pitch],[data-si-bench],[data-si-dnp]")) continue;
      let section = el;
      for (let i = 0; i < 10 && section && section !== root; i++) {
        const text = String(section.textContent || "");
        const isNoiseBlock =
          (/Comments/i.test(text) && /Updates/i.test(text)) ||
          /Conversation/i.test(text) ||
          (/Starting\\s*%\\s*Key/i.test(text) && /90%/i.test(text)) ||
          (/Team Analysis/i.test(text) && /UPDATE/i.test(text)) ||
          /Potential Factors/i.test(text) ||
          /Set your username/i.test(text) ||
          (/\\bExpert\\b/i.test(t) && text.length < 400);
        if (isNoiseBlock) {
          hide(section);
          break;
        }
        section = section.parentElement;
      }
    }
  };

  const expandOverflow = (el) => {
    if (!(el instanceof HTMLElement)) return;
    if (getComputedStyle(el).display === "none") return;
    const cs = getComputedStyle(el);
    if (
      /(auto|scroll|hidden)/.test(cs.overflowY) ||
      /(auto|scroll|hidden)/.test(cs.overflow) ||
      (cs.maxHeight && cs.maxHeight !== "none")
    ) {
      set(el, {
        overflow: "visible",
        "overflow-x": "visible",
        "overflow-y": "visible",
        "max-height": "none",
        height: "auto",
      });
    }
  };
  expandOverflow(root);
  expandOverflow(root.querySelector(".mantine-Modal-body"));
  expandOverflow(root.querySelector(".mantine-Modal-header"));
  for (const node of root.querySelectorAll("*")) expandOverflow(node);

  const portal =
    root.closest(".mantine-Modal-root") ||
    root.closest('[role="dialog"]') ||
    root.parentElement;
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (portal && (child === portal || child.contains(portal))) continue;
    if (child.contains(root)) continue;
    set(child, { visibility: "hidden" });
  }
  if (portal instanceof HTMLElement) {
    set(portal, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "auto",
      inset: "auto",
      width: "100%",
      height: "auto",
      "min-height": "0",
      "max-height": "none",
      overflow: "visible",
      transform: "none",
      display: "block",
      "z-index": "2147483646",
    });
  }
  const inner = root.closest(".mantine-Modal-inner");
  if (inner instanceof HTMLElement) {
    set(inner, {
      position: "static",
      top: "0",
      left: "0",
      transform: "none",
      "align-items": "flex-start",
      "justify-content": "flex-start",
      padding: "0",
      margin: "0",
      width: "fit-content",
      height: "auto",
      "max-height": "none",
      "min-height": "0",
      overflow: "visible",
    });
  }

  const found = findTightPitch(root);
  const pitchEl = found.el;
  const benchEl = findSectionByHeading(root, /^Bench Players$/i);
  const dnpEl = findSectionByHeading(root, /^DNP Players$/i);

  if (pitchEl) {
    set(pitchEl, {
      overflow: "visible",
      "max-height": "none",
      "box-sizing": "content-box",
      "padding-top": "40px",
      "padding-bottom": "20px",
      "padding-left": "10px",
      "padding-right": "10px",
    });
    pitchEl.setAttribute("data-si-pitch", "1");
  }
  if (benchEl) benchEl.setAttribute("data-si-bench", "1");
  if (dnpEl) dnpEl.setAttribute("data-si-dnp", "1");

  hideNoiseSections();

  // Hide any large sibling blocks that are not pitch/bench/dnp keepers.
  const keepers = [pitchEl, benchEl, dnpEl].filter(Boolean);
  const isKeeperRelated = (el) =>
    keepers.some(
      (k) => k === el || k.contains(el) || el.contains(k),
    );
  for (const el of root.querySelectorAll("div, section, article, aside")) {
    if (!(el instanceof HTMLElement)) continue;
    if (isKeeperRelated(el)) continue;
    if (keepers.some((k) => el.contains(k))) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 80 || r.width < 80) continue;
    const t = el.innerText || "";
    if (
      /Starting\\s*%\\s*Key/i.test(t) ||
      /\\bComments\\b/i.test(t) ||
      /Conversation/i.test(t) ||
      /Team Analysis/i.test(t) ||
      /Potential Factors/i.test(t) ||
      /Set your username/i.test(t)
    ) {
      hide(el);
    }
  }

  // Hide modal chrome (title/close) — full shot is pitch + bench + DNP only.
  const header = root.querySelector(".mantine-Modal-header");
  if (header instanceof HTMLElement) hide(header);

  const contentSize = (el) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (node) => {
      if (!(node instanceof HTMLElement)) return;
      if (getComputedStyle(node).display === "none") return;
      if (getComputedStyle(node).visibility === "hidden") return;
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    };
    if (keepers.length) {
      for (const k of keepers) add(k);
    } else {
      add(el);
      for (const node of el.querySelectorAll("*")) add(node);
    }
    if (!Number.isFinite(minX)) {
      const r = el.getBoundingClientRect();
      return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
    }
    return {
      width: Math.max(1, Math.ceil(maxX - minX)),
      height: Math.max(1, Math.ceil(maxY - minY)),
    };
  };

  const size = contentSize(root);
  set(root, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "auto",
    bottom: "auto",
    margin: "0",
    transform: "none",
    width: size.width + "px",
    height: size.height + "px",
    "max-width": "none",
    "max-height": "none",
    "min-height": "0",
    overflow: "visible",
    "z-index": "2147483647",
  });
  root.setAttribute("data-si-modal", "1");

  window.__siRestoreModalStyles = () => {
    for (const { el, prev } of patches) {
      if (prev == null || prev === "") el.removeAttribute("style");
      else el.setAttribute("style", prev);
    }
    root.removeAttribute("data-si-modal");
    document
      .querySelectorAll("[data-si-pitch],[data-si-bench],[data-si-dnp]")
      .forEach((el) => {
        el.removeAttribute("data-si-pitch");
        el.removeAttribute("data-si-bench");
        el.removeAttribute("data-si-dnp");
      });
  };

  return {
    modal: size,
    hasPitch: Boolean(pitchEl),
    hasBench: Boolean(benchEl),
    hasDnp: Boolean(dnpEl),
    pctInModal: percentCount(root),
    sample: found.sample,
  };
})()`;

export const SI_REMARK_PITCH_SCRIPT = `(() => {
  const root = document.querySelector(
    "[data-si-modal], [data-modal-content], .mantine-Modal-content",
  );
  if (!(root instanceof HTMLElement)) return { ok: false, reason: "no-modal" };
  root.setAttribute("data-si-modal", "1");
  document.querySelectorAll("[data-si-pitch]").forEach((el) => {
    el.removeAttribute("data-si-pitch");
  });

  ${SI_DOM_HELPERS}

  const found = findTightPitch(root);
  const best = found.el;
  if (!best) {
    return {
      ok: false,
      reason: "no-tight-green",
      pctInModal: percentCount(root),
      sample: found.sample,
    };
  }
  best.style.setProperty("overflow", "visible", "important");
  best.style.setProperty("max-height", "none", "important");
  best.style.setProperty("box-sizing", "content-box", "important");
  best.style.setProperty("padding-top", "40px", "important");
  best.style.setProperty("padding-bottom", "20px", "important");
  best.style.setProperty("padding-left", "10px", "important");
  best.style.setProperty("padding-right", "10px", "important");
  best.setAttribute("data-si-pitch", "1");

  // Re-mark bench/dnp if React wiped attributes.
  const benchEl = findSectionByHeading(root, /^Bench Players$/i);
  const dnpEl = findSectionByHeading(root, /^DNP Players$/i);
  if (benchEl) benchEl.setAttribute("data-si-bench", "1");
  if (dnpEl) dnpEl.setAttribute("data-si-dnp", "1");

  const r = best.getBoundingClientRect();
  return {
    ok: true,
    width: Math.round(r.width),
    height: Math.round(r.height),
    pct: percentCount(best),
    hasBench: Boolean(benchEl),
    hasDnp: Boolean(dnpEl),
  };
})()`;

export const SI_EXTRACT_SECTION_TEXT_SCRIPT = `(() => {
  const pitch = document.querySelector("[data-si-pitch]");
  const bench = document.querySelector("[data-si-bench]");
  const dnp = document.querySelector("[data-si-dnp]");
  return {
    pitch: pitch ? String(pitch.innerText || "") : "",
    bench: bench ? String(bench.innerText || "") : "",
    dnp: dnp ? String(dnp.innerText || "") : "",
  };
})()`;
