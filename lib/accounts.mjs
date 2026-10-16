// Analyse d'un compte (le sien ou un compte modèle) : relevé du profil et de ses dernières
// publications (Apify, ou l'API YouTube), calculs (lib/account-metrics.mjs), puis lecture par Claude.
//
// Même découpage que les scans, compatible avec la limite de 300 s de Vercel :
//   createAccountAnalysis  → lance les relevés en asynchrone (< 10 s)
//   advanceAccountAnalysis → appelé en boucle par l'interface : suit les relevés, puis calcule
//   (la lecture par Claude est une requête à part, lancée par l'interface ensuite)
import crypto from "node:crypto";
import { config } from "./env.mjs";
import { cacheGet, cacheSet, acquireLock, releaseLock } from "./store.mjs";
import { startRun, getRun, abortRun, datasetItems, isTerminal, accountInfo, hasApifyToken } from "./apify.mjs";
import { fetchWithTimeout } from "./sources.mjs";
import { computeAccountMetrics, VIEW_LABEL, engagementFormula, PERIODS, knownNumbers, unverifiedNumbers } from "./account-metrics.mjs";
import { coverImages } from "./social.mjs";
import { analyzeAccount, ACCOUNT_SUPPORTS } from "./claude.mjs";

export const ACCOUNT_PLATFORMS = ["instagram", "tiktok", "x", "linkedin", "youtube"];
export const ACCOUNT_LABELS = { instagram: "Instagram", tiktok: "TikTok", x: "X", linkedin: "LinkedIn", youtube: "YouTube" };

const DAY = 864e5;
const TTL = 400 * DAY; // une analyse reste consultable un an (et sert de point de croissance)
const FRESH_MS = 6 * 3.6e6; // même compte analysé il y a moins de 6 h : réutilisé sans frais
const HARD_DEADLINE_MS = 240 * 1000;
const MIN_CREDIT_USD = 0.1;
const MAX_POSTS = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const tagsFromText = (text) => [...String(text || "").matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// Ce que la personne colle : lien du profil, @nom ou nom
// ---------------------------------------------------------------------------

const RESERVED = {
  instagram: new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv"]),
  tiktok: new Set(["video", "photo", "tag", "music", "discover", "search", "foryou", "following"]),
  x: new Set(["home", "search", "explore", "i", "status", "hashtag", "intent", "share", "messages", "notifications", "settings", "login", "signup"]),
};

/**
 * @returns {{ platform, handle, key, url, kind? }} — handle tel qu'affiché, key stable (minuscules), url canonique.
 * Lève une erreur lisible si l'entrée ne désigne pas un profil.
 */
export function parseAccountInput(platform, input) {
  if (!ACCOUNT_PLATFORMS.includes(platform)) throw new Error("Choisis le réseau du compte à analyser.");
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Colle le lien du profil ou son @nom.");
  let url = null;
  try {
    url = /^https?:\/\//i.test(raw) ? new URL(raw) : /^(www\.)?[a-z0-9-]+\.(com|net)\//i.test(raw) ? new URL(`https://${raw}`) : null;
  } catch {
    throw new Error("Lien invalide : vérifie qu'il est complet.");
  }
  const parts = url ? url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s)) : [];
  const host = url ? url.hostname.replace(/^(www\.|m\.|mobile\.)/, "").toLowerCase() : "";
  const wrongSite = (expected) => url && !expected.some((h) => host === h || host.endsWith(`.${h}`));

  if (platform === "instagram") {
    if (wrongSite(["instagram.com"])) throw new Error("Ce lien n'est pas un lien Instagram.");
    const name = url ? parts[0] : raw.replace(/^@/, "");
    if (url && RESERVED.instagram.has(String(name).toLowerCase())) throw new Error("C'est le lien d'une publication : colle celui du profil (instagram.com/nom).");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(name || "")) throw new Error("Nom de compte Instagram invalide.");
    return { platform, handle: name, key: name.toLowerCase(), url: `https://www.instagram.com/${name}/` };
  }
  if (platform === "tiktok") {
    if (wrongSite(["tiktok.com"])) throw new Error("Ce lien n'est pas un lien TikTok.");
    const seg = url ? parts.find((p) => p.startsWith("@")) : raw;
    if (url && !seg) throw new Error("Colle le lien du profil TikTok (tiktok.com/@nom).");
    const name = String(seg || "").replace(/^@/, "");
    if (!/^[A-Za-z0-9._]{2,24}$/.test(name)) throw new Error("Nom de compte TikTok invalide.");
    return { platform, handle: name, key: name.toLowerCase(), url: `https://www.tiktok.com/@${name}` };
  }
  if (platform === "x") {
    if (wrongSite(["x.com", "twitter.com"])) throw new Error("Ce lien n'est pas un lien X.");
    const name = url ? parts[0] : raw.replace(/^@/, "");
    if (url && RESERVED.x.has(String(name).toLowerCase())) throw new Error("Colle le lien du profil X (x.com/nom).");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name || "")) throw new Error("Nom de compte X invalide.");
    return { platform, handle: name, key: name.toLowerCase(), url: `https://x.com/${name}` };
  }
  if (platform === "linkedin") {
    if (wrongSite(["linkedin.com"])) throw new Error("Ce lien n'est pas un lien LinkedIn.");
    const fromText = raw.match(/^(in|company)\/([^/?#]+)/i);
    const kindSeg = url ? parts[0] : fromText?.[1];
    const slug = url ? parts[1] : fromText?.[2];
    const kind = String(kindSeg || "").toLowerCase() === "company" ? "company" : String(kindSeg || "").toLowerCase() === "in" ? "person" : null;
    if (!kind || !slug) throw new Error("Colle le lien du profil (linkedin.com/in/nom) ou de la page (linkedin.com/company/nom).");
    if (!/^[\p{L}\p{N}_.%-]{2,100}$/u.test(slug)) throw new Error("Lien LinkedIn invalide.");
    const path = kind === "company" ? "company" : "in";
    return { platform, kind, handle: slug, key: `${kind}:${slug.toLowerCase()}`, url: `https://www.linkedin.com/${path}/${slug}/` };
  }
  // YouTube : @handle, /channel/UC…, /user/nom (anciens liens), /c/nom (non résolu sans recherche).
  if (wrongSite(["youtube.com", "youtu.be"])) throw new Error("Ce lien n'est pas un lien YouTube.");
  if (url && (parts[0] === "watch" || parts[0] === "shorts" || host === "youtu.be")) throw new Error("C'est le lien d'une vidéo : colle celui de la chaîne (youtube.com/@nom).");
  if (url && parts[0] === "channel" && /^UC[\w-]{22}$/.test(parts[1] || "")) {
    return { platform, channelId: parts[1], handle: parts[1], key: parts[1].toLowerCase(), url: `https://www.youtube.com/channel/${parts[1]}` };
  }
  if (url && parts[0] === "user" && parts[1]) {
    return { platform, username: parts[1], handle: parts[1], key: `user:${parts[1].toLowerCase()}`, url: `https://www.youtube.com/user/${parts[1]}` };
  }
  if (url && parts[0] === "c") throw new Error("Les anciens liens youtube.com/c/… ne sont pas pris en charge : colle le lien youtube.com/@nom de la chaîne.");
  const name = (url ? parts[0] : raw).replace(/^@/, "");
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(name || "")) throw new Error("Nom de chaîne YouTube invalide (il commence par @).");
  return { platform, handle: name, key: name.toLowerCase(), url: `https://www.youtube.com/@${name}` };
}

// ---------------------------------------------------------------------------
// YouTube : API officielle (clé gratuite, 3 unités de quota par analyse)
// ---------------------------------------------------------------------------

function isoDurationSecs(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
  return m ? Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0) : null;
}

