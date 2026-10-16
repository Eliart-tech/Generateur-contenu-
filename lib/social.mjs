// Scan des réseaux sociaux : TikTok, Instagram, X et LinkedIn via Apify, YouTube Shorts via
// l'API YouTube, plus des sujets montants gratuits (X France, Google Trends, Google Actualités).
//
// Un scan se déroule en étapes courtes, compatibles avec la limite Vercel :
//   createScan  → lance les runs Apify en asynchrone et relève les sources gratuites (< 10 s)
//   advanceScan → appelé en boucle par l'interface (< 25 s par appel) : suit les runs,
//                 lance la recherche d'abonnés Instagram, puis lit, normalise et note les posts.
import crypto from "node:crypto";
import { config } from "./env.mjs";
import { cacheGet, cacheSet } from "./store.mjs";
import { startRun, getRun, abortRun, datasetItems, isTerminal, accountInfo, hasApifyToken } from "./apify.mjs";
import { fetchWithTimeout, decodeXmlEntities, googleTrends, googleNews } from "./sources.mjs";
import { scorePosts, clusterPosts, normalizeTag } from "./virality.mjs";

export const SOCIAL_NETWORKS = ["tiktok", "instagram", "x", "linkedin", "youtube"];
export const NETWORK_LABELS = { tiktok: "TikTok", instagram: "Instagram", x: "X", linkedin: "LinkedIn", youtube: "YouTube Shorts" };

const DAY = 864e5;
const SCAN_TTL = 7 * DAY;
const FRESH_MS = 6 * 3.6e6; // un scan de moins de 6 h est réutilisé (économie de crédit)
const HARD_DEADLINE_MS = 240 * 1000; // au-delà, on arrête les runs lents et on garde le partiel
const MIN_CREDIT_USD = 0.35;
const FOLLOWERS_TTL = 7 * DAY;

