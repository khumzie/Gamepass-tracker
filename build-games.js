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

async function run() {
  console.log("Fetching IDs from sigls...");
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
  console.log(`Total unique IDs: ${allIds.length}`);

  const products = await fetchProducts(allIds);

  const m = new Map();
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

    m.set(id, {
      id,
      title: titleFor(p),
      image: imageFor(p),
      platforms,
      ea: isEa,
      release: dateFor(p),
      description: p.LocalizedProperties?.[0]?.ShortDescription || p.LocalizedProperties?.[0]?.ProductDescription?.slice(0, 200) || "",
      developer: p.LocalizedProperties?.[0]?.DeveloperName || ""
    });
  }

  const games = [...m.values()].sort((a, b) => a.title.localeCompare(b.title));
  console.log(`Normalized ${games.length} games.`);
  const output = {
    updatedAt: Date.now(),
    updatedDate: new Date().toISOString(),
    count: games.length,
    games
  };
  fs.writeFileSync('games.json', JSON.stringify(output, null, 2));
  console.log('Saved games.json successfully!');
}

run().catch(console.error);
