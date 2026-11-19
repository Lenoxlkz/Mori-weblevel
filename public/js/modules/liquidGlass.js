// liquidGlass.js — Apple Liquid Glass optical refraction, specular rim, pill nav & slider physics

const SVG_NS = "http://www.w3.org/2000/svg";
const refractionCache = new Map();
let svgDefsNode = null;
let filterIdCounter = 0;

/**
 * Computes Snell's law edge bevel refraction shift for a given distance from edge.
 * @param {number} bezel
 * @param {number} thickness
 * @param {number} ior
 * @returns {(distance: number) => number}
 */
export function computeBevelDisplacement(bezel = 12, thickness = 18, ior = 1.5) {
  const safeBezel = Math.max(1, Number(bezel) || 1);
  const safeThickness = Math.max(0, Number(thickness) || 0);
  const safeIor = Math.max(1, Number(ior) || 1.5);
  const samples = 128;
  const lut = new Float32Array(samples);

  for (let i = 0; i < samples; i++) {
    const t = Math.max(2e-3, i / (samples - 1));
    const q = 1 - t;
    const base = 1 - q ** 4;
    const height = base ** 0.25;
    const slope = q ** 3 / Math.max(1e-4, base ** 0.75);
    const incident = Math.atan(slope);
    const refracted = Math.asin(Math.min(1, Math.sin(incident) / safeIor));
    lut[i] =
      Math.tan(incident - refracted) * safeThickness * (0.35 + 0.65 * height);
  }

  return (distance) => {
    if (distance < 0 || distance >= safeBezel) return 0;
    const f = (distance / safeBezel) * (samples - 1);
    const idx = Math.floor(f);
    const a = lut[idx];
    const b = lut[Math.min(idx + 1, samples - 1)];
    return a + (b - a) * (f - idx);
  };
}

/**
 * Computes normalized [0, 1] progress ratio for range sliders.
 */
export function computeSliderProgress(value, min = 0, max = 100) {
  const v = Number(value);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return 0;
  }
  const span = hi - lo;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (v - lo) / span));
}

/**
 * Computes floating pill lens geometry inside the bottom navigation bar.
 */
export function computeNavPillMetrics(itemRect, containerRect) {
  if (!itemRect || !containerRect || itemRect.width <= 0) {
    return { left: 0, width: 0, visible: false };
  }
  const left = Math.max(4, itemRect.left - containerRect.left);
  const width = Math.max(0, itemRect.width);
  return {
    left: Math.round(left * 10) / 10,
    width: Math.round(width * 10) / 10,
    visible: width > 0,
  };
}

/**
 * Resolves initial theme honoring explicit saved preference or system color scheme.
 */
export function resolveInitialTheme(storedTheme, prefersDark = false) {
  if (storedTheme === "dark" || storedTheme === "light") {
    return storedTheme;
  }
  return prefersDark ? "dark" : "light";
}

/**
 * Checks whether the current browser reliably supports SVG feDisplacementMap backdrop filters.
 */
export function supportsSvgBackdropRefraction(userAgent = "") {
  return (
    /Chrom(e|ium)\/|Edg\//.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS/.test(userAgent)
  );
}

function getSvgDefs() {
  if (svgDefsNode?.isConnected) return svgDefsNode;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-liquid-glass-defs", "");
  svg.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  svgDefsNode = document.createElementNS(SVG_NS, "defs");
  svg.appendChild(svgDefsNode);
  document.body.appendChild(svg);
  return svgDefsNode;
}

function encodeCanvasDataUrl(canvas) {
  return new Promise((resolve) => {
    try {
      resolve(canvas.toDataURL("image/png"));
    } catch (_) {
      resolve("");
    }
  });
}