const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const tagsFromText = (text) => [...String(text || "").matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// Adaptateurs par réseau : entrée de l'actor + conversion vers le format commun
// { network, id, url, text, createdAt, views, likes, comments, shares, saves,
//   authorHandle, authorFollowers, hashtags[], sound, soundId, soundOriginal, mediaType, lang, flags[] }
// ---------------------------------------------------------------------------

function mapTiktok(it) {
  if (!it || it.errorCode || !it.id) return null;
  const music = it.musicMeta || {};
  return {
    network: "tiktok",
    id: String(it.id),
    url: it.webVideoUrl || null,
    text: it.text || "",
    createdAt: it.createTimeISO || iso(it.createTime),
    views: num(it.playCount),
    likes: num(it.diggCount),
    comments: num(it.commentCount),
    shares: num(it.shareCount),
    saves: num(it.collectCount),
    authorHandle: it.authorMeta?.name || null,
    authorFollowers: num(it.authorMeta?.fans),
    authorTotalLikes: num(it.authorMeta?.heart),
    authorPostCount: num(it.authorMeta?.video),
    hashtags: (it.hashtags || []).map((h) => h?.name).filter(Boolean),
    sound: music.musicOriginal ? "Son original" : [music.musicName, music.musicAuthor].filter(Boolean).join(" · ") || null,
    soundId: music.musicId ? String(music.musicId) : null,
    soundOriginal: Boolean(music.musicOriginal),
    mediaType: it.isSlideshow ? "carrousel" : "vidéo",
    lang: it.textLanguage || null,
    flags: it.isAd || it.isSponsored ? ["sponsorisé"] : [],
  };
}

function mapInstagram(it) {
  if (!it || it.error || !(it.id || it.shortCode)) return null;
  const views = num(it.videoPlayCount ?? it.igPlayCount);
  let likes = num(it.likesCount);
  if (likes !== null && (likes < 0 || (likes === 0 && views > 500))) likes = null; // likes masqués
  const music = it.musicInfo || {};
  const type = it.productType === "clips" ? "reel" : it.type === "Sidecar" ? "carrousel" : it.type === "Video" ? "vidéo" : "image";
  return {
    network: "instagram",
    id: String(it.id || it.shortCode),
    url: it.url || (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : null),
    text: it.caption || "",
    createdAt: iso(it.timestamp),
    views,
    likes,
    comments: num(it.commentsCount),
    shares: num(it.sharesCount),
    saves: null,
    authorHandle: it.ownerUsername || null,
    authorFollowers: null, // complété par la recherche de profils
    hashtags: it.hashtags || [],
    sound: music.uses_original_audio ? "Son original" : [music.song_name, music.artist_name].filter(Boolean).join(" · ") || null,
    soundId: music.audio_id ? String(music.audio_id) : null,
    soundOriginal: Boolean(music.uses_original_audio),
    mediaType: type,
    lang: null,
    flags: it.paidPartnership ? ["sponsorisé"] : [],
  };
}

function mapX(it) {
  if (!it || !it.id || it.noResults || it.isRetweet || it.isReply || it.type === "mock_tweet") return null;
  // Deux sources possibles : apidojo (payante) ou scraper_one (offre gratuite, sans vues).
  const text = it.fullText ?? it.text ?? it.postText ?? "";
  const shares = (num(it.retweetCount ?? it.repostCount) || 0) + (num(it.quoteCount) || 0);
  return {
    network: "x",
    id: String(it.id),
    url: it.url || it.twitterUrl || it.postUrl || null,
    text,
    createdAt: iso(it.createdAt ?? it.timestamp),
    views: num(it.viewCount),
    likes: num(it.likeCount ?? it.favouriteCount),
    comments: num(it.replyCount),
    shares,
    saves: num(it.bookmarkCount),
    authorHandle: it.author?.userName || it.author?.screenName || null,
    authorFollowers: num(it.author?.followers ?? it.author?.followersCount),
    hashtags: it.entities?.hashtags?.map((h) => h.text) || tagsFromText(text),
    sound: null,
    soundId: null,
    soundOriginal: false,
    mediaType: it.extendedEntities?.media?.[0]?.type || it.media?.[0]?.type || "texte",
    lang: it.lang || null,
    flags: [],
  };
}

function mapLinkedin(it) {
  if (!it || !it.content || !(it.id || it.linkedinUrl)) return null;
  const e = it.engagement || {};
  const media = it.postVideo ? "vidéo" : it.document ? "document" : it.postImages?.length > 1 ? "carrousel" : it.postImages?.length ? "image" : it.article ? "article" : "texte";
  return {
    network: "linkedin",
    id: String(it.id || it.linkedinUrl),
    url: it.linkedinUrl || null,
    text: it.content,
    createdAt: it.postedAt?.date || iso(it.postedAt?.timestamp),
    views: null,
    likes: num(e.likes),
    comments: num(e.comments),
    shares: num(e.shares),
    saves: null,
    authorHandle: it.author?.publicIdentifier || it.author?.universalName || it.author?.name || null,
    authorName: it.author?.name || null,
    authorFollowers: num(it.author?.followerCount ?? it.author?.followersCount),
    hashtags: tagsFromText(it.content),
    sound: null,
    soundId: null,
    soundOriginal: false,
    mediaType: media,
    lang: null,
    flags: [],
  };
}

const sinceDate = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

const ADAPTERS = {
  tiktok: {
    actor: "clockworks/free-tiktok-scraper",
    timeout: 150,
    maxCharge: 0.25,
    input: (q) => ({
      searchQueries: q.tiktok.slice(0, 2),
      searchSection: "/video",
      videoSearchDateFilter: "PAST_WEEK",
      resultsPerPage: 13,
      proxyCountryCode: "FR",
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadAvatars: false,
      shouldDownloadMusicCovers: false,
      shouldDownloadSlideshowImages: false,
      downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
      commentsPerPost: 0,
    }),
    map: mapTiktok,
  },
  instagram: {
    actor: "apify/instagram-search-scraper",
    timeout: 120,
    maxCharge: 0.1,
    input: (q) => ({ search: q.instagram.replace(/,/g, " "), searchType: "popular", searchLimit: 25 }),
    map: mapInstagram,
  },
  x: {
    // L'actor le plus fiable n'est utilisable qu'en offre payante ; repli sans vues sinon.
    actor: (account) => (account?.free ? "scraper_one/x-posts-search" : "apidojo/twitter-scraper-lite"),
    timeout: 90,
    maxCharge: 0.05,
    input: (q, account) => {
      const query = `${q.x} lang:fr min_faves:20 -filter:replies -filter:retweets`;
      return account?.free
        ? { query, searchType: "top", resultsCount: 25 }
        : { searchTerms: [`${query} since:${sinceDate(3)}`], sort: "Top", maxItems: 25 };
    },
    map: mapX,
  },
  linkedin: {
    actor: "harvestapi/linkedin-post-search",
    timeout: 120,
    maxCharge: 0.08,
    input: (q) => ({
      searchQueries: q.linkedin.slice(0, 2).map((s) => (s.startsWith('"') ? s : `"${s}"`)),
      maxPosts: 25,
      postedLimit: "week",
      sortBy: "relevance",
      contentType: "all",
      profileScraperMode: "short",
      scrapeReactions: false,
      scrapeComments: false,
    }),
    map: mapLinkedin,
  },
};

// Coût indicatif d'un scan (offre gratuite, ~25 posts par réseau), affiché avant de lancer.
export const SCAN_COST_USD = { tiktok: 0.14, instagram: 0.1, x: 0.02, linkedin: 0.05, youtube: 0 };

// ---------------------------------------------------------------------------
// YouTube Shorts (API officielle gratuite, clé requise) : posts avec vraies métriques
// ---------------------------------------------------------------------------

function isoDurationSecs(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : null;
}

async function youtubeShorts(query) {
  const key = config.youtubeKey;
  const g = (path, params) =>
    fetchWithTimeout(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`).then(async (r) => {
      if (!r.ok) throw new Error(`YouTube HTTP ${r.status}`);
      return r.json();
    });
  const search = await g("search", {
    part: "snippet",
    type: "video",
    q: query,
    regionCode: config.geo,
    relevanceLanguage: config.lang,
    publishedAfter: new Date(Date.now() - 7 * DAY).toISOString(),
    order: "viewCount",
    videoDuration: "short",
    maxResults: "25",
  });
  const ids = (search.items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const videos = await g("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") });
  const channelIds = [...new Set((videos.items || []).map((v) => v.snippet?.channelId).filter(Boolean))];
  const channels = channelIds.length ? await g("channels", { part: "statistics", id: channelIds.join(",") }) : { items: [] };
  const subs = Object.fromEntries((channels.items || []).map((c) => [c.id, num(c.statistics?.subscriberCount)]));
  return (videos.items || [])
    .filter((v) => (isoDurationSecs(v.contentDetails?.duration) ?? 999) <= 180)
    .map((v) => ({
      network: "youtube",
      id: v.id,
      url: `https://www.youtube.com/shorts/${v.id}`,
      text: [v.snippet?.title, v.snippet?.description].filter(Boolean).join("\n").slice(0, 500),
      createdAt: v.snippet?.publishedAt || null,
      views: num(v.statistics?.viewCount),
      likes: num(v.statistics?.likeCount),
      comments: num(v.statistics?.commentCount),
      shares: null,
      saves: null,
      authorHandle: v.snippet?.channelTitle || null,
      authorFollowers: subs[v.snippet?.channelId] ?? null,
      hashtags: tagsFromText(`${v.snippet?.title} ${v.snippet?.description}`),
      sound: null,
      soundId: null,
      soundOriginal: false,
      mediaType: "short",
      lang: v.snippet?.defaultAudioLanguage || v.snippet?.defaultLanguage || null,
      flags: [],
    }));
}

