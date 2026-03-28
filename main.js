// ==UserScript==
// @name         PxHance
// @namespace    https://pixiv.net/
// @version      1.0.1
// @description  Hover Pixiv thumbnails to show a zoomed preview, scroll to view multiple pages, with single/all download options inside the blurred container. Click image to go to artwork page.
// @match        https://www.pixiv.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pixiv.net
// @grant        GM_addStyle
// @grant        GM_download
// @run-at       document-start
// ==/UserScript==

(() => {
  // biome-ignore lint/suspicious/noRedundantUseStrict: <explanation>
  "use strict";

  const DEBUG = true;
  const HOVER_DELAY = 60;
  const LEAVE_DELAY = 140;
  const ZOOM_SCALE = 1.8;
  const DOWNLOAD_DELAY = 300;

  let hoverTimer = null;
  let leaveTimer = null;
  let active = null;
  let tokenSeq = 0;

  const originalCache = new Map();

  function log(...args) {
    if (DEBUG) console.log("[PixivHover]", ...args);
  }
  function warn(...args) {
    if (DEBUG) console.warn("[PixivHover]", ...args);
  }
  function err(...args) {
    if (DEBUG) console.error("[PixivHover]", ...args);
  }

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
      transform: scale(0.96);
      opacity: 0;
      transition: transform 0.12s ease, opacity 0.12s ease;
      pointer-events: none;
      display: flex;
      flex-direction: column;
    }

    .px-hover-layer.px-show {
      transform: scale(1);
      opacity: 1;
      pointer-events: auto;
    }

    .px-hover-img-container {
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    /* 新增：图片链接层的样式 */
    .px-hover-link-wrapper {
        display: block;
        width: 100%;
        height: 100%;
        text-decoration: none;
        cursor: pointer; /* 提示可点击 */
        outline: none;
    }

    .px-hover-layer img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain !important;
      object-position: center center !important;
      user-select: none;
      -webkit-user-drag: none;
      background: transparent;
      pointer-events: none; /* 让点击穿透到 parent a 标签 */
    }

    .px-hover-controls {
      position: absolute;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
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
      transition: opacity 0.12s ease;
      z-index: 10;
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
      transition: background 0.1s;
    }

    .px-btn:hover { background: rgba(255, 255, 255, 0.25); }
    .px-btn:active { background: rgba(255, 255, 255, 0.4); }

    img[data-px-hoverable="1"] {
      cursor: zoom-in !important;
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

  function loadImage(url, timeoutMs = 15000) {
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
      const timer = setTimeout(() => finish(false), timeoutMs);
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

    // --- 修改开始：创建链接包装层 ---
    const linkWrapper = document.createElement("a");
    linkWrapper.className = "px-hover-link-wrapper";
    linkWrapper.target = "_blank"; //在新窗口打开作品页
    linkWrapper.rel = "noreferrer"; //保护隐私，防止 Referer 泄漏到作品页（虽然都在 Pixiv 域名下，但这是一种好习惯）

    const preview = document.createElement("img");

    linkWrapper.appendChild(preview);
    imgContainer.appendChild(linkWrapper);
    layer.appendChild(imgContainer);
    // --- 修改结束 ---

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

    // 把 linkWrapper 也传出去，方便后面设置 href
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

  function positionElements(layer, rect) {
    const w = Math.min(
      Math.max(Math.round(rect.width * ZOOM_SCALE), 300),
      window.innerWidth - 16,
    );
    const h = Math.min(
      Math.max(Math.round(rect.height * ZOOM_SCALE), 300),
      window.innerHeight - 16,
    );

    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top + rect.height / 2 - h / 2;

    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));

    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;
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

    // --- 新增：设置作品页链接 ---
    els.linkWrapper.href = `/artworks/${illustId}`;

    els.preview.src = thumbUrl;

    document.documentElement.appendChild(els.layer);

    positionElements(els.layer, img.getBoundingClientRect());
    requestAnimationFrame(() => els.layer.classList.add("px-show"));

    const keepAlive = () => {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    };
    const setLeave = () => {
      leaveTimer = setTimeout(() => removeActive(), LEAVE_DELAY);
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
          els.preview.src = active.urls[active.currentIndex];
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
          await new Promise((r) => setTimeout(r, DOWNLOAD_DELAY));
        }
      }
    });

    const urls = await fetchOriginalUrlsByIllustId(illustId);
    if (!urls || active.token !== myToken) return;

    active.urls = urls;
    els.pageInd.textContent = `1 / ${urls.length}`;

    if (urls.length <= 1) els.btnAll.style.display = "none";

    requestAnimationFrame(() => els.controls.classList.add("px-show"));

    try {
      await loadImage(urls[0]);
      if (active.token === myToken && active.currentIndex === 0) {
        els.preview.src = urls[0];
      }
    } catch (e) {
      err("Original load failed", e);
    }
  }

  function scheduleShow(img) {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showPreview(img), HOVER_DELAY);
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
        leaveTimer = setTimeout(() => removeActive(), LEAVE_DELAY);
      },
      true,
    );

    window.addEventListener(
      "scroll",
      () => {
        const layer = document.getElementById("px-hover-layer");
        if (layer && active?.img)
          positionElements(layer, active.img.getBoundingClientRect());
      },
      { passive: true },
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindGlobalEvents, {
      once: true,
    });
  } else {
    bindGlobalEvents();
  }
})();
