(() => {
  "use strict";

  const SIGLS = {
    console: "f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e",
    pc: "fdd9e2a7-0fee-49f6-ad69-4354098401ff",
    ea: "b8900d09-a491-44cc-916e-32b5acae621b",
    all: "29a81209-df6f-41fd-a528-2ae6b91f719c"
  };

  const MARKET = "GB";
  const LANG = "en-gb";
  const DB_NAME = "gamepass-tracker";
  const DB_VERSION = 2; // Upgraded to v2 with proper keyPath for reliable persistence
  const STORAGE_KEY_STATUSES = "gamepass_statuses";
  const STORAGE_KEY_PROXY = "gamepass_custom_proxy";

  let games = [];
  let statuses = {};
  let filter = "all";
  let search = "";
  let platform = "all";
  let sort = "new";
  let isRefreshing = false;
  let activeDetailGame = null;

  // Quick Triage state
  let triageQueue = [];
  let triageIndex = 0;
  let triageHistory = [];

  const $ = id => document.getElementById(id);
  const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  // Deduplication Helpers: removes duplicate PC/Xbox entries and picks the best edition
  function getBaseKey(title) {
    let t = (title || "").toLowerCase();
    t = t.replace(/[®™©]/g, '')
         .replace(/['']/g, "'")
         .replace(/[""]/g, '"')
         .replace(/[–—]/g, '-');

    // Strip platform indicators
    t = t.replace(/\s*\((windows|pc|xbox|xbox\s*one|xbox\s*series\s*[xs])(\s*10)?\)/gi, '')
         .replace(/\s*-\s*(windows|pc)(\s*10)?$/gi, '')
         .replace(/\s+for\s+windows(\s*10)?$/gi, '');

    // Strip edition indicators for grouping
    const editionPatterns = [
      /\s*[:-]?\s*(standard|deluxe|complete|definitive|ultimate|anniversary|enhanced|special|goty|game of the year|collector'?s?)\s*edition$/gi,
      /\s*[:-]?\s*(digital\s*deluxe|premium|gold)\s*edition$/gi,
      /\s*[:-]?\s*(remastered|director'?s?\s*cut)$/gi
    ];
    for (const pat of editionPatterns) {
      t = t.replace(pat, '');
    }

    return t.replace(/[^a-z0-9]/g, '');
  }

  function getEditionScore(g) {
    const t = (g.title || "").toLowerCase();
    let score = 50;

    // Edition superiority (Complete > Definitive > Enhanced > Standard)
    if (t.includes('complete') || t.includes('ultimate') || t.includes('game of the year') || t.includes('goty')) score += 50;
    else if (t.includes('definitive') || t.includes('anniversary') || t.includes('gold') || t.includes('deluxe') || t.includes('premium')) score += 35;
    else if (t.includes('enhanced') || t.includes('special edition') || t.includes('remastered') || t.includes("director's cut")) score += 20;
    else if (t.includes('standard')) score -= 10;

    // Penalize platform tags in title (prefer clean title)
    if (t.includes('(windows') || t.includes('- windows') || t.includes('(pc)')) score -= 15;
    if (t.includes('preview')) score -= 10;

    // Prefer entries with better metadata
    if (g.image) score += 5;
    if (g.description && g.description.length > 50) score += 5;
    if (g.developer) score += 2;

    return score;
  }

  function deduplicateGames(rawGames) {
    if (!Array.isArray(rawGames)) return [];
    const groups = new Map();
    for (const g of rawGames) {
      if (!g || !g.id) continue;
      const k = getBaseKey(g.title);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    }

    const out = [];
    for (const list of groups.values()) {
      if (list.length === 1) {
        out.push(list[0]);
        continue;
      }

      // Sort by best edition
      list.sort((a, b) => getEditionScore(b) - getEditionScore(a));
      const best = { ...list[0] };

      // Merge platforms
      const platforms = new Set();
      let isEa = false;
      let anyActive = false;
      const aliasIds = [];

      for (const item of list) {
        if (!aliasIds.includes(item.id)) aliasIds.push(item.id);
        if (Array.isArray(item.aliasIds)) {
          for (const aid of item.aliasIds) {
            if (!aliasIds.includes(aid)) aliasIds.push(aid);
          }
        }
        if (item.platforms) {
          for (const p of item.platforms) platforms.add(p);
        }
        if (item.ea) isEa = true;
        if (!item.removed) anyActive = true;
      }

      best.platforms = platforms.size ? Array.from(platforms) : ["console"];
      best.ea = isEa;
      best.removed = !anyActive;
      best.aliasIds = aliasIds;

      out.push(best);
    }

    return out;
  }

  // Get status for game, checking primary ID and any alias IDs
  function getGameStatus(target) {
    if (!target) return null;
    const id = typeof target === "string" ? target : target.id;
    if (statuses[id]) return statuses[id];
    const game = typeof target === "object" ? target : games.find(g => g.id === id);
    if (game && Array.isArray(game.aliasIds)) {
      for (const aid of game.aliasIds) {
        if (statuses[aid]) return statuses[aid];
      }
    }
    return null;
  }

  // LocalStorage Helpers for immediate synchronous persistence & zero data loss
  function readStatusesFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_STATUSES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch (e) {
      console.warn("Failed reading statuses from localStorage:", e);
    }
    return {};
  }

  function writeStatusesToLocalStorage(data) {
    try {
      localStorage.setItem(STORAGE_KEY_STATUSES, JSON.stringify(data));
    } catch (e) {
      console.warn("Failed writing statuses to localStorage:", e);
    }
  }

  // IndexedDB Helper with migration to keyPath: "id"
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("meta")) {
          d.createObjectStore("meta");
        }
        if (d.objectStoreNames.contains("statuses")) {
          try {
            d.deleteObjectStore("statuses");
          } catch (_) {}
        }
        d.createObjectStore("statuses", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Notice Banner Helper
  function showNotice(html, duration = 6000) {
    const msg = $("message");
    const msgText = $("message-text");
    if (msg && msgText) {
      msgText.innerHTML = html;
      msg.style.display = "flex";
      if (duration > 0) {
        setTimeout(() => {
          if (!isRefreshing && msg.style.display === "flex") {
            msg.style.display = "none";
          }
        }, duration);
      }
    }
  }

  // Load local data and pre-bundled games.json
  async function loadLocal() {
    // 1. Instantly load statuses from localStorage so user categories NEVER appear reset
    statuses = readStatusesFromLocalStorage();

    try {
      const d = await db();

      // 2. Read from IndexedDB and merge
      const idbStatuses = await new Promise(resolve => {
        try {
          const tx = d.transaction("statuses", "readonly");
          const store = tx.objectStore("statuses");
          const req = store.getAll();
          const map = {};
          req.onsuccess = () => {
            if (Array.isArray(req.result)) {
              for (const item of req.result) {
                if (item && item.id) map[item.id] = item.status;
              }
            }
            resolve(map);
          };
          req.onerror = () => resolve({});
        } catch (_) {
          resolve({});
        }
      });

      // Merge: whatever is in either storage is safely preserved
      statuses = { ...statuses, ...idbStatuses };
      writeStatusesToLocalStorage(statuses);

      // Backfill IndexedDB if localStorage had statuses
      try {
        const tx = d.transaction("statuses", "readwrite");
        const store = tx.objectStore("statuses");
        for (const [id, s] of Object.entries(statuses)) {
          store.put({ id, status: s });
        }
      } catch (_) {}

      // 3. Load cached games
      const cached = await new Promise(resolve => {
        try {
          const tx = d.transaction("meta", "readonly");
          const req = tx.objectStore("meta").get("games");
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });

      if (cached && Array.isArray(cached.games) && cached.games.length > 0) {
        games = deduplicateGames(cached.games);
        if (cached.at) {
          $("updated").textContent = "Last refresh: " + new Date(cached.at).toLocaleDateString("en-GB", {
            day: "numeric", month: "short", year: "numeric"
          });
        }
        render();
        // Check for updates dynamically in background
        checkCatalogueUpdates(cached.at);
      } else {
        // First run: load bundled games.json so the catalogue is NEVER empty!
        await loadBundledCatalogue();
      }
    } catch (err) {
      console.warn("Error initializing from IndexedDB, falling back to bundled catalogue:", err);
      await loadBundledCatalogue();
    }
  }

  async function loadBundledCatalogue() {
    try {
      const res = await fetch("./games.json?t=" + Date.now());
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.games) && data.games.length > 0) {
          games = deduplicateGames(data.games);
          await saveGames(data.updatedAt || Date.now());
          $("updated").textContent = "Catalogue loaded: " + games.length + " games";
          render();
          return true;
        }
      }
    } catch (e) {
      console.error("Failed to load games.json:", e);
    }
    return false;
  }

  // Dynamically check for new additions and removed titles from games.json
  async function checkCatalogueUpdates() {
    try {
      const res = await fetch("./games.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.games) || data.games.length === 0) return;

      const incomingGames = deduplicateGames(data.games);
      const incomingMap = new Map(incomingGames.map(g => [g.id, g]));
      const currentMap = new Map(games.map(g => [g.id, g]));

      let newlyAdded = 0;
      let newlyRemoved = 0;

      // Check incoming games
      for (const [id, inc] of incomingMap.entries()) {
        const cur = currentMap.get(id);
        if (!cur) {
          newlyAdded++;
          currentMap.set(id, { ...inc, isNew: true, removed: Boolean(inc.removed) });
        } else {
          if (inc.removed && !cur.removed) {
            newlyRemoved++;
          }
          currentMap.set(id, {
            ...cur,
            ...inc,
            removed: Boolean(inc.removed)
          });
        }
      }

      // Check for games that were in currentMap but are absent from incoming
      for (const [id, cur] of currentMap.entries()) {
        if (!incomingMap.has(id) && !cur.removed) {
          newlyRemoved++;
          cur.removed = true;
          cur.removedDate = cur.removedDate || new Date().toISOString();
        }
      }

      games = deduplicateGames([...currentMap.values()]);
      await saveGames(data.updatedAt || Date.now());

      if (newlyAdded > 0 || newlyRemoved > 0) {
        showNotice(
          `✨ <strong>Catalogue updated!</strong> Found <strong>${newlyAdded}</strong> new Game Pass title(s) and <strong>${newlyRemoved}</strong> removed title(s).`
        );
        render();
      }
    } catch (e) {
      // Offline or network error - continue with local cache
    }
  }

  async function saveGames(timestamp = Date.now()) {
    try {
      const d = await db();
      const tx = d.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ games, at: timestamp }, "games");
    } catch (e) {
      console.error("Failed to save games to IndexedDB:", e);
    }
  }

  // Update a single game's category status (synchronizing all alias IDs)
  async function setStatus(id, status) {
    const game = games.find(g => g.id === id || (g.aliasIds && g.aliasIds.includes(id)));
    const targetIds = [id];
    if (game && Array.isArray(game.aliasIds)) {
      for (const aid of game.aliasIds) {
        if (!targetIds.includes(aid)) targetIds.push(aid);
      }
    }

    for (const tid of targetIds) {
      if (status) {
        statuses[tid] = status;
      } else {
        delete statuses[tid];
      }
    }

    // 1. Immediately write to localStorage (guarantees synchronous persistence across page refreshes)
    writeStatusesToLocalStorage(statuses);

    // 2. Persist to IndexedDB
    try {
      const d = await db();
      const tx = d.transaction("statuses", "readwrite");
      const store = tx.objectStore("statuses");
      for (const tid of targetIds) {
        if (status) {
          store.put({ id: tid, status });
        } else {
          store.delete(tid);
        }
      }
    } catch (e) {
      console.error("Failed to update status in IndexedDB:", e);
    }

    // 3. Update DOM incrementally WITHOUT destroying or re-rendering all game icons!
    const primaryId = game ? game.id : id;
    updateGameStatusInDOM(primaryId, status);

    // 4. Update details modal if open
    if (activeDetailGame && (activeDetailGame.id === primaryId || (activeDetailGame.aliasIds && activeDetailGame.aliasIds.includes(id)))) {
      updateDetailModalActions(primaryId);
    }
  }

  // Targeted DOM update: avoids destroying <img> elements so upcoming icons NEVER reload/flicker
  function updateGameStatusInDOM(id, newStatus) {
    // Update badge counters and tab counts
    updateCounters();

    const card = document.querySelector(`.game[data-game-id="${id}"]`);
    if (!card) return;

    const game = games.find(g => g.id === id);

    // Update action button classes
    const bPlay = card.querySelector('button[data-s="play"]');
    const bDone = card.querySelector('button[data-s="done"]');
    const bSkip = card.querySelector('button[data-s="skip"]');

    if (bPlay) bPlay.className = newStatus === "play" ? "active-play" : "";
    if (bDone) bDone.className = newStatus === "done" ? "active-done" : "";
    if (bSkip) bSkip.className = newStatus === "skip" ? "active-skip" : "";

    // Update or insert status badge on the cover image
    const coverWrap = card.querySelector(".cover-wrap");
    if (coverWrap) {
      let userBadge = coverWrap.querySelector(".status-badge:not(.removed)");
      if (newStatus) {
        const labels = { play: "WANT TO PLAY", done: "PLAYED", skip: "SKIP" };
        if (userBadge) {
          userBadge.className = `status-badge ${newStatus}`;
          userBadge.textContent = labels[newStatus];
        } else {
          userBadge = document.createElement("span");
          userBadge.className = `status-badge ${newStatus}`;
          userBadge.textContent = labels[newStatus];
          coverWrap.appendChild(userBadge);
        }
      } else if (userBadge) {
        userBadge.remove();
      }
    }

    // Determine if the card should remain in the current view
    let shouldStay = true;
    if (filter === "unmarked" && (newStatus || game?.removed)) {
      shouldStay = false;
    } else if (filter === "removed" && !game?.removed) {
      shouldStay = false;
    } else if (filter !== "all" && filter !== "unmarked" && filter !== "removed") {
      shouldStay = (newStatus === filter);
    }

    if (!shouldStay) {
      // Smoothly animate ONLY this specific card out.
      // Every other game card and image remains completely untouched in the DOM!
      card.classList.add("card-leaving");
      setTimeout(() => {
        card.remove();
        const listEl = $("list");
        if (listEl && listEl.querySelectorAll(".game").length === 0) {
          renderEmptyState();
        }
      }, 190);
    }
  }

  // Fetch with timeout and retries
  async function fetchJSON(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // Fetch sigl IDs using direct or proxy fallbacks
  async function fetchIdsForKind(kind, customProxy) {
    const directUrl = `https://catalog.gamepass.com/sigls/v2?id=${SIGLS[kind]}&language=${LANG}&market=${MARKET}`;
    const candidates = [];

    if (customProxy && customProxy.trim()) {
      const base = customProxy.trim();
      candidates.push(base.includes("?") ? `${base}${encodeURIComponent(directUrl)}` : `${base}${directUrl}`);
    }

    candidates.push(directUrl);
    candidates.push(`https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`);
    candidates.push(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(directUrl)}`);

    for (const url of candidates) {
      try {
        const data = await fetchJSON(url, 6000);
        if (Array.isArray(data)) {
          const ids = data.filter(x => x && x.id).map(x => x.id);
          if (ids.length > 0) return ids;
        }
      } catch (e) {
        // try next candidate
      }
    }
    return [];
  }

  // Fetch product metadata directly from Microsoft DisplayCatalog (Open CORS)
  async function fetchProducts(ids) {
    const out = [];
    const chunkSize = 50;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const batch = ids.slice(i, i + chunkSize);
      const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${encodeURIComponent(batch.join(","))}&market=${MARKET}&languages=${LANG}`;
      try {
        const data = await fetchJSON(url, 10000);
        if (Array.isArray(data.Products)) {
          out.push(...data.Products);
        }
      } catch (e) {
        console.warn("Failed batch for products:", e);
      }
    }
    return out;
  }

  function extractImage(p) {
    const lp = p.LocalizedProperties?.[0];
    const imgs = lp?.Images || p.Images || [];
    const preferred = ["Poster", "BoxArt", "FeaturePromotionalSquareArt", "BrandedKeyArt", "Hero", "SuperHeroArt"];
    for (const typ of preferred) {
      const found = imgs.find(i => i.ImagePurpose === typ || i.Purpose === typ);
      if (found?.Uri) {
        let uri = found.Uri;
        if (uri.startsWith("//")) uri = "https:" + uri;
        return uri;
      }
    }
    const any = imgs.find(i => i.Uri);
    if (any?.Uri) {
      let uri = any.Uri;
      if (uri.startsWith("//")) uri = "https:" + uri;
      return uri;
    }
    return "";
  }

  function extractReleaseDate(p) {
    const d = p.MarketProperties?.[0]?.OriginalReleaseDate || p.MarketProperties?.[0]?.ReleaseDate || p.Properties?.ReleaseDate;
    return d ? Date.parse(d) || 0 : 0;
  }

  function extractTitle(p) {
    return p.LocalizedProperties?.[0]?.ProductTitle || p.ProductTitle || "Unknown title";
  }

  // REFRESH CATALOGUE: Syncs new games from static update and live Microsoft APIs
  async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;

    const refreshBtn = $("refresh");
    const refreshBtn2 = $("refresh2");
    refreshBtn.classList.add("spinning");
    if (refreshBtn2) refreshBtn2.disabled = true;

    showNotice("<strong>Checking for updates…</strong> Syncing latest Game Pass titles.", 0);

    let newlyAdded = 0;
    let newlyRemoved = 0;
    let customProxy = localStorage.getItem(STORAGE_KEY_PROXY) || "";

    try {
      // Step 1: Check bundled / static games.json from the host
      try {
        const bundledRes = await fetch("./games.json?t=" + Date.now(), { cache: "no-store" });
        if (bundledRes.ok) {
          const bundledData = await bundledRes.json();
          if (Array.isArray(bundledData.games) && bundledData.games.length > 0) {
            const currentMap = new Map(games.map(g => [g.id, g]));
            for (const g of bundledData.games) {
              const cur = currentMap.get(g.id);
              if (!cur) {
                newlyAdded++;
                currentMap.set(g.id, { ...g, isNew: true });
              } else {
                if (g.removed && !cur.removed) newlyRemoved++;
                currentMap.set(g.id, { ...cur, ...g });
              }
            }
            games = deduplicateGames([...currentMap.values()]);
          }
        }
      } catch (e) {
        console.warn("Static games.json fetch failed, trying live API sync:", e);
      }

      // Step 2: Attempt live API scan for active Game Pass IDs
      $("message-text").innerHTML = "<strong>Scanning Xbox catalogue…</strong> Checking for brand new additions and removed titles.";
      const sourceMap = {};
      const fetchPromises = ["console", "pc", "ea", "all"].map(async kind => {
        const ids = await fetchIdsForKind(kind, customProxy);
        for (const id of ids) {
          sourceMap[id] = sourceMap[id] || [];
          sourceMap[id].push(kind);
        }
      });

      await Promise.allSettled(fetchPromises);
      const allFoundIds = Object.keys(sourceMap);

      if (allFoundIds.length > 0) {
        const activeSet = new Set(allFoundIds);
        const currentMap = new Map(games.map(g => [g.id, g]));

        // Check for removed games
        for (const [id, g] of currentMap.entries()) {
          const hasActiveAlias = g.aliasIds ? g.aliasIds.some(aid => activeSet.has(aid)) : false;
          if (!activeSet.has(id) && !hasActiveAlias && !g.removed) {
            newlyRemoved++;
            g.removed = true;
            g.removedDate = g.removedDate || new Date().toISOString();
          }
        }

        // Check for brand new games
        const knownAllIds = new Set();
        for (const g of currentMap.values()) {
          knownAllIds.add(g.id);
          if (g.aliasIds) g.aliasIds.forEach(aid => knownAllIds.add(aid));
        }

        const brandNewIds = allFoundIds.filter(id => !knownAllIds.has(id));
        if (brandNewIds.length > 0) {
          $("message-text").innerHTML = `<strong>Found ${brandNewIds.length} new game(s)!</strong> Loading metadata from Microsoft…`;
          const newProducts = await fetchProducts(brandNewIds);
          for (const p of newProducts) {
            const id = p.ProductId || p.Id;
            if (!id) continue;
            const src = sourceMap[id] || [];
            const platforms = [];
            if (src.includes("console")) platforms.push("console");
            if (src.includes("pc")) platforms.push("pc");
            if (!platforms.length && src.includes("all")) platforms.push("console");

            currentMap.set(id, {
              id,
              title: extractTitle(p),
              image: extractImage(p),
              platforms,
              ea: src.includes("ea"),
              release: extractReleaseDate(p),
              description: p.LocalizedProperties?.[0]?.ShortDescription ||
                           p.LocalizedProperties?.[0]?.ProductDescription?.slice(0, 300) || "",
              developer: p.LocalizedProperties?.[0]?.DeveloperName || "",
              removed: false,
              isNew: true,
              addedDate: Date.now()
            });
            newlyAdded++;
          }
        }

        games = deduplicateGames([...currentMap.values()]);
      }

      await saveGames(Date.now());

      $("updated").textContent = "Last refresh: " + new Date().toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric"
      });

      if (newlyAdded > 0 || newlyRemoved > 0) {
        showNotice(`<strong>Updated!</strong> Added <strong>${newlyAdded}</strong> new game(s), marked <strong>${newlyRemoved}</strong> removed title(s). Total: ${games.length} titles.`);
      } else {
        showNotice(`<strong>Catalogue is up-to-date!</strong> ${games.length} unique titles tracked.`, 4000);
      }

      render();
    } catch (err) {
      console.error("Refresh encountered an error:", err);
      showNotice(`<strong>Sync finished with local data.</strong> ${games.length} games available.`, 4000);
    } finally {
      isRefreshing = false;
      refreshBtn.classList.remove("spinning");
      if (refreshBtn2) refreshBtn2.disabled = false;
    }
  }

  // Filter & Search Logic
  function visibleGames() {
    let list = games;

    // Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(g =>
        g.title.toLowerCase().includes(q) ||
        (g.developer && g.developer.toLowerCase().includes(q)) ||
        (g.description && g.description.toLowerCase().includes(q))
      );
    }

    // Platform filter
    if (platform !== "all") {
      if (platform === "ea") {
        list = list.filter(g => g.ea);
      } else {
        list = list.filter(g => g.platforms && g.platforms.includes(platform));
      }
    }

    // Status filter
    if (filter === "unmarked") {
      list = list.filter(g => !getGameStatus(g) && !g.removed);
    } else if (filter === "removed") {
      list = list.filter(g => g.removed);
    } else if (filter !== "all") {
      list = list.filter(g => getGameStatus(g) === filter);
    }

    // Sorting
    list = [...list].sort((a, b) => {
      if (sort === "az") return a.title.localeCompare(b.title);
      if (sort === "za") return b.title.localeCompare(a.title);
      if (sort === "new") {
        // Prioritize active and newest release/added
        if (Boolean(a.removed) !== Boolean(b.removed)) return a.removed ? 1 : -1;
        return (b.release || 0) - (a.release || 0);
      }
      if (sort === "status") {
        const order = { play: 3, done: 2, skip: 1 };
        const scoreA = order[getGameStatus(a)] || 0;
        const scoreB = order[getGameStatus(b)] || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return a.title.localeCompare(b.title);
      }
      return 0;
    });

    return list;
  }

  // Update counters and badges
  function updateCounters() {
    const counts = { play: 0, done: 0, skip: 0, removed: 0, unmarked: 0 };
    for (const g of games) {
      if (g.removed) {
        counts.removed++;
      }
      const s = getGameStatus(g);
      if (s && counts[s] !== undefined) {
        counts[s]++;
      } else if (!g.removed) {
        counts.unmarked++;
      }
    }

    $("total").textContent = games.length || "0";
    $("play").textContent = counts.play;
    $("done").textContent = counts.done;
    $("skip").textContent = counts.skip;

    $("tab-all").textContent = `All (${games.length})`;
    $("tab-play").textContent = `Want to play (${counts.play})`;
    $("tab-done").textContent = `Played (${counts.done})`;
    $("tab-skip").textContent = `Skip (${counts.skip})`;
    $("tab-unmarked").textContent = `Unmarked (${counts.unmarked})`;
    const tabRem = $("tab-removed");
    if (tabRem) tabRem.textContent = `Removed (${counts.removed})`;

    const triageBadge = $("triage-badge");
    if (triageBadge) triageBadge.textContent = counts.unmarked;
  }

  function renderEmptyState() {
    const listEl = $("list");
    if (!games.length) {
      listEl.innerHTML = `
        <div class="empty">
          <b>No games in catalogue yet</b>
          <p>Click below to load the complete Game Pass library.</p>
          <button id="empty-refresh">↻ Load Catalogue Now</button>
        </div>
      `;
      const b = $("empty-refresh");
      if (b) b.onclick = refresh;
    } else {
      listEl.innerHTML = `
        <div class="empty">
          <b>No games found</b>
          <p>Try adjusting your search query, platform, or status filter.</p>
          <button id="reset-filters">Clear filters</button>
        </div>
      `;
      const b = $("reset-filters");
      if (b) {
        b.onclick = () => {
          search = "";
          $("search").value = "";
          $("clear-search").classList.remove("visible");
          platform = "all";
          $("platform").value = "all";
          filter = "all";
          document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x.dataset.filter === "all"));
          render();
        };
      }
    }
  }

  // Full Grid Render (used on initial load, tab changes, search, and sorting)
  function render() {
    updateCounters();
    const filtered = visibleGames();
    const listEl = $("list");

    if (!filtered.length) {
      renderEmptyState();
      return;
    }

    listEl.innerHTML = filtered.map(g => {
      const s = getGameStatus(g);
      const statusLabels = { play: "WANT TO PLAY", done: "PLAYED", skip: "SKIP" };
      let statusBadges = "";

      if (g.removed) {
        statusBadges += `<span class="status-badge removed">REMOVED</span>`;
      }
      if (s) {
        statusBadges += `<span class="status-badge ${s}">${statusLabels[s]}</span>`;
      }

      const coverSrc = g.image ? escapeHTML(g.image) : "";
      const coverHtml = coverSrc
        ? `<div class="cover-wrap"><img class="cover" loading="lazy" decoding="async" src="${coverSrc}" alt="" onerror="this.style.opacity='0'">${statusBadges}</div>`
        : `<div class="cover-wrap">${statusBadges}</div>`;

      const platformPills = (g.platforms || []).map(p =>
        `<span class="pill">${p === "console" ? "Xbox" : p.toUpperCase()}</span>`
      ).join("");
      const eaPill = g.ea ? '<span class="pill ea">EA Play</span>' : "";
      const removedPill = g.removed ? '<span class="pill pill-removed">Removed</span>' : "";
      const newPill = (g.isNew && !g.removed) ? '<span class="pill pill-new">New</span>' : "";

      return `
        <article class="game" data-game-id="${escapeHTML(g.id)}" tabindex="0">
          ${coverHtml}
          <div class="game-body">
            <div class="game-title" title="${escapeHTML(g.title)}">${escapeHTML(g.title)}</div>
            <div class="game-meta">
              ${removedPill}
              ${newPill}
              ${platformPills}
              ${eaPill}
            </div>
            <div class="actions">
              <button data-id="${escapeHTML(g.id)}" data-s="play" class="${s === "play" ? "active-play" : ""}">Play</button>
              <button data-id="${escapeHTML(g.id)}" data-s="done" class="${s === "done" ? "active-done" : ""}">Played</button>
              <button data-id="${escapeHTML(g.id)}" data-s="skip" class="${s === "skip" ? "active-skip" : ""}">Skip</button>
            </div>
          </div>
        </article>
      `;
    }).join("");
  }

  // Quick Triage / Speed Sorter Mode
  function openQuickTriage() {
    // Select games for triage: prioritize active unmarked games
    let queue = games.filter(g => !g.removed && !getGameStatus(g));
    if (queue.length === 0) {
      // If all active games are categorised, offer all active games
      queue = games.filter(g => !g.removed);
    }
    triageQueue = queue;
    triageIndex = 0;
    triageHistory = [];

    if (triageQueue.length === 0) {
      alert("No games available to triage!");
      return;
    }

    $("triage-modal").classList.add("open");
    renderTriageCard();
  }

  function renderTriageCard() {
    const cardEl = $("triage-card");
    if (cardEl) {
      cardEl.style.transform = "";
      cardEl.classList.remove("swiping-right", "swiping-left", "swiping-up");
    }

    if (triageIndex >= triageQueue.length) {
      // Finished all games in queue!
      $("triage-progress").textContent = "Completed! 🎉";
      $("triage-title").textContent = "All Games Categorised!";
      $("triage-dev").textContent = "Great job organizing your backlog!";
      $("triage-desc").textContent = "You have reviewed all games in this triage session. Explore your organized categories in the tabs below.";
      $("triage-img").src = "";
      $("triage-img").style.display = "none";
      $("triage-meta").innerHTML = "";
      $("triage-status-badge").innerHTML = "";
      return;
    }

    const g = triageQueue[triageIndex];
    $("triage-progress").textContent = `${triageIndex + 1} of ${triageQueue.length}`;
    $("triage-title").textContent = g.title;
    $("triage-dev").textContent = g.developer ? "Developer: " + g.developer : "";
    $("triage-desc").textContent = g.description || "No description available for this title.";

    const img = $("triage-img");
    if (g.image) {
      img.src = g.image;
      img.style.display = "block";
    } else {
      img.style.display = "none";
    }

    // Preload next 2 game covers so next cards load with zero latency
    for (let i = 1; i <= 2; i++) {
      if (triageIndex + i < triageQueue.length && triageQueue[triageIndex + i].image) {
        const pre = new Image();
        pre.src = triageQueue[triageIndex + i].image;
      }
    }

    const s = getGameStatus(g);
    let badgeHtml = "";
    if (g.removed) {
      badgeHtml += `<span class="status-badge removed">REMOVED FROM GP</span>`;
    }
    if (s) {
      const labels = { play: "WANT TO PLAY", done: "PLAYED", skip: "SKIP" };
      badgeHtml += `<span class="status-badge ${s}">${labels[s]}</span>`;
    }
    $("triage-status-badge").innerHTML = badgeHtml;

    const platformPills = (g.platforms || []).map(p =>
      `<span class="pill">${p === "console" ? "Xbox" : p.toUpperCase()}</span>`
    ).join("");
    const eaPill = g.ea ? '<span class="pill ea">EA Play</span>' : "";
    let dateStr = "";
    if (g.release) {
      dateStr = `<span class="pill">${new Date(g.release).getFullYear()}</span>`;
    }
    $("triage-meta").innerHTML = platformPills + eaPill + dateStr;
  }

  function triageAction(targetStatus) {
    if (triageIndex >= triageQueue.length) return;
    const g = triageQueue[triageIndex];
    const prevStatus = getGameStatus(g) || null;

    triageHistory.push({ index: triageIndex, id: g.id, prevStatus });
    setStatus(g.id, targetStatus);

    triageIndex++;
    renderTriageCard();
  }

  function triageUndo() {
    if (triageHistory.length === 0) return;
    const last = triageHistory.pop();
    setStatus(last.id, last.prevStatus);
    triageIndex = last.index;
    renderTriageCard();
  }

  function triagePass() {
    if (triageIndex < triageQueue.length) {
      triageIndex++;
      renderTriageCard();
    }
  }

  // Setup Mobile / iPhone Swipe Gestures on Triage Card
  function setupTriageSwipe() {
    const cardEl = $("triage-card");
    if (!cardEl) return;

    let touchStartX = 0;
    let touchStartY = 0;
    let touchCurrentX = 0;
    let touchCurrentY = 0;
    let isSwiping = false;

    cardEl.addEventListener("touchstart", e => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchCurrentX = touchStartX;
      touchCurrentY = touchStartY;
      isSwiping = true;
      cardEl.style.transition = "none";
    }, { passive: true });

    cardEl.addEventListener("touchmove", e => {
      if (!isSwiping || e.touches.length !== 1) return;
      touchCurrentX = e.touches[0].clientX;
      touchCurrentY = e.touches[0].clientY;

      const deltaX = touchCurrentX - touchStartX;
      const deltaY = touchCurrentY - touchStartY;

      // Slight rotation based on horizontal drag
      const rotate = deltaX * 0.05;
      cardEl.style.transform = `translate(${deltaX}px, ${deltaY}px) rotate(${rotate}deg)`;

      // Dynamic glow classes
      cardEl.classList.toggle("swiping-right", deltaX > 40);
      cardEl.classList.toggle("swiping-left", deltaX < -40);
      cardEl.classList.toggle("swiping-up", deltaY < -40 && Math.abs(deltaX) < 40);
    }, { passive: true });

    cardEl.addEventListener("touchend", () => {
      if (!isSwiping) return;
      isSwiping = false;

      const deltaX = touchCurrentX - touchStartX;
      const deltaY = touchCurrentY - touchStartY;

      cardEl.classList.remove("swiping-right", "swiping-left", "swiping-up");
      cardEl.style.transition = "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease, border-color 0.2s ease";

      const threshold = 65;

      if (deltaX > threshold) {
        // Swipe Right -> Want to Play
        cardEl.style.transform = "translate(120%, 0) rotate(15deg)";
        setTimeout(() => {
          cardEl.style.transition = "none";
          cardEl.style.transform = "";
          triageAction("play");
        }, 160);
      } else if (deltaX < -threshold) {
        // Swipe Left -> Skip
        cardEl.style.transform = "translate(-120%, 0) rotate(-15deg)";
        setTimeout(() => {
          cardEl.style.transition = "none";
          cardEl.style.transform = "";
          triageAction("skip");
        }, 160);
      } else if (deltaY < -threshold && Math.abs(deltaX) < 50) {
        // Swipe Up -> Played
        cardEl.style.transform = "translate(0, -120%)";
        setTimeout(() => {
          cardEl.style.transition = "none";
          cardEl.style.transform = "";
          triageAction("done");
        }, 160);
      } else {
        // Snap back
        cardEl.style.transform = "";
      }
    });
  }

  // Game Details Modal
  function showGameDetails(gameId) {
    const g = games.find(x => x.id === gameId);
    if (!g) return;
    activeDetailGame = g;

    $("detail-title").textContent = g.title;
    $("detail-dev").textContent = g.developer ? "Developer: " + g.developer : "";
    $("detail-desc").textContent = g.description || "No description available for this title.";

    const img = $("detail-img");
    if (g.image) {
      img.src = g.image;
      img.style.display = "block";
    } else {
      img.style.display = "none";
    }

    const platformPills = (g.platforms || []).map(p =>
      `<span class="pill">${p === "console" ? "Xbox Series X|S / Xbox One" : "PC Game Pass"}</span>`
    ).join("");
    const eaPill = g.ea ? '<span class="pill ea">EA Play</span>' : "";
    const removedPill = g.removed ? '<span class="pill pill-removed">Removed from Game Pass</span>' : "";
    let dateStr = "";
    if (g.release) {
      dateStr = `<span class="pill">Release: ${new Date(g.release).toLocaleDateString("en-GB", { year: "numeric", month: "short" })}</span>`;
    }
    $("detail-meta").innerHTML = removedPill + platformPills + eaPill + dateStr;

    $("detail-store").href = `https://www.xbox.com/en-gb/games/store/p/${g.id}`;
    updateDetailModalActions(g.id);

    $("detail-modal").classList.add("open");
  }

  function updateDetailModalActions(gameId) {
    const s = getGameStatus(gameId);
    const bPlay = $("detail-btn-play");
    const bDone = $("detail-btn-done");
    const bSkip = $("detail-btn-skip");

    bPlay.className = s === "play" ? "active-play" : "";
    bDone.className = s === "done" ? "active-done" : "";
    bSkip.className = s === "skip" ? "active-skip" : "";

    bPlay.onclick = () => setStatus(gameId, s === "play" ? null : "play");
    bDone.onclick = () => setStatus(gameId, s === "done" ? null : "done");
    bSkip.onclick = () => setStatus(gameId, s === "skip" ? null : "skip");
  }

  function closeModals() {
    $("detail-modal").classList.remove("open");
    $("drawer").classList.remove("open");
    $("triage-modal").classList.remove("open");
    activeDetailGame = null;
  }

  // Event Listeners
  $("list").addEventListener("click", e => {
    const actionBtn = e.target.closest("button[data-id]");
    if (actionBtn) {
      e.stopPropagation();
      const id = actionBtn.dataset.id;
      const targetStatus = actionBtn.dataset.s;
      const curStatus = getGameStatus(id);
      setStatus(id, curStatus === targetStatus ? null : targetStatus);
      return;
    }

    const card = e.target.closest(".game");
    if (card && card.dataset.gameId) {
      showGameDetails(card.dataset.gameId);
    }
  });

  $("search").addEventListener("input", e => {
    search = e.target.value;
    $("clear-search").classList.toggle("visible", Boolean(search));
    render();
  });

  $("clear-search").addEventListener("click", () => {
    search = "";
    $("search").value = "";
    $("clear-search").classList.remove("visible");
    $("search").focus();
    render();
  });

  $("platform").addEventListener("change", e => {
    platform = e.target.value;
    render();
  });

  $("sort").addEventListener("change", e => {
    sort = e.target.value;
    render();
  });

  $("tabs").addEventListener("click", e => {
    const b = e.target.closest(".tab");
    if (!b) return;
    filter = b.dataset.filter;
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === b));
    render();
  });

  $("refresh").onclick = refresh;
  $("refresh2").onclick = () => {
    closeModals();
    refresh();
  };

  // Quick Triage Modal Controls
  $("start-triage").onclick = openQuickTriage;
  $("triage-close").onclick = closeModals;
  $("triage-play").onclick = () => triageAction("play");
  $("triage-done").onclick = () => triageAction("done");
  $("triage-skip").onclick = () => triageAction("skip");
  $("triage-undo").onclick = triageUndo;
  $("triage-pass").onclick = triagePass;

  $("subtitle").onclick = () => {
    const proxyInput = $("custom-proxy");
    if (proxyInput) {
      proxyInput.value = localStorage.getItem(STORAGE_KEY_PROXY) || "";
    }
    $("drawer").classList.add("open");
  };

  $("close").onclick = closeModals;
  $("detail-close").onclick = closeModals;

  $("detail-modal").onclick = e => {
    if (e.target === $("detail-modal")) closeModals();
  };
  $("drawer").onclick = e => {
    if (e.target === $("drawer")) closeModals();
  };
  $("triage-modal").onclick = e => {
    if (e.target === $("triage-modal")) closeModals();
  };

  $("message-close").onclick = () => {
    $("message").style.display = "none";
  };

  // Custom proxy save
  $("custom-proxy").addEventListener("change", e => {
    localStorage.setItem(STORAGE_KEY_PROXY, e.target.value.trim());
  });

  // Export & Import backlog statuses
  $("export-btn").onclick = () => {
    const exportData = {
      version: 2,
      exportedAt: new Date().toISOString(),
      statuses
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gamepass-backlog-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async evt => {
      try {
        const parsed = JSON.parse(evt.target.result);
        if (parsed && typeof parsed.statuses === "object") {
          statuses = { ...statuses, ...parsed.statuses };
          writeStatusesToLocalStorage(statuses);
          try {
            const d = await db();
            const tx = d.transaction("statuses", "readwrite");
            const store = tx.objectStore("statuses");
            for (const [id, s] of Object.entries(statuses)) {
              store.put({ id, status: s });
            }
          } catch (e) {
            console.warn("IndexedDB import status save:", e);
          }
          render();
          alert("Backlog statuses imported successfully!");
        } else {
          alert("Invalid backup file format.");
        }
      } catch (err) {
        alert("Error reading backup file: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Reset statuses
  $("reset").onclick = async () => {
    if (!confirm("Are you sure you want to reset all game statuses (Want to play, Played, Skip)? This cannot be undone.")) return;
    statuses = {};
    writeStatusesToLocalStorage(statuses);
    try {
      const d = await db();
      const tx = d.transaction("statuses", "readwrite");
      tx.objectStore("statuses").clear();
    } catch (e) {
      console.error(e);
    }
    render();
    closeModals();
  };

  // Keyboard Shortcuts for Rapid Backlog Management
  window.addEventListener("keydown", e => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;

    const triageOpen = $("triage-modal").classList.contains("open");
    if (triageOpen) {
      if (e.key === "1" || e.key.toLowerCase() === "p" || e.key === "ArrowRight") {
        e.preventDefault();
        triageAction("play");
      } else if (e.key === "2" || e.key.toLowerCase() === "d" || e.key === "ArrowUp") {
        e.preventDefault();
        triageAction("done");
      } else if (e.key === "3" || e.key.toLowerCase() === "s" || e.key === "ArrowLeft") {
        e.preventDefault();
        triageAction("skip");
      } else if (e.key.toLowerCase() === "z" || e.key === "Backspace") {
        e.preventDefault();
        triageUndo();
      } else if (e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        triagePass();
      } else if (e.key === "Escape") {
        closeModals();
      }
    } else {
      if (e.key === "Escape") {
        closeModals();
      }
    }
  });

  // Service Worker Registration
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  }

  // Initialize App
  (async () => {
    setupTriageSwipe();
    await loadLocal();
  })();
})();