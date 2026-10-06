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
  const DB_VERSION = 1;

  let games = [];
  let statuses = {};
  let filter = "all";
  let search = "";
  let platform = "all";
  let sort = "new";
  let isRefreshing = false;
  let activeDetailGame = null;

  const $ = id => document.getElementById(id);
  const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  // IndexedDB Helper
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("meta")) {
          req.result.createObjectStore("meta");
        }
        if (!req.result.objectStoreNames.contains("statuses")) {
          req.result.createObjectStore("statuses");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Load local data and pre-bundled games.json
  async function loadLocal() {
    try {
      const d = await db();

      // Load statuses
      statuses = await new Promise((resolve, reject) => {
        const tx = d.transaction("statuses", "readonly");
        const store = tx.objectStore("statuses");
        const req = store.getAll();
        const map = {};
        req.onsuccess = () => {
          for (const item of req.result) {
            map[item.id] = item.status;
          }
          resolve(map);
        };
        req.onerror = () => reject(req.error);
      });

      // Load cached games
      const cached = await new Promise(resolve => {
        const tx = d.transaction("meta", "readonly");
        const req = tx.objectStore("meta").get("games");
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });

      if (cached && Array.isArray(cached.games) && cached.games.length > 0) {
        games = cached.games;
        if (cached.at) {
          $("updated").textContent = "Last refresh: " + new Date(cached.at).toLocaleDateString("en-GB", {
            day: "numeric", month: "short", year: "numeric"
          });
        }
        render();
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
          games = data.games;
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

  async function saveGames(timestamp = Date.now()) {
    try {
      const d = await db();
      const tx = d.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ games, at: timestamp }, "games");
    } catch (e) {
      console.error("Failed to save games to IndexedDB:", e);
    }
  }

  async function setStatus(id, status) {
    if (status) {
      statuses[id] = status;
    } else {
      delete statuses[id];
    }

    try {
      const d = await db();
      const tx = d.transaction("statuses", "readwrite");
      const store = tx.objectStore("statuses");
      if (status) {
        store.put({ id, status });
      } else {
        store.delete(id);
      }
    } catch (e) {
      console.error("Failed to update status in IndexedDB:", e);
    }

    render();
    if (activeDetailGame && activeDetailGame.id === id) {
      updateDetailModalActions(id);
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

  // Normalization logic merging products & existing metadata
  function normalizeProducts(products, sourceMap, existingGames = []) {
    const m = new Map();
    for (const g of existingGames) {
      m.set(g.id, { ...g });
    }

    for (const p of products) {
      const id = p.ProductId || p.Id;
      if (!id) continue;
      const src = sourceMap[id] || [];
      const old = m.get(id) || {
        id,
        title: extractTitle(p),
        image: extractImage(p),
        platforms: [],
        ea: false,
        release: extractReleaseDate(p),
        description: "",
        developer: ""
      };

      old.title = extractTitle(p) || old.title;
      old.image = extractImage(p) || old.image;

      const platforms = new Set(old.platforms);
      if (src.includes("console")) platforms.add("console");
      if (src.includes("pc")) platforms.add("pc");
      if (!platforms.size && src.includes("all")) platforms.add("console");
      old.platforms = [...platforms];

      old.ea = old.ea || src.includes("ea");
      old.release = extractReleaseDate(p) || old.release;
      old.description = p.LocalizedProperties?.[0]?.ShortDescription ||
                        p.LocalizedProperties?.[0]?.ProductDescription?.slice(0, 300) || old.description || "";
      old.developer = p.LocalizedProperties?.[0]?.DeveloperName || old.developer || "";

      m.set(id, old);
    }

    return [...m.values()].sort((a, b) => (b.release || 0) - (a.release || 0));
  }

  // REFRESH CATALOGUE: Syncs new games from static update and live Microsoft APIs
  async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;

    const refreshBtn = $("refresh");
    const refreshBtn2 = $("refresh2");
    refreshBtn.classList.add("spinning");
    if (refreshBtn2) refreshBtn2.disabled = true;

    const msg = $("message");
    const msgText = $("message-text");
    msg.style.display = "flex";
    msgText.innerHTML = "<strong>Checking for updates…</strong> Syncing latest Game Pass titles.";

    let initialCount = games.length;
    let updatedViaNetwork = false;
    let customProxy = localStorage.getItem("gamepass_custom_proxy") || "";

    try {
      // Step 1: Check for updated games.json from the host / automated GitHub action
      try {
        const bundledRes = await fetch("./games.json?t=" + Date.now(), { cache: "no-store" });
        if (bundledRes.ok) {
          const bundledData = await bundledRes.json();
          if (Array.isArray(bundledData.games) && bundledData.games.length > 0) {
            const currentIds = new Set(games.map(g => g.id));
            const newGames = bundledData.games.filter(g => !currentIds.has(g.id));

            // Merge any newer entries
            const mergedMap = new Map();
            for (const g of bundledData.games) mergedMap.set(g.id, g);
            for (const g of games) {
              if (!mergedMap.has(g.id)) mergedMap.set(g.id, g);
            }
            games = [...mergedMap.values()];
            updatedViaNetwork = true;
          }
        }
      } catch (e) {
        console.warn("Static games.json fetch failed, attempting live API sync:", e);
      }

      // Step 2: Attempt live API scan for newly added game IDs
      msgText.innerHTML = "<strong>Scanning Xbox catalogue…</strong> Checking for brand new additions.";
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
        // Find which IDs are completely new to our local database
        const knownIds = new Set(games.map(g => g.id));
        const newIds = allFoundIds.filter(id => !knownIds.has(id));

        if (newIds.length > 0) {
          msgText.innerHTML = `<strong>Found ${newIds.length} new game(s)!</strong> Loading metadata from Microsoft…`;
          const newProducts = await fetchProducts(newIds);
          games = normalizeProducts(newProducts, sourceMap, games);
          updatedViaNetwork = true;
        }
      }

      const added = games.length - initialCount;
      await saveGames(Date.now());

      $("updated").textContent = "Last refresh: " + new Date().toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric"
      });

      if (added > 0) {
        msgText.innerHTML = `<strong>Updated!</strong> Found <strong>${added}</strong> new Game Pass title(s). Total: ${games.length} games.`;
      } else {
        msgText.innerHTML = `<strong>Catalogue is up-to-date!</strong> ${games.length} Game Pass entries loaded.`;
      }

      render();
    } catch (err) {
      console.error("Refresh encountered an error:", err);
      if (games.length > 0) {
        msgText.innerHTML = `<strong>Sync complete.</strong> ${games.length} games loaded from local storage.`;
      } else {
        msgText.innerHTML = `<strong>Couldn't refresh catalogue.</strong> Check your internet connection and try again.`;
      }
    } finally {
      isRefreshing = false;
      refreshBtn.classList.remove("spinning");
      if (refreshBtn2) refreshBtn2.disabled = false;
      setTimeout(() => {
        if (!isRefreshing && msg.style.display === "flex") {
          msg.style.display = "none";
        }
      }, 5000);
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
      list = list.filter(g => !statuses[g.id]);
    } else if (filter !== "all") {
      list = list.filter(g => statuses[g.id] === filter);
    }

    // Sorting
    list = [...list].sort((a, b) => {
      if (sort === "az") return a.title.localeCompare(b.title);
      if (sort === "za") return b.title.localeCompare(a.title);
      if (sort === "new") return (b.release || 0) - (a.release || 0);
      if (sort === "status") {
        const order = { play: 3, done: 2, skip: 1 };
        const scoreA = order[statuses[a.id]] || 0;
        const scoreB = order[statuses[b.id]] || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return a.title.localeCompare(b.title);
      }
      return 0;
    });

    return list;
  }

  // Render UI
  function render() {
    // Calculate status counts
    const counts = { play: 0, done: 0, skip: 0 };
    for (const s of Object.values(statuses)) {
      if (counts[s] !== undefined) counts[s]++;
    }

    $("total").textContent = games.length || "0";
    $("play").textContent = counts.play;
    $("done").textContent = counts.done;
    $("skip").textContent = counts.skip;

    // Update tab badges
    const unmarkedCount = Math.max(0, games.length - counts.play - counts.done - counts.skip);
    $("tab-all").textContent = `All (${games.length})`;
    $("tab-play").textContent = `Want to play (${counts.play})`;
    $("tab-done").textContent = `Played (${counts.done})`;
    $("tab-skip").textContent = `Skip (${counts.skip})`;
    $("tab-unmarked").textContent = `Unmarked (${unmarkedCount})`;

    const filtered = visibleGames();
    const listEl = $("list");

    if (!filtered.length) {
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
      return;
    }

    listEl.innerHTML = filtered.map(g => {
      const s = statuses[g.id];
      const statusLabels = { play: "WANT TO PLAY", done: "PLAYED", skip: "SKIP" };
      const statusBadge = s ? `<span class="status-badge ${s}">${statusLabels[s]}</span>` : "";

      const coverSrc = g.image ? escapeHTML(g.image) : "";
      const coverHtml = coverSrc
        ? `<div class="cover-wrap"><img class="cover" loading="lazy" src="${coverSrc}" alt="" onerror="this.style.display='none'">${statusBadge}</div>`
        : `<div class="cover-wrap">${statusBadge}</div>`;

      const platformPills = (g.platforms || []).map(p =>
        `<span class="pill">${p === "console" ? "Xbox" : p.toUpperCase()}</span>`
      ).join("");
      const eaPill = g.ea ? '<span class="pill ea">EA Play</span>' : "";

      return `
        <article class="game" data-game-id="${escapeHTML(g.id)}">
          ${coverHtml}
          <div class="game-body">
            <div class="game-title" title="${escapeHTML(g.title)}">${escapeHTML(g.title)}</div>
            <div class="game-meta">
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
    let dateStr = "";
    if (g.release) {
      dateStr = `<span class="pill">Release: ${new Date(g.release).toLocaleDateString("en-GB", { year: "numeric", month: "short" })}</span>`;
    }
    $("detail-meta").innerHTML = platformPills + eaPill + dateStr;

    $("detail-store").href = `https://www.xbox.com/en-gb/games/store/p/${g.id}`;
    updateDetailModalActions(g.id);

    $("detail-modal").classList.add("open");
  }

  function updateDetailModalActions(gameId) {
    const s = statuses[gameId];
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
    activeDetailGame = null;
  }

  // Event Listeners
  $("list").addEventListener("click", e => {
    const actionBtn = e.target.closest("button[data-id]");
    if (actionBtn) {
      e.stopPropagation();
      const id = actionBtn.dataset.id;
      const targetStatus = actionBtn.dataset.s;
      setStatus(id, statuses[id] === targetStatus ? null : targetStatus);
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

  $("subtitle").onclick = () => {
    const proxyInput = $("custom-proxy");
    if (proxyInput) {
      proxyInput.value = localStorage.getItem("gamepass_custom_proxy") || "";
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

  $("message-close").onclick = () => {
    $("message").style.display = "none";
  };

  // Custom proxy save
  $("custom-proxy").addEventListener("change", e => {
    localStorage.setItem("gamepass_custom_proxy", e.target.value.trim());
  });

  // Export & Import backlog statuses
  $("export-btn").onclick = () => {
    const exportData = {
      version: 1,
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
          const d = await db();
          const tx = d.transaction("statuses", "readwrite");
          const store = tx.objectStore("statuses");
          for (const [id, s] of Object.entries(statuses)) {
            store.put({ id, status: s });
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

  // Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  }

  // Initialize
  (async () => {
    await loadLocal();
  })();
})();