function bakeGlassSurface(width, height, radius, options = {}) {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const r = Math.min(w / 2, h / 2, Math.max(4, Math.round(radius)));
  const bezel = options.bezel ?? Math.min(16, Math.max(6, Math.min(w, h) * 0.18));
  const thickness = options.thickness ?? Math.min(22, Math.max(8, Math.min(w, h) * 0.28));
  const key = `${w}|${h}|${r}|${bezel.toFixed(1)}|${thickness.toFixed(1)}`;
  if (refractionCache.has(key)) return refractionCache.get(key);

  const density = Math.min(window.devicePixelRatio || 1, 1.5);
  const cw = Math.max(16, Math.ceil(w * density));
  const ch = Math.max(16, Math.ceil(h * density));
  const shift = computeBevelDisplacement(bezel, thickness, 1.5);

  const dx = new Float32Array(cw * ch);
  const dy = new Float32Array(cw * ch);
  const rimA = new Float32Array(cw * ch);
  const maskA = new Float32Array(cw * ch);
  const outerIdx = new Int32Array(cw * ch);
  let outerCount = 0;
  let maxDisp = 1e-4;

  const hw = w / 2;
  const hh = h / 2;
  const pxStep = 1 / density;
  const flatLimit = Math.max(bezel * 1.7, 5);

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const px = ((x + 0.5) * w) / cw - hw;
      const py = ((y + 0.5) * h) / ch - hh;
      const qx = Math.abs(px) - (hw - r);
      const qy = Math.abs(py) - (hh - r);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const len = Math.hypot(ox, oy);
      const d = r - (len + Math.min(Math.max(qx, qy), 0));
      const idx = y * cw + x;

      if (d > flatLimit) {
        maskA[idx] = 1;
        continue;
      }

      outerIdx[outerCount++] = idx;

      let nx = 0;
      let ny = 0;
      if (len > 0) {
        nx = (ox / len) * Math.sign(px);
        ny = (oy / len) * Math.sign(py);
      } else if (qx > qy) {
        nx = Math.sign(px);
      } else {
        ny = Math.sign(py);
      }

      const s = -shift(d);
      const vx = nx * s;
      const vy = ny * s;
      dx[idx] = vx;
      dy[idx] = vy;

      const m = Math.max(Math.abs(vx), Math.abs(vy));
      if (m > maxDisp) maxDisp = m;

      maskA[idx] = Math.min(1, Math.max(0, d / pxStep + 0.5));

      if (d >= -pxStep) {
        const facing = -(nx + ny) * Math.SQRT1_2;
        const light =
          0.22 + 0.78 * Math.abs(facing) ** 2.2 * (facing > 0 ? 1 : 0.62);
        const hair = Math.max(0.55, pxStep * 0.75);
        const line = Math.exp(-(((d - hair) / hair) ** 2));
        const inner = Math.exp(-((d / (bezel * 0.55)) ** 2)) * 0.14;
        const edgeAA = Math.min(1, Math.max(0, d / pxStep + 1));
        rimA[idx] = Math.min(1, Math.max(0, (line * 0.7 + inner) * light * edgeAA));
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const empty = Promise.resolve({ filter: "", rim: "" });
    refractionCache.set(key, empty);
    return empty;
  }

  // 1. Displacement map
  const dispImg = ctx.createImageData(cw, ch);
  dispImg.data.fill(128);
  for (let i = 3; i < dispImg.data.length; i += 4) dispImg.data[i] = 255;
  for (let e = 0; e < outerCount; e++) {
    const i = outerIdx[e];
    const o = i * 4;
    dispImg.data[o] = Math.round(127.5 + (dx[i] / maxDisp) * 127.5);
    dispImg.data[o + 1] = Math.round(127.5 + (dy[i] / maxDisp) * 127.5);
  }
  ctx.putImageData(dispImg, 0, 0);
  const dispPromise = encodeCanvasDataUrl(canvas);

  // 2. Specular rim overlay
  const rimImg = ctx.createImageData(cw, ch);
  for (let i = 0; i < cw * ch; i++) {
    const o = i * 4;
    rimImg.data[o] = 255;
    rimImg.data[o + 1] = 255;
    rimImg.data[o + 2] = 255;
    rimImg.data[o + 3] = Math.round(rimA[i] * 255);
  }
  ctx.putImageData(rimImg, 0, 0);
  const rimPromise = encodeCanvasDataUrl(canvas);

  // 3. Shape mask
  const maskImg = ctx.createImageData(cw, ch);
  for (let i = 0; i < cw * ch; i++) {
    const o = i * 4;
    maskImg.data[o] = 255;
    maskImg.data[o + 1] = 255;
    maskImg.data[o + 2] = 255;
    maskImg.data[o + 3] = Math.round(maskA[i] * 255);
  }
  ctx.putImageData(maskImg, 0, 0);
  const maskPromise = encodeCanvasDataUrl(canvas);

  const job = Promise.all([dispPromise, rimPromise, maskPromise]).then(
    ([mapUrl, rimUrl, maskUrl]) => {
      if (!mapUrl || !maskUrl) return { filter: "", rim: rimUrl ? `url("${rimUrl}")` : "" };
      const id = `mori-lg-refract-${++filterIdCounter}`;
      const filter = document.createElementNS(SVG_NS, "filter");
      filter.setAttribute("id", id);
      filter.setAttribute("x", "-0.2");
      filter.setAttribute("y", "-0.2");
      filter.setAttribute("width", "1.4");
      filter.setAttribute("height", "1.4");
      filter.setAttribute("color-interpolation-filters", "sRGB");

      const feField = document.createElementNS(SVG_NS, "feImage");
      feField.setAttribute("href", mapUrl);
      feField.setAttribute("x", "0");
      feField.setAttribute("y", "0");
      feField.setAttribute("width", String(w));
      feField.setAttribute("height", String(h));
      feField.setAttribute("preserveAspectRatio", "none");
      feField.setAttribute("result", "field");

      const feDisp = document.createElementNS(SVG_NS, "feDisplacementMap");
      feDisp.setAttribute("in", "SourceGraphic");
      feDisp.setAttribute("in2", "field");
      feDisp.setAttribute("scale", String((maxDisp * 2).toFixed(2)));
      feDisp.setAttribute("xChannelSelector", "R");
      feDisp.setAttribute("yChannelSelector", "G");
      feDisp.setAttribute("result", "bent");

      const feMask = document.createElementNS(SVG_NS, "feImage");
      feMask.setAttribute("href", maskUrl);
      feMask.setAttribute("x", "0");
      feMask.setAttribute("y", "0");
      feMask.setAttribute("width", String(w));
      feMask.setAttribute("height", String(h));
      feMask.setAttribute("preserveAspectRatio", "none");
      feMask.setAttribute("result", "shape");

      const feClip = document.createElementNS(SVG_NS, "feComposite");
      feClip.setAttribute("in", "bent");
      feClip.setAttribute("in2", "shape");
      feClip.setAttribute("operator", "in");

      filter.append(feField, feDisp, feMask, feClip);
      getSvgDefs().appendChild(filter);

      return {
        filter: `url(#${id})`,
        rim: rimUrl ? `url("${rimUrl}")` : "",
      };
    },
  );

  refractionCache.set(key, job);
  return job;
}