// ---------------------------------------------------------------------------
// Sujets montants gratuits : X France (trends24 → getdaytrends), Google Trends, Google Actualités
// ---------------------------------------------------------------------------

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

async function xTrendsFrance() {
  try {
    const res = await fetchWithTimeout("https://trends24.in/france/", { headers: { "user-agent": BROWSER_UA } });
    if (!res.ok) throw new Error(`trends24 HTTP ${res.status}`);
    const html = await res.text();
    const lists = [...html.matchAll(/<ol class="?trend-card__list"?[^>]*>([\s\S]*?)<\/ol>/g)].map((m) =>
      [...m[1].matchAll(/class="?trend-link"?[^>]*>([\s\S]*?)<\/a>/g)].map((t) => decodeXmlEntities(t[1].replace(/<[^>]+>/g, "").trim())),
    );
    if (!lists.length || !lists[0].length) throw new Error("trends24 : structure inattendue");
    const latest = lists[0].slice(0, 20);
    const older = new Set((lists[3] || lists[lists.length - 1] || []).map((t) => t.toLowerCase()));
    return latest.map((title, i) => ({ title, rank: i + 1, rising: !older.has(title.toLowerCase()) }));
  } catch (err) {
    const res = await fetchWithTimeout("https://getdaytrends.com/france/", { headers: { "user-agent": BROWSER_UA } });
    if (!res.ok) throw new Error(`${err.message} ; getdaytrends HTTP ${res.status}`);
    const html = await res.text();
    const names = [...html.matchAll(/<td class="main">\s*<a[^>]*>([\s\S]*?)<\/a>/g)].map((m) => decodeXmlEntities(m[1].replace(/<[^>]+>/g, "").trim()));
    if (!names.length) throw new Error(`${err.message} ; getdaytrends : structure inattendue`);
    return names.slice(0, 20).map((title, i) => ({ title, rank: i + 1, rising: false }));
  }
}