async function youtubeGet(path, params) {
  const res = await fetchWithTimeout(`${config.youtubeBase}/${path}?${new URLSearchParams({ ...params, key: config.youtubeKey })}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || "";
    if (/quota/i.test(reason)) throw new Error("Quota de l'API YouTube épuisé pour aujourd'hui. Réessaie demain.");
    throw new Error(`API YouTube : ${data?.error?.message || `HTTP ${res.status}`}`);
  }
  return data;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Shorts : l'API n'a pas de champ dédié. La chaîne tient une playlist automatique de ses Shorts
// (« UUSH » + identifiant de chaîne sans « UC ») : c'est la source la plus fiable. À défaut, la règle
// publique de YouTube : 3 min maximum (60 s avant le 15/10/2024) et format carré ou vertical.
async function youtubeShortIds(channelId) {
  try {
    const items = (await youtubeGet("playlistItems", { part: "contentDetails", playlistId: `UUSH${channelId.slice(2)}`, maxResults: "50" })).items || [];
    return new Set(items.map((i) => i.contentDetails?.videoId).filter(Boolean));
  } catch {
    return null;
  }
}

function shortByRule(v, duration) {
  if (!isNum(duration)) return false;
  const limit = Date.parse(v.snippet?.publishedAt || 0) >= Date.parse("2024-10-15") ? 180 : 60;
  const w = Number(v.player?.embedWidth);
  const h = Number(v.player?.embedHeight);
  const vertical = w > 0 && h > 0 ? h >= w : null;
  return duration <= limit && vertical !== false && !v.liveStreamingDetails;
}

async function youtubeAccount(target) {
  if (!config.youtubeKey) throw new Error("Clé YouTube absente : ajoute YOUTUBE_API_KEY pour analyser une chaîne.");
  const params = { part: "snippet,statistics,contentDetails" };
  if (target.channelId) params.id = target.channelId;
  else if (target.username) params.forUsername = target.username;
  else params.forHandle = `@${target.handle}`;
  const ch = (await youtubeGet("channels", params)).items?.[0];
  if (!ch) throw Object.assign(new Error("Chaîne YouTube introuvable : vérifie le @nom."), { code: "not_found" });
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  const ids = uploads
    ? ((await youtubeGet("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "50" })).items || []).map((i) => i.contentDetails?.videoId).filter(Boolean)
    : [];
  const videos = ids.length
    ? (await youtubeGet("videos", { part: "snippet,statistics,contentDetails,liveStreamingDetails,player", maxWidth: "200", id: ids.join(",") })).items || []
    : [];
  const shortIds = await youtubeShortIds(ch.id);
  const kept = videos
    .filter((v) => (v.snippet?.liveBroadcastContent || "none") === "none" && !v.liveStreamingDetails)
    .sort((a, b) => Date.parse(b.snippet?.publishedAt || 0) - Date.parse(a.snippet?.publishedAt || 0))
    .slice(0, MAX_POSTS);
  const posts = kept.map((v) => {
    const s = v.statistics || {};
    const duration = isoDurationSecs(v.contentDetails?.duration);
    const short = shortIds ? shortIds.has(v.id) : shortByRule(v, duration);
    return {
      id: v.id,
      url: short ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
      createdAt: v.snippet?.publishedAt || null,
      text: [v.snippet?.title, v.snippet?.description].filter(Boolean).join("\n").slice(0, 1500),
      title: v.snippet?.title || "",
      type: short ? "short" : "long",
      pinned: false,
      own: true,
      views: num(s.viewCount),
      likes: num(s.likeCount),
      likesHidden: s.likeCount === undefined,
      comments: num(s.commentCount),
      shares: null,
      saves: null,
      duration,
      hashtags: tagsFromText(`${v.snippet?.title} ${v.snippet?.description}`),
      sound: null,
      cover: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || null,
    };
  });
  const st = ch.statistics || {};
  return {
    notes: [
      shortIds ? "Shorts repérés grâce à la playlist Shorts de la chaîne." : "Shorts repérés par la règle de YouTube (3 min maximum, format vertical ou carré) : la playlist Shorts de la chaîne n'était pas lisible.",
      "YouTube compte les vues dès le début de la lecture depuis le 24 août 2026 : une comparaison avec des chiffres plus anciens n'est pas homogène.",
    ],
    profile: {
      name: ch.snippet?.title || target.handle,
      handle: ch.snippet?.customUrl ? ch.snippet.customUrl.replace(/^@/, "") : target.handle,
      url: ch.snippet?.customUrl ? `https://www.youtube.com/${ch.snippet.customUrl.startsWith("@") ? ch.snippet.customUrl : `@${ch.snippet.customUrl}`}` : `https://www.youtube.com/channel/${ch.id}`,
      avatar: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || null,
      bio: ch.snippet?.description || "",
      followers: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
      followersHidden: Boolean(st.hiddenSubscriberCount),
      following: null,
      postsCount: num(st.videoCount),
      totalViews: num(st.viewCount),
      verified: null,
      category: null,
      externalUrl: null,
      createdAt: ch.snippet?.publishedAt || null,
    },
    posts,
  };
}

// ---------------------------------------------------------------------------
// Relevés Apify : un ou deux runs par réseau, puis conversion au format commun
// { id, url, createdAt, text, type, pinned, own, kind, views, likes, likesHidden, comments,
//   shares, saves, duration, hashtags[], sound{name, original}, reactions{}, cover, flags[] }
// ---------------------------------------------------------------------------

const accountError = (code, message) => Object.assign(new Error(message), { code });

// Réactions LinkedIn : libellés de l'interface française de LinkedIn.
export const LINKEDIN_REACTIONS = { LIKE: "J'aime", PRAISE: "Bravo", APPRECIATION: "Soutien", EMPATHY: "J'adore", INTEREST: "Instructif", ENTERTAINMENT: "Amusant" };

