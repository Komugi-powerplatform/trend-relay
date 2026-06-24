#!/usr/bin/env node
// trend-relay — fetch ranked trend data (Zenn likes, HN points, Hatena
// bookmarks) from a NON-blocked egress IP (GitHub Actions) and normalize it
// to data/latest.json.
//
// Why this exists: the cloud `neta-trend-daily` Routine runs from Anthropic's
// cloud egress IP, which these data hosts (Zenn API / HN Algolia / Hatena) may
// 403-block as datacenter/anti-bot traffic. GitHub Actions runs from a
// different egress and can reach them. The cloud Routine then reads the
// committed JSON via raw.githubusercontent.com (a host it *can* reach) instead
// of calling the blocked APIs directly. Scores stop collapsing to "-".
//
// No external dependencies — Node 18+ native fetch only.

import { writeFile, mkdir } from "node:fs/promises";

const UA =
  "trend-relay/1.0 (+https://github.com/Komugi-powerplatform/trend-relay)";
const errors = [];

async function getJSON(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Run fn; on failure record the reason and return fallback so one dead source
// never blanks the whole report (safe default + visible error, not silent).
async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
    return fallback;
  }
}

const zennMap = (j) =>
  (j.articles || []).map((a) => ({
    title: a.title,
    url: "https://zenn.dev" + a.path,
    likes: a.liked_count,
  }));

// ---- Zenn -------------------------------------------------------------------
// trending = the high-like articles (the report's main signal).
// topic feeds (order=latest) = freshness / niche coverage for ai/ts/security.
const zenn = { trending: [], topics: {} };
zenn.trending = await safe(
  "zenn.trending",
  async () =>
    zennMap(
      await getJSON("https://zenn.dev/api/articles?order=trending&count=15"),
    ),
  [],
);
for (const t of ["ai", "typescript", "security"]) {
  zenn.topics[t] = await safe(
    `zenn.topic.${t}`,
    async () =>
      zennMap(
        await getJSON(
          `https://zenn.dev/api/articles?topicname=${t}&order=latest&count=8`,
        ),
      ),
    [],
  );
}

// ---- Hacker News (Algolia API) ---------------------------------------------
const hackernews = await safe(
  "hackernews",
  async () => {
    const j = await getJSON(
      "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20",
    );
    return (j.hits || []).map((h) => ({
      title: h.title,
      url: "https://news.ycombinator.com/item?id=" + h.objectID,
      points: h.points,
      comments: h.num_comments,
    }));
  },
  [],
);

// ---- Hatena Bookmark (hotentry RSS / RDF) ----------------------------------
// Hatena RSS titles arrive as numeric character references (&#x300E; …) plus a
// few named entities. Decode numeric refs first, then named (&amp; last).
const decode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function parseHatenaRSS(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s\S]*?<\/item>/g)) {
    const block = m[0];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    const count = block.match(
      /<hatena:bookmarkcount>(\d+)<\/hatena:bookmarkcount>/,
    )?.[1];
    if (title && link) {
      items.push({
        title: decode(title.trim()),
        url: link.trim(),
        bookmarks: count ? Number(count) : null,
      });
    }
  }
  return items;
}

// Only the top-level IT hotentry exposes an RSS feed; the it/<subcategory>
// pages are SPA HTML (no ?mode=rss). The IT hotentry is broad enough — it's
// currently dominated by AI/Claude/security stories anyway — and the cloud
// Routine tags interest itself.
const hatenaFeeds = {
  it: "https://b.hatena.ne.jp/hotentry/it.rss",
};
const hatena = {};
for (const [k, url] of Object.entries(hatenaFeeds)) {
  hatena[k] = await safe(
    `hatena.${k}`,
    async () => parseHatenaRSS(await getText(url)).slice(0, 15),
    [],
  );
}

// ---- write ------------------------------------------------------------------
const out = {
  generated_at: new Date().toISOString().replace(/:\d\d\.\d+Z$/, "Z"),
  errors,
  zenn,
  hackernews,
  hatena,
};
await mkdir("data", { recursive: true });
await writeFile("data/latest.json", JSON.stringify(out, null, 2) + "\n");
console.log(
  `wrote data/latest.json — zenn.trending=${zenn.trending.length} ` +
    `hn=${hackernews.length} hatena.it=${hatena.it.length} errors=${errors.length}`,
);
if (errors.length) console.log("errors:", errors);
