const fs = require('fs');

const SIGLS = {
  console: "f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e",
  pc: "fdd9e2a7-0fee-49f6-ad69-4354098401ff",
  ea: "b8900d09-a491-44cc-916e-32b5acae621b",
  all: "29a81209-df6f-41fd-a528-2ae6b91f719c"
};

const MARKET = "GB";
const LANG = "en-gb";

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function fetchIds(kind) {
  const url = `https://catalog.gamepass.com/sigls/v2?id=${SIGLS[kind]}&language=${LANG}&market=${MARKET}`;
  const data = await fetchJSON(url);
  return data.filter(x => x.id).map(x => x.id);
}

function imageFor(p) {
  const lp = p.LocalizedProperties?.[0];
  const imgs = lp?.Images || p.Images || [];
  const preferred = ["Poster", "BoxArt", "FeaturePromotionalSquareArt", "BrandedKeyArt", "Hero", "SuperHeroArt"];
  for (const typ of preferred) {
    const x = imgs.find(i => i.ImagePurpose === typ || i.Purpose === typ);
    if (x?.Uri) {
      let uri = x.Uri;
      if (uri.startsWith('//')) uri = 'https:' + uri;
      return uri;
    }
  }
  const x = imgs.find(i => i.Uri);
  if (x?.Uri) {
    let uri = x.Uri;
    if (uri.startsWith('//')) uri = 'https:' + uri;
    return uri;
  }
  return "";
}

function titleFor(p) {
  return p.LocalizedProperties?.[0]?.ProductTitle || p.ProductTitle || "Unknown game";
}

function dateFor(p) {
  const x = p.MarketProperties?.[0]?.OriginalReleaseDate || p.MarketProperties?.[0]?.ReleaseDate || p.Properties?.ReleaseDate;
  return x ? Date.parse(x) || 0 : 0;
}

async function fetchProducts(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const u = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${encodeURIComponent(batch.join(","))}&market=${MARKET}&languages=${LANG}`;
    const d = await fetchJSON(u);
    if (Array.isArray(d.Products)) {
      out.push(...d.Products);
    }
    console.log(`Fetched ${out.length} / ${ids.length} products...`);
  }
  return out;
}

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
  const groups = new Map();
  for (const g of rawGames) {
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

async function run() {
  console.log("Reading existing catalogue from games.json...");
  const existingMap = new Map();
  try {
    if (fs.existsSync('games.json')) {
      const prev = JSON.parse(fs.readFileSync('games.json', 'utf8'));
      if (Array.isArray(prev.games)) {
        for (const g of prev.games) {
          if (g && g.id) existingMap.set(g.id, g);
        }
      }
      console.log(`Found ${existingMap.size} games in previous catalogue.`);
    }
  } catch (e) {
    console.warn("Could not read previous games.json:", e.message);
  }

  console.log("Fetching current IDs from sigls...");
  const sourceMap = {};
  for (const k of ["console", "pc", "ea", "all"]) {
    try {
      const ids = await fetchIds(k);
      console.log(`Kind ${k}: ${ids.length} IDs`);
      for (const id of ids) {
        if (!sourceMap[id]) sourceMap[id] = [];
        sourceMap[id].push(k);
      }
    } catch (e) {
      console.error(`Failed to fetch ${k}:`, e.message);
    }
  }

  const allIds = Object.keys(sourceMap);
  const activeIdsSet = new Set(allIds);
  console.log(`Total active IDs currently on Game Pass: ${allIds.length}`);

  // Fetch product metadata only for IDs that need it (new or all)
  const products = await fetchProducts(allIds);

  const m = new Map();
  let newlyAddedCount = 0;

  for (const p of products) {
    const id = p.ProductId || p.Id;
    if (!id) continue;
    const src = sourceMap[id] || [];
    const platforms = [];
    if (src.includes("console")) platforms.push("console");
    if (src.includes("pc")) platforms.push("pc");
    if (!platforms.length && src.includes("all")) {
      platforms.push("console");
    }
    const isEa = src.includes("ea");

    const existing = existingMap.get(id);
    const isBrandNew = !existing;
    if (isBrandNew) newlyAddedCount++;

    m.set(id, {
      id,
      title: titleFor(p) || existing?.title || "Unknown game",
      image: imageFor(p) || existing?.image || "",
      platforms: platforms.length ? platforms : (existing?.platforms || ["console"]),
      ea: isEa || Boolean(existing?.ea),
      release: dateFor(p) || existing?.release || 0,
      description: p.LocalizedProperties?.[0]?.ShortDescription || p.LocalizedProperties?.[0]?.ProductDescription?.slice(0, 200) || existing?.description || "",
      developer: p.LocalizedProperties?.[0]?.DeveloperName || existing?.developer || "",
      removed: false,
      addedDate: existing?.addedDate || Date.now()
    });
  }

  // Preserve games that have been removed from Game Pass
  let removedCount = 0;
  for (const [id, oldGame] of existingMap.entries()) {
    if (!activeIdsSet.has(id)) {
      removedCount++;
      m.set(id, {
        ...oldGame,
        removed: true,
        removedDate: oldGame.removedDate || new Date().toISOString()
      });
    }
  }

  const rawGames = [...m.values()];
  console.log(`Raw games before deduplication: ${rawGames.length}`);

  // Deduplicate and choose best edition
  const games = deduplicateGames(rawGames).sort((a, b) => {
    // Active games first, then removed games
    if (Boolean(a.removed) !== Boolean(b.removed)) {
      return a.removed ? 1 : -1;
    }
    return a.title.localeCompare(b.title);
  });

  console.log(`Catalogue summary after deduplication: ${games.filter(g => !g.removed).length} active, ${games.filter(g => g.removed).length} removed. Total unique titles: ${games.length}`);
  const output = {
    updatedAt: Date.now(),
    updatedDate: new Date().toISOString(),
    count: games.filter(g => !g.removed).length,
    totalCount: games.length,
    removedCount: games.filter(g => g.removed).length,
    games
  };
  fs.writeFileSync('games.json', JSON.stringify(output, null, 2));
  console.log('Saved games.json successfully!');
}

run().catch(console.error);