function mapInstagramPost(it, handle) {
  if (!it || it.error || !(it.shortCode || it.id)) return null;
  const isVideo = it.productType === "clips" || it.type === "Video";
  const type = it.productType === "clips" ? "reel" : it.type === "Sidecar" ? "carrousel" : it.type === "Video" ? "vidéo" : "image";
  const plays = num(it.videoPlayCount ?? it.igPlayCount);
  const likes = num(it.likesCount);
  const music = it.musicInfo || {};
  return {
    id: String(it.shortCode || it.id),
    url: it.url || (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : null),
    createdAt: iso(it.timestamp),
    text: it.caption || "",
    type,
    pinned: Boolean(it.isPinned),
    own: true,
    collab: Boolean(it.ownerUsername && String(it.ownerUsername).toLowerCase() !== handle),
    // Sur une photo ou un carrousel, 0 lecture veut dire « pas de compteur », pas « zéro ».
    views: isVideo && plays !== null && plays > 0 ? plays : null,
    likes: likes !== null && likes >= 0 ? likes : null,
    likesHidden: likes !== null && likes < 0,
    comments: num(it.commentsCount),
    shares: null,
    saves: null,
    duration: isVideo ? num(it.videoDuration) : null,
    hashtags: it.hashtags || tagsFromText(it.caption),
    sound: isVideo && (music.song_name || music.uses_original_audio)
      ? { name: music.uses_original_audio ? "Son original" : [music.song_name, music.artist_name].filter(Boolean).join(" · "), original: Boolean(music.uses_original_audio) }
      : null,
    cover: it.displayUrl || null,
    flags: it.paidPartnership ? ["sponsorisé"] : [],
  };
}

function mapTiktokPost(it) {
  if (!it || it.errorCode || !it.id) return null;
  const music = it.musicMeta || {};
  return {
    id: String(it.id),
    url: it.webVideoUrl || null,
    createdAt: it.createTimeISO || iso(it.createTime),
    text: it.text || "",
    type: it.isSlideshow ? "carrousel" : "vidéo",
    pinned: Boolean(it.isPinned),
    own: true,
    views: num(it.playCount),
    likes: num(it.diggCount),
    likesHidden: false,
    comments: num(it.commentCount),
    shares: num(it.shareCount),
    saves: num(it.collectCount),
    duration: it.isSlideshow ? null : num(it.videoMeta?.duration),
    hashtags: (it.hashtags || []).map((h) => h?.name).filter(Boolean),
    sound: music.musicName || music.musicOriginal
      ? { name: music.musicOriginal ? "Son original" : [music.musicName, music.musicAuthor].filter(Boolean).join(" · "), original: Boolean(music.musicOriginal) }
      : null,
    cover: it.videoMeta?.coverUrl || null,
    flags: it.isAd || it.isSponsored ? ["sponsorisé"] : [],
  };
}

function xMediaType(media) {
  const t = media?.[0]?.type;
  return t === "video" || t === "animated_gif" ? "vidéo" : t === "photo" ? "image" : "texte";
}

function mapXPost(it, handle) {
  // Deux sources : apidojo (offre payante) ou scraper_one (offre gratuite, sans type de post).
  const id = it?.id ?? it?.postId;
  if (!it || !id || it.noResults || it.type === "mock_tweet" || it.demo) return null;
  const text = it.fullText ?? it.text ?? it.postText ?? "";
  const media = it.extendedEntities?.media || it.media || [];
  const replyToSelf = it.isReply && String(it.inReplyToUsername || "").toLowerCase() === handle;
  const kind = it.isRetweet || /^RT @/.test(text) ? "retweet" : it.isReply ? (replyToSelf ? "fil" : "réponse") : it.isQuote ? "citation" : "original";
  const durMs = num(media?.[0]?.video_info?.duration_millis ?? media?.[0]?.durationMillis);
  return {
    id: String(id),
    url: it.url || it.twitterUrl || it.postUrl || null,
    createdAt: iso(it.createdAt ?? it.timestamp),
    text,
    type: xMediaType(media),
    pinned: Boolean(it.isPinned),
    // Les retweets portent les compteurs du post d'origine, les réponses à d'autres comptes ne sont pas des publications.
    own: kind === "original" || kind === "citation" || kind === "fil",
    kind,
    views: num(it.viewCount),
    likes: num(it.likeCount ?? it.favouriteCount),
    likesHidden: false,
    comments: num(it.replyCount),
    shares: (num(it.retweetCount ?? it.repostCount) || 0) + (num(it.quoteCount) || 0),
    saves: num(it.bookmarkCount),
    duration: durMs !== null ? durMs / 1000 : null,
    hashtags: it.entities?.hashtags?.map((h) => h.text) || tagsFromText(text),
    sound: null,
    cover: media?.[0]?.media_url_https || media?.[0]?.mediaUrlHttps || null,
    flags: [],
  };
}

function mapLinkedinPost(it) {
  if (!it || !(it.id || it.linkedinUrl) || it.type === "error") return null;
  const e = it.engagement || {};
  // Republication simple : l'item est le post d'origine (son auteur, ses compteurs), repris par le compte.
  const isRepost = Boolean(it.repostedBy);
  const isQuote = !isRepost && Boolean(it.repost);
  const type = it.postVideo ? "vidéo" : it.document ? "document" : it.postImages?.length > 1 ? "carrousel" : it.postImages?.length ? "image" : it.article ? "article" : "texte";
  const reactions = {};
  for (const r of e.reactions || []) if (r?.type && LINKEDIN_REACTIONS[r.type]) reactions[LINKEDIN_REACTIONS[r.type]] = num(r.count) || 0;
  return {
    id: String(it.id || it.linkedinUrl),
    url: it.linkedinUrl || null,
    createdAt: it.postedAt?.date || iso(it.postedAt?.timestamp),
    text: it.content || "",
    type,
    pinned: false,
    own: !isRepost,
    kind: isRepost ? "republication" : isQuote ? "citation" : "original",
    views: null,
    // engagement.likes compte toutes les réactions (J'aime, Bravo, Soutien…).
    likes: it.socialContent?.hideReactionsCount ? null : num(e.likes),
    likesHidden: Boolean(it.socialContent?.hideReactionsCount),
    comments: it.socialContent?.hideCommentsCount ? null : num(e.comments),
    shares: it.socialContent?.hideRepostsCount ? null : num(e.shares),
    saves: null,
    duration: null,
    hashtags: tagsFromText(it.content),
    sound: null,
    reactions: Object.keys(reactions).length ? reactions : null,
    cover: it.postImages?.[0]?.url || it.document?.coverPages?.[0]?.imageUrls?.[0] || it.postVideo?.thumbnailUrl || null,
    flags: [],
  };
}