function syncAllRangeSliders() {
  document.querySelectorAll('input[type="range"]').forEach((slider) => {
    const p = computeSliderProgress(
      slider.value,
      slider.min === "" ? 0 : slider.min,
      slider.max === "" ? 100 : slider.max,
    );
    slider.style.setProperty("--lg-progress", String(p));
  });
}

function initNavLens() {
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return;

  let lens = nav.querySelector(".mori-nav-lens");
  if (!lens) {
    lens = document.createElement("div");
    lens.className = "mori-nav-lens";
    lens.setAttribute("aria-hidden", "true");
    nav.prepend(lens);
  }

  let rafId = 0;
  const positionLens = () => {
    rafId = 0;
    const activeItem = nav.querySelector(".nav-item.active");
    if (!activeItem || activeItem.style.display === "none") {
      lens.classList.remove("ready");
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const itemRect = activeItem.getBoundingClientRect();
    const metrics = computeNavPillMetrics(itemRect, navRect);
    if (!metrics.visible) {
      lens.classList.remove("ready");
      return;
    }
    lens.style.width = `${metrics.width}px`;
    lens.style.transform = `translate3d(${metrics.left}px, 0, 0)`;
    lens.classList.add("ready");
  };

  const schedulePosition = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(positionLens);
  };

  schedulePosition();

  const observer = new MutationObserver(schedulePosition);
  observer.observe(nav, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  window.addEventListener("resize", schedulePosition, { passive: true });
  window.addEventListener("mori_gallery_visibility_changed", schedulePosition);
  window.addEventListener("mori_tools_visibility_changed", schedulePosition);
  document.fonts?.ready?.then(schedulePosition);
}

function initScrollRefractionGovernor() {
  let scrollTimer = 0;
  const markScrolling = () => {
    document.documentElement.setAttribute("data-lg-scrolling", "");
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      document.documentElement.removeAttribute("data-lg-scrolling");
    }, 140);
  };
  window.addEventListener("scroll", markScrolling, {
    passive: true,
    capture: true,
  });
}

