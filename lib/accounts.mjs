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
import { computeAccountMetrics, VIEW_LABEL, engagementFormula, PERIODS, writtenNumbers, median } from "./account-metrics.mjs";
import { coverImages } from "./social.mjs";
import { analyzeAccount, ACCOUNT_SUPPORTS } from "./claude.mjs";

export const ACCOUNT_PLATFORMS = ["instagram", "tiktok", "x", "linkedin", "youtube"];
export const ACCOUNT_LABELS = { instagram: "Instagram", tiktok: "TikTok", x: "X", linkedin: "LinkedIn", youtube: "YouTube" };

const DAY = 864e5;
const TTL = 400 * DAY; // une analyse reste consultable un an (et sert de point de croissance)
const FRESH_MS = 6 * 3.6e6; // même compte analysé il y a moins de 6 h : réutilisé sans frais
const HARD_DEADLINE_MS = 240 * 1000;
const READ_RETRY_MS = HARD_DEADLINE_MS + 10 * 60 * 1000; // relecture des données d'un relevé terminé
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
  let parts = [];
  try {
    parts = url ? url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s)) : [];
  } catch {
    throw new Error("Lien invalide : vérifie qu'il est complet.");
  }
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
  if (url && parts[0] === "channel") throw new Error("Lien de chaîne invalide : l'identifiant commence par UC (youtube.com/channel/UC…).");
  // Un lien vers autre chose qu'une chaîne (direct, playlist, recherche…) ne désigne pas un compte.
  if (url && !String(parts[0] || "").startsWith("@")) throw new Error("Ce lien ne mène pas à une chaîne : colle le lien youtube.com/@nom de la chaîne.");
  const name = (url ? parts[0] : raw).replace(/^@/, "");
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(name || "")) throw new Error("Nom de chaîne YouTube invalide (il commence par @).");
  return { platform, handle: name, key: name.toLowerCase(), url: `https://www.youtube.com/@${name}` };
}