const ADAPTERS = {
  instagram: {
    cost: 0.11,
    runs: (t) => [
      { name: "profile", actor: "apify/instagram-profile-scraper", input: { usernames: [t.handle] }, timeout: 90, maxCharge: 0.02 },
      { name: "posts", actor: "apify/instagram-post-scraper", input: { username: [t.handle], resultsLimit: MAX_POSTS, skipPinnedPosts: false, dataDetailLevel: "detailedData" }, timeout: 180, maxCharge: 0.15 },
    ],
    parse(items, t) {
      const p = (items.profile || []).find((x) => x && !x.error && x.username) || null;
      const pErr = (items.profile || []).find((x) => x?.error);
      if (!p && pErr?.error === "not_found") throw accountError("not_found", "Compte Instagram introuvable : vérifie le nom.");
      if (p?.private) throw accountError("private", "Ce compte Instagram est privé : seuls les comptes publics peuvent être analysés.");
      const posts = (items.posts || []).map((x) => mapInstagramPost(x, t.key)).filter(Boolean);
      if (!p && !posts.length) throw accountError("unavailable", "Instagram n'a renvoyé ni profil ni publication pour ce compte (compte introuvable, ou relevé bloqué). Réessaie plus tard.");
      return {
        profile: {
          name: p?.fullName || t.handle,
          handle: p?.username || t.handle,
          url: `https://www.instagram.com/${p?.username || t.handle}/`,
          avatar: p?.profilePicUrlHD || p?.profilePicUrl || null,
          bio: p?.biography || "",
          followers: num(p?.followersCount),
          following: num(p?.followsCount),
          postsCount: num(p?.postsCount),
          verified: p ? Boolean(p.verified) : null,
          category: p?.businessCategoryName || null,
          externalUrl: p?.externalUrl || null,
        },
        posts,
        notes: [
          "Lectures : le compteur public d'Instagram (videoPlayCount), celui qu'on voit sur la page Reels en navigation privée. Les photos et carrousels n'ont pas de compteur de vues : ils sont comparés entre eux sur leur engagement.",
          "Partages et enregistrements : Instagram ne les rend pas publics.",
        ],
      };
    },
  },
  tiktok: {
    cost: 0.12,
    runs: (t) => [
      {
        name: "posts",
        actor: "clockworks/free-tiktok-scraper",
        input: {
          profiles: [t.handle],
          profileScrapeSections: ["videos"],
          profileSorting: "latest",
          resultsPerPage: MAX_POSTS,
          excludePinnedPosts: false,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
          shouldDownloadSlideshowImages: false,
          shouldDownloadAvatars: false,
          shouldDownloadMusicCovers: false,
          downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
          commentsPerPost: 0,
          proxyCountryCode: "None",
        },
        timeout: 180,
        maxCharge: 0.16,
      },
    ],
    parse(items, t) {
      const list = items.posts || [];
      const err = list.find((x) => x?.errorCode);
      const posts = list.map(mapTiktokPost).filter(Boolean);
      if (!posts.length) {
        if (err?.errorCode === "PROFILE_PRIVATE") throw accountError("private", "Ce compte TikTok est privé : seuls les comptes publics peuvent être analysés.");
        if (err?.errorCode === "NOT_FOUND") throw accountError("not_found", "Compte TikTok introuvable : vérifie le nom.");
        throw accountError("empty", "Aucune vidéo publique trouvée sur ce compte TikTok.");
      }
      const a = list.find((x) => x?.authorMeta)?.authorMeta || {};
      return {
        profile: {
          name: a.nickName || a.name || t.handle,
          handle: a.name || t.handle,
          url: `https://www.tiktok.com/@${a.name || t.handle}`,
          avatar: a.avatar || a.originalAvatarUrl || null,
          bio: a.signature || "",
          followers: num(a.fans),
          following: num(a.following),
          postsCount: num(a.video),
          totalLikes: num(a.heart),
          verified: a.verified === undefined ? null : Boolean(a.verified),
          category: null,
          externalUrl: a.bioLink || null,
        },
        posts,
        notes: ["Vues : le compteur affiché par TikTok sous chaque vidéo (playCount). Partages et enregistrements sont publics sur TikTok et comptent dans l'engagement."],
      };
    },
  },
  x: {
    cost: 0.02,
    // L'actor le plus complet n'est utilisable qu'en offre payante ; repli sans type de post sinon.
    runs: (t, account) =>
      account?.free
        ? [{ name: "posts", actor: "scraper_one/x-profile-posts-scraper", input: { profileUrls: [`https://x.com/${t.handle}`], resultsLimit: MAX_POSTS, skipPinnedPosts: true }, timeout: 120, maxCharge: 0.05 }]
        : [{ name: "posts", actor: "apidojo/twitter-scraper-lite", input: { twitterHandles: [t.handle], sort: "Latest", maxItems: MAX_POSTS }, timeout: 120, maxCharge: 0.05 }],
    parse(items, t, run) {
      const list = items.posts || [];
      if (list.some((x) => x?.demo)) throw accountError("demo", "Le relevé X est passé en mode démonstration (offre Apify gratuite) : réessaie, ou passe à une offre payante.");
      const posts = list.map((x) => mapXPost(x, t.key)).filter(Boolean);
      if (!posts.length) throw accountError("empty", "Aucun post public trouvé sur ce compte X (compte introuvable, protégé ou vide).");
      const mine = list.find((x) => {
        const a = x?.author || {};
        return String(a.userName || a.screenName || "").toLowerCase() === t.key && !x.isRetweet;
      });
      const a = mine?.author || {};
      if (a.protected) throw accountError("private", "Ce compte X est protégé : seuls les comptes publics peuvent être analysés.");
      const basic = run?.actor === "scraper_one/x-profile-posts-scraper";
      return {
        profile: {
          name: a.name || t.handle,
          handle: a.userName || a.screenName || t.handle,
          url: `https://x.com/${a.userName || a.screenName || t.handle}`,
          avatar: (a.profilePicture || a.profileImageUrl || "").replace("_normal.", "_200x200.") || null,
          bio: a.description || "",
          followers: num(a.followers ?? a.followersCount),
          following: num(a.following ?? a.friendsCount),
          postsCount: num(a.statusesCount),
          verified: a.isVerified || a.isBlueVerified ? true : a.isVerified === undefined ? null : false,
          category: null,
          externalUrl: null,
        },
        posts,
        notes: [
          "Impressions : le compteur « Vues » affiché par X sous chaque post. Ce sont des affichages, pas des personnes différentes.",
          basic
            ? "Offre Apify gratuite : ce relevé ne distingue pas les réponses et les citations, et ne donne pas les signets. Les posts épinglés sont écartés à la source."
            : "Les retweets et les réponses à d'autres comptes sont comptés à part : ce ne sont pas des publications du compte.",
        ],
      };
    },
  },
  linkedin: {
    cost: 0.09,
    runs: (t) => [
      {
        name: "posts",
        actor: "harvestapi/linkedin-profile-posts",
        input: { targetUrls: [t.url], maxPosts: MAX_POSTS, includeReposts: true, includeQuotePosts: true, scrapeReactions: false, scrapeComments: false },
        timeout: 180,
        maxCharge: 0.12,
      },
      t.kind === "company"
        ? { name: "profile", actor: "harvestapi/linkedin-company", input: { companies: [t.url] }, timeout: 90, maxCharge: 0.02 }
        : { name: "profile", actor: "harvestapi/linkedin-profile-scraper", input: { urls: [t.url], profileScraperMode: "Profile details no email ($4 per 1k)" }, timeout: 90, maxCharge: 0.02 },
    ],
    parse(items, t) {
      const posts = (items.posts || []).map(mapLinkedinPost).filter(Boolean);
      const p = (items.profile || []).find((x) => x && !x.error && (x.followerCount !== undefined || x.name || x.firstName)) || null;
      if (!posts.length && !p) throw accountError("empty", "Aucune publication publique trouvée sur ce compte LinkedIn.");
      const author = (items.posts || []).find((x) => x?.author && !x.repostedBy)?.author || {};
      const name = p ? (t.kind === "company" ? p.name : [p.firstName, p.lastName].filter(Boolean).join(" ")) : author.name;
      return {
        profile: {
          name: name || t.handle,
          handle: t.handle,
          url: t.url,
          avatar: (t.kind === "company" ? p?.logo : p?.photo) || author.avatar?.url || null,
          bio: (t.kind === "company" ? p?.tagline || p?.description : p?.headline || p?.about) || author.info || "",
          followers: num(p?.followerCount),
          following: null,
          connections: num(p?.connectionsCount),
          postsCount: null,
          verified: p?.verified === undefined ? null : Boolean(p?.verified),
          category: t.kind === "company" ? "Page entreprise" : "Profil",
          externalUrl: p?.website || null,
        },
        posts,
        notes: [
          "LinkedIn ne rend publiques ni les vues ni les enregistrements : les publications sont comparées sur leur engagement (réactions + commentaires + republications).",
          "LinkedIn ne signale pas les posts épinglés dans ce relevé.",
          ...(p ? [] : ["Les informations du profil (abonnés) n'ont pas pu être relevées : l'engagement par abonné n'est pas calculé."]),
        ],
      };
    },
  },
};

