/* global XBookmarksParser, XBookmarksArchive, chrome */
(function () {
  "use strict";

  const SETTINGS_KEY = "fetchDelaySeconds";
  const THEME_KEY = "xbmTheme";
  const ENABLED_KEY = "xbmEnabled";
  const DEFAULT_DELAY_SECONDS = 3;
  const MIN_DELAY_SECONDS = 1;
  const MAX_DELAY_SECONDS = 60;
  const CLAMP_LINES = 8;

  let fetchDelayMs = DEFAULT_DELAY_SECONDS * 1000;
  const bookmarks = new Map();
  let activeTab = "bookmarks";
  let searchQuery = "";
  let enabled = true;
  let isLoading = false;
  let themePref = "auto";
  let viewRange = "all";
  let viewFrom = "";
  let viewTo = "";
  let sortDir = "desc";
  const PAGE_SIZE = 100;
  let visibleLimit = PAGE_SIZE;
  let uiRoot = null;
  let nextCursor = null;
  let lastApiUrl = null;
  let lastApiMeta = null;
  let isFetchingMore = false;
  let seenCursors = new Set();
  let loadAllActive = false;
  let fetchChainTimer = null;
  let pendingRemoveId = null;
  let archiveSaveTimer = null;
  let lastArchiveSaveAt = 0;
  let fetchRetryCount = 0;
  let lastFetchUrl = null;
  const MAX_FETCH_RETRIES = 5;

  function clampDelaySeconds(value) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return DEFAULT_DELAY_SECONDS;
    return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, n));
  }

  function getDelaySeconds() {
    return fetchDelayMs / 1000;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        { [SETTINGS_KEY]: DEFAULT_DELAY_SECONDS, [THEME_KEY]: "auto", [ENABLED_KEY]: true },
        (result) => {
          fetchDelayMs =
            clampDelaySeconds(result[SETTINGS_KEY]) * 1000;
          themePref = result[THEME_KEY] === "dark" || result[THEME_KEY] === "light"
            ? result[THEME_KEY]
            : "auto";
          enabled = result[ENABLED_KEY] !== false;
          resolve();
        }
      );
    });
  }

  function isHistoryPage() {
    return window.location.pathname.startsWith("/i/history");
  }

  function getPageTitle() {
    return "Bookmarks";
  }

  function detectXDark() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const parts = String(bg).match(/[\d.]+/g);
      if (parts && parts.length >= 3) {
        const [r, g, b] = parts.map(Number);
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return luminance < 0.35;
      }
    } catch (_) {}
    return Boolean(
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function getEffectiveTheme() {
    if (themePref === "dark" || themePref === "light") return themePref;
    return detectXDark() ? "dark" : "light";
  }

  function applyTheme() {
    const app = uiRoot?.querySelector(".xbm-app");
    if (app) app.dataset.theme = getEffectiveTheme();
    updateThemeButton();
  }

  function setTheme(next) {
    themePref = next;
    chrome.storage.sync.set({ [THEME_KEY]: next }, () => {});
    applyTheme();
  }

  function setEnabled(next) {
    enabled = next;
    chrome.storage.sync.set({ [ENABLED_KEY]: next }, () => {});
    document.body.classList.toggle("xbm-active", next);
    if (!next) {
      stopLoadAll();
      uiRoot?.remove();
      uiRoot = null;
    } else {
      mountUI();
    }
    updateFloat();
  }

  function ensureFloat() {
    if (!document.body || document.getElementById("xbm-float-root")) return;
    const root = document.createElement("div");
    root.id = "xbm-float-root";
    root.innerHTML = `<button type="button" id="xbm-float-btn" title="Show custom bookmarks view" aria-label="Show custom bookmarks view">${ICON_EYE}</button>`;
    document.body.appendChild(root);
    root.querySelector("button").addEventListener("click", () => setEnabled(true));
  }

  function updateFloat() {
    const root = document.getElementById("xbm-float-root");
    if (root) root.hidden = enabled;
  }

  function openSettingsModal() {
    const modal = document.getElementById("xbm-settings-modal");
    const input = document.getElementById("xbm-settings-delay");
    if (!modal || !input) return;
    input.value = getDelaySeconds();
    modal.hidden = false;
  }

  function closeSettingsModal() {
    const modal = document.getElementById("xbm-settings-modal");
    if (modal) modal.hidden = true;
  }

  function saveDelayFromModal(value) {
    const seconds = clampDelaySeconds(value);
    const input = document.getElementById("xbm-settings-delay");
    if (input) input.value = seconds;
    chrome.storage.sync.set({ [SETTINGS_KEY]: seconds }, () => {
      if (chrome.runtime.lastError) {
        showToast("Could not save settings");
        return;
      }
      fetchDelayMs = seconds * 1000;
      updateLoadingUI();
      showToast(`Saved - ${seconds} second wait`);
      closeSettingsModal();
    });
  }

  function injectScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("content/inject.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function replaceBookmarks(items) {
    bookmarks.clear();
    for (const item of items) {
      if (item?.id) bookmarks.set(String(item.id), item);
    }
  }

  function scheduleArchiveSave() {
    clearTimeout(archiveSaveTimer);
    archiveSaveTimer = setTimeout(async () => {
      if (loadAllActive && Date.now() - lastArchiveSaveAt < 30000) return;
      lastArchiveSaveAt = Date.now();
      try {
        await XBookmarksArchive.save(Array.from(bookmarks.values()));
      } catch (error) {
        if (String(error?.message).includes("Extension context invalidated")) return;
        console.error("X Bookmarks archive save failed", error);
        showToast("Local archive could not be saved");
      }
    }, 250);
  }

  function mergeBookmarks(tweets) {
    const previousCount = bookmarks.size;
    const merged = XBookmarksArchive.merge(
      Array.from(bookmarks.values()),
      tweets
    );
    replaceBookmarks(merged);
    scheduleArchiveSave();
    return bookmarks.size - previousCount;
  }

  function formatRelativeDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 1) return "today";
    if (diffDays === 1) return "1d";
    if (diffDays < 7) return `${diffDays}d`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;

    return date.toLocaleDateString("en-US", { day: "numeric", month: "short" });
  }

  function formatMonthHeader(iso) {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function linkifyText(text) {
    let html = escapeHtml(text);
    html = html.replace(
      /(https?:\/\/[^\s]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    );
    html = html.replace(
      /@([a-zA-Z0-9_]+)/g,
      '<a href="https://x.com/$1" target="_blank" rel="noopener">@$1</a>'
    );
    html = html.replace(
      /#([a-zA-Z0-9_\u0080-\uFFFF]+)/g,
      '<a href="https://x.com/hashtag/$1" target="_blank" rel="noopener">#$1</a>'
    );
    return html;
  }

  function getItemTime(item) {
    const raw = item.createdAt || item.bookmarkedAt || null;
    const t = raw ? new Date(raw).getTime() : NaN;
    return Number.isNaN(t) ? null : t;
  }

  function getViewBounds() {
    const now = Date.now();
    if (viewRange === "7" || viewRange === "30") {
      return { from: now - parseInt(viewRange, 10) * 24 * 60 * 60 * 1000, to: null };
    }
    if (viewRange === "custom") {
      const from = viewFrom ? new Date(`${viewFrom}T00:00:00`).getTime() : null;
      const to = viewTo ? new Date(`${viewTo}T23:59:59.999`).getTime() : null;
      return {
        from: Number.isNaN(from) ? null : from,
        to: Number.isNaN(to) ? null : to,
      };
    }
    return { from: null, to: null };
  }

  function getFilteredBookmarks() {
    const { from, to } = getViewBounds();
    let list = Array.from(bookmarks.values());

    if (from || to) {
      list = list.filter((b) => {
        const t = getItemTime(b);
        if (t === null) return !from && !to;
        if (from && t < from) return false;
        if (to && t > to) return false;
        return true;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (b) =>
          b.text?.toLowerCase().includes(q) ||
          b.author?.name?.toLowerCase().includes(q) ||
          b.author?.screenName?.toLowerCase().includes(q)
      );
    }

    const dir = sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const ta = getItemTime(a) ?? 0;
      const tb = getItemTime(b) ?? 0;
      return (ta - tb) * dir;
    });
  }

  function groupByMonth(items) {
    const groups = new Map();
    for (const item of items) {
      const key = item.createdAt
        ? formatMonthHeader(item.createdAt)
        : "Undated";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return groups;
  }

  function groupByAuthor(items) {
    const groups = new Map();
    for (const item of items) {
      const key = item.author?.screenName || "unknown";
      if (!groups.has(key)) {
        groups.set(key, { author: item.author, tweets: [] });
      }
      groups.get(key).tweets.push(item);
    }
    return Array.from(groups.values()).sort((a, b) =>
      a.author.name.localeCompare(b.author.name, "en")
    );
  }

  function renderMedia(media) {
    if (!media?.length) return "";
    return media
      .slice(0, 4)
      .map(
        (m) => `
      <div class="xbm-media-item ${media.length > 1 ? "xbm-media-grid" : ""}">
        <img src="${escapeHtml(m.previewUrl)}" alt="" loading="lazy" />
      </div>`
      )
      .join("");
  }

  function renderQuoted(quoted) {
    if (!quoted) return "";
    return `
      <div class="xbm-quoted">
        <div class="xbm-card-header">
          <img class="xbm-avatar xbm-avatar-sm" src="${escapeHtml(quoted.author.avatarUrl)}" alt="" />
          <div class="xbm-author-meta">
            <span class="xbm-name">${escapeHtml(quoted.author.name)}</span>
            <span class="xbm-handle">@${escapeHtml(quoted.author.screenName)}</span>
          </div>
        </div>
        <div class="xbm-text" data-clamp>${linkifyText(quoted.text)}</div>
        <button type="button" class="xbm-readmore">Read more</button>
        ${quoted.media?.length ? `<div class="xbm-media">${renderMedia(quoted.media)}</div>` : ""}
      </div>`;
  }

  function renderCard(tweet) {
    const verified = tweet.author.verified
      ? '<svg class="xbm-verified" viewBox="0 0 24 24"><path fill="currentColor" d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z"/></svg>'
      : "";

    const removing = pendingRemoveId === tweet.id;

    return `
      <article class="xbm-card${removing ? " xbm-card-removing" : ""}" data-id="${escapeHtml(tweet.id)}">
        <div class="xbm-card-header">
          <img class="xbm-avatar" src="${escapeHtml(tweet.author.avatarUrl)}" alt="" loading="lazy" />
          <div class="xbm-author-meta">
            <div class="xbm-name-row">
              <span class="xbm-name">${escapeHtml(tweet.author.name)}</span>
              ${verified}
            </div>
            <span class="xbm-handle">@${escapeHtml(tweet.author.screenName)}</span>
          </div>
          <time class="xbm-time">${formatRelativeDate(tweet.createdAt)}</time>
          <button type="button" class="xbm-remove-btn" data-id="${escapeHtml(tweet.id)}" title="Remove bookmark" aria-label="Remove bookmark" ${removing ? "disabled" : ""}>
            ${ICON_BOOKMARK}
          </button>
        </div>
        <div class="xbm-text" data-clamp>${linkifyText(tweet.text)}</div>
        <button type="button" class="xbm-readmore">Read more</button>
        ${tweet.media?.length ? `<div class="xbm-media">${renderMedia(tweet.media)}</div>` : ""}
        ${renderQuoted(tweet.quotedTweet)}
        <div class="xbm-card-actions">
          <a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener" class="xbm-action-link">Open</a>
        </div>
      </article>`;
  }

  function renderBookmarksGrid(items) {
    if (!items.length) {
      const hint = isHistoryPage()
        ? 'The first page is loaded by X. Make sure you are on the Bookmarks tab, then click "Load All" below to fetch everything.'
        : 'The first page is loaded by X. To fetch everything, click "Load All" below.';
      return `<div class="xbm-empty">
        <p>No bookmarks yet, or nothing matches your search.</p>
        <p class="xbm-empty-hint">${hint}</p>
      </div>`;
    }

    const groups = groupByMonth(items);
    let html = '<div class="xbm-masonry">';

    for (const [month, tweets] of groups) {
      html += `<h2 class="xbm-month-header">${escapeHtml(month)}</h2>`;
      html += '<div class="xbm-columns">';
      html += tweets.map(renderCard).join("");
      html += "</div>";
    }

    html += "</div>";
    return html;
  }

  function renderAuthorsView(items) {
    const groups = groupByAuthor(items);
    if (!groups.length) {
      return `<div class="xbm-empty"><p>No authors found.</p></div>`;
    }

    let html = '<div class="xbm-authors-grid">';
    for (const group of groups) {
      html += `
        <section class="xbm-author-section">
          <div class="xbm-author-header">
            <img class="xbm-avatar" src="${escapeHtml(group.author.avatarUrl)}" alt="" />
            <div>
              <div class="xbm-name">${escapeHtml(group.author.name)}</div>
              <div class="xbm-handle">@${escapeHtml(group.author.screenName)} · ${group.tweets.length} bookmarks</div>
            </div>
          </div>
          <div class="xbm-columns">${group.tweets.map(renderCard).join("")}</div>
        </section>`;
    }
    html += "</div>";
    return html;
  }

  function renderMainContent() {
    const items = getFilteredBookmarks();
    const visible = items.slice(0, visibleLimit);
    const remaining = items.length - visible.length;
    const footer = remaining > 0
      ? `<div class="xbm-more-wrap"><button type="button" class="xbm-show-more">Show more (${visible.length} of ${items.length})</button></div>`
      : "";
    if (activeTab === "authors") return renderAuthorsView(visible) + footer;
    return renderBookmarksGrid(visible) + footer;
  }

  function getLoadLabel() {
    if (!isLoading) return "Load all";
    if (loadAllActive) return `Loading… (${getDelaySeconds()}s)`;
    return "Loading…";
  }

  const THEME_ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  const THEME_ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
  const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_ARROW_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';
  const ICON_ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
  const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/></svg>';
  const ICON_SETTINGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
  const ICON_CHEVRONS_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>';
  const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
  const ICON_BOOKMARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>';
  const ICON_CALENDAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';
  const ICON_ARCHIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  function getThemeButton() {
    const dark = getEffectiveTheme() === "dark";
    return {
      icon: dark ? THEME_ICON_SUN : THEME_ICON_MOON,
      title: dark ? "Switch to light mode" : "Switch to dark mode",
    };
  }

  function closeMenus(except) {
    ["xbm-export-menu", "xbm-load-menu"].forEach((id) => {
      if (id === except) return;
      const menu = document.getElementById(id);
      if (menu) menu.hidden = true;
    });
    const exportBtn = document.getElementById("xbm-export-btn");
    if (exportBtn && except !== "xbm-export-menu") exportBtn.setAttribute("aria-expanded", "false");
    const loadBtn = document.getElementById("xbm-load-btn");
    if (loadBtn && except !== "xbm-load-menu") loadBtn.setAttribute("aria-expanded", "false");
  }

  function toggleMenu(menuId, btnId) {
    const menu = document.getElementById(menuId);
    const btn = document.getElementById(btnId);
    if (!menu || !btn) return;
    const willOpen = menu.hidden;
    closeMenus();
    menu.hidden = !willOpen;
    btn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen && menuId === "xbm-export-menu") {
      const countEl = document.getElementById("xbm-export-count");
      if (countEl) countEl.textContent = `${bookmarks.size} bookmarks`;
    }
  }

  function updateSortButton() {
    const btn = document.getElementById("xbm-sort");
    if (!btn) return;
    const newest = sortDir !== "asc";
    btn.innerHTML = `${newest ? ICON_ARROW_DOWN : ICON_ARROW_UP}<span>${newest ? "Newest" : "Oldest"}</span>`;
    const label = `Sort order: ${newest ? "newest first" : "oldest first"}`;
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  function updateThemeButton() {
    const btn = document.getElementById("xbm-theme-btn");
    if (!btn) return;
    const { icon, title } = getThemeButton();
    btn.innerHTML = icon;
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }

  function renderUI() {
    const count = bookmarks.size;
    const loadingClass = isLoading ? " xbm-loading" : "";
    const hasMore = Boolean(nextCursor);
    const themeBtn = getThemeButton();

    return `
      <div class="xbm-app${enabled ? "" : " xbm-disabled"}" data-theme="${getEffectiveTheme()}">
        <header class="xbm-header">
          <div class="xbm-header-left">
            <a class="xbm-logo-link" href="https://x.com/home" title="Go to X home" aria-label="Go to X home">
            <svg class="xbm-logo" viewBox="0 0 24 24"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </a>
          </div>
          <div class="xbm-header-title">
            <h1 class="xbm-title">${getPageTitle()}</h1>
            <span class="xbm-badge" id="xbm-badge">${count} saved</span>
          </div>
          <div class="xbm-header-right">
            <button type="button" class="xbm-icon-btn" id="xbm-load-btn" title="Load more bookmarks" aria-label="Load more bookmarks">
              ${ICON_CHEVRONS_DOWN}
            </button>
            <button type="button" class="xbm-icon-btn" id="xbm-export-btn" title="Export bookmarks" aria-label="Export bookmarks" aria-haspopup="menu" aria-expanded="false">
              ${ICON_DOWNLOAD}
            </button>
            <button type="button" class="xbm-icon-btn" id="xbm-view-btn" title="Show standard X view" aria-label="Show standard X view">
              ${ICON_EYE_OFF}
            </button>
            <button type="button" class="xbm-icon-btn" id="xbm-theme-btn" title="${themeBtn.title}" aria-label="${themeBtn.title}">
              ${themeBtn.icon}
            </button>
            <button type="button" class="xbm-icon-btn" id="xbm-settings-btn" title="Settings">
              ${ICON_SETTINGS}
            </button>
          </div>
          <div class="xbm-menu" id="xbm-load-menu" role="menu" aria-label="Load more bookmarks" hidden>
            <div class="xbm-menu-head">
              <span class="xbm-menu-title">Load more</span>
              <span class="xbm-menu-sub" id="xbm-load-progress"></span>
            </div>
            <div class="xbm-load-progress-track"><div class="xbm-load-progress-fill" id="xbm-load-fill"></div></div>
            <button type="button" class="xbm-menu-item" id="xbm-load-start" role="menuitem">
              ${ICON_CHEVRONS_DOWN}
              <span><span class="xbm-menu-item-title">Load all</span><span class="xbm-menu-item-sub">Fetch every remaining page</span></span>
            </button>
            <button type="button" class="xbm-menu-item" id="xbm-load-stop" role="menuitem">
              ${ICON_X}
              <span><span class="xbm-menu-item-title">Stop</span><span class="xbm-menu-item-sub">Keep what is loaded so far</span></span>
            </button>
          </div>
          <div class="xbm-menu" id="xbm-export-menu" role="menu" aria-label="Export bookmarks" hidden>
            <div class="xbm-menu-head">
              <span class="xbm-menu-title">Export as JSON</span>
            </div>
            <button type="button" class="xbm-menu-item" data-export="7" role="menuitem">
              ${ICON_CALENDAR}
              <span><span class="xbm-menu-item-title">Last 7 days</span><span class="xbm-menu-item-sub">By tweet date</span></span>
            </button>
            <button type="button" class="xbm-menu-item" data-export="30" role="menuitem">
              ${ICON_CALENDAR}
              <span><span class="xbm-menu-item-title">Last 30 days</span><span class="xbm-menu-item-sub">By tweet date</span></span>
            </button>
            <button type="button" class="xbm-menu-item" data-export="custom" role="menuitem">
              ${ICON_CALENDAR}
              <span><span class="xbm-menu-item-title">Custom range</span><span class="xbm-menu-item-sub">Pick start and end below</span></span>
            </button>
            <button type="button" class="xbm-menu-item" data-export="all" role="menuitem">
              ${ICON_ARCHIVE}
              <span><span class="xbm-menu-item-title">Full archive</span><span class="xbm-menu-item-sub" id="xbm-export-count"></span></span>
            </button>
            <div id="xbm-export-custom" class="xbm-menu-custom" hidden>
              <input type="date" id="xbm-export-from" aria-label="Export start date" />
              <span>–</span>
              <input type="date" id="xbm-export-to" aria-label="Export end date" />
              <button type="button" class="xbm-menu-go" id="xbm-export-go">Go</button>
            </div>
          </div>
        </header>

        <div class="xbm-toolbar">
          <div class="xbm-search-wrap">
            ${ICON_SEARCH}
            <input type="search" id="xbm-search" class="xbm-search" placeholder="Search bookmarks - press / to focus" value="${escapeHtml(searchQuery)}" />
          </div>
          <div class="xbm-tabs">
            <button type="button" class="xbm-tab${activeTab === "bookmarks" ? " active" : ""}" data-tab="bookmarks">Bookmarks</button>
            <button type="button" class="xbm-tab${activeTab === "authors" ? " active" : ""}" data-tab="authors">Authors</button>
          </div>
          <div class="xbm-filters">
            <div class="xbm-seg" role="tablist" aria-label="Filter by date">
              <button type="button" class="xbm-seg-btn active" data-range="all" role="tab">All</button>
              <button type="button" class="xbm-seg-btn" data-range="7" role="tab">7D</button>
              <button type="button" class="xbm-seg-btn" data-range="30" role="tab">30D</button>
              <button type="button" class="xbm-seg-btn" data-range="custom" role="tab">Custom</button>
            </div>
            <div id="xbm-filter-custom" class="xbm-filter-custom" hidden>
              <input type="date" id="xbm-filter-from" aria-label="Filter start date" />
              <span>–</span>
              <input type="date" id="xbm-filter-to" aria-label="Filter end date" />
            </div>
            <span class="xbm-filter-count" id="xbm-filter-count"></span>
            <button type="button" class="xbm-sort-btn" id="xbm-sort" aria-label="Sort order: newest first">
              ${ICON_ARROW_DOWN}<span>Newest</span>
            </button>
          </div>
        </div>

        <main class="xbm-main${loadingClass}" id="xbm-main">
          ${renderMainContent()}
        </main>

        <div class="xbm-modal-overlay" id="xbm-settings-modal" hidden>
          <div class="xbm-modal" role="dialog" aria-label="Settings">
            <div class="xbm-modal-head">
              <span class="xbm-modal-title">Settings</span>
              <button type="button" class="xbm-icon-btn xbm-modal-close" id="xbm-settings-close" title="Close" aria-label="Close">
                ${ICON_X}
              </button>
            </div>
            <label class="xbm-modal-field" for="xbm-settings-delay">
              <span class="xbm-modal-label">Wait time between pages (seconds)</span>
              <span class="xbm-modal-hint">"Load all" waits this long between page requests. At least 2-3 seconds is recommended to reduce ban risk.</span>
              <span class="xbm-modal-row">
                <input type="number" id="xbm-settings-delay" min="1" max="60" step="1" value="3" />
                <span class="xbm-modal-unit">s</span>
              </span>
            </label>
            <div class="xbm-modal-actions">
              <button type="button" class="xbm-modal-save" id="xbm-settings-save">Save</button>
              <button type="button" class="xbm-modal-reset" id="xbm-settings-reset">Reset to default (3 s)</button>
            </div>
          </div>
        </div>

        <div class="xbm-toast" id="xbm-toast" hidden></div>
      </div>`;
  }

  function showToast(message) {
    const toast = document.getElementById("xbm-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.hidden = true;
    }, 3000);
  }

  function updateLoadingUI() {
    const badge = document.getElementById("xbm-badge");
    const loadBtn = document.getElementById("xbm-load-btn");
    const main = document.getElementById("xbm-main");
    const progress = document.getElementById("xbm-load-progress");
    const fill = document.getElementById("xbm-load-fill");
    const startBtn = document.getElementById("xbm-load-start");
    const stopBtn = document.getElementById("xbm-load-stop");
    const hasMore = Boolean(nextCursor);

    if (badge) {
      badge.textContent = isLoading
        ? `${bookmarks.size} · loading…`
        : `${bookmarks.size} saved`;
    }
    if (loadBtn) {
      loadBtn.classList.toggle("xbm-busy", isLoading);
      loadBtn.disabled = isLoading || (!nextCursor && !loadAllActive);
    }
    if (startBtn) startBtn.disabled = isLoading || (!nextCursor && !loadAllActive);
    if (stopBtn) stopBtn.disabled = !isLoading;
    if (progress) {
      progress.textContent = isLoading
        ? `${bookmarks.size} loaded · ${getDelaySeconds()}s between pages`
        : hasMore
          ? `${bookmarks.size} loaded · more pages available`
          : `${bookmarks.size} loaded · up to date`;
    }
    if (fill) {
      fill.style.transform = isLoading ? "scaleX(1)" : "scaleX(0)";
      fill.classList.toggle("xbm-fill-idle", !isLoading);
    }
    if (main) {
      main.classList.toggle("xbm-loading", isLoading);
    }
  }

  function updateMainContent() {
    const main = document.getElementById("xbm-main");
    if (main) {
      main.innerHTML = renderMainContent();
    }
    const items = getFilteredBookmarks();
    const countEl = document.getElementById("xbm-filter-count");
    if (countEl) {
      countEl.textContent =
        items.length !== bookmarks.size
          ? `${items.length} of ${bookmarks.size} shown`
          : "";
    }
    updateLoadingUI();
    refreshCards();
  }

  function removeBookmarkFromUI(tweetId) {
    bookmarks.delete(tweetId);
    scheduleArchiveSave();
    const card = document.querySelector(`.xbm-card[data-id="${tweetId}"]`);
    if (card) {
      card.classList.add("xbm-card-removed");
      setTimeout(() => {
        card.remove();
        updateLoadingUI();
        if (!document.querySelector(".xbm-card")) {
          updateMainContent();
        }
      }, 280);
    } else {
      updateMainContent();
    }
  }

  async function requestRemoveBookmark(tweetId) {
    if (pendingRemoveId) return;
    pendingRemoveId = tweetId;
    updateMainContent();
    showToast("Removing…");

    document.dispatchEvent(
      new CustomEvent("x-bookmarks-remove", { detail: { tweetId } })
    );
  }

  function applyTextClamps() {
    document.querySelectorAll("#x-bookmarks-manager-root .xbm-text[data-clamp]").forEach((el) => {
      el.classList.remove("xbm-open");
      const btn = el.nextElementSibling;
      const isBtn = btn && btn.classList && btn.classList.contains("xbm-readmore");
      const overflowing = el.scrollHeight > el.clientHeight + 4;
      el.classList.toggle("xbm-faded", Boolean(isBtn && overflowing));
      if (isBtn) {
        btn.classList.toggle("xbm-show", overflowing);
        btn.textContent = "Read more";
      }
    });
  }

  function refreshCards() {
    applyTextClamps();
  }

  function bindEvents() {
    const search = document.getElementById("xbm-search");
    if (search) {
      search.addEventListener("input", (e) => {
        searchQuery = e.target.value;
        clearTimeout(search._debounce);
        search._debounce = setTimeout(() => {
          visibleLimit = PAGE_SIZE;
          updateMainContent();
        }, 150);
      });
    }

    if (uiRoot) {
      uiRoot.addEventListener("click", (e) => {
        const showMoreBtn = e.target?.closest?.(".xbm-show-more");
        if (showMoreBtn) {
          e.preventDefault();
          visibleLimit += PAGE_SIZE;
          updateMainContent();
          return;
        }
        const removeBtn = e.target?.closest?.(".xbm-remove-btn");
        if (removeBtn) {
          e.preventDefault();
          e.stopPropagation();
          const id = removeBtn.dataset.id;
          if (!id || pendingRemoveId) return;
          requestRemoveBookmark(id);
          return;
        }
        const moreBtn = e.target?.closest?.(".xbm-readmore");
        if (moreBtn) {
          e.preventDefault();
          e.stopPropagation();
          const text = moreBtn.previousElementSibling;
          if (!text || !text.matches(".xbm-text[data-clamp]")) return;
          const open = text.classList.toggle("xbm-open");
          text.classList.toggle("xbm-faded", !open);
          moreBtn.textContent = open ? "Show less" : "Read more";
        }
      });
    }

    document.querySelectorAll(".xbm-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        activeTab = tab.dataset.tab;
        document.querySelectorAll(".xbm-tab").forEach((t) => {
          t.classList.toggle("active", t.dataset.tab === activeTab);
        });
        visibleLimit = PAGE_SIZE;
        updateMainContent();
      });
    });

    document.getElementById("xbm-view-btn")?.addEventListener("click", () => {
      setEnabled(false);
    });
    document.querySelectorAll(".xbm-seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        viewRange = btn.dataset.range || "all";
        document.querySelectorAll(".xbm-seg-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
        });
        const customRange = document.getElementById("xbm-filter-custom");
        if (customRange) customRange.hidden = viewRange !== "custom";
        visibleLimit = PAGE_SIZE;
        updateMainContent();
      });
    });
    document.getElementById("xbm-filter-from")?.addEventListener("change", (event) => {
      viewFrom = event.target.value;
      visibleLimit = PAGE_SIZE;
      updateMainContent();
    });
    document.getElementById("xbm-filter-to")?.addEventListener("change", (event) => {
      viewTo = event.target.value;
      visibleLimit = PAGE_SIZE;
      updateMainContent();
    });
    document.getElementById("xbm-sort")?.addEventListener("click", () => {
      sortDir = sortDir === "asc" ? "desc" : "asc";
      updateSortButton();
      visibleLimit = PAGE_SIZE;
      updateMainContent();
    });
    document.getElementById("xbm-theme-btn")?.addEventListener("click", () => {
      setTheme(getEffectiveTheme() === "dark" ? "light" : "dark");
    });
    document.getElementById("xbm-settings-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      openSettingsModal();
    });
    document.getElementById("xbm-settings-close")?.addEventListener("click", () => {
      closeSettingsModal();
    });
    document.getElementById("xbm-settings-modal")?.addEventListener("click", (e) => {
      if (e.target?.id === "xbm-settings-modal") closeSettingsModal();
    });
    document.getElementById("xbm-settings-save")?.addEventListener("click", () => {
      saveDelayFromModal(document.getElementById("xbm-settings-delay")?.value);
    });
    document.getElementById("xbm-settings-reset")?.addEventListener("click", () => {
      saveDelayFromModal(DEFAULT_DELAY_SECONDS);
    });
    document.getElementById("xbm-settings-delay")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        saveDelayFromModal(e.target.value);
      }
    });
    document.getElementById("xbm-export-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("xbm-export-menu", "xbm-export-btn");
    });
    document.getElementById("xbm-load-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("xbm-load-menu", "xbm-load-btn");
    });
    document.querySelectorAll("#xbm-export-menu .xbm-menu-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const value = item.dataset.export || "all";
        const customBox = document.getElementById("xbm-export-custom");
        if (value === "custom") {
          if (customBox) customBox.hidden = false;
          return;
        }
        if (customBox) customBox.hidden = true;
        closeMenus();
        exportJson(value);
      });
    });
    document.getElementById("xbm-export-go")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      exportJson("custom");
    });
    document.getElementById("xbm-load-start")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      startLoadAll();
    });
    document.getElementById("xbm-load-stop")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      stopLoadAll();
      updateMainContent();
    });
    document.addEventListener("click", (e) => {
      if (!e.target?.closest?.(".xbm-menu") && !e.target?.closest?.(".xbm-icon-btn")) {
        closeMenus();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenus();
        closeSettingsModal();
      }
    });
  }

  function exportJson(range = "all") {
    const days = ["7", "30"].includes(range) ? parseInt(range, 10) : null;
    const fromValue = document.getElementById("xbm-export-from")?.value || null;
    const toValue = document.getElementById("xbm-export-to")?.value || null;
    let from = null;
    let to = null;

    if (range === "custom") {
      if (!fromValue || !toValue) {
        showToast("Select a start and end date");
        return;
      }
      from = new Date(`${fromValue}T00:00:00`).toISOString();
      to = new Date(`${toValue}T23:59:59.999`).toISOString();
      if (new Date(from).getTime() > new Date(to).getTime()) {
        showToast("Start date cannot be after end date");
        return;
      }
    }

    const data = XBookmarksArchive.createExport(
      Array.from(bookmarks.values()),
      { days, from, to }
    );

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    const suffix = range === "custom"
      ? `${fromValue}-to-${toValue}`
      : days
        ? `last-${days}-days`
        : "all";
    a.download = `x-bookmarks-${suffix}-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`${data.count} bookmarks downloaded as JSON`);
  }

  function buildNextPageUrl(baseUrl, cursor) {
    if (!baseUrl || !cursor) return null;
    try {
      const url = new URL(baseUrl, window.location.origin);
      const variables = JSON.parse(url.searchParams.get("variables") || "{}");
      variables.cursor = cursor;
      variables.count = variables.count || 20;
      url.searchParams.set("variables", JSON.stringify(variables));
      return url.toString();
    } catch {
      return null;
    }
  }

  function dispatchFetchPage(url) {
    document.dispatchEvent(
      new CustomEvent("x-bookmarks-fetch-page", {
        detail: { url, meta: lastApiMeta },
      })
    );
  }

  function fetchNextPage() {
    if (isFetchingMore || !nextCursor || !lastApiUrl) return false;
    if (seenCursors.has(nextCursor)) {
      nextCursor = null;
      return false;
    }

    const nextUrl = buildNextPageUrl(lastApiUrl, nextCursor);
    if (!nextUrl) return false;

    seenCursors.add(nextCursor);
    isFetchingMore = true;
    isLoading = true;
    updateLoadingUI();

    lastFetchUrl = nextUrl;
    dispatchFetchPage(nextUrl);
    return true;
  }

  function scheduleAutoFetch() {
    clearTimeout(fetchChainTimer);
    if (!loadAllActive || !nextCursor || isFetchingMore) return;
    if (seenCursors.has(nextCursor)) {
      finishLoadingAll();
      return;
    }

    fetchChainTimer = setTimeout(() => {
      if (!fetchNextPage()) {
        finishLoadingAll();
      }
    }, fetchDelayMs);
  }

  function stopLoadAll() {
    loadAllActive = false;
    isLoading = false;
    isFetchingMore = false;
    clearTimeout(fetchChainTimer);
    updateLoadingUI();
  }

  function retryFetchPage() {
    if (!lastFetchUrl) {
      finishLoadingAll();
      return;
    }
    isFetchingMore = true;
    isLoading = true;
    updateLoadingUI();
    dispatchFetchPage(lastFetchUrl);
  }

  function startLoadAll() {
    if (isLoading) return;
    if (!nextCursor) {
      showToast("No more pages to load");
      return;
    }

    loadAllActive = true;
    isLoading = true;
    fetchRetryCount = 0;
    updateLoadingUI();
    showToast(`Loading one page every ${getDelaySeconds()} seconds`);
    scheduleAutoFetch();
  }

  function finishLoadingAll() {
    const wasLoading = loadAllActive;
    stopLoadAll();
    updateMainContent();
    scheduleArchiveSave();

    if (wasLoading && bookmarks.size > 0) {
      showToast(`Loaded ${bookmarks.size} bookmarks in total`);
    }
  }

  function hideNativeUI() {
    document.body.classList.add("xbm-active");
  }

  function mountUI() {
    if (uiRoot) return;
    hideNativeUI();
    uiRoot = document.createElement("div");
    uiRoot.id = "x-bookmarks-manager-root";
    uiRoot.innerHTML = renderUI();
    document.body.appendChild(uiRoot);
    bindEvents();
    refreshCards();
  }

  function handleBookmarkData(payload, url, meta) {
    if (url) lastApiUrl = url;
    if (meta) lastApiMeta = meta;

    const { tweets, cursor } = XBookmarksParser.parseBookmarkResponse(payload);
    mergeBookmarks(tweets);

    if (cursor) {
      nextCursor = cursor;
    } else {
      nextCursor = null;
    }

    isFetchingMore = false;

    if (uiRoot) {
      if (loadAllActive) updateLoadingUI();
      else updateMainContent();
    }

    if (loadAllActive) {
      fetchRetryCount = 0;
      if (nextCursor && !seenCursors.has(nextCursor)) {
        isLoading = true;
        updateLoadingUI();
        scheduleAutoFetch();
      } else {
        finishLoadingAll();
      }
    } else {
      isLoading = false;
      updateLoadingUI();
    }
  }

  function initKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        document.getElementById("xbm-search")?.focus();
      }
    });
  }

  function waitForBody() {
    return new Promise((resolve) => {
      if (document.body) return resolve();
      const obs = new MutationObserver(() => {
        if (document.body) {
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.documentElement, { childList: true });
    });
  }

  async function init() {
    injectScript();
    await loadSettings();
    try {
      replaceBookmarks(await XBookmarksArchive.load());
    } catch (error) {
      console.error("X Bookmarks archive load failed", error);
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes[SETTINGS_KEY]) {
        fetchDelayMs =
          clampDelaySeconds(changes[SETTINGS_KEY].newValue) * 1000;
        updateLoadingUI();
      }
      if (changes[THEME_KEY]) {
        const next = changes[THEME_KEY].newValue;
        themePref = next === "dark" || next === "light" ? next : "auto";
        applyTheme();
      }
    });

    document.addEventListener("x-bookmarks-extension", (e) => {
      const { type, payload, url, meta } = e.detail || {};

      if (type === "bookmarks-data") {
        handleBookmarkData(payload, url, meta);
        if (!uiRoot && enabled) mountUI();
      }

      if (type === "fetch-error") {
        isFetchingMore = false;
        if (loadAllActive) {
          if (fetchRetryCount < MAX_FETCH_RETRIES && lastFetchUrl) {
            fetchRetryCount += 1;
            const waitSecs = Math.min(30 * 2 ** (fetchRetryCount - 1), 180);
            showToast(`Rate limited - retrying in ${waitSecs}s (${fetchRetryCount}/${MAX_FETCH_RETRIES})`);
            clearTimeout(fetchChainTimer);
            fetchChainTimer = setTimeout(() => {
              if (!loadAllActive) return;
              retryFetchPage();
            }, waitSecs * 1000);
          } else {
            finishLoadingAll();
            showToast("Loading stopped - partial list kept");
          }
        } else {
          isLoading = false;
          updateLoadingUI();
        }
      }

      if (type === "bookmark-removed" && e.detail?.tweetId) {
        pendingRemoveId = null;
        removeBookmarkFromUI(e.detail.tweetId);
        showToast("Removed from bookmarks");
      }

      if (type === "remove-error") {
        pendingRemoveId = null;
        updateMainContent();
        showToast(e.detail?.message || "Could not remove");
      }

      if (type === "ready") {
        waitForBody().then(() => {
          setTimeout(() => {
            if (!uiRoot && enabled) mountUI();
          }, 2500);
        });
      }
    });

    await waitForBody();
    ensureFloat();
    updateFloat();
    setTimeout(() => {
      if (!uiRoot && enabled) mountUI();
    }, 4000);
    initKeyboardShortcuts();
  }

  init();
})();