function initRefractionSurfaces() {
  const canRefract = supportsSvgBackdropRefraction(navigator.userAgent);
  const reducedTransparency = window.matchMedia?.(
    "(prefers-reduced-transparency: reduce)",
  )?.matches;
  if (reducedTransparency) return;

  const targets = [
    ".bottom-nav",
    "#downloadBtn",
    ".download-bubble-btn",
    ".download-bubble-dropup",
    ".media-card",
    ".modal-content",
  ];

  const applyToElement = (el) => {
    if (!el || document.body?.classList.contains("glass-off")) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return;
    const computedRadius = parseFloat(getComputedStyle(el).borderRadius) || 24;
    if (canRefract) {
      el.setAttribute("data-lg-refract", "surface");
    }
    bakeGlassSurface(rect.width, rect.height, computedRadius).then(
      ({ filter, rim }) => {
        if (!el.isConnected) return;
        if (filter && canRefract) {
          el.style.setProperty("--lg-refraction", filter);
        }
        if (rim) {
          el.style.setProperty("--lg-rim", rim);
        }
      },
    );
  };

  const refreshAll = () => {
    targets.forEach((selector) => {
      document.querySelectorAll(selector).forEach(applyToElement);
    });
  };

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        applyToElement(entry.target);
      }
    });
    targets.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => ro.observe(el));
    });
  }

  refreshAll();
  window.addEventListener("resize", refreshAll, { passive: true });
}

function initPointerShimmer() {
  const selector =
    "#downloadBtn, .chip, .gallery-chip, .sniffer-filter-chip, .tool-chip, .settings-menu-item, .tool-card, .edit-btn, .done-btn, .clear-all-btn, .download-bubble-btn, .back-btn-settings, .tool-view-back-btn, .gallery-rescan";

  let activeTarget = null;

  const updatePointerPos = (el, clientX, clientY) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (((clientX - rect.left) / rect.width) * 100).toFixed(1);
    const y = (((clientY - rect.top) / rect.height) * 100).toFixed(1);
    el.style.setProperty("--lg-x", `${x}%`);
    el.style.setProperty("--lg-y", `${y}%`);
  };

  document.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target?.closest?.(selector);
      if (!target) return;
      activeTarget = target;
      updatePointerPos(target, e.clientX, e.clientY);
      target.setAttribute("data-pressed", "");
    },
    { passive: true },
  );

  const release = () => {
    if (!activeTarget) return;
    activeTarget.removeAttribute("data-pressed");
    activeTarget = null;
  };

  document.addEventListener("pointerup", release, { passive: true });
  document.addEventListener("pointercancel", release, { passive: true });
}

function initSystemThemeSync() {
  const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mql) return;

  const handleChange = () => {
    const explicit = localStorage.getItem("mori_theme");
    if (explicit === "dark" || explicit === "light") return;
    const nextTheme = resolveInitialTheme(null, mql.matches);
    document.documentElement.setAttribute("data-theme", nextTheme);
    const toggle = document.getElementById("darkModeToggle");
    if (toggle) toggle.checked = nextTheme === "dark";
  };

  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handleChange);
  }
}

export function initLiquidGlass() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  initSystemThemeSync();
  initNavLens();
  syncAllRangeSliders();
  initScrollRefractionGovernor();
  initPointerShimmer();

  document.addEventListener("input", (e) => {
    if (e.target?.matches?.('input[type="range"]')) {
      syncAllRangeSliders();
    }
  });

  // Sync dynamic sliders inserted later (e.g. Tools subviews)
  const sliderObserver = new MutationObserver(() => {
    syncAllRangeSliders();
  });
  sliderObserver.observe(document.body, { childList: true, subtree: true });

  // Defer refraction baking slightly so initial paint stays instant
  requestAnimationFrame(() => {
    initRefractionSurfaces();
  });
}