// Coût indicatif d'une analyse (offre gratuite d'Apify, ~40 publications), affiché avant de lancer.
export const ACCOUNT_COST_USD = { instagram: ADAPTERS.instagram.cost, tiktok: ADAPTERS.tiktok.cost, x: ADAPTERS.x.cost, linkedin: ADAPTERS.linkedin.cost, youtube: 0 };

export function availableAccountPlatforms() {
  const apify = hasApifyToken();
  return { instagram: apify, tiktok: apify, x: apify, linkedin: apify, youtube: Boolean(config.youtubeKey) };
}

// ---------------------------------------------------------------------------
// Stockage : une analyse par clé, un index pour la liste, un historique par compte (croissance réelle)
// ---------------------------------------------------------------------------

const analysisKey = (id) => `acct-${id}`;
const INDEX_KEY = "acct-index";
const histKey = (platform, key) => `acct-hist-${hash(`${platform}:${key}`)}`;

export async function loadAccountAnalysis(id) {
  return id ? cacheGet(analysisKey(id), TTL) : null;
}

async function saveAnalysis(a) {
  await cacheSet(analysisKey(a.id), a, TTL);
}

// Ligne de l'index : ce que la liste des comptes affiche.
const indexRow = (a) => ({
  id: a.id,
  platform: a.platform,
  key: a.key,
  handle: a.profile?.handle || a.handle,
  name: a.profile?.name || a.handle,
  avatar: a.profile?.avatar || null,
  followers: a.profile?.followers ?? null,
  createdAt: a.createdAt,
  status: a.status,
});

async function updateIndex(a, { remove = false } = {}) {
  const list = (await cacheGet(INDEX_KEY, TTL).catch(() => null)) || [];
  const next = list.filter((r) => r.id !== a.id);
  if (!remove) next.unshift(indexRow(a));
  await cacheSet(INDEX_KEY, next.slice(0, 120), TTL);
}

export async function listAccountAnalyses() {
  return (await cacheGet(INDEX_KEY, TTL).catch(() => null)) || [];
}

export async function deleteAccountAnalysis(id) {
  const a = await loadAccountAnalysis(id);
  if (!a) return false;
  await updateIndex(a, { remove: true });
  // L'analyse sort de la liste ; son point de croissance aussi.
  const hk = histKey(a.platform, a.key);
  const hist = (await cacheGet(hk, TTL).catch(() => null)) || [];
  await cacheSet(hk, hist.filter((h) => h.id !== id), TTL);
  return true;
}

