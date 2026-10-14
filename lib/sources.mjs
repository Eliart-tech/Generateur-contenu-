// Sources de tendances gratuites (ou à clé gratuite). Chaque source échoue
// silencieusement : le radar agrège ce qui répond et liste les erreurs.
import crypto from "node:crypto";
import { config } from "./env.mjs";
import { cacheGet, cacheSet } from "./store.mjs";

const CACHE_MS = 30 * 60 * 1000; // 30 minutes

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        "user-agent": "generateur-contenu-perso/0.1 (outil personnel)",
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// --- Google Trends (flux RSS public "Tendances du jour", sans clé) ---
async function googleTrends(geo) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Google Trends HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < 15) {
    const block = m[1];
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1];
    const traffic = /<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(block)?.[1];
    const news = /<ht:news_item_title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ht:news_item_title>/.exec(block)?.[1];
    if (title) {
      items.push({
        title: decodeXmlEntities(title.trim()),
        signal: traffic ? `${traffic.trim()} recherches` : "tendance du jour",
        detail: news ? decodeXmlEntities(news.trim()) : "",
      });
    }
  }
  return items;
}

// --- GDELT (actualité mondiale, gratuit, rafraîchi ~15 min) ---
async function gdeltNews(query, lang) {
  const q = lang === "fr" ? `${query} sourcelang:french` : query;
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?" +
    new URLSearchParams({
      query: q,
      mode: "ArtList",
      maxrecords: "12",
      timespan: "3d",
      sort: "hybridrel",
      format: "json",
    });
  const res = await fetchWithTimeout(url, {}, 25000);
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const data = await res.json();
  return (data.articles || []).slice(0, 12).map((a) => ({
    title: a.title || "",
    signal: a.domain || "",
    detail: a.seendate ? `vu le ${String(a.seendate).slice(0, 8)}` : "",
    url: a.url || "",
  }));
}

// --- YouTube Data API v3 (gratuite, clé requise) ---
async function youtubeTrending(geo) {
  if (!config.youtubeKey) throw new Error("YOUTUBE_API_KEY absente (optionnelle)");
  const url =
    "https://www.googleapis.com/youtube/v3/videos?" +
    new URLSearchParams({
      part: "snippet,statistics",
      chart: "mostPopular",
      regionCode: geo,
      maxResults: "15",
      key: config.youtubeKey,
    });
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((v) => ({
    title: v.snippet?.title || "",
    signal: `${Number(v.statistics?.viewCount || 0).toLocaleString("fr-FR")} vues`,
    detail: v.snippet?.channelTitle || "",
    url: `https://www.youtube.com/watch?v=${v.id}`,
  }));
}

async function youtubeSearch(query) {
  if (!config.youtubeKey) throw new Error("YOUTUBE_API_KEY absente (optionnelle)");
  const publishedAfter = new Date(Date.now() - 7 * 864e5).toISOString();
  const url =
    "https://www.googleapis.com/youtube/v3/search?" +
    new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      order: "viewCount",
      publishedAfter,
      maxResults: "8",
      key: config.youtubeKey,
    });
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((v) => ({
    title: v.snippet?.title || "",
    signal: "vidéo récente la plus vue sur le sujet",
    detail: v.snippet?.channelTitle || "",
    url: v.id?.videoId ? `https://www.youtube.com/watch?v=${v.id.videoId}` : "",
  }));
}

// --- Reddit (endpoints JSON publics, signaux précoces) ---
async function redditTop(query) {
  const url = query
    ? "https://www.reddit.com/search.json?" +
      new URLSearchParams({ q: query, sort: "top", t: "week", limit: "10" })
    : "https://www.reddit.com/r/popular/top.json?t=day&limit=10";
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const data = await res.json();
  return (data.data?.children || []).map((c) => ({
    title: c.data?.title || "",
    signal: `${c.data?.score ?? 0} upvotes · r/${c.data?.subreddit ?? ""}`,
    detail: "",
    url: c.data?.permalink ? `https://www.reddit.com${c.data.permalink}` : "",
  }));
}

// --- Hacker News via Algolia (gratuit, niches tech/business) ---
async function hackerNews(query) {
  const url =
    "https://hn.algolia.com/api/v1/search?" +
    new URLSearchParams({
      query: query || "",
      tags: "story",
      numericFilters: "points>80",
      hitsPerPage: "8",
    });
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Hacker News HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits || []).map((h) => ({
    title: h.title || "",
    signal: `${h.points} points · ${h.num_comments ?? 0} commentaires`,
    detail: "",
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));
}

const SOURCES = [
  { key: "googleTrends", label: "Google Trends", run: ({ geo }) => googleTrends(geo) },
  { key: "news", label: "Actualité (GDELT)", run: ({ query, lang }) => gdeltNews(query, lang) },
  { key: "youtubeTrending", label: "YouTube tendances", run: ({ geo }) => youtubeTrending(geo) },
  { key: "youtubeSearch", label: "YouTube sur le sujet", run: ({ query }) => youtubeSearch(query) },
  { key: "reddit", label: "Reddit", run: ({ query }) => redditTop(query) },
  { key: "hackerNews", label: "Hacker News", run: ({ query }) => hackerNews(query) },
];

export async function getTrends({ query, geo, lang }) {
  const g = geo || config.geo;
  const l = lang || config.lang;
  const key =
    "trends-" +
    crypto.createHash("sha1").update(`${query}|${g}|${l}`).digest("hex").slice(0, 16);
  const cached = cacheGet(key, CACHE_MS);
  if (cached) return { ...cached, fromCache: true };

  const sources = {};
  const errors = [];
  await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const items = await s.run({ query, geo: g, lang: l });
        if (items.length) sources[s.key] = { label: s.label, items };
      } catch (err) {
        errors.push({ source: s.label, error: String(err?.message || err) });
      }
    }),
  );

  const result = { query, geo: g, fetchedAt: new Date().toISOString(), sources, errors };
  if (Object.keys(sources).length) cacheSet(key, result);
  return result;
}

// Résumé texte compact des tendances, injecté dans les prompts Claude.
export function trendsAsText(trends, maxPerSource = 8) {
  const lines = [];
  for (const [, { label, items }] of Object.entries(trends.sources || {})) {
    lines.push(`## ${label}`);
    for (const it of items.slice(0, maxPerSource)) {
      lines.push(`- ${it.title}${it.signal ? ` (${it.signal})` : ""}${it.detail ? ` — ${it.detail}` : ""}`);
    }
  }
  return lines.join("\n") || "(aucune source de tendances disponible pour le moment)";
}
