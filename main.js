// ==UserScript==
// @name         PxHance
// @namespace    https://pixiv.net/
// @version      1.3.0
// @description  Hover Pixiv thumbnails to show a zoomed preview, scroll to view multiple pages, with single/all download options inside the blurred container. Click image to go to artwork page.
// @match        https://www.pixiv.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pixiv.net
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license MIT
// ==/UserScript==

(() => {
  // biome-ignore lint/suspicious/noRedundantUseStrict: <explanation>
  "use strict";

  const DEBUG = false;

  const DEFAULTS = {
    HOVER_DELAY: 120,
    LEAVE_DELAY: 100,
    ZOOM_SCALE: 1.1,
    MAX_ZOOM_WIDTH_VW: 40,
    DOWNLOAD_DELAY: 200,
    IMAGE_LOAD_TIMEOUT: 8000,
    THUMB_UPGRADE_DELAY: 10,
  };

  const CONFIG = {
    HOVER_DELAY: GM_getValue("HOVER_DELAY", DEFAULTS.HOVER_DELAY),
    LEAVE_DELAY: GM_getValue("LEAVE_DELAY", DEFAULTS.LEAVE_DELAY),
    ZOOM_SCALE: GM_getValue("ZOOM_SCALE", DEFAULTS.ZOOM_SCALE),
    MAX_ZOOM_WIDTH_VW: GM_getValue(
      "MAX_ZOOM_WIDTH_VW",
      DEFAULTS.MAX_ZOOM_WIDTH_VW,
    ),
    DOWNLOAD_DELAY: GM_getValue("DOWNLOAD_DELAY", DEFAULTS.DOWNLOAD_DELAY),
    IMAGE_LOAD_TIMEOUT: DEFAULTS.IMAGE_LOAD_TIMEOUT,
    THUMB_UPGRADE_DELAY: DEFAULTS.THUMB_UPGRADE_DELAY,
  };

  function registerMenu() {
    GM_registerMenuCommand("Set Hover Delay", () => {
      const val = prompt("Hover Delay (ms):", CONFIG.HOVER_DELAY);
      if (val !== null) {
        GM_setValue("HOVER_DELAY", Number(val));
        location.reload();
      }
    });

    GM_registerMenuCommand("Set Leave Delay", () => {
      const val = prompt("Leave Delay (ms):", CONFIG.LEAVE_DELAY);
      if (val !== null) {
        GM_setValue("LEAVE_DELAY", Number(val));
        location.reload();
      }
    });

    GM_registerMenuCommand("Set Zoom Scale", () => {
      const val = prompt(
        "Zoom Scale (e.g., 1.1, 1.2, 1.5):",
        CONFIG.ZOOM_SCALE,
      );
      if (val !== null) {
        GM_setValue("ZOOM_SCALE", Number(val));
        location.reload();
      }
    });

    GM_registerMenuCommand("Set Max Zoom Width (vw)", () => {
      const val = prompt(
        "Max Zoom Width in viewport width % (e.g., 40, 50, 60):",
        CONFIG.MAX_ZOOM_WIDTH_VW,
      );
      if (val !== null) {
        GM_setValue("MAX_ZOOM_WIDTH_VW", Number(val));
        location.reload();
      }
    });

    GM_registerMenuCommand("Set Download Delay", () => {
      const val = prompt("Download Delay (ms):", CONFIG.DOWNLOAD_DELAY);
      if (val !== null) {
        GM_setValue("DOWNLOAD_DELAY", Number(val));
        location.reload();
      }
    });

    GM_registerMenuCommand("Reset Defaults", () => {
      Object.keys(DEFAULTS).forEach((k) => GM_setValue(k, DEFAULTS[k]));
      location.reload();
    });
  }

  registerMenu();

  let hoverTimer = null;
  let leaveTimer = null;
  let active = null;
  let tokenSeq = 0;

  const originalCache = new Map();

  function log(...args) {
    if (DEBUG) console.log("[PixivHover]", ...args);
  }

  function err(...args) {
    if (DEBUG) console.error("[PixivHover]", ...args);
  }

  // JUSTIFIED IMAGE GRID
  const MASONRY_ATTR = "data-px-masonry";
  const JG = {
    ROW_HEIGHT: 380,
    GAP: 8,
    MIN_ITEMS: 2,
    MIN_WIDTH: 240,
    LANDSCAPE_RATIO_THRESHOLD: 1.1,
    DESKTOP_ITEMS_PER_ROW: 4,
    MOBILE_ITEMS_PER_ROW: 2,
    MOBILE_BREAKPOINT: 768,
  };

  let masonryRaf = 0;
  let layoutLocked = false;
  let seenImages = new Set();

  GM_addStyle(`
  li[data-px-jg-item="1"] > div,
  li[data-px-jg-item="1"] > div > div {
    -webkit-mask-image: none !important;
    mask-image: none !important;
    overflow: unset !important;
  }

  ul[data-px-masonry="1"] {
    gap: 8px !important;
    width: 100% !important;
    padding-left: 0 !important;
    margin: 0 !important;
  }

  ul[data-px-masonry="1"] > li {
    list-style: none !important;
    flex: 0 0 auto !important;
    margin: 0 !important;
    padding: 0 !important;
    width: auto !important;
    max-width: none !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
    will-change: flex-basis, width, max-width;
  }

  li[data-px-jg-item="1"] div[width][height] {
    overflow: hidden !important;
    display: block !important;
    height: auto !important;
  }

  li[data-px-jg-item="1"] div[width][height] > a {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
  }

  li[data-px-jg-item="1"] img {
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
    object-position: center center !important;
    will-change: opacity;
  }
`);

  function findBookmarkGrid() {
    const uls = Array.from(document.querySelectorAll("ul"));

    for (const ul of uls) {
      const items = Array.from(ul.children).filter((el) => el.tagName === "LI");
      if (items.length < JG.MIN_ITEMS) continue;

      let hit = 0;
      for (const li of items.slice(0, 10)) {
        if (li.querySelector('a[href*="/artworks/"]')) hit++;
      }

      if (hit >= 3) return ul;
    }

    return null;
  }

  function getFrameNode(li) {
    return li.querySelector("div[width][height]");
  }

  function getThumbImage(li) {
    return li.querySelector("div[width][height] img");
  }

  function getImageRatio(img) {
    if (!img) return 1;

    // ✅ 优先使用预加载的master1200 ratio
    if (img.dataset.pxMaster1200Ratio) {
      return parseFloat(img.dataset.pxMaster1200Ratio);
    }

    // ✅ 然后 natural
    if (img.naturalWidth > 0) {
      return img.naturalWidth / img.naturalHeight;
    }

    // ✅ fallback: DOM 属性（pixiv 有 width/height）
    const w = parseFloat(img.getAttribute("width"));
    const h = parseFloat(img.getAttribute("height"));
    if (w && h) return w / h;

    return 1;
  }

  function isLandscapeRatio(ratio) {
    return ratio > JG.LANDSCAPE_RATIO_THRESHOLD;
  }

  function getSrcUpgradedUrl(src) {
    let upgraded = src;
    if (upgraded.includes("square1200") || upgraded.includes("custom1200")) {
      upgraded = upgraded.replace("square1200", "master1200");
      upgraded = upgraded.replace("custom1200", "master1200");
      upgraded = upgraded.replace("custom-thumb", "img-master");
      upgraded = upgraded.replace(/\/c\/[^/]+\//, "/");
    }
    return upgraded;
  }

  async function preloadMaster1200Size(img) {
    return new Promise((resolve) => {
      const upgraded = getSrcUpgradedUrl(img.src);
      if (!upgraded || upgraded === img.src) {
        resolve(null);
        return;
      }

      const hidden = new Image();
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 3000);

      const cleanup = () => {
        clearTimeout(timeout);
        hidden.onload = null;
        hidden.onerror = null;
      };

      hidden.onload = () => {
        cleanup();
        if (hidden.naturalWidth > 0 && hidden.naturalHeight > 0) {
          resolve(hidden.naturalWidth / hidden.naturalHeight);
        } else {
          resolve(null);
        }
      };

      hidden.onerror = () => {
        cleanup();
        resolve(null);
      };

      hidden.src = upgraded;
    });
  }

  async function preloadAllMaster1200Sizes() {
    const ul = findBookmarkGrid();
    if (!ul) return;

    const items = Array.from(ul.children).filter((el) => el.tagName === "LI");

    // 并行加载所有尺寸，不注册任何事件监听（避免重排）
    const promises = items.map(async (li) => {
      const img = getThumbImage(li);
      if (!img) return;

      if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
        return;
      }

      const ratio = await preloadMaster1200Size(img);
      if (ratio) {
        img.dataset.pxMaster1200Ratio = ratio;
      }
    });

    await Promise.all(promises);
  }

  function hookImage(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (seenImages.has(img)) return;
    seenImages.add(img);

    // If layout is locked (completed preload), don't trigger re-layout on load
    if (layoutLocked) {
      return;
    }

    const refresh = () => {
      scheduleBookmarkMasonry();
    };

    img.addEventListener("load", refresh);
    img.addEventListener("error", refresh);

    if (img.complete) {
      refresh();
    }
  }

  function applyRow(row, rowHeight) {
    const totalGap = JG.GAP * (row.length - 1);
    const usableWidth = Math.max(1, row.containerWidth - totalGap);
    const sumRatio = row.reduce((sum, item) => sum + item.ratio, 0);

    const scale = usableWidth / sumRatio;

    for (const item of row) {
      const li = item.li;
      const frame = getFrameNode(li);
      const w = Math.max(JG.MIN_WIDTH, Math.round(item.ratio * scale));

      li.dataset.pxJgItem = "1";
      li.style.setProperty("flex", `0 0 ${w}px`, "important");
      li.style.setProperty("width", `${w}px`, "important");
      li.style.setProperty("max-width", `${w}px`, "important");

      if (frame) {
        frame.style.setProperty("width", `${w}px`, "important");
        frame.style.setProperty("height", `${rowHeight}px`, "important");
        frame.style.setProperty("min-height", `${rowHeight}px`, "important");
      }
    }
  }

  function applyBookmarkMasonry() {
    const ul = findBookmarkGrid();
    if (!ul) return;

    ul.setAttribute(MASONRY_ATTR, "1");

    const items = Array.from(ul.children).filter((el) => el.tagName === "LI");
    const containerWidth =
      ul.clientWidth || document.documentElement.clientWidth || 1200;
    const isMobile = window.innerWidth < JG.MOBILE_BREAKPOINT;
    const targetItemsPerRow = isMobile
      ? JG.MOBILE_ITEMS_PER_ROW
      : JG.DESKTOP_ITEMS_PER_ROW;

    let row = [];

    const flushRow = () => {
      if (!row.length) return;

      const hasLandscape = row.some((item) => isLandscapeRatio(item.ratio));
      const totalGap = JG.GAP * (row.length - 1);
      const usableWidth = Math.max(1, containerWidth - totalGap);

      let rowHeight;

      if (!hasLandscape) {
        // Pure portrait: use fixed height
        rowHeight = JG.ROW_HEIGHT;
      } else {
        // Mixed or landscape: sync heights, calculate from width
        const sumRatio = row.reduce((sum, item) => sum + item.ratio, 0);
        rowHeight = Math.max(120, Math.round(usableWidth / sumRatio));
      }

      row.containerWidth = containerWidth;
      applyRow(row, rowHeight);

      row = [];
    };

    for (const li of items) {
      const img = getThumbImage(li);
      if (!img) continue;

      // 如果已预加载了master1200尺寸，使用该数据
      // 否则跳过未加载完的图片
      const hasPreloadedRatio = img.dataset.pxMaster1200Ratio;
      if (!hasPreloadedRatio) {
        if (
          !img.complete ||
          img.naturalWidth === 0 ||
          img.naturalHeight === 0
        ) {
          continue;
        }
      }

      const ratio = Math.max(0.25, Math.min(getImageRatio(img), 4.5));
      row.push({ li, ratio });

      // Check if row should flush
      const hasLandscape = row.some((item) => isLandscapeRatio(item.ratio));
      const sumRatio = row.reduce((sum, item) => sum + item.ratio, 0);
      const totalGap = JG.GAP * (row.length - 1);
      const usableWidth = Math.max(1, containerWidth - totalGap);

      let shouldFlush = false;

      if (!hasLandscape) {
        // Pure portrait: flush when reaching target count
        shouldFlush = row.length >= targetItemsPerRow;
      } else {
        // With landscape: flush based on width or row size
        const projectedHeight = Math.round(usableWidth / sumRatio);
        const minHeightForLandscape = 200;
        shouldFlush =
          row.length >= JG.DESKTOP_ITEMS_PER_ROW ||
          (row.length >= 2 && projectedHeight < minHeightForLandscape);
      }

      if (shouldFlush) {
        flushRow();
      }
    }

    flushRow();
    layoutLocked = true; // Lock layout after first apply
  }

  function scheduleBookmarkMasonry() {
    if (masonryRaf) return;

    masonryRaf = requestAnimationFrame(() => {
      masonryRaf = 0;
      setTimeout(applyBookmarkMasonry, 60);
    });
  }

  function hookSpaNavigation() {
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;

    history.pushState = function () {
      const ret = _pushState.apply(this, arguments);
      // Clear preload cache for new page
      seenImages = new Set();
      layoutLocked = false;
      // Pre-load sizes before layout on new page
      preloadAllMaster1200Sizes().then(() => {
        scheduleBookmarkMasonry();
      });
      return ret;
    };

    history.replaceState = function () {
      const ret = _replaceState.apply(this, arguments);
      seenImages = new Set();
      layoutLocked = false;
      preloadAllMaster1200Sizes().then(() => {
        scheduleBookmarkMasonry();
      });
      return ret;
    };

    window.addEventListener("popstate", () => {
      seenImages = new Set();
      layoutLocked = false;
      preloadAllMaster1200Sizes().then(() => {
        scheduleBookmarkMasonry();
      });
    });
  }

  // JUSTIFIED IMAGE GRID END

  // hover and preview
  GM_addStyle(`
    .px-hover-layer {
      position: fixed;
      z-index: 2147483647;
      box-sizing: border-box;
      overflow: hidden;
      border-radius: 8px;
      background: rgba(18, 18, 18, 0.75);
      border: 1px solid rgba(255,255,255,0.16);
      box-shadow: 0 18px 60px rgba(0,0,0,0.45);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      transform-origin: center center;
      transform: scale(0.96) translateZ(0);
      opacity: 0;
      transition: transform 0.1s ease-out, opacity 0.1s ease-out;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      will-change: transform, opacity;
    }

    .px-hover-layer.px-show {
      transform: scale(1) translateZ(0);
      opacity: 1;
      pointer-events: auto;
    }

    .px-hover-img-container {
      flex: 1;
      overflow: hidden !important;
      position: relative;
      max-width: 100% !important;
      max-height: 100% !important;
    }

    .px-hover-link-wrapper {
        display: block;
        width: 100%;
        height: 100%;
        text-decoration: none;
        cursor: pointer;
        outline: none;
    }

    .px-hover-layer img {
      display: block;
      width: 100% !important;
      height: 100% !important;
      max-width: 100% !important;
      max-height: 100% !important;
      object-fit: contain !important;
      object-position: center center !important;
      user-select: none;
      -webkit-user-drag: none;
      background: transparent;
      pointer-events: none;
      transition: opacity 0.08s ease-out;
      will-change: opacity;
    }

    .px-hover-controls {
      position: absolute;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%) translateZ(0);
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(20, 20, 20, 0.35);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      padding: 6px 14px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.35);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.1s ease-out;
      z-index: 10;
      will-change: opacity;
    }

    .px-hover-controls.px-show {
      opacity: 1;
      pointer-events: auto;
    }

    .px-page-indicator {
      color: #fff;
      font-size: 13px;
      font-weight: bold;
      font-family: monospace;
      min-width: 45px;
      text-align: center;
      user-select: none;
    }

    .px-btn {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.08s ease-out;
      will-change: background-color;
    }

    .px-btn:hover { background: rgba(255, 255, 255, 0.25); }
    .px-btn:active { background: rgba(255, 255, 255, 0.4); }

    img[data-px-hoverable="1"] {
      cursor: zoom-in !important;
    }

    div[width="184"][height="184"] {
      width: 100% !important;
      height: auto !important;
      max-width: none !important;
    }

    img.thumb {
      object-fit: contain !important;
      background: rgba(0, 0, 0, 0.05);
      will-change: opacity;
    }

  `);

  function getThumbUrl(img) {
    return (
      img.currentSrc ||
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("srcset")?.split(" ")[0] ||
      ""
    );
  }

  function getIllustIdFromElement(el) {
    const a = el.closest?.('a[href*="/artworks/"]');
    if (a) {
      const m = (a.getAttribute("href") || "").match(/\/artworks\/(\d+)/);
      if (m) return m[1];
    }
    const gtm = el.closest?.("[data-gtm-value]");
    if (gtm) {
      const v = gtm.getAttribute("data-gtm-value");
      if (v && /^\d+$/.test(v)) return v;
    }
    return null;
  }

  function isLikelyArtworkThumb(target) {
    return (
      target instanceof HTMLImageElement &&
      Boolean(getIllustIdFromElement(target))
    );
  }

  function loadImage(url, timeoutMs = null) {
    return new Promise((resolve, reject) => {
      const test = new Image();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        test.onload = null;
        test.onerror = null;
        ok ? resolve(url) : reject(new Error("image load failed"));
      };
      const timer = setTimeout(
        () => finish(false),
        timeoutMs ?? CONFIG.IMAGE_LOAD_TIMEOUT,
      );
      test.onload = () => finish(true);
      test.onerror = () => finish(false);
      test.src = url;
    });
  }

  function fetchOriginalUrlsByIllustId(illustId) {
    if (!illustId) return Promise.resolve(null);
    if (originalCache.has(illustId)) return originalCache.get(illustId);

    const p = fetch(`/ajax/illust/${illustId}/pages`, {
      credentials: "include",
      headers: { "x-requested-with": "XMLHttpRequest" },
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const j = await r.json();
        const urls = j?.body?.map((page) => page.urls.original).filter(Boolean);
        return urls && urls.length > 0 ? urls : null;
      })
      .catch((e) => {
        err("fetch original urls failed", illustId, e);
        return null;
      });

    originalCache.set(illustId, p);
    return p;
  }

  function createOverlayElements() {
    const layer = document.createElement("div");
    layer.id = "px-hover-layer";
    layer.className = "px-hover-layer";

    const imgContainer = document.createElement("div");
    imgContainer.className = "px-hover-img-container";

    const linkWrapper = document.createElement("a");
    linkWrapper.className = "px-hover-link-wrapper";
    linkWrapper.target = "_blank";
    linkWrapper.rel = "noreferrer";

    const preview = document.createElement("img");

    linkWrapper.appendChild(preview);
    imgContainer.appendChild(linkWrapper);
    layer.appendChild(imgContainer);

    const controls = document.createElement("div");
    controls.className = "px-hover-controls";

    const pageInd = document.createElement("div");
    pageInd.className = "px-page-indicator";
    pageInd.textContent = "- / -";

    const btnCurrent = document.createElement("button");
    btnCurrent.className = "px-btn";
    btnCurrent.textContent = "⬇️";

    const btnAll = document.createElement("button");
    btnAll.className = "px-btn";
    btnAll.textContent = "⬇️⬇️⬇️";

    controls.appendChild(pageInd);
    controls.appendChild(btnCurrent);
    controls.appendChild(btnAll);

    layer.appendChild(controls);

    return {
      layer,
      controls,
      preview,
      pageInd,
      btnCurrent,
      btnAll,
      linkWrapper,
    };
  }

  function positionElements(layer, rect, img) {
    // Display master1200 thumbnail * zoom scale, capped at configurable vw max width
    const maxWidthVw = window.innerWidth * (CONFIG.MAX_ZOOM_WIDTH_VW / 100);
    let w = Math.round(rect.width * CONFIG.ZOOM_SCALE);
    w = Math.min(Math.max(w, 300), maxWidthVw, window.innerWidth - 16);

    // Scale height proportionally to maintain aspect ratio
    const h = Math.round((w / rect.width) * rect.height);
    const finalH = Math.min(Math.max(h, 300), window.innerHeight - 16);

    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top + rect.height / 2 - finalH / 2;

    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - finalH - 8));

    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
    layer.style.setProperty("width", `${w}px`, "important");
    layer.style.setProperty("height", `${finalH}px`, "important");
    layer.style.setProperty("max-width", `${w}px`, "important");
    layer.style.setProperty("max-height", `${finalH}px`, "important");
  }

  function removeActive() {
    tokenSeq += 1;
    if (hoverTimer) clearTimeout(hoverTimer);
    if (leaveTimer) clearTimeout(leaveTimer);

    document.getElementById("px-hover-layer")?.remove();

    if (active) log("hide preview", active.illustId);
    active = null;
  }

  function executeDownload(url, illustId, index = null) {
    const defaultName =
      index !== null ? `pixiv_${illustId}_p${index}` : `pixiv_${illustId}`;
    const name = url.split("/").pop()?.split("?")[0] || defaultName;

    try {
      if (typeof GM_download === "function") {
        GM_download({
          url: url,
          name: name,
          saveAs: true,
          headers: { Referer: "https://www.pixiv.net/" },
          onerror: (e) => err("GM_download failed", e),
        });
        return;
      }
    } catch (e) {
      err("GM_download threw", e);
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.click();
  }

  async function showPreview(img) {
    const thumbUrl = getThumbUrl(img);
    const illustId = getIllustIdFromElement(img);
    if (!thumbUrl || !illustId) return;

    const myToken = ++tokenSeq;
    active = {
      token: myToken,
      img,
      illustId,
      thumbUrl,
      urls: [],
      currentIndex: 0,
    };

    document.getElementById("px-hover-layer")?.remove();

    const els = createOverlayElements();

    els.linkWrapper.href = `/artworks/${illustId}`;

    // Display master1200 only, don't load full resolution
    els.preview.src = thumbUrl;

    document.documentElement.appendChild(els.layer);

    positionElements(els.layer, img.getBoundingClientRect(), img);
    requestAnimationFrame(() => els.layer.classList.add("px-show"));

    const keepAlive = () => {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    };
    const setLeave = () => {
      leaveTimer = setTimeout(() => removeActive(), CONFIG.LEAVE_DELAY);
    };

    els.layer.addEventListener("pointerenter", keepAlive);
    els.layer.addEventListener("pointerleave", setLeave);

    els.layer.addEventListener(
      "wheel",
      (e) => {
        if (!active.urls || active.urls.length <= 1) return;
        e.preventDefault();

        const oldIndex = active.currentIndex;
        if (e.deltaY > 0) {
          active.currentIndex = Math.min(
            active.currentIndex + 1,
            active.urls.length - 1,
          );
        } else {
          active.currentIndex = Math.max(active.currentIndex - 1, 0);
        }

        if (oldIndex !== active.currentIndex) {
          // Still show master1200, not full resolution
          els.pageInd.textContent = `${active.currentIndex + 1} / ${active.urls.length}`;
        }
      },
      { passive: false },
    );

    els.btnCurrent.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (active.urls.length === 0) return;
      executeDownload(
        active.urls[active.currentIndex],
        active.illustId,
        active.currentIndex,
      );
    });

    els.btnAll.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (active.urls.length === 0) return;

      for (let i = 0; i < active.urls.length; i++) {
        executeDownload(active.urls[i], active.illustId, i);
        if (i < active.urls.length - 1) {
          await new Promise((r) => setTimeout(r, CONFIG.DOWNLOAD_DELAY));
        }
      }
    });

    // Fetch URLs for download and page indicator, but don't load images
    const urls = await fetchOriginalUrlsByIllustId(illustId);
    if (!urls || active.token !== myToken) return;

    active.urls = urls;
    els.pageInd.textContent = `1 / ${urls.length}`;

    if (urls.length <= 1) els.btnAll.style.display = "none";

    requestAnimationFrame(() => els.controls.classList.add("px-show"));
  }

  function scheduleShow(img) {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showPreview(img), CONFIG.HOVER_DELAY);
  }

  function bindGlobalEvents() {
    document.addEventListener(
      "pointerover",
      (e) => {
        const target =
          e.target instanceof Element ? e.target.closest("img") : null;
        if (!isLikelyArtworkThumb(target)) return;

        target.dataset.pxHoverable = "1";
        if (leaveTimer) {
          clearTimeout(leaveTimer);
          leaveTimer = null;
        }
        scheduleShow(target);
      },
      true,
    );

    document.addEventListener(
      "pointerout",
      (e) => {
        const fromImg =
          e.target instanceof Element ? e.target.closest("img") : null;
        if (!isLikelyArtworkThumb(fromImg)) return;

        const rel = e.relatedTarget;
        if (rel instanceof Node && fromImg.contains(rel)) return;

        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        if (leaveTimer) clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => removeActive(), CONFIG.LEAVE_DELAY);
      },
      true,
    );

    window.addEventListener(
      "scroll",
      () => {
        const layer = document.getElementById("px-hover-layer");
        if (layer && active?.img)
          positionElements(
            layer,
            active.img.getBoundingClientRect(),
            active.img,
          );
      },
      { passive: true },
    );
  }

  function upgradeThumbQuality(img) {
    if (!img || !img.src) return;

    const upgraded = getSrcUpgradedUrl(img.src);

    if (img.src !== upgraded) {
      img.removeAttribute("srcset");
      img.src = upgraded;
      // Layout is already locked, so load event won't trigger re-layout
    }
  }

  async function upgradeThumbsLater() {
    const ul = findBookmarkGrid();
    if (!ul) return;

    const imgs = Array.from(ul.querySelectorAll("img"));

    for (const img of imgs) {
      // Skip if already upgraded
      if (img.dataset.pxUpgraded === "1") continue;

      upgradeThumbQuality(img);
      img.dataset.pxUpgraded = "1";

      // Don't trigger re-layout since we already have preloaded sizes
      await new Promise((r) => setTimeout(r, CONFIG.THUMB_UPGRADE_DELAY));
    }
  }

  function waitLayoutStable(callback) {
    let lastHeight = 0;
    let stableCount = 0;

    const check = () => {
      const ul = findBookmarkGrid();
      if (!ul) return requestAnimationFrame(check);

      const h = ul.offsetHeight;

      if (h === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = h;
      }

      if (stableCount >= 3) {
        callback();
      } else {
        requestAnimationFrame(check);
      }
    };

    check();
  }

  function startBookmarkEnhance() {
    // 1. Pre-load master1200 sizes to lock layout
    layoutLocked = false;
    preloadAllMaster1200Sizes().then(() => {
      // 2. Apply layout based on final dimensions
      applyBookmarkMasonry();

      // 3. Wait for layout to stabilize, then upgrade thumbnails
      waitLayoutStable(() => {
        upgradeThumbsLater();
      });
    });
  }

  function initObserver() {
    let updateTimeout = null;

    const observer = new MutationObserver(() => {
      // Debounce: wait 300ms before updating layout
      if (updateTimeout) clearTimeout(updateTimeout);

      updateTimeout = setTimeout(() => {
        // Pre-load master1200 sizes before layout
        preloadAllMaster1200Sizes().then(() => {
          scheduleBookmarkMasonry();
        });

        setTimeout(() => {
          upgradeThumbsLater();
        }, 200);
      }, 300);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    startBookmarkEnhance();
  }

  // init
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        hookSpaNavigation();
        bindGlobalEvents();
        initObserver();
      },
      { once: true },
    );
  } else {
    hookSpaNavigation();
    bindGlobalEvents();
    initObserver();
  }
})();