async function previousRunning(platform, key) {
  const list = await listAccountAnalyses();
  const prev = list.find((r) => r.platform === platform && r.key === key);
  if (!prev || Date.now() - Date.parse(prev.createdAt) >= FRESH_MS || !["running", "done"].includes(prev.status)) return null;
  return loadAccountAnalysis(prev.id);
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

/**
 * Lance l'analyse d'un compte. Réutilise une analyse du même compte de moins de 6 h, sauf `force`.
 */
export async function createAccountAnalysis({ platform, input, force = false }) {
  const target = parseAccountInput(platform, input);
  const avail = availableAccountPlatforms();
  if (!avail[platform]) {
    throw new Error(platform === "youtube"
      ? "Clé YouTube absente : ajoute YOUTUBE_API_KEY pour analyser une chaîne."
      : `Jeton Apify absent : ajoute APIFY_TOKEN pour analyser un compte ${ACCOUNT_LABELS[platform]}.`);
  }
  if (!force) {
    const prev = await previousRunning(platform, target.key);
    if (prev) return { ...prev, reused: true };
  }
  const a = {
    id: crypto.randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    platform,
    key: target.key,
    handle: target.handle,
    url: target.url,
    kind: target.kind || null,
    target,
    status: "running",
    runs: {},
    profile: null,
    posts: [],
    notes: [],
    metrics: null,
    insights: null,
    insightsError: null,
    error: null,
    costUsd: null,
    claude: null,
  };

  if (platform === "youtube") {
    try {
      const data = await youtubeAccount(target);
      await finalizeAnalysis(a, data);
    } catch (err) {
      a.status = "error";
      a.error = err.message;
      a.errorCode = err.code || null;
    }
    await saveAnalysis(a);
    await updateIndex(a);
    return a;
  }

  const account = await accountInfo().catch(() => null);
  if (account?.remainingUsd !== null && account?.remainingUsd !== undefined && account.remainingUsd < MIN_CREDIT_USD) {
    throw new Error(`Crédit Apify insuffisant pour une analyse (${account.remainingUsd.toFixed(2)} $ restants ce mois-ci).`);
  }
  a.account = account ? { plan: account.plan, free: account.free } : null;
  await Promise.all(
    ADAPTERS[platform].runs(target, account).map(async (r) => {
      try {
        const run = await startRun(r.actor, r.input, { timeout: r.timeout, maxCharge: r.maxCharge });
        a.runs[r.name] = { actor: r.actor, runId: run.id, datasetId: run.datasetId, status: run.status || "RUNNING" };
      } catch (err) {
        a.runs[r.name] = { actor: r.actor, status: "ERROR", error: err.message };
      }
    }),
  );
  if (Object.values(a.runs).every((r) => r.status === "ERROR")) {
    a.status = "error";
    a.error = Object.values(a.runs)[0]?.error || "Le relevé n'a pas pu démarrer.";
  }
  await saveAnalysis(a);
  await updateIndex(a);
  return a;
}

/** Fait avancer une analyse en cours (≈ budget secondes) ; un seul appel à la fois (verrou). */
export async function advanceAccountAnalysis(a, { budgetSecs = 18 } = {}) {
  if (!a || a.status !== "running") return a;
  const lockKey = `acct-${a.id}`;
  const locked = await acquireLock(lockKey, (budgetSecs + 60) * 1000).catch(() => true);
  if (!locked) {
    await sleep(2000);
    return (await loadAccountAnalysis(a.id)) || a;
  }
  try {
    const fresh = (await loadAccountAnalysis(a.id)) || a;
    return fresh.status === "running" ? await advanceLocked(fresh, budgetSecs) : fresh;
  } finally {
    await releaseLock(lockKey).catch(() => {});
  }
}

async function advanceLocked(a, budgetSecs) {
  const age = Date.now() - Date.parse(a.createdAt);
  const pending = Object.values(a.runs).filter((r) => r.runId && !isTerminal(r.status) && r.status !== "ERROR");
  const wait = Math.max(0, Math.min(budgetSecs, (HARD_DEADLINE_MS - age) / 1000));
  let pollErrors = 0;
  await Promise.all(
    pending.map(async (r) => {
      try {
        const st = await getRun(r.runId, wait);
        r.status = st.status || r.status;
        r.usageUsd = st.usageUsd;
        delete r.pollError;
      } catch (err) {
        r.pollError = err.message;
        pollErrors += 1;
      }
    }),
  );
  if (pending.length && pollErrors === pending.length) await sleep(3000);
  const still = Object.values(a.runs).filter((r) => r.runId && !isTerminal(r.status) && r.status !== "ERROR");
  if (still.length && Date.now() - Date.parse(a.createdAt) < HARD_DEADLINE_MS) {
    await saveAnalysis(a);
    return a;
  }
  // Délai dépassé : on arrête les retardataires et on garde ce qu'ils ont déjà relevé (et payé).
  await Promise.all(still.map(async (r) => {
    await abortRun(r.runId);
    r.status = "TIMED-OUT";
  }));
  const items = {};
  for (const [name, r] of Object.entries(a.runs)) {
    if (!r.datasetId) continue;
    try {
      items[name] = await datasetItems(r.datasetId, 120);
    } catch (err) {
      r.error = err.message;
    }
  }
  try {
    const postsRun = a.runs.posts;
    const data = ADAPTERS[a.platform].parse(items, a.target, postsRun);
    if (postsRun && postsRun.status !== "SUCCEEDED") data.notes = [...(data.notes || []), `Le relevé des publications s'est arrêté avant la fin (${postsRun.status}) : l'analyse porte sur ce qu'il a relevé.`];
    await finalizeAnalysis(a, data);
  } catch (err) {
    a.status = "error";
    a.error = err.message;
    a.errorCode = err.code || null;
  }
  a.costUsd = Math.round(Object.values(a.runs).reduce((s, r) => s + (Number(r.usageUsd) || 0), 0) * 1000) / 1000 || null;
  await saveAnalysis(a);
  await updateIndex(a);
  return a;
}

async function finalizeAnalysis(a, data) {
  const hk = histKey(a.platform, a.key);
  const hist = ((await cacheGet(hk, TTL).catch(() => null)) || []).filter((h) => h.id !== a.id);
  a.profile = data.profile;
  a.posts = data.posts.slice(0, 60);
  a.notes = data.notes || [];
  a.metrics = computeAccountMetrics({ platform: a.platform, profile: a.profile, posts: a.posts, now: Date.now(), history: hist });
  a.status = "done";
  a.finishedAt = new Date().toISOString();
  if (Number.isFinite(a.profile?.followers)) {
    hist.push({ id: a.id, at: a.finishedAt, followers: a.profile.followers, postsCount: a.profile.postsCount ?? null });
    await cacheSet(hk, hist.slice(-60), TTL).catch(() => {});
  }
}

/** Ce que l'interface reçoit d'une analyse (sans les données internes des runs). */
export function accountView(a) {
  if (!a) return null;
  return {
    id: a.id,
    createdAt: a.createdAt,
    finishedAt: a.finishedAt || null,
    status: a.status,
    reused: Boolean(a.reused),
    platform: a.platform,
    key: a.key,
    handle: a.handle,
    url: a.url,
    kind: a.kind,
    runs: Object.fromEntries(Object.entries(a.runs || {}).map(([k, r]) => [k, { status: r.status, error: r.error || null }])),
    error: a.error || null,
    errorCode: a.errorCode || null,
    profile: a.profile,
    notes: a.notes || [],
    metrics: a.metrics,
    insights: a.insights,
    insightsError: a.insightsError || null,
    costUsd: a.costUsd ?? null,
    claude: a.claude || null,
    formula: { engagement: engagementFormula(a.platform), views: VIEW_LABEL[a.platform] || "vues" },
  };
}

/** Historique des analyses d'un même compte (pour choisir une version et suivre l'évolution). */
export async function accountHistory(platform, key) {
  return (await listAccountAnalyses()).filter((r) => r.platform === platform && r.key === key);
}

// ---------------------------------------------------------------------------
// Lecture par Claude, puis contrôle : chaque constat doit s'appuyer sur un indicateur disponible ou
// sur des publications qui le prouvent ; un chiffre absent des données est signalé.
// ---------------------------------------------------------------------------

const fr = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "?" : Number(n).toLocaleString("fr-FR", { maximumFractionDigits: d }));
const frDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", year: "numeric" });
const PERIOD_LABEL = Object.fromEntries(PERIODS.map((p) => [p.key, p.label]));
const TYPE_LABEL = { reel: "Reel", vidéo: "vidéo", carrousel: "carrousel", image: "photo", short: "Short", long: "vidéo longue", texte: "texte", document: "document", article: "article" };