async function externalTopics(niche) {
  const out = { xFrance: [], googleTrends: [], news: [], errors: [] };
  await Promise.all([
    xTrendsFrance().then((v) => (out.xFrance = v)).catch((e) => out.errors.push({ source: "Tendances X France", error: e.message })),
    googleTrends(config.geo).then((v) => (out.googleTrends = v.slice(0, 15))).catch((e) => out.errors.push({ source: "Google Trends", error: e.message })),
    niche
      ? googleNews(niche, config.lang, config.geo, 8).then((v) => (out.news = v)).catch((e) => out.errors.push({ source: "Google Actualités", error: e.message }))
      : null,
  ]);
  return out;
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

const scanKey = (id) => `scan-${id}`;
const latestKey = (niche) => `scan-latest-${hash(String(niche || "").toLowerCase().trim())}`;

export async function loadScan(id) {
  return id ? cacheGet(scanKey(id), SCAN_TTL) : null;
}

async function saveScan(scan) {
  await cacheSet(scanKey(scan.id), scan, SCAN_TTL);
  await cacheSet(latestKey(scan.niche), { id: scan.id }, SCAN_TTL);
  await cacheSet("scan-latest", { id: scan.id }, SCAN_TTL);
}

export async function latestScan(niche) {
  const ptr = await cacheGet(niche ? latestKey(niche) : "scan-latest", SCAN_TTL);
  return ptr?.id ? loadScan(ptr.id) : null;
}

// Réseaux réellement interrogeables avec les clés présentes.
export function availableNetworks() {
  const apify = hasApifyToken();
  return {
    tiktok: apify,
    instagram: apify,
    x: apify,
    linkedin: apify,
    youtube: Boolean(config.youtubeKey),
  };
}

/**
 * Démarre un scan. `queries` : requêtes par réseau (préparées par l'IA à partir de la niche).
 * Réutilise un scan récent de la même niche sauf si `force`.
 */
export async function createScan({ niche, audience = "", networks, queries, force = false }) {
  const avail = availableNetworks();
  const wanted = (networks?.length ? networks : SOCIAL_NETWORKS).filter((n) => SOCIAL_NETWORKS.includes(n));
  const usable = wanted.filter((n) => avail[n]);

  if (!force) {
    const prev = await latestScan(niche);
    const sameNets = prev && [...prev.networks].sort().join() === [...usable].sort().join();
    if (prev && sameNets && Date.now() - Date.parse(prev.createdAt) < FRESH_MS && prev.status !== "error") {
      return { ...prev, reused: true };
    }
  }

  const apifyNets = usable.filter((n) => n !== "youtube");
  let account = null;
  if (apifyNets.length) {
    account = await accountInfo().catch(() => null);
    if (account?.remainingUsd !== null && account?.remainingUsd !== undefined && account.remainingUsd < MIN_CREDIT_USD) {
      throw new Error(`Crédit Apify insuffisant pour un scan (${account.remainingUsd.toFixed(2)} $ restants ce mois-ci).`);
    }
  }

  const scan = {
    id: crypto.randomUUID().slice(0, 10),
    createdAt: new Date().toISOString(),
    niche,
    audience,
    networks: usable,
    skipped: wanted.filter((n) => !avail[n]),
    queries,
    account: account ? { plan: account.plan, free: account.free, remainingUsd: account.remainingUsd } : null,
    runs: {},
    status: "running",
    external: null,
    youtubePosts: [],
    errors: [],
  };

  await Promise.all([
    ...apifyNets.map(async (net) => {
      const ad = ADAPTERS[net];
      const actor = typeof ad.actor === "function" ? ad.actor(account) : ad.actor;
      try {
        const run = await startRun(actor, ad.input(queries, account), { timeout: ad.timeout, maxCharge: ad.maxCharge });
        scan.runs[net] = { actor, runId: run.id, datasetId: run.datasetId, status: run.status || "RUNNING" };
      } catch (err) {
        scan.runs[net] = { actor, status: "ERROR", error: err.message };
      }
    }),
    usable.includes("youtube")
      ? youtubeShorts(queries.youtube || niche)
          .then((posts) => (scan.youtubePosts = posts))
          .catch((err) => scan.errors.push({ source: NETWORK_LABELS.youtube, error: err.message }))
      : null,
    externalTopics(niche).then((ext) => (scan.external = ext)),
  ]);

  if (!apifyNets.length || Object.values(scan.runs).every((r) => isTerminal(r.status) || r.status === "ERROR")) {
    await finalizeScan(scan);
  }
  await saveScan(scan);
  return scan;
}

const TERMINAL_OK = (s) => s === "SUCCEEDED";

/** Fait avancer un scan en cours, en ~budget secondes maximum. */
export async function advanceScan(scan, { budgetSecs = 18 } = {}) {
  if (!scan || scan.status !== "running") return scan;
  const age = Date.now() - Date.parse(scan.createdAt);
  const pending = Object.entries(scan.runs).filter(([, r]) => r.runId && !isTerminal(r.status) && r.status !== "ERROR");
  const wait = Math.max(0, Math.min(budgetSecs, (HARD_DEADLINE_MS - age) / 1000));

  await Promise.all(
    pending.map(async ([net, r]) => {
      try {
        const st = await getRun(r.runId, wait);
        r.status = st.status || r.status;
        r.usageUsd = st.usageUsd;
        r.runSecs = st.runSecs;
      } catch (err) {
        r.pollError = err.message;
      }
      void net;
    }),
  );

  // Instagram ne donne pas les abonnés : dès que la recherche est finie, on les demande
  // pour les meilleurs Reels (avec un cache de 7 jours par compte).
  const ig = scan.runs.instagram;
  if (ig && TERMINAL_OK(ig.status) && !scan.runs.instagramProfiles) {
    try {
      const items = (await datasetItems(ig.datasetId, 60)).map(mapInstagram).filter(Boolean);
      const cache = (await cacheGet("igf", 30 * DAY)) || {};
      const owners = [...new Set(items.sort((a, b) => (b.views || 0) - (a.views || 0)).map((p) => p.authorHandle).filter(Boolean))]
        .filter((u) => !(cache[u] && Date.now() - cache[u].t < FOLLOWERS_TTL))
        .slice(0, 10);
      if (owners.length) {
        const run = await startRun("apify/instagram-profile-scraper", { usernames: owners }, { timeout: 60, maxCharge: 0.04 });
        scan.runs.instagramProfiles = { actor: "apify/instagram-profile-scraper", runId: run.id, datasetId: run.datasetId, status: run.status || "RUNNING" };
      } else {
        scan.runs.instagramProfiles = { status: "SUCCEEDED", cachedOnly: true };
      }
    } catch (err) {
      scan.runs.instagramProfiles = { status: "ERROR", error: err.message };
    }
  }

  const stillRunning = Object.values(scan.runs).filter((r) => r.runId && !isTerminal(r.status) && r.status !== "ERROR");
  if (stillRunning.length && Date.now() - Date.parse(scan.createdAt) < HARD_DEADLINE_MS) {
    await saveScan(scan);
    return scan;
  }
  // Délai dépassé : on arrête les retardataires et on garde ce qu'ils ont déjà relevé (et payé).
  await Promise.all(stillRunning.map(async (r) => {
    await abortRun(r.runId);
    r.status = "TIMED-OUT";
  }));
  await finalizeScan(scan);
  await saveScan(scan);
  return scan;
}

const compactPost = (p) => ({
  key: p.key,
  network: p.network,
  url: p.url,
  text: String(p.text || "").replace(/\s+/g, " ").trim().slice(0, 280),
  createdAt: p.createdAt,
  ageH: Math.round(p.ageH),
  views: p.noViews ? null : p.views ?? null,
  likes: p.likes ?? null,
  comments: p.comments ?? null,
  shares: p.shares ?? null,
  saves: p.saves ?? null,
  authorHandle: p.authorHandle,
  authorName: p.authorName || null,
  authorFollowers: p.authorFollowers ?? null,
  reach: p.reach === null || p.reach === undefined ? null : Math.round(p.reach * 10) / 10,
  ratio: Math.round(p.R * 10) / 10,
  score: p.pvs,
  nowScore: p.nowScore,
  label: p.label,
  confidence: p.conf,
  flags: p.flags,
  hashtags: (p.hashtags || []).slice(0, 6),
  sound: p.sound || null,
  mediaType: p.mediaType || null,
  growth24h: p.growth24h === undefined ? null : Math.round(p.growth24h * 100) / 100,
});

async function finalizeScan(scan) {
  const raw = [...(scan.youtubePosts || [])];
  const stats = {};
  for (const [net, r] of Object.entries(scan.runs)) {
    if (net === "instagramProfiles") continue;
    stats[net] = { status: r.status, error: r.error || null, fetched: 0 };
    if (!r.datasetId) continue;
    try {
      const items = await datasetItems(r.datasetId, 80);
      const mapped = items.map(ADAPTERS[net].map).filter(Boolean);
      stats[net].fetched = mapped.length;
      raw.push(...mapped);
    } catch (err) {
      stats[net].error = err.message;
    }
  }
  if (scan.youtubePosts?.length) stats.youtube = { status: "SUCCEEDED", fetched: scan.youtubePosts.length };

  // Abonnés Instagram : profils fraîchement relevés + cache.
  const cache = (await cacheGet("igf", 30 * DAY)) || {};
  const prof = scan.runs.instagramProfiles;
  if (prof?.datasetId) {
    try {
      for (const p of await datasetItems(prof.datasetId, 20)) {
        if (!p?.username || p.error) continue;
        const likes = (p.latestPosts || []).map((x) => x.likesCount).filter((v) => Number.isFinite(v) && v >= 0);
        likes.sort((a, b) => a - b);
        cache[p.username] = {
          f: num(p.followersCount),
          likesMedian: likes.length >= 6 ? likes[Math.floor(likes.length / 2)] : null,
          t: Date.now(),
        };
      }
      await cacheSet("igf", cache, 30 * DAY);
    } catch {
      /* les ratios Instagram retomberont sur la comparaison au lot */
    }
  }
  for (const p of raw) {
    if (p.network === "instagram" && cache[p.authorHandle]) {
      p.authorFollowers = cache[p.authorHandle].f;
      p.authorLikesMedian = cache[p.authorHandle].likesMedian;
    }
  }

  // Vitesse réelle : comparaison avec les relevés des scans précédents de la même niche.
  const snapKey = `snaps-${hash(String(scan.niche || "").toLowerCase())}`;
  const snapshots = (await cacheGet(snapKey, 14 * DAY)) || {};
  const externalTerms = [
    ...(scan.external?.xFrance || []).map((t) => t.title),
    ...(scan.external?.googleTrends || []).map((t) => t.title),
  ];
  const { posts, excluded } = scorePosts(raw, { snapshots });
  const excludeTerms = [
    ...String(scan.niche || "").split(/[\s,/'’-]+/).filter((w) => w.length >= 4),
    scan.niche,
    ...(scan.queries?.hashtags || []),
    ...(scan.queries?.tiktok || []),
    scan.queries?.instagram,
  ].filter(Boolean);
  const clusters = clusterPosts(posts, { externalTerms, excludeTerms });

  const now = Date.now();
  for (const p of posts) snapshots[p.key] = { vol: p.vol, t: now };
  for (const [k, v] of Object.entries(snapshots)) if (now - v.t > 14 * DAY) delete snapshots[k];
  await cacheSet(snapKey, snapshots, 14 * DAY).catch(() => {});

  for (const net of Object.keys(stats)) stats[net].kept = posts.filter((p) => p.network === net).length;
  scan.stats = stats;
  scan.excluded = excluded;
  scan.posts = posts.slice(0, 60).map(compactPost);
  scan.clusters = clusters.map((c) => ({ ...c, postKeys: c.postKeys.filter((k) => scan.posts.some((p) => p.key === k)) }));
  scan.status = "done";
  scan.finishedAt = new Date().toISOString();
  scan.costUsd = Math.round(Object.values(scan.runs).reduce((s, r) => s + (Number(r.usageUsd) || 0), 0) * 100) / 100 || null;
  delete scan.youtubePosts;
}

// ---------------------------------------------------------------------------
// Texte compact pour les prompts (idées, angles, scripts, juge)
// ---------------------------------------------------------------------------

const fmtN = (n) => (n === null || n === undefined ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));
const fmtAge = (h) => (h < 48 ? `${h} h` : `${Math.round(h / 24)} j`);

export function postLine(p, i) {
  const metrics = [
    p.views !== null ? `${fmtN(p.views)} vues` : null,
    p.likes !== null ? `${fmtN(p.likes)} j'aime` : null,
    p.comments !== null ? `${fmtN(p.comments)} comm.` : null,
    p.shares ? `${fmtN(p.shares)} partages` : null,
    p.saves ? `${fmtN(p.saves)} enreg.` : null,
    p.reach !== null ? `×${String(p.reach).replace(".", ",")} son audience` : null,
    `×${String(p.ratio).replace(".", ",")} vs ses pairs`,
  ].filter(Boolean);
  return `${i !== undefined ? `P${i + 1} ` : ""}[${NETWORK_LABELS[p.network]} · ${p.mediaType || "post"} · il y a ${fmtAge(p.ageH)} · score ${p.score}] @${p.authorHandle || "?"}${p.authorFollowers ? ` (${fmtN(p.authorFollowers)} abonnés)` : ""} — ${metrics.join(", ")} — « ${p.text.slice(0, 200)} »${p.hashtags.length ? ` ${p.hashtags.map((h) => `#${normalizeTag(h)}`).join(" ")}` : ""}${p.sound && p.sound !== "Son original" ? ` — son : ${p.sound}` : ""}`;
}

export function clusterLine(c) {
  return `${c.label} (${c.kind}) — ${c.stage}, ${c.creators} créateurs sur ${c.networks.map((n) => NETWORK_LABELS[n]).join(", ")}, ratio médian ×${String(c.medianRatio).replace(".", ",")}, ${c.hitRate} % de posts à ×3 ou plus${c.external ? ", aussi dans les tendances nationales" : ""}`;
}

export function externalLines(ext) {
  if (!ext) return [];
  const lines = [];
  if (ext.xFrance?.length) lines.push(`Tendances X France (maintenant) : ${ext.xFrance.slice(0, 15).map((t) => `${t.title}${t.rising ? " ↑" : ""}`).join(", ")}`);
  if (ext.googleTrends?.length) lines.push(`Recherches Google en hausse (France) : ${ext.googleTrends.slice(0, 10).map((t) => `${t.title} (${t.signal})`).join(", ")}`);
  if (ext.news?.length) lines.push(`Actualité du sujet (7 j) : ${ext.news.slice(0, 6).map((n) => `${n.title} — ${n.signal}`).join(" | ")}`);
  return lines;
}

/** Résumé du scan injecté dans les prompts de prévision (angles, scripts, juge). */
export function socialAsText(scan, max = 12) {
  if (!scan || scan.status !== "done") return "";
  const date = new Date(scan.finishedAt || scan.createdAt).toLocaleDateString("fr-FR");
  const lines = [`## Réseaux sociaux — posts qui sur-performent dans la niche (relevés le ${date})`];
  scan.posts.slice(0, max).forEach((p) => lines.push(`- ${postLine(p)}`));
  if (scan.clusters?.length) {
    lines.push("## Tendances détectées sur les réseaux");
    scan.clusters.slice(0, 5).forEach((c) => lines.push(`- ${clusterLine(c)}`));
  }
  const ext = externalLines(scan.external);
  if (ext.length) {
    lines.push("## Sujets montants en France");
    ext.forEach((l) => lines.push(`- ${l}`));
  }
  return lines.join("\n");
}