// ---------------------------------------------------------------------------
// YouTube : API officielle (clé gratuite, 4 unités de quota par analyse)
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
    channelId: ch.id,
    profile: {
      name: ch.snippet?.title || target.handle,
      handle: ch.snippet?.customUrl ? ch.snippet.customUrl.replace(/^@/, "") : target.handle,
      url: ch.snippet?.customUrl ? `https://www.youtube.com/${ch.snippet.customUrl.startsWith("@") ? ch.snippet.customUrl : `@${ch.snippet.customUrl}`}` : `https://www.youtube.com/channel/${ch.id}`,
      avatar: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || null,
      bio: ch.snippet?.description || "",
      followers: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
      followersHidden: Boolean(st.hiddenSubscriberCount),
      // L'API arrondit les abonnés à 3 chiffres significatifs (1 234 567 → 1 230 000).
      followersRounded: !st.hiddenSubscriberCount && num(st.subscriberCount) >= 1000,
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
  // Un post signé d'un autre compte (republication sans marqueur) n'est pas une publication du compte.
  const author = String(it.author?.userName || it.author?.screenName || it.authorUsername || "").toLowerCase();
  const foreign = Boolean(author) && author !== handle;
  const kind = it.isRetweet || /^RT @/.test(text) || foreign ? "retweet" : it.isReply ? (replyToSelf ? "fil" : "réponse") : it.isQuote ? "citation" : "original";
  const views = num(it.viewCount);
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
    // 0 impression = compteur absent (posts d'avant les vues, ou relevé incomplet), pas « zéro ».
    views: views !== null && views > 0 ? views : null,
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

// Une analyse supprimée reste une « pierre tombale » : plus servie, plus listée, plus relancée.
export async function loadAccountAnalysis(id) {
  const a = id ? await cacheGet(analysisKey(id), TTL) : null;
  return a && a.status !== "deleted" ? a : null;
}

// Verrou bref, attendu quelques secondes : sérialise les lectures-écritures de l'index et de l'historique
// (deux analyses qui se terminent ensemble ne s'écrasent pas). Sans verrou au bout de l'attente, on
// écrit quand même : mieux vaut un risque de course rare qu'une analyse absente de la liste.
// Une panne du stockage (Redis injoignable, quota) n'est pas « verrou pris » : elle remonte tout de suite.
async function withLock(key, fn, { ttlMs = 15000, waitMs = 8000 } = {}) {
  const until = Date.now() + waitMs;
  let got = await acquireLock(key, ttlMs);
  while (!got && Date.now() < until) {
    await sleep(150);
    got = await acquireLock(key, ttlMs);
  }
  try {
    return await fn();
  } finally {
    if (got) await releaseLock(key).catch(() => {});
  }
}

async function saveAnalysis(a) {
  await cacheSet(analysisKey(a.id), a, TTL);
}

// Ligne de l'index : ce que la liste des comptes affiche.
const indexRow = (a) => ({
  id: a.id,
  platform: a.platform,
  key: a.key,
  // Ce qu'on a pu coller pour ce compte (sur YouTube, @nom ou lien de chaîne → identifiant de chaîne).
  inputKeys: [...new Set([a.inputKey, a.key].filter(Boolean))],
  scrapedAt: a.scrapedAt || null,
  handle: a.profile?.handle || a.handle,
  name: a.profile?.name || a.handle,
  avatar: a.profile?.avatar || null,
  followers: a.profile?.followers ?? null,
  createdAt: a.createdAt,
  status: a.status,
});

// Une lecture en échec n'écrit rien : une liste vide réécrite effacerait toutes les analyses.
async function updateIndex(a, { remove = false } = {}) {
  await withLock(`${INDEX_KEY}-lock`, async () => {
    const list = (await cacheGet(INDEX_KEY, TTL, { strict: true })) || [];
    const next = list.filter((r) => r.id !== a.id);
    if (!remove) next.unshift(indexRow(a));
    next.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
    await cacheSet(INDEX_KEY, next.slice(0, 120), TTL);
  }).catch((err) => console.error(`Index des comptes non mis à jour : ${err.message}`));
}

async function updateHistory(a, change) {
  const hk = histKey(a.platform, a.key);
  await withLock(`${hk}-lock`, async () => {
    const hist = (await cacheGet(hk, TTL, { strict: true })) || [];
    await cacheSet(hk, change(hist.filter((h) => h.id !== a.id)).slice(-60), TTL);
  }).catch((err) => console.error(`Historique du compte non mis à jour : ${err.message}`));
}

// Une lecture en échec remonte (« liste indisponible ») au lieu de passer pour une liste vide.
export async function listAccountAnalyses() {
  return (await cacheGet(INDEX_KEY, TTL, { strict: true })) || [];
}

export async function deleteAccountAnalysis(id) {
  return withLock(`acct-run-${id}`, () => deleteLocked(id), { ttlMs: 60000, waitMs: 45000 });
}

async function deleteLocked(id) {
  const a = await loadAccountAnalysis(id);
  if (!a) return false;
  // Relevés encore en cours arrêtés (plus de frais) ; l'analyse devient une pierre tombale, puis sort
  // de la liste, et son point de croissance aussi.
  await Promise.all(Object.values(a.runs || {}).filter((r) => r.runId && !isTerminal(r.status) && r.status !== "ERROR").map((r) => abortRun(r.runId)));
  await saveAnalysis({ id: a.id, platform: a.platform, key: a.key, createdAt: a.createdAt, status: "deleted" });
  await updateIndex(a, { remove: true });
  await updateHistory(a, (hist) => hist);
  return true;
}

const sameAccount = (r, platform, key) => r.platform === platform && (r.key === key || (r.inputKeys || []).includes(key));

async function previousRunning(platform, key) {
  const list = await listAccountAnalyses();
  const prev = list.find((r) => sameAccount(r, platform, key));
  if (!prev || Date.now() - Date.parse(prev.createdAt) >= FRESH_MS || !["running", "done"].includes(prev.status)) return null;
  return loadAccountAnalysis(prev.id);
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

/**
 * Lance l'analyse d'un compte. Réutilise une analyse du même compte de moins de 6 h, sauf `force` ;
 * un relevé déjà en cours est toujours repris, même avec `force` : jamais deux relevés payés en
 * parallèle pour un même compte (double clic, deux onglets). Un verrou par compte sérialise la décision.
 */
export async function createAccountAnalysis({ platform, input, force = false }) {
  const target = parseAccountInput(platform, input);
  const avail = availableAccountPlatforms();
  if (!avail[platform]) {
    throw new Error(platform === "youtube"
      ? "Clé YouTube absente : ajoute YOUTUBE_API_KEY pour analyser une chaîne."
      : `Jeton Apify absent : ajoute APIFY_TOKEN pour analyser un compte ${ACCOUNT_LABELS[platform]}.`);
  }
  return withLock(`acct-new-${hash(`${platform}:${target.key}`)}`, async () => {
    const prev = await previousRunning(platform, target.key);
    if (prev && (!force || prev.status === "running")) return { ...prev, reused: true };
    return startAccountAnalysis(platform, target);
  }, { ttlMs: 90000, waitMs: 30000 });
}

async function startAccountAnalysis(platform, target) {
  const a = {
    id: crypto.randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    platform,
    key: target.key,
    inputKey: target.key,
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
      // Une chaîne a plusieurs adresses (@nom, /channel/UC…, /user/…) : son identifiant fait foi.
      if (data.channelId) a.key = data.channelId.toLowerCase();
      await finalizeAnalysis(a, data, Date.now());
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
  // Enregistrée avant de dépenser : si le stockage ne répond pas, aucun relevé payé n'est lancé.
  await saveAnalysis(a);
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
  try {
    await saveAnalysis(a);
  } catch (err) {
    // Relevés lancés mais impossibles à suivre : on les arrête plutôt que de payer pour rien.
    await Promise.all(Object.values(a.runs).filter((r) => r.runId).map((r) => abortRun(r.runId)));
    throw err;
  }
  await updateIndex(a);
  return a;
}

/** Fait avancer une analyse en cours (≈ budget secondes) ; un seul appel à la fois (verrou). */
export async function advanceAccountAnalysis(a, { budgetSecs = 18 } = {}) {
  if (!a || a.status !== "running") return a;
  const lockKey = `acct-run-${a.id}`;
  const locked = await acquireLock(lockKey, (budgetSecs + 60) * 1000).catch(() => true);
  if (!locked) {
    await sleep(2000);
    return loadAccountAnalysis(a.id);
  }
  try {
    const fresh = await loadAccountAnalysis(a.id);
    if (!fresh) return null; // supprimée entre-temps
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
        r.finishedAt = st.finishedAt || null;
        r.runSecs = st.runSecs ?? null;
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
    if (await deleted(a.id)) return null;
    await saveAnalysis(a);
    return a;
  }
  // Délai dépassé : on arrête les retardataires et on garde ce qu'ils ont déjà relevé (et payé).
  await Promise.all(still.map(async (r) => {
    await abortRun(r.runId);
    r.status = "TIMED-OUT";
  }));
  const items = {};
  const unread = [];
  for (const [name, r] of Object.entries(a.runs)) {
    if (!r.datasetId) continue;
    try {
      items[name] = await datasetItems(r.datasetId, 120);
      delete r.readError;
    } catch (err) {
      r.readError = err.message;
      unread.push(name);
    }
  }
  // Données payées mais illisibles pour l'instant : on retente au prochain suivi plutôt que de conclure
  // à tort que le compte est vide (les jeux de données restent plusieurs jours chez Apify).
  if (unread.length && Date.now() - Date.parse(a.createdAt) < READ_RETRY_MS) {
    if (await deleted(a.id)) return null;
    await saveAnalysis(a);
    return a;
  }
  try {
    const postsRun = a.runs.posts;
    if (unread.includes("posts")) {
      throw accountError("unreadable", `Les publications relevées n'ont pas pu être lues (${postsRun.readError}). Réessaie : rien n'a été conclu sur ce compte.`);
    }
    // Relevé des publications en échec et vide : c'est le relevé qui a échoué, pas le compte qui est vide.
    if (postsRun && postsRun.status !== "SUCCEEDED" && !(items.posts || []).length) {
      throw accountError("scrape_failed", `Le relevé des publications a échoué (${postsRun.status}${postsRun.error ? ` : ${postsRun.error}` : ""}) : rien n'a été conclu sur ce compte. Réessaie plus tard.`);
    }
    const data = ADAPTERS[a.platform].parse(items, a.target, postsRun);
    if (postsRun && postsRun.status !== "SUCCEEDED") data.notes = [...(data.notes || []), `Le relevé des publications s'est arrêté avant la fin (${postsRun.status}) : l'analyse porte sur ce qu'il a relevé.`];
    await finalizeAnalysis(a, data, scrapedAt(a));
  } catch (err) {
    a.status = "error";
    a.error = err.message;
    a.errorCode = err.code || null;
  }
  a.costUsd = Math.round(Object.values(a.runs).reduce((s, r) => s + (Number(r.usageUsd) || 0), 0) * 1000) / 1000 || null;
  if (await deleted(a.id)) return null;
  await saveAnalysis(a);
  await updateIndex(a);
  return a;
}

// Supprimée pendant le suivi : rien n'est réécrit (ni l'analyse, ni l'index, ni l'historique).
async function deleted(id) {
  const raw = await cacheGet(analysisKey(id), TTL).catch(() => null);
  return raw?.status === "deleted";
}

// Moment du relevé : la fin des runs Apify, pas celle du calcul (l'interface peut revenir le lendemain ;
// les âges des publications et le point de croissance se mesurent au relevé).
function scrapedAt(a) {
  const runs = Object.values(a.runs || {});
  const ends = runs.map((r) => Date.parse(r.finishedAt)).filter(Number.isFinite);
  if (ends.length) return Math.max(...ends);
  const secs = runs.map((r) => Number(r.runSecs)).filter(Number.isFinite);
  return Date.parse(a.createdAt) + (secs.length ? Math.max(...secs) * 1000 : 0);
}

async function finalizeAnalysis(a, data, at) {
  const hk = histKey(a.platform, a.key);
  // Historique illisible (panne passagère) : pas de croissance cette fois (raison affichée), rien n'est effacé.
  const stored = await cacheGet(hk, TTL, { strict: true }).then((x) => x || [], () => null);
  const hist = stored ? stored.filter((h) => h.id !== a.id) : null;
  a.profile = data.profile;
  a.posts = data.posts.slice(0, 60);
  a.notes = data.notes || [];
  a.scrapedAt = new Date(at).toISOString();
  a.metrics = computeAccountMetrics({ platform: a.platform, profile: a.profile, posts: a.posts, now: at, history: hist });
  a.status = "done";
  a.finishedAt = new Date().toISOString();
  // Un point par analyse, même sans abonnés connus : la raison affichée ensuite reste exacte.
  const point = { id: a.id, at: a.scrapedAt, followers: Number.isFinite(a.profile?.followers) ? a.profile.followers : null, postsCount: a.profile?.postsCount ?? null };
  if (await deleted(a.id)) return;
  await updateHistory(a, (h) => [...h, point].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)));
}

/** Ce que l'interface reçoit d'une analyse (sans les données internes des runs). */
export function accountView(a) {
  if (!a) return null;
  return {
    id: a.id,
    createdAt: a.createdAt,
    finishedAt: a.finishedAt || null,
    scrapedAt: a.scrapedAt || null,
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
    formula: { engagement: a.metrics?.engagement?.formula || engagementFormula(a.platform), views: VIEW_LABEL[a.platform] || "vues" },
  };
}

/** Historique des analyses d'un même compte (pour choisir une version et suivre l'évolution). */
export async function accountHistory(platform, key) {
  // Secondaire : une liste indisponible n'empêche pas d'afficher l'analyse elle-même.
  return (await listAccountAnalyses().catch(() => [])).filter((r) => sameAccount(r, platform, key));
}

// ---------------------------------------------------------------------------
// Lecture par Claude, puis contrôle : chaque constat doit s'appuyer sur un indicateur disponible ou
// sur des publications qui le prouvent ; un chiffre absent des données est signalé.
// ---------------------------------------------------------------------------

const fr = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "?" : Number(n).toLocaleString("fr-FR", { maximumFractionDigits: d }));
// Pourcentage lisible même très petit : 4,75 % ; 0,0026 %.
const frPct = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "?" : n !== 0 && Math.abs(n) < 0.1 ? Number(n).toLocaleString("fr-FR", { maximumSignificantDigits: 2 }) : fr(n, 2));
const frDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", year: "numeric" });
const PERIOD_LABEL = Object.fromEntries(PERIODS.map((p) => [p.key, p.label]));
const TYPE_LABEL = { reel: "Reel", vidéo: "vidéo", carrousel: "carrousel", image: "photo", short: "Short", long: "vidéo longue", texte: "texte", document: "document", article: "article" };