/** Indicateurs calculés, une ligne par clé : ce que Claude lit, et à quoi chaque constat doit se rattacher. */
export function indicatorLines(a) {
  const m = a.metrics;
  const lines = [];
  const c = m.cadence;
  lines.push(`[echantillon] ${m.sample.analysed} publications analysées${m.sample.accountPosts ? ` (le compte en a ${fr(m.sample.accountPosts)})` : ""}, dont ${m.sample.tooRecent} trop récentes pour être jugées ; ${m.sample.pinned} épinglée(s) et ${m.sample.notOwn} republication(s), retweet(s) ou réponse(s) écartées.`);
  if (c) {
    lines.push(`[frequence] ${c.posts} publications du ${frDate(c.from)} au ${frDate(c.to)} (${fr(c.spanDays, 1)} jours), soit environ ${fr(c.perWeek, 1)} par semaine ; écart médian ${fr(c.medianGapDays, 1)} jour(s) ; plus long silence ${fr(c.longestGap?.days, 1)} jours ; dernière publication il y a ${fr(c.lastPostDaysAgo, 1)} jour(s).`);
    lines.push(c.regularity ? `[regularite] ${c.regularity.label} (coefficient de variation des écarts ${fr(c.regularity.cv, 2)}).` : "[regularite] pas assez de publications pour juger la régularité.");
  }
  lines.push(`[mesures] ${m.groups.map((g) => `${g.label} : ${g.posts} publication(s), ${g.comparable} comparable(s)${g.median !== null ? `, médiane ${g.measure === "views" ? `de ${m.performance.views.label}` : "d'engagement"} ${fr(g.median)}, maximum ${fr(g.max)}` : ", trop peu pour une médiane"}`).join(" ; ")}.`);
  const e = m.engagement;
  lines.push(e.perFollower
    ? `[engagement] (${e.formula}) ÷ abonnés : médiane ${fr(e.perFollower.median, 2)} %, moyenne ${fr(e.perFollower.mean, 2)} % (${e.perFollower.n} publications)${e.perView ? ` ; ÷ ${m.performance.views.label} : médiane ${fr(e.perView.median, 2)} %` : ""}.`
    : "[engagement] nombre d'abonnés inconnu : pas d'engagement par abonné.");
  lines.push(`[formats] ${m.formats.map((f) => `${TYPE_LABEL[f.type] || f.type} ${f.count} (${f.share} %)${f.medianRatio !== null ? `, médiane ×${fr(f.medianRatio, 2)}` : ""}`).join(" ; ")}.`);
  if (m.durations) lines.push(`[durees] durée médiane ${fr(m.durations.medianSeconds)} s ; ${m.durations.buckets.map((b) => `${b.bucket} : ${b.count}${b.medianRatio !== null ? ` (médiane ×${fr(b.medianRatio, 2)})` : ""}`).join(" ; ")}.`);
  lines.push(`[hashtags] ${fr(m.hashtags.perPostMedian, 1)} par publication (médiane), ${m.hashtags.postsWithout} publication(s) sans hashtag${m.hashtags.top.length ? ` ; les plus utilisés : ${m.hashtags.top.map((t) => `#${t.tag} (${t.count})`).join(", ")}` : ""}.`);
  lines.push(`[legendes] longueur médiane ${fr(m.captions.medianLength)} caractères ; ${m.captions.withQuestion} légende(s) avec une question.`);
  if (m.sounds) lines.push(`[sons] ${m.sounds.original} son(s) original(aux), ${m.sounds.reused} son(s) repris${m.sounds.top.length ? ` ; repris plusieurs fois : ${m.sounds.top.map((t) => `${t.name} (${t.count})`).join(", ")}` : ""}.`);
  const slot = (list, label) => list.map((x) => `${label(x.key)} ${x.count}${x.medianRatio !== null ? ` (médiane ×${fr(x.medianRatio, 2)})` : ""}`).join(", ");
  lines.push(`[moments] heure de Paris. Jours : ${slot(m.timing.byDay, (k) => k)}. Moments : ${slot(m.timing.byPeriod, (k) => PERIOD_LABEL[k])}. ${m.timing.bestDay || m.timing.bestPeriod ? `Ressort : ${[m.timing.bestDay && `le ${m.timing.bestDay.key}`, m.timing.bestPeriod && PERIOD_LABEL[m.timing.bestPeriod.key]].filter(Boolean).join(" et ")}.` : `Aucun jour ni moment ne ressort (il faut au moins ${m.timing.minPerSlot} publications comparables par créneau et un écart net).`}`);
  lines.push(m.trend ? `[evolution] les ${m.trend.n} publications les plus récentes : médiane ×${fr(m.trend.recentMedianRatio, 2)} ; les ${m.trend.n} précédentes : ×${fr(m.trend.previousMedianRatio, 2)}.` : "[evolution] pas assez de publications comparables pour mesurer une évolution.");
  lines.push(m.growth ? `[croissance] abonnés : ${fr(m.growth.followersDelta)} en ${fr(m.growth.days, 1)} jours (${fr(m.growth.followersPct, 2)} %), entre deux analyses de l'outil.` : "[croissance] une seule analyse de ce compte : croissance inconnue.");
  if (m.specific?.reactions) lines.push(`[reactions] ${m.specific.reactions.map((r) => `${r.type} ${r.share} %`).join(", ")}.`);
  if (m.specific?.kinds) lines.push(`[types_x] ${Object.entries(m.specific.kinds).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  return lines.join("\n");
}

// Numérotation des publications pour Claude : celles du compte d'abord (plus récente en tête), épinglées à la fin.
function numbering(a) {
  const rows = (a.metrics?.posts || []).filter((p) => p.status !== "épinglé");
  const pinned = (a.metrics?.posts || []).filter((p) => p.status === "épinglé");
  return [...rows, ...pinned];
}

export function postLines(a) {
  const groups = Object.fromEntries((a.metrics?.groups || []).map((g) => [g.key, g]));
  return numbering(a)
    .map((p, i) => {
      const g = groups[p.group];
      const place = p.status === "épinglé"
        ? "épinglée"
        : p.ratio !== null
          ? `${p.status}, ×${fr(p.ratio, 2)} la médiane des ${g?.label || "publications"}`
          : p.status;
      const measures = [
        p.views !== null ? `${fr(p.views)} ${VIEW_LABEL[a.platform]}` : null,
        p.likes !== null ? `${fr(p.likes)} ${a.platform === "linkedin" ? "réactions" : "j'aime"}` : null,
        p.comments !== null ? `${fr(p.comments)} commentaires` : null,
        p.shares ? `${fr(p.shares)} partages` : null,
        p.saves ? `${fr(p.saves)} enregistrements` : null,
      ].filter(Boolean).join(", ");
      const dur = p.duration ? ` ${Math.round(p.duration)} s` : "";
      return `P${i + 1} [${TYPE_LABEL[p.type] || p.type || "publication"}${dur} · ${frDate(p.createdAt)} ${String(p.paris?.hour ?? "").padStart(2, "0")} h · ${place}] ${measures} — « ${p.text.slice(0, 300)} »${p.hashtags?.length ? ` ${p.hashtags.map((h) => `#${h}`).join(" ")}` : ""}${p.sound ? ` — son : ${p.sound.name}` : ""}`;
    })
    .join("\n");
}

function profileText(a) {
  const p = a.profile || {};
  return [
    `${p.name || a.handle} (@${p.handle || a.handle}) · ${ACCOUNT_LABELS[a.platform]}${a.kind === "company" ? " · page entreprise" : ""}`,
    p.followers !== null && p.followers !== undefined ? `Abonnés : ${fr(p.followers)}` : "Abonnés : inconnus",
    p.postsCount ? `Publications sur le compte : ${fr(p.postsCount)}` : null,
    p.category ? `Catégorie : ${p.category}` : null,
    p.bio ? `Bio : ${String(p.bio).slice(0, 400)}` : null,
  ].filter(Boolean).join("\n");
}