export const ENGAGEMENT_REASON = {
  "no-followers": "nombre d'abonnés inconnu",
  "zero-followers": "le compte n'a aucun abonné",
  "no-mature": "aucune publication assez ancienne pour être jugée",
  hidden: "engagement masqué ou incomplet sur toutes les publications jugées",
};
const GROWTH_REASON = {
  "no-followers": "abonnés inconnus",
  first: "première analyse de ce compte",
  "history-unavailable": "historique illisible pour l'instant",
  "no-history-followers": "les analyses précédentes n'ont pas relevé les abonnés",
  "too-close": "analyses à moins de 12 h d'écart",
  "below-precision": "variation plus petite que l'arrondi des abonnés de YouTube",
};
// Analyses d'avant la correction : un seul engagement par vue, sans famille.
const perViewList = (e) => (Array.isArray(e.perView) ? e.perView : e.perView ? [{ label: "toutes", ...e.perView }] : []);

/** Indicateurs calculés, une ligne par clé : ce que Claude lit, et à quoi chaque constat doit se rattacher. */
export function indicatorLines(a) {
  const m = a.metrics;
  const lines = [];
  const c = m.cadence;
  lines.push(`[echantillon] ${m.sample.analysed} publications analysées${m.sample.accountPosts ? ` (le compte en a ${fr(m.sample.accountPosts)})` : ""}, dont ${m.sample.tooRecent} trop récentes pour être jugées ; ${m.sample.pinned} épinglée(s) et ${m.sample.notOwn} republication(s), retweet(s) ou réponse(s) écartées.`);
  if (c) {
    lines.push(`[frequence] ${c.posts} publications du ${frDate(c.from)} au ${frDate(c.to)} (${fr(c.spanDays, 1)} jours), soit environ ${fr(c.perWeek, 1)} par semaine ; écart médian ${fr(c.medianGapDays, 1)} jour(s) ; plus long silence ${fr(c.longestGap?.days, 1)} jours ; dernière publication il y a ${fr(c.lastPostDaysAgo, 1)} jour(s)${c.dormant ? " : compte à l'arrêt, ce rythme décrit une période passée, ne le présente pas comme actuel" : ""}.`);
    lines.push(c.regularity ? `[regularite] ${c.regularity.label} (coefficient de variation des écarts ${fr(c.regularity.cv, 2)}).` : "[regularite] pas assez de publications pour juger la régularité.");
  }
  lines.push(`[mesures] ${m.groups.map((g) => `${g.label} : ${g.posts} publication(s), ${g.comparable} comparable(s)${g.median !== null ? `, médiane ${g.measure === "views" ? `de ${m.performance.views.label}` : "d'engagement"} ${fr(g.median)}, maximum ${fr(g.max)}` : ", trop peu pour une médiane"}`).join(" ; ")}.`);
  const e = m.engagement;
  lines.push(e.perFollower
    ? `[engagement] (${e.formula}) ÷ abonnés : médiane ${frPct(e.perFollower.median)} %, moyenne ${frPct(e.perFollower.mean)} % (${e.perFollower.n} publications)${perViewList(e).map((v) => ` ; ÷ ${m.performance.views.label} (${v.label}) : médiane ${frPct(v.median)} %`).join("")}.`
    : `[engagement] pas d'engagement par abonné : ${ENGAGEMENT_REASON[e.reason] || "non calculable"}.`);
  lines.push(`[formats] ${m.formats.map((f) => `${TYPE_LABEL[f.type] || f.type} ${f.count} (${f.share} %)${f.medianRatio !== null ? `, médiane ×${fr(f.medianRatio, 2)}` : ""}`).join(" ; ")}.`);
  if (m.durations) lines.push(`[durees] durée médiane ${fr(m.durations.medianSeconds)} s ; ${m.durations.buckets.map((b) => `${b.bucket} : ${b.count}${b.medianRatio !== null ? ` (médiane ×${fr(b.medianRatio, 2)})` : ""}`).join(" ; ")}.`);
  lines.push(`[hashtags] ${fr(m.hashtags.perPostMedian, 1)} par publication (médiane), ${m.hashtags.postsWithout} publication(s) sans hashtag${m.hashtags.top.length ? ` ; les plus utilisés : ${m.hashtags.top.map((t) => `#${t.tag} (${t.count})`).join(", ")}` : ""}.`);
  lines.push(`[legendes] ${m.captions.source === "titre" ? "titres" : "légendes"} (liens retirés) : longueur médiane ${fr(m.captions.medianLength)} caractères ; ${m.captions.withQuestion} sur ${m.captions.posts} avec une question.`);
  if (m.sounds) lines.push(`[sons] ${m.sounds.original} son(s) original(aux), ${m.sounds.reused} son(s) repris${m.sounds.top.length ? ` ; repris plusieurs fois : ${m.sounds.top.map((t) => `${t.name} (${t.count})`).join(", ")}` : ""}.`);
  const slot = (list, label) => list.map((x) => `${label(x.key)} ${x.count}${x.medianRatio !== null ? ` (médiane ×${fr(x.medianRatio, 2)})` : ""}`).join(", ");
  lines.push(`[moments] heure de Paris. Jours : ${slot(m.timing.byDay, (k) => k)}. Moments : ${slot(m.timing.byPeriod, (k) => PERIOD_LABEL[k])}. ${m.timing.bestDay || m.timing.bestPeriod ? `Ressort : ${[m.timing.bestDay && `le ${m.timing.bestDay.key}`, m.timing.bestPeriod && PERIOD_LABEL[m.timing.bestPeriod.key]].filter(Boolean).join(" et ")}.` : `Aucun jour ni moment ne ressort : n'en parle pas (il faut au moins ${m.timing.minBestSlot} publications comparables dans le créneau, trois créneaux mesurés et un écart net).`}`);
  lines.push(m.trend
    ? `[evolution] les ${m.trend.n} publications récentes (âge médian ${fr(m.trend.recentMedianAgeDays, 1)} j) : médiane ×${fr(m.trend.recentMedianRatio, 2)} ; les ${m.trend.n} précédentes (âge médian ${fr(m.trend.previousMedianAgeDays, 1)} j) : ×${fr(m.trend.previousMedianRatio, 2)}. Les plus anciennes ont eu plus de temps pour accumuler.`
    : "[evolution] pas assez de publications comparables assez anciennes pour mesurer une évolution : n'en parle pas.");
  lines.push(m.growth
    ? `[croissance] abonnés : ${m.growth.approximate ? "environ " : ""}${fr(m.growth.followersDelta)} en ${fr(m.growth.days, 1)} jours (${fr(m.growth.followersPct, 2)} %), entre deux analyses de l'outil${m.growth.approximate ? ` (YouTube arrondit les abonnés à ${fr(m.growth.precision)} près)` : ""}.`
    : `[croissance] non mesurée (${GROWTH_REASON[m.growthNote?.reason] || "pas deux analyses comparables de ce compte"}) : n'en parle pas.`);
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

// Un indicateur ne peut fonder un constat que s'il a été calculé, avec de quoi comparer.
function supportAvailable(key, m) {
  const measured = (list) => (list || []).filter((x) => x.medianRatio !== null && x.medianRatio !== undefined).length;
  switch (key) {
    // Compte à l'arrêt : son rythme passé ne fonde aucun constat sur le présent.
    case "frequence": return Boolean(m.cadence?.perWeek !== null && m.cadence?.perWeek !== undefined && !m.cadence?.dormant);
    case "regularite": return Boolean(m.cadence?.regularity && !m.cadence?.dormant);
    case "engagement": return Boolean(m.engagement?.perFollower || perViewList(m.engagement || {}).length);
    case "mesures": return (m.groups || []).some((g) => g.median !== null);
    case "formats": return measured(m.formats) >= 2;
    case "durees": return measured(m.durations?.buckets) >= 2;
    case "hashtags": return measured(m.hashtags?.top) >= 1;
    case "legendes": return m.captions?.medianLength !== null && (m.captions?.posts || 0) >= 6;
    case "sons": return Boolean(m.sounds?.withSound);
    case "moments": return Boolean(m.timing?.bestDay || m.timing?.bestPeriod);
    case "evolution": return Boolean(m.trend);
    case "croissance": return Boolean(m.growth);
    case "reactions": return Boolean(m.specific?.reactions);
    case "types_x": return Boolean(m.specific?.kinds);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Ce qu'un texte affirme sans chiffre : un jour ou un moment, une croissance d'abonnés, une évolution,
// un format qui marche. Chaque affirmation doit correspondre à ce que les calculs trouvent ; sinon le
// texte est écarté (et listé). Mieux vaut écarter une phrase juste de temps en temps que montrer une
// phrase fausse.
// ---------------------------------------------------------------------------

const re = (alts, flags = "iu") => new RegExp(`(?<![\\p{L}])(?:${alts})(?![\\p{L}])`, flags);
const stems = (alts) => new RegExp(`(?<![\\p{L}])(?:${alts})`, "iu");

// Un but (« pour attirer de nouveaux abonnés, … ») n'est pas un constat sur les données.
const PURPOSE_RE = /(?<![\p{L}])(?:pour|afin de|afin d')\s*(?:[\p{L}']+\s+){0,2}?[\p{L}]+(?:er|ir|re)(?![\p{L}])[^.,;:!?]*/giu;
const claimPart = (t) => String(t || "").replace(PURPOSE_RE, " ");

// Jours et moments : ce qu'ils désignent.
const DAY_RE = /(?<![\p{L}])(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)s?(?![\p{L}])/giu;
const DAY_GROUPS = [
  [re("en semaine|jours? ouvrés|jours? de semaine"), ["lundi", "mardi", "mercredi", "jeudi", "vendredi"]],
  [re("début de semaine"), ["lundi", "mardi"]],
  [re("milieu de semaine"), ["mardi", "mercredi", "jeudi"]],
  [re("fin de semaine"), ["vendredi", "samedi", "dimanche"]],
  [re("week-ends?|weekends?"), ["samedi", "dimanche"]],
];
const PERIOD_GROUPS = [
  [re("après-midi|midi|heure du déjeuner|déjeuner"), ["après-midi"]],
  [re("matin|matins|matinée|matinées|tôt|petit-déjeuner"), ["matin"]],
  [re("soir|soirs|soirée|soirées|tard|en fin de journée|fin de journée"), ["soir"]],
  [re("la nuit|de nuit|nuits|nocturnes?"), ["nuit"]],
  [re("en journée|dans la journée|la journée"), ["matin", "après-midi"]],
];
const SLOT_WORDS = re("heures? de publication|horaires?|créneaux?|moments? de publication|meilleurs? moments?|jours? de publication|meilleurs? jours?|à quelle heure|quand publier|quand poster");
// Un jour ou un moment n'est une affirmation sur les données que dans un contexte de publication ou de
// performance (« Routine du matin » est un thème, pas un créneau).
const TIMING_CONTEXT = stems("publi|post|poste|sort|mis en ligne|mise en ligne|diffus|march|perform|vues|lectures|impressions|engagement|meilleur|mieux|pire|mauvais|faible|creux|évit|résultat|réaction|portée|cartonn|fonctionn|touche|atteint|jour |jours |créneau|moment");
const NEGATIVE = stems("évit|moins|mauvais|pire|faible|en dessous|à proscrire|jamais|n'est pas|ne marche pas|ne fonctionne pas|peu de");

// Croissance des abonnés.
const AUDIENCE = re("abonnés?|abonnées?|followers?|communauté|audience|fans?|base d'abonnés");
const GAIN = stems("augment|grimp|grandi|agrandi|élargi|gross|explos|progress|gagn|attir|croiss|croît|décoll|envol|de plus en plus|en hausse|nouveaux? abonnés|nouvelles? abonnées");
const LOSS = stems("chut|baiss|diminu|fond|recul|perd|perte|de moins en moins|en baisse|désabonn|s'effrit|s'érod");
const FLAT = stems("stagn|stable|plafonn");
const ACCOUNT_GROWTH = re("croissance du compte|compte en croissance|compte en pleine croissance|sa croissance|croissance de son compte|croissance de la chaîne|chaîne en croissance");

// Évolution des performances dans le temps.
const UP = stems("augment|hausse|grimp|amélior|progress|s'envol|explos|de plus en plus|repart|décoll|remont");
const DOWN = stems("baiss|chut|diminu|ralenti|fléchi|s'effondr|dégrad|de moins en moins|en recul|recule|décli|s'essouffl|essouffl|perte de vitesse|s'érod|plong");
const TEMPORAL = stems("depuis|récemment|récent|dernièr|derniers|ces semaines|ce mois|en ce moment|actuellement|aujourd'hui|maintenant|tendance|évolution|au fil|peu à peu|progressivement|de plus en plus|de moins en moins|ralenti|s'essouffl|essouffl|repart|décoll|remont|en hausse|en baisse|en recul|perte de vitesse");

// Formats nommés dans un texte, et les types de publication qu'ils désignent.
const FORMAT_WORDS = [
  [re("vidéos? longues?|longs? formats?"), ["long"]],
  [re("shorts?"), ["short"]],
  [re("reels?"), ["reel", "vidéo"]],
  [re("carrousels?|diaporamas?"), ["carrousel"]],
  [re("photos?|images?"), ["image"]],
  [re("documents?|pdf"), ["document"]],
  [re("articles?"), ["article"]],
  [re("posts? texte|textes? seuls?"), ["texte"]],
  [re("vidéos?"), ["vidéo", "reel", "short", "long"]],
];
const FORMAT_TALK = stems("format|que les|plutôt que|mieux que|plus que|moins que|surpass|devant les|par rapport aux|face aux");

function mentionedDays(t) {
  const out = new Set([...t.matchAll(DAY_RE)].map((x) => x[1].toLowerCase()));
  const groups = DAY_GROUPS.filter(([r]) => r.test(t)).map(([, days]) => days);
  return { days: [...out], groups };
}

// Raison d'écarter ce que dit un texte, ou null.
//   numbers : refuser tout nombre écrit ; timing / growth / trend : vérifier ces sujets ;
//   sense : « positive » ou « negative » (section qui affirme ce qui marche, ou ce qui marche moins).
function textProblem(text, m, { numbers = true, timing = true, growth = true, trend = true, sense = null } = {}) {
  if (numbers) {
    const nums = writtenNumbers(text);
    if (nums.length) return `nombre écrit par Claude (${nums.join(", ")}) : les chiffres viennent uniquement des calculs`;
  }
  const t = claimPart(text);
  if (timing) {
    const { days, groups } = mentionedDays(t);
    const periods = PERIOD_GROUPS.filter(([r]) => r.test(t)).map(([, p]) => p);
    const named = days.length || groups.length || periods.length;
    if ((named && TIMING_CONTEXT.test(t)) || SLOT_WORDS.test(t)) {
      const bd = m.timing?.bestDay?.key;
      const bp = m.timing?.bestPeriod?.key;
      const best = [bd && `le ${bd}`, bp && PERIOD_LABEL[bp]].filter(Boolean).join(", ");
      if (!bd && !bp) return "parle d'un jour ou d'un moment alors qu'aucun ne ressort des publications";
      // Seul un créneau qui ressort par le haut est mesuré : jamais un « moins bon » jour.
      if (sense === "negative" || NEGATIVE.test(t)) return `présente un jour ou un moment comme moins bon : seul le créneau qui ressort par le haut est mesuré (${best})`;
      if (days.some((d) => d !== bd) || groups.some((g) => !g.includes(bd)) || periods.some((p) => !p.includes(bp))) {
        return `ne correspond pas au créneau qui ressort (${best})`;
      }
    }
  }
  if (growth && ((AUDIENCE.test(t) && (GAIN.test(t) || LOSS.test(t) || FLAT.test(t))) || ACCOUNT_GROWTH.test(t))) {
    const g = m.growth;
    if (!g) return "parle de la croissance des abonnés alors qu'elle n'est pas mesurée";
    const gain = GAIN.test(t) || ACCOUNT_GROWTH.test(t);
    const loss = LOSS.test(t);
    const flat = FLAT.test(t);
    if ((gain && !loss && g.followersDelta <= 0) || (loss && !gain && g.followersDelta >= 0) || (flat && Math.abs(g.followersPct ?? 0) >= 1)) {
      return "contredit la croissance mesurée entre les analyses";
    }
  }
  if (trend && (UP.test(t) || DOWN.test(t)) && TEMPORAL.test(t)) {
    if (!m.trend) return "parle d'une évolution alors qu'elle n'est pas mesurable avec ces publications";
    const up = UP.test(t);
    const down = DOWN.test(t);
    const pct = m.trend.changePct ?? 0;
    if (up === down) return "parle d'une évolution sans sens clair";
    if (Math.abs(pct) < 10) return `l'évolution mesurée (${pct > 0 ? "+" : ""}${pct} %) est trop faible pour parler de hausse ou de baisse`;
    if ((up && pct < 0) || (down && pct > 0)) return "contredit l'évolution mesurée";
  }
  return null;
}

// Un format nommé dans une comparaison doit être mesuré, et dans le bon sens.
function formatProblem(text, appui, m, sense) {
  const t = String(text || "");
  if (appui !== "formats" && !FORMAT_TALK.test(t)) return null;
  const words = [];
  for (const [r, types] of FORMAT_WORDS) {
    const hit = r.exec(t);
    if (hit && !words.some((w) => w.index === hit.index)) words.push({ index: hit.index, types });
  }
  if (!words.length) return appui === "formats" ? "ne nomme aucun format mesuré" : null;
  words.sort((a, b) => a.index - b.index);
  const measured = (types) => (m.formats || []).filter((f) => types.includes(f.type)).sort((a, b) => b.count - a.count)[0];
  const found = words.map((w) => measured(w.types));
  const ratios = found.map((f) => f?.medianRatio ?? null);
  if (ratios.some((r) => r === null)) return "nomme un format dont la performance n'est pas mesurée (trop peu de publications comparables)";
  // Chaque format est rapporté à la médiane de sa famille : des formats de familles différentes (Reels
  // sur leurs lectures, photos sur leur engagement) ne se comparent pas entre eux.
  if (found.length > 1 && found.some((f) => f.groups && !f.groups.some((g) => found[0].groups?.includes(g)))) {
    return "compare des formats qui ne sont pas mesurés de la même façon : la comparaison n'a pas de sens";
  }
  const [first, ...others] = ratios;
  // Une comparaison exige un écart réel : à égalité, aucun format ne « marche mieux ».
  if (sense === "positive" && (first < 1 || others.some((r) => r >= first))) return "le format présenté comme le meilleur ne l'est pas dans les mesures";
  if (sense === "negative" && (first > 1 || others.some((r) => r <= first))) return "le format présenté comme le moins bon ne l'est pas dans les mesures";
  return null;
}

// Un hashtag cité doit être mesuré, dans le bon sens ; une durée aussi.
function measureProblem(text, appui, m, sense) {
  const t = String(text || "");
  for (const [, tag] of t.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const h = (m.hashtags?.top || []).find((x) => x.tag === tag.toLowerCase());
    if (!h || h.medianRatio === null) return `cite #${tag}, dont la performance n'est pas mesurée`;
    if ((sense === "positive" && h.medianRatio < 1) || (sense === "negative" && h.medianRatio > 1)) return `contredit la mesure de #${tag}`;
  }
  if (appui === "durees" && sense) {
    const b = m.durations?.buckets || [];
    const SHORT = ["moins de 15 s", "15 à 30 s", "30 à 60 s"];
    const val = (list) => median(list.map((x) => x.medianRatio).filter((x) => x !== null));
    const shortR = val(b.filter((x) => SHORT.includes(x.bucket)));
    const longR = val(b.filter((x) => !SHORT.includes(x.bucket)));
    const saysShort = stems("court|brève|bref").test(t);
    const saysLong = stems("long").test(t);
    if (shortR === null || longR === null) return "compare des durées qui ne sont pas toutes mesurées";
    const shortWins = shortR > longR;
    if ((saysShort && !saysLong && (sense === "positive") !== shortWins) || (saysLong && !saysShort && (sense === "positive") === shortWins)) {
      return "contredit la mesure des durées";
    }
  }
  return null;
}

// Phrases d'un paragraphe ; une phrase qui pose problème est retirée, le reste est gardé.
const sentences = (text) => String(text || "").match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((x) => x.trim()).filter(Boolean) || [];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Valide la réponse de Claude contre les données ; renvoie l'analyse à afficher et ce qui a été écarté. */
export function validateInsights(out, a) {
  const m = a.metrics;
  const list = numbering(a);
  const dropped = [];
  const drop = (where, texte, raison) => {
    dropped.push({ where, texte: String(texte || "").slice(0, 300), raison });
    return null;
  };
  const post = (n) => list[n - 1] || null;
  const usable = (p) => p && p.status !== "épinglé" && p.status !== "trop récent";
  const refs = (ns, test = () => true) => [...new Set(Array.isArray(ns) ? ns : [])].map(post).filter((p) => usable(p) && test(p)).map((p) => p.id);
  const isUp = (p) => p.status === "au-dessus";
  const isDown = (p) => p.status === "en dessous";
  const notDown = (p) => p.ratio !== null && p.ratio >= 1;
  const arr = (x) => (Array.isArray(x) ? x : []);
  const str = (x) => (typeof x === "string" ? x.trim() : "");

  // proof : statut exigé des publications citées ; required : au moins une publication de ce statut,
  // quel que soit l'appui ; sense : ce que la section affirme (ce qui marche, ou ce qui marche moins).
  const claim = (c, where, { proof = () => true, required = false, sense = null } = {}) => {
    const texte = str(c?.texte);
    if (!texte) return null;
    const posts = refs(c.publications, proof);
    const appui = ACCOUNT_SUPPORTS.includes(c.appui) ? c.appui : "publications";
    if (appui !== "publications" && !supportAvailable(appui, m)) {
      return drop(where, texte, `l'indicateur « ${appui} » n'est pas calculable avec ces données`);
    }
    if ((required || appui === "publications") && !posts.length) {
      return drop(where, texte, required ? `aucune publication ${sense === "negative" ? "en dessous" : "au-dessus"} de sa médiane ne l'appuie` : "aucune publication ne l'appuie");
    }
    const problem = textProblem(texte, m, { sense }) || formatProblem(texte, appui, m, sense) || measureProblem(texte, appui, m, sense);
    if (problem) return drop(where, texte, problem);
    return { texte, appui, posts, ...(c.priorite ? { priorite: c.priorite } : {}) };
  };
  const claims = (list_, where, opts) => arr(list_).map((c) => claim(c, where, opts)).filter(Boolean);

  // Paragraphes : chaque phrase est vérifiée ; celles qui posent problème sont retirées.
  const paragraph = (text, where) =>
    sentences(str(text))
      .filter((x) => {
        const problem = textProblem(x, m) || formatProblem(x, null, m, null) || measureProblem(x, null, m, null);
        if (problem) drop(where, x, problem);
        return !problem;
      })
      .join(" ");

  // Thèmes : des étiquettes de sujet. Pas de nombre, et des publications de ce thème citées.
  const themes = arr(out.themes)
    .map((t) => ({ nom: str(t?.nom), posts: refs(t?.publications) }))
    .filter((t) => {
      if (!t.nom) return false;
      const problem = textProblem(t.nom, m, { timing: false, growth: false, trend: false });
      if (problem) return drop("thèmes", t.nom, problem);
      if (!t.posts.length) return drop("thèmes", t.nom, "aucune publication de ce thème n'est citée");
      return true;
    });

  const accroches = arr(out.accroches)
    .map((h) => ({ type: str(h?.type), post: post(h?.publication), pourquoi: str(h?.pourquoi) }))
    .filter((h) => {
      const label = `${h.type} · ${h.pourquoi}`;
      if (!usable(h.post) || !isUp(h.post)) return drop("accroches", label, "la publication citée n'est pas au-dessus de sa médiane");
      const problem = textProblem(`${h.type}. ${h.pourquoi}`, m, { sense: "positive" });
      if (problem) return drop("accroches", label, problem);
      return true;
    })
    .map((h) => ({ type: h.type, post: h.post.id, pourquoi: h.pourquoi }));

  // Idées : le titre, le format et l'accroche sont des propositions (un « carrousel 6 slides » est
  // permis), mais ne doivent rien affirmer sur un créneau, une croissance ou une évolution ; le
  // mécanisme repris, lui, vient de publications au-dessus de leur médiane.
  const idees = arr(out.idees)
    .map((i) => ({ ...i, titre: str(i?.titre), format: str(i?.format), accroche: str(i?.accroche), angle: str(i?.angle), inspiree_de: refs(i?.inspiree_de, isUp) }))
    .filter((i) => {
      if (!i.titre) return false;
      if (!i.inspiree_de.length) return drop("idées", i.titre, "aucune publication au-dessus de sa médiane ne la fonde");
      const problem = textProblem(i.angle, m, { sense: "positive" })
        || [i.titre, i.format, i.accroche].map((x) => textProblem(x, m, { numbers: false })).find(Boolean);
      if (problem) return drop("idées", i.titre, problem);
      return true;
    });

  // Expression récurrente : au moins deux mots, lus tels quels (mots entiers) dans au moins deux légendes.
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
  const captions = list.filter((p) => p.status !== "épinglé").map((p) => norm(p.text));
  const expressions = arr(out.voix?.expressions).filter((x) => {
    const e = norm(x);
    if (e.split(" ").length < 2) return false;
    const r = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(e)}(?![\\p{L}\\p{N}])`, "u");
    return captions.filter((t) => r.test(t)).length >= 2;
  });

  return {
    createdAt: new Date().toISOString(),
    positionnement: paragraph(out.positionnement, "portrait"),
    themes,
    marche: claims(out.ce_qui_marche, "ce qui marche", { proof: isUp, required: true, sense: "positive" }),
    marcheMoins: claims(out.ce_qui_marche_moins, "ce qui marche moins", { proof: isDown, required: true, sense: "negative" }),
    accroches,
    swot: {
      forces: claims(out.forces, "forces", { proof: isUp, sense: "positive" }),
      faiblesses: claims(out.faiblesses, "faiblesses", { proof: isDown, sense: "negative" }),
      opportunites: claims(out.opportunites, "opportunités", { proof: notDown }),
      menaces: claims(out.menaces, "menaces", { sense: "negative" }),
    },
    recommandations: claims(out.recommandations, "recommandations", { proof: notDown }),
    idees,
    voix: {
      resume: paragraph(out.voix?.resume, "style d'écriture"),
      expressions: [...new Set(expressions)].slice(0, 6),
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
    const fresh = await loadAccountAnalysis(a.id);
    if (!fresh) throw new Error("Analyse introuvable (supprimée ?)");
    Object.assign(fresh, fields);
    if (usd) {
      const c = (fresh.claude ||= { costUsd: 0 });
      c.costUsd = Math.round(((c.costUsd || 0) + usd) * 10000) / 10000;
    }
    await saveAnalysis(fresh);
    return fresh;
  };
  try {
    let cur = await loadAccountAnalysis(a.id);
    if (!cur) throw new Error("Analyse introuvable (supprimée ?)");
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