// Un indicateur ne peut fonder un constat que s'il a été calculé.
function supportAvailable(key, m) {
  switch (key) {
    case "regularite": return Boolean(m.cadence?.regularity);
    case "engagement": return Boolean(m.engagement?.perFollower || m.engagement?.perView);
    case "durees": return Boolean(m.durations);
    case "sons": return Boolean(m.sounds);
    case "moments": return Boolean(m.timing?.bestDay || m.timing?.bestPeriod);
    case "evolution": return Boolean(m.trend);
    case "croissance": return Boolean(m.growth);
    case "reactions": return Boolean(m.specific?.reactions);
    case "types_x": return Boolean(m.specific?.kinds);
    case "frequence": return Boolean(m.cadence);
    default: return true;
  }
}

/** Valide la réponse de Claude contre les données ; renvoie l'analyse à afficher et ce qui a été écarté. */
export function validateInsights(out, a) {
  const m = a.metrics;
  const list = numbering(a);
  const known = knownNumbers(m, a.profile || {});
  const dropped = [];
  const post = (n) => list[n - 1] || null;
  const usable = (p) => p && p.status !== "épinglé" && p.status !== "trop récent";
  const refs = (ns, test = () => true) => [...new Set(ns || [])].map(post).filter((p) => usable(p) && test(p)).map((p) => p.id);
  const claim = (c, test, where) => {
    const posts = refs(c.publications, test);
    if (!ACCOUNT_SUPPORTS.includes(c.appui)) c.appui = "publications";
    if (c.appui === "publications" && !posts.length) {
      dropped.push({ where, texte: c.texte, raison: "aucune publication ne l'appuie" });
      return null;
    }
    if (c.appui !== "publications" && !supportAvailable(c.appui, m)) {
      dropped.push({ where, texte: c.texte, raison: `l'indicateur « ${c.appui} » n'est pas calculable avec ces données` });
      return null;
    }
    // Claude ne doit écrire aucun chiffre ; s'il en écrit un qui n'existe pas dans les données, le constat est écarté.
    const unverified = unverifiedNumbers(c.texte, known).map((x) => x.text);
    if (unverified.length) {
      dropped.push({ where, texte: c.texte, raison: `chiffre absent des données (${unverified.join(", ")})` });
      return null;
    }
    return { texte: c.texte, appui: c.appui, posts, ...(c.priorite ? { priorite: c.priorite } : {}) };
  };
  const claims = (arr, test, where) => (arr || []).map((c) => claim(c, test, where)).filter(Boolean);
  const above = (p) => p.ratio !== null && p.ratio >= 1.2;
  const below = (p) => p.ratio !== null && p.ratio <= 0.8;
  const captions = list.map((p) => String(p.text || "").toLowerCase());
  return {
    createdAt: new Date().toISOString(),
    positionnement: out.positionnement,
    themes: (out.themes || []).map((t) => ({ nom: t.nom, posts: refs(t.publications) })).filter((t) => t.nom),
    marche: claims(out.ce_qui_marche, above, "ce qui marche"),
    marcheMoins: claims(out.ce_qui_marche_moins, below, "ce qui marche moins"),
    accroches: (out.accroches || [])
      .map((h) => ({ type: h.type, post: usable(post(h.publication)) ? post(h.publication).id : null, pourquoi: h.pourquoi }))
      .filter((h) => h.post),
    swot: {
      forces: claims(out.forces, () => true, "forces"),
      faiblesses: claims(out.faiblesses, () => true, "faiblesses"),
      opportunites: claims(out.opportunites, () => true, "opportunités"),
      menaces: claims(out.menaces, () => true, "menaces"),
    },
    recommandations: claims(out.recommandations, () => true, "recommandations"),
    idees: (out.idees || []).map((i) => ({ ...i, inspiree_de: refs(i.inspiree_de, (p) => p.ratio !== null && p.ratio >= 1) })),
    voix: {
      resume: out.voix?.resume || "",
      // Une « expression récurrente » doit se lire telle quelle dans au moins une légende.
      expressions: (out.voix?.expressions || []).filter((x) => x && captions.some((t) => t.includes(String(x).toLowerCase()))).slice(0, 6),
    },
    controle: { ecartes: dropped.length, details: dropped },
  };
}

/** Lecture du compte par Claude (une à la fois par analyse). */
export async function accountInsights(a, { force = false, timeoutMs } = {}) {
  const lockKey = `acct-ins-${a.id}`;
  if (!(await acquireLock(lockKey, 300000).catch(() => true))) {
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      await sleep(3000);
      const s = await loadAccountAnalysis(a.id);
      if (s?.insights) return s;
      if (s?.insightsError) throw new Error(s.insightsError);
    }
    throw Object.assign(new Error("La lecture du compte est toujours en cours. Réessaie dans un instant."), { status: 409 });
  }
  const save = async (fields, usd) => {
    const fresh = (await loadAccountAnalysis(a.id)) || a;
    Object.assign(fresh, fields);
    if (usd) {
      const c = (fresh.claude ||= { costUsd: 0 });
      c.costUsd = Math.round(((c.costUsd || 0) + usd) * 10000) / 10000;
    }
    await saveAnalysis(fresh);
    return fresh;
  };
  try {
    let cur = (await loadAccountAnalysis(a.id)) || a;
    if (cur.status !== "done" || !cur.metrics) throw new Error("L'analyse du compte n'est pas terminée.");
    if (cur.insights && !force) return cur;
    if (cur.insightsError) cur = await save({ insightsError: null });
    if (!cur.metrics.posts.length) throw new Error("Aucune publication à lire.");
    let cost = 0;
    try {
      const list = numbering(cur);
      const nOf = new Map(list.map((p, i) => [p.id, i + 1]));
      const pick = [...(cur.metrics.top || []), ...(cur.metrics.flop || []).slice(0, 2), ...list.filter((p) => p.status !== "épinglé").slice(0, 3).map((p) => p.id)];
      const covers = [...new Set(pick)].map((id) => list.find((p) => p.id === id)).filter((p) => p?.cover).slice(0, 8);
      const imgs = await coverImages(covers.map((p) => ({ key: p.id, cover: p.cover })), 8);
      const out = await analyzeAccount({
        platformLabel: ACCOUNT_LABELS[cur.platform],
        profileText: profileText(cur),
        summaryText: indicatorLines(cur),
        postsText: postLines(cur),
        images: imgs.map((im) => ({ n: nOf.get(im.key), mediaType: im.mediaType, data: im.data })),
        timeoutMs,
        onUsage: (usd) => (cost += usd || 0),
      });
      return await save({ insights: { ...validateInsights(out, cur), images: imgs.length }, insightsError: null }, cost);
    } catch (err) {
      await save({ insightsError: err.message }, cost);
      throw err;
    }
  } finally {
    await releaseLock(lockKey).catch(() => {});
  }
}
