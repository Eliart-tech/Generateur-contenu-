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
import { computeAccountMetrics, VIEW_LABEL, engagementFormula, writtenNumbers } from "./account-metrics.mjs";
import { coverImages } from "./social.mjs";
import { analyzeAccount, classifyAccountTexts } from "./claude.mjs";

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
// `busy` : message d'erreur (409) si le verrou n'est pas obtenu à temps ; sans lui, on continue sans verrou.
async function withLock(key, fn, { ttlMs = 15000, waitMs = 8000, busy = null } = {}) {
  const until = Date.now() + waitMs;
  let got = await acquireLock(key, ttlMs);
  while (!got && Date.now() < until) {
    await sleep(150);
    got = await acquireLock(key, ttlMs);
  }
  if (!got && busy) throw Object.assign(new Error(busy), { status: 409 });
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
// strict : l'échec remonte (suppression) au lieu d'être seulement journalisé.
async function updateIndex(a, { remove = false, strict = false } = {}) {
  await withLock(`${INDEX_KEY}-lock`, async () => {
    const list = (await cacheGet(INDEX_KEY, TTL, { strict: true })) || [];
    const next = list.filter((r) => r.id !== a.id);
    if (!remove) next.unshift(indexRow(a));
    next.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
    await cacheSet(INDEX_KEY, next.slice(0, 120), TTL);
  }).catch((err) => {
    if (strict) throw err;
    console.error(`Index des comptes non mis à jour : ${err.message}`);
  });
}

async function updateHistory(a, change) {
  const hk = histKey(a.platform, a.key);
  await withLock(`${hk}-lock`, async () => {
    const hist = (await cacheGet(hk, TTL, { strict: true })) || [];
    await cacheSet(hk, change(hist.filter((h) => h.id !== a.id)).slice(-60), TTL);
  }).catch((err) => console.error(`Historique du compte non mis à jour : ${err.message}`));
}

// Une lecture en échec remonte (« liste indisponible ») au lieu de passer pour une liste vide. Une ligne
// restée « en cours » après la fin du relevé (écriture d'index ratée) est corrigée d'après l'analyse.
// `finalize` : termine au passage les analyses abandonnées (affichage de la liste). Jamais pendant le
// lancement d'une analyse : ce travail réseau retarderait la décision prise sous verrou.
export async function listAccountAnalyses({ finalize = true } = {}) {
  const rows = (await cacheGet(INDEX_KEY, TTL, { strict: true })) || [];
  const stale = rows.filter((r) => r.status === "running" && Date.now() - Date.parse(r.createdAt) > HARD_DEADLINE_MS);
  if (!stale.length || !finalize) return rows;
  const fixed = new Map();
  for (const r of stale) {
    const raw = await cacheGet(analysisKey(r.id), TTL).catch(() => undefined);
    if (raw === undefined) continue; // illisible : on laisse la ligne telle quelle
    fixed.set(r.id, raw && raw.status !== "deleted" ? raw : null);
  }
  // Analyses abandonnées encore « en cours » : terminées ici (trois au plus par affichage de la liste).
  for (const [id, a] of [...fixed].filter(([, x]) => x?.status === "running").slice(0, 3)) {
    fixed.set(id, (await advanceAccountAnalysis(a, { budgetSecs: 0 }).catch(() => a)) || null);
  }
  for (const a of fixed.values()) if (a && a.status !== "running") updateIndex(a);
  return rows.flatMap((r) => (!fixed.has(r.id) ? [r] : fixed.get(r.id) ? [indexRow(fixed.get(r.id))] : []));
}

export async function deleteAccountAnalysis(id) {
  return withLock(`acct-run-${id}`, () => deleteLocked(id), { ttlMs: 60000, waitMs: 45000 });
}

async function deleteLocked(id) {
  const raw = await cacheGet(analysisKey(id), TTL);
  if (!raw) return false;
  if (raw.status === "deleted") {
    // Suppression déjà commencée (index non mis à jour la première fois) : on la termine.
    await updateIndex(raw, { remove: true, strict: true });
    await updateHistory(raw, (hist) => hist);
    return true;
  }
  const a = raw;
  // Relevés encore en cours arrêtés (plus de frais) ; l'analyse devient une pierre tombale, puis sort
  // de la liste, et son point de croissance aussi.
  await Promise.all(Object.values(a.runs || {}).filter((r) => r.runId && !isTerminal(r.status) && r.status !== "ERROR").map((r) => abortRun(r.runId)));
  await saveAnalysis({ id: a.id, platform: a.platform, key: a.key, inputKey: a.inputKey || null, createdAt: a.createdAt, status: "deleted" });
  await clearLive(a);
  await updateIndex(a, { remove: true, strict: true });
  await updateHistory(a, (hist) => hist);
  return true;
}

const sameAccount = (r, platform, key) => r.platform === platform && (r.key === key || (r.inputKeys || []).includes(key));

// Relevé en cours d'un compte : noté à part de l'index (une écriture d'index ratée ne doit jamais
// permettre un second relevé payé du même compte).
const liveKey = (platform, key) => `acct-live-${hash(`${platform}:${key}`)}`;
const setLive = (a) => cacheSet(liveKey(a.platform, a.inputKey || a.key), { id: a.id }, READ_RETRY_MS);
const clearLive = (a) => cacheSet(liveKey(a.platform, a.inputKey || a.key), null, 1000).catch(() => {});

async function previousRunning(platform, key) {
  const live = await cacheGet(liveKey(platform, key), READ_RETRY_MS, { strict: true });
  if (live?.id) {
    let running = await loadAccountAnalysis(live.id);
    // Personne ne l'a suivie jusqu'au bout (onglet fermé) : on la termine maintenant, au lieu de la
    // réutiliser indéfiniment comme « en cours ».
    if (running?.status === "running" && Date.now() - Date.parse(running.createdAt) > HARD_DEADLINE_MS) running = await advanceAccountAnalysis(running, { budgetSecs: 0 });
    if (running?.status === "running") return running;
  }
  const list = await listAccountAnalyses({ finalize: false });
  const prev = list.find((r) => sameAccount(r, platform, key));
  if (!prev || Date.now() - Date.parse(prev.createdAt) >= FRESH_MS || !["running", "done"].includes(prev.status)) return null;
  // La ligne de l'index peut être en retard (écriture manquée, analyse abandonnée) : l'analyse elle-même fait foi.
  const a = await loadAccountAnalysis(prev.id);
  if (!a || !["running", "done"].includes(a.status)) return null;
  if (a.status === "running" && Date.now() - Date.parse(a.createdAt) > HARD_DEADLINE_MS) {
    const done = await advanceAccountAnalysis(a, { budgetSecs: 0 });
    return done?.status === "done" ? done : null;
  }
  return a;
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
  }, { ttlMs: 90000, waitMs: 30000, busy: "Une analyse de ce compte est déjà en train de démarrer. Réessaie dans un instant." });
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
  await setLive(a);
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
    await clearLive(a);
    await saveAnalysis({ ...a, runs: {}, status: "error", errorCode: "start_failed", error: `Le relevé n'a pas pu être enregistré (${err.message}) : il a été arrêté, rien n'est facturé au-delà. Réessaie.` }).catch(() => {});
    throw err;
  }
  if (a.status !== "running") await clearLive(a);
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
  // Démarrage pas encore enregistré (aucun relevé noté) : on attend, puis on le dit — jamais de verdict
  // sur le compte à partir d'un relevé qui n'a pas eu lieu.
  if (!Object.keys(a.runs || {}).length) {
    if (age < 60000) return a;
    a.status = "error";
    a.errorCode = "start_failed";
    a.error = "Le relevé n'a pas démarré : rien n'a été conclu sur ce compte. Réessaie.";
    if (await deleted(a.id)) return null;
    await saveAnalysis(a);
    await clearLive(a);
    await updateIndex(a);
    return a;
  }
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
  if (unread.length) {
    a.readFailSince = a.readFailSince || new Date().toISOString();
    if (Date.now() - Date.parse(a.readFailSince) < READ_RETRY_MS - HARD_DEADLINE_MS) {
      if (await deleted(a.id)) return null;
      await saveAnalysis(a);
      return a;
    }
  }
  try {
    const postsRun = a.runs.posts;
    if (unread.includes("posts")) {
      throw accountError("unreadable", `Les publications relevées n'ont pas pu être lues (${postsRun.readError}). Réessaie : rien n'a été conclu sur ce compte.`);
    }
    // Relevé des publications en échec et vide : c'est le relevé qui a échoué, pas le compte qui est vide.
    const realItems = (items.posts || []).filter((x) => x && !x.error && !x.errorCode && !x.noResults && !x.demo && x.type !== "error");
    if (postsRun && postsRun.status !== "SUCCEEDED" && !realItems.length) {
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
  await clearLive(a);
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
  return (await listAccountAnalyses({ finalize: false }).catch(() => [])).filter((r) => sameAccount(r, platform, key));
}

// ---------------------------------------------------------------------------
// Lecture par Claude, puis contrôle : chaque constat doit s'appuyer sur un indicateur disponible ou
// sur des publications qui le prouvent ; un chiffre absent des données est signalé.
// ---------------------------------------------------------------------------

const fr = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "?" : Number(n).toLocaleString("fr-FR", { maximumFractionDigits: d }));
const frDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", year: "numeric" });
const TYPE_LABEL = { reel: "Reel", vidéo: "vidéo", carrousel: "carrousel", image: "photo", short: "Short", long: "vidéo longue", texte: "texte", document: "document", article: "article" };

/**
 * Ce que Claude lit des calculs : de quoi comprendre le compte (échantillon, familles, formats, légendes,
 * hashtags, sons), pas les indicateurs sur lesquels il n'a rien à dire (rythme, moments, évolution,
 * croissance, engagement) : l'application les affiche elle-même, avec leur formule.
 */
export function indicatorLines(a) {
  const m = a.metrics;
  const lines = [];
  lines.push(`[echantillon] ${m.sample.analysed} publications analysées, dont ${m.sample.tooRecent} trop récentes pour être jugées ; ${m.sample.pinned} épinglée(s) et ${m.sample.notOwn} republication(s), retweet(s) ou réponse(s) écartées.`);
  lines.push(`[familles] chaque publication est comparée à la médiane de sa famille : ${m.groups.map((g) => `${g.label} (${g.measure === "views" ? m.performance.views.label : "engagement"}, ${g.comparable} comparable(s))`).join(" ; ")}.`);
  lines.push(`[formats] ${m.formats.map((f) => `${TYPE_LABEL[f.type] || f.type} ${f.count}`).join(" ; ")}.`);
  lines.push(`[hashtags] ${m.hashtags.top.length ? `les plus utilisés : ${m.hashtags.top.map((t) => `#${t.tag}`).join(", ")}` : "peu de hashtags répétés"}.`);
  if (m.sounds?.top?.length) lines.push(`[sons] repris plusieurs fois : ${m.sounds.top.map((t) => t.name).join(", ")}.`);
  if (m.specific?.reactions) lines.push(`[reactions] réactions LinkedIn reçues, de la plus fréquente à la moins fréquente : ${m.specific.reactions.map((r) => r.type).join(", ")}.`);
  lines.push("[reserve] Sujets montrés par l'application, dont tu ne parles pas : chiffres, jours et heures de publication, rythme, croissance des abonnés, évolution dans le temps, comparaison de formats, de durées ou de hashtags, comparaison avec d'autres comptes ou une moyenne.");
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
      return `P${i + 1} [${TYPE_LABEL[p.type] || p.type || "publication"}${dur} · ${frDate(p.createdAt)} · ${place}] ${measures} — « ${p.text.slice(0, 300)} »${p.hashtags?.length ? ` ${p.hashtags.map((h) => `#${h}`).join(" ")}` : ""}${p.sound ? ` — son : ${p.sound.name}` : ""}`;
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

// ---------------------------------------------------------------------------
// Sujets réservés aux calculs. Claude ne doit parler ni de chiffres, ni de jours ou d'heures de
// publication, ni de rythme, ni de croissance des abonnés, ni d'évolution dans le temps, ni de
// comparaison de formats, de durées ou de hashtags, ni de comparaison avec d'autres comptes : les
// tuiles et les tableaux les montrent, avec leur formule. Toute phrase qui aborde l'un de ces sujets est
// écartée, quel que soit son sens (on ne cherche pas à deviner si « n'augmente plus » dit vrai) :
// mieux vaut écarter une phrase juste que montrer une phrase fausse. Une seconde lecture par Claude
// (classifyAccountTexts) rattrape ensuite les tournures que ces listes ne connaissent pas.
// ---------------------------------------------------------------------------

const words = (alts) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, "iu");
const stems = (alts) => new RegExp(`(?<![\\p{L}])(?:${alts})`, "iu");

// Tournures de contenu retirées avant les tests : elles ne disent rien des chiffres du compte, mais
// contiennent des mots que les tests guettent (« un public de débutants qui veulent progresser », « aide
// sa communauté à améliorer sa posture », « tenues de tous les jours », « durée de cuisson », « un montage
// au rythme rapide »). Elles sont remplacées par un point, pour qu'aucun test ne relie les mots d'avant à
// ceux d'après.
const NEUTRAL = [
  /(?:qui (?:veulent|veut|souhaitent|souhaite|cherchent à|cherche à|rêvent de|rêve d'|rêve de|aimeraient|aimerait|ont envie de|a envie de|apprennent à|apprend à|essaient de|essaie de|espèrent|espère)|souhaitant|désireu(?:x|se|ses) d[e']|en quête d[e'])[^,.;:!?]*/giu,
  /(?:aide|aident|aider|accompagne|accompagnent|accompagner|guide|guident|guider|pousse|poussent|pousser|encourage|encouragent|encourager|motive|motivent|motiver|apprend|apprennent|apprendre|invite|invitent|inviter)\s+(?:à\s+)?(?:sa|son|ses|leur|leurs|la|les|cette|ces|aux)\s+(?:communauté|audience|abonnée?s|public|fans|followers|élèves|clients?|clientes?|lecteurs|lectrices)(?:\s+(?:de|d')\s*[\p{L}'-]+)?\s+(?:à|pour)\s+(?!(?:grandir|s'agrandir|s'élargir|augmenter|croître|s'étoffer|grossir)(?![\p{L}]))[\p{L}'-]+/giu,
  /(?:donne|donnent|partage|partagent|offre|offrent|transmet|transmettent|explique|expliquent|montre|montrent|propose|proposent|raconte|racontent)\s+(?:à|avec)\s+(?:sa|son|ses|leur|leurs)\s+(?:communauté|audience|abonnée?s|public|fans|followers|lecteurs|lectrices)/giu,
  /(?:gagner|perdre|gagne|perd|gagnent|perdent) du temps|perte de poids|prise de poids|prise de masse|chutes? (?:de|des) cheveux|pertes? (?:en bourse|de chaleur|d'énergie|de données)/giu,
  /(?:fans?|amateurs?|amatrices?|passionnée?s?|adeptes?|mordue?s?) (?:de|d'|du|des) ?[\p{L}'-]+/giu,
  /(?:de|du) (?:tous les jours|quotidien)|au quotidien/giu,
  /(?:à|pour|d') (?:améliorer|booster|optimiser|travailler|augmenter|développer) (?:leurs|vos|tes|nos|leur|votre|ta|notre) [\p{L}'-]+/giu,
  /performances? (?:sportives?|physiques?|athlétiques?|scolaires?|énergétiques?|commerciales?|économiques?|financières?|(?:en|au|à la|de) (?:course|natation|vélo|cyclisme|musculation|squat|compétition|match|marathon|trail)|d'(?:un|une) (?!compte|chaîne|page|profil|publication|post|vidéo|reel)[\p{L}-]+)|vues? (?:à couper le souffle|imprenables?|panoramiques?|aériennes?|du ciel|sur (?:la|le|les|l')[\p{L}'-]*)|à (?:la )?portée (?:de|des) (?:tous|toutes|chacun|tout le monde|débutants?|[\p{L}-]+)|à portée de main|réactions? chimiques?|(?:booster|améliorer|augmenter) (?:les|ses|leurs) stats (?:de|d'|du)\s*[\p{L}'-]+/giu,
  /(?<!(?:vidéos?|reels?|shorts?|tiktoks?|contenus?|formats?|lives?|légendes?|textes?)\s+(?:[\p{L}'-]+\s+)?)(?:en|de) (?:moins d'|à peine |plus d')?(?:une|quelques|deux|trois|cinq|dix|quinze|trente|\p{Nd}+) (?:minutes?|secondes?|min)(?![\p{L}])|(?:durées?|temps) de (?:cuisson|pose|repos|préparation|séchage|trajet|marinade|fermentation|charge|vol|lavage)|prête?s? en [\p{L}\p{N}]+ (?:minutes|min)/giu,
  /au rythme d(?:e|u|es) [\p{L}'-]+|rythmes? (?:cardiaques?|de vie|du sommeil|circadiens?|biologiques?|scolaires?|afro\p{L}*|latinos?|musicaux|endiablés?|tropicaux)|rythmes? (?:rapides?|lents?|soutenus?|effrénés?|nerveux|enlevés?|endiablés?)\s+(?:du|de la|des|de) (?:montage|narration|musique|vidéo|séquences?|coupes?|récit)|rythmes? (?:du montage|de (?:la )?narration|de la musique|de pédalage|des coupes|de la vidéo|du récit)|(?:montage|narration|récit|vidéos?|reels?|tiktoks?|séquences?|chorégraphies?|coupes?)\s+(?:(?!sort|publi|post|tweet|parai)[\p{L}'-]+,?\s+){0,2}?(?:au|à un|d'un) rythme (?:rapide|lent|soutenu|effréné|nerveux|enlevé|endiablé)|montage rythmé|cadences? de pédalage|en cadence/giu,
  /(?:la|une|cette) tendance (?:est|sera|était) (?:au|à la|aux|à l') [\p{L}'-]+/giu,
  /meilleurs? moments? (?:de|des|du|d') ?[\p{L}'-]+|(?:le )?(?:bon|meilleur) moment pour (?!publier|poster)[\p{L}'-]+/giu,
  /haut de gamme|engagement (?:écologique|militant|associatif|citoyen|social|politique|religieux|personnel)|(?:leurs?|ses) (?:résultats|performances|stats),? (?:bons?|bonnes?) ou (?:mauvais|mauvaises)/giu,
];
const neutral = (t) => NEUTRAL.reduce((s, r) => s.replace(r, " . "), String(t || ""));
// Citations (accroches, légendes citées) : leur contenu n'est pas une affirmation sur le compte.
const unquoted = (t) => t.replace(/«[^»]*»|"[^"]*"|“[^”]*”/g, " ");

// --- Publications, formats et compteurs ---
const PUB_NOUNS = "publications?|posts?|reels?|vidéos?|carrousels?|shorts?|contenus?|tiktoks?|lives?|épisodes?|stor(?:y|ies)|tweets?|threads?|photos?|documents?|articles?|newsletters?|vlogs?";
const PUB_NOUN = words(PUB_NOUNS);
// Sujet d'un constat de résultat : une publication, un format ou un contenu nommé (« ses tutos »).
const SUBJ = `(?:${PUB_NOUNS}|tutos?|tutoriels?|recettes?|avant / après|formats?)`;
const METRICS = "vues|lectures|impressions|réactions|interactions|commentaires|partages|repartages|enregistrements|sauvegardes|j'aime|likes|abonnés|abonnées|followers|engagement|clics|échanges|visionnages|retweets|reposts";
const PERF = words("vues|lectures|impressions|engagement|performances?|résultats|portée|réactions|interactions|j'aime|likes?|commentaires|partages|enregistrements|statistiques|stats|chiffres|visibilité|reach|succès|popularité|traction|échanges|visionnages");
const AUDIENCE_WORDS = "abonnés?|abonnées?|abonnements|followers?|communautés?|audiences?|fans?|public|base d'abonnés|notoriété|popularité|lectorat|spectateurs|spectatrices|viewers|(?:son|leur|sa) réseau(?! (?:de|d'|du|des|commercial|électrique))|(?:sa|leur) base(?! de (?:données|connaissances))";
const AUDIENCE = words(AUDIENCE_WORDS);
const ACCOUNT_WORDS = "(?:le|ce|son|du|au) compte|(?:la|cette|sa) chaîne(?! (?:d'(?:un|une)|de (?:vélo|montage|production|magasins|restaurants|froid|télé|télévision|valeur|montagnes?)|du (?:froid|Mont)|des (?:Alpes|Pyrénées)|alimentaire|hi-fi))|(?:la|cette|sa) page(?! (?:de|d'|du|des))|(?:le|ce|son) profil|(?:son|sa) (?:instagram|insta|tiktok|youtube|linkedin|chaîne youtube)";
const ACCOUNT = words(ACCOUNT_WORDS);
// Verbes de résultat, conjugués (sujet : une publication, un format ou un compteur).
const PERF_VERBS = "marchent|marche|marchaient|marchait|fonctionnent|fonctionne|font|fait|faisaient|faisait|performent|performe|plaisent|plaît|engagent|engage|cartonnent|cartonne|obtiennent|obtient|génèrent|génère|récoltent|récolte|attirent|attire|retiennent|retient|réussissent|réussit|convertissent|convertit|tirent|tire|portent|porte|dépassent|dépasse|surpassent|surpasse|suscitent|suscite|cumulent|cumule|totalisent|totalise|sont|est|restent|reste|étaient|était|ont|a|rapportent|rapporte|déclenchent|déclenche";

// --- Comparaisons ---
const COMPARE = stems("mieux|moins|plus(?![\\p{L}])|davantage|meilleur|pire|supérieur|inférieur|que les|que ses|que leurs|que ces|que des|que ceux|que celles|qu'aux|qu'avant|qu'auparavant|par rapport aux?|devant les|surpass|dépass|écras|l'emport|face aux|contre les|plutôt que|à l'inverse|contrairement|à la différence|tandis que|alors que (?:les|ses|leurs)|là où (?:les|ses|leurs)|prennent le dessus|prend le dessus|autant que|aussi bien que");
// Comparaison de résultats (pas de « plus chaudes », « plus tendre ») : mieux, plus de vues, les plus partagés…
const COMPARE_PERF_ALTS = `mieux|moins bien|meilleur|pire|davantage|le plus(?! d)|le moins(?! d)|(?:plus|moins)(?=\\s*(?:[.!?,;:]|$))|(?:plus|moins) d(?:e |')(?:${METRICS}|succès|monde|réactions)|surpass|l'emport|prennent le dessus|prend le dessus|(?:plus|moins) (?:vus|vues|regardé\\p{L}*|partagé\\p{L}*|commenté\\p{L}*|aimé\\p{L}*|liké\\p{L}*|enregistré\\p{L}*|lus|lues|performant\\p{L}*|efficaces?|populaires?|engageant\\p{L}*|porteu\\p{L}*)`;
const COMPARE_PERF = stems(COMPARE_PERF_ALTS);
// Une publication ou un compteur sujet d'une comparaison de résultats (« ses vidéos font plus de vues »,
// « l'engagement est meilleur ») ; la fenêtre s'arrête à « pour », « qui », « comme » (« pensés pour mieux expliquer »).
const WINDOW = "(?:(?!\\s(?:pour|afin|comme|qui|quand|lorsque|comment|où)\\s)[^.!?]){0,40}?";
const PUB_PERF_CMP = new RegExp(`(?<![\\p{L}])${SUBJ}(?:\\s+[\\p{L}'-]+){0,6}?\\s+(?:ne\\s+|n')?(?:${PERF_VERBS})(?![\\p{L}])${WINDOW}(?:${COMPARE_PERF_ALTS})`, "iu");
const PERF_NOUNS = "engagement|vues|lectures|impressions|réactions|interactions|commentaires|partages|résultats|performances|chiffres|stats|statistiques|portée|visibilité";
const PERF_SUBJ = `(?:l'|le |la |les |ses |son |sa |leurs? )(?:${PERF_NOUNS})`;
const PERF_SUBJ_CMP = new RegExp(`(?<![\\p{L}])${PERF_SUBJ}(?![\\p{L}])${WINDOW}(?:${COMPARE_PERF_ALTS})`, "iu");

// --- Créneaux de publication ---
// Jours, repas, moments : un créneau seulement s'ils touchent la publication (verbe ou publication datée :
// « vidéos du dimanche »), une comparaison de résultats (« le week-end, ses vidéos font plus de vues »),
// l'activité de l'audience (« sa communauté est active le soir ») ou un conseil (« privilégie le mardi
// matin »). Pas dans un sujet (« recettes du dimanche », « routine du matin », « tenues pour sortir le soir »).
const MEALS = "pause déjeuner|heure du déjeuner|(?<!petit[- ])déjeuner|dîner";
const SLOT_TIME = `lundis?|mardis?|mercredis?|jeudis?|vendredis?|samedis?|dimanches?|week-ends?|weekends?|en semaine|jours? ouvrés|(?:début|milieu|fin) de semaine|matins?|matinées?|petit matin|aube|midi|après-midi|${MEALS}|soirs?|soirées?|nuits?|minuit|en journée|dans la journée|en fin de journée|en début de journée|heures? de bureau|heure de pointe|à heure fixe|tôt|tard`;
const SLOT_TIME_NO_MEAL = SLOT_TIME.replace(`|${MEALS}`, "");
const TIME_WORD = words(SLOT_TIME);
// Verbes de publication conjugués (« publie », « postent », « met en ligne ») ; « public », « publications »,
// « postes » (le nom) n'en sont pas. « Sortir » ne compte qu'avec une publication nommée.
const PUBLISH_STRONG = stems("publi(?:e|es|ent|er|ez|ons|ait|aient|ais|é|ée|és|ées|ant|era|eront|erait|eraient)(?![\\p{L}])|post(?:ent|er|ez|é|ée|és|ées|ait|aient|ais|ant)(?![\\p{L}])|(?:il|elle|on|ils|elles|qu'il|qu'elle|qu'on|ne|n'|je|tu) postes?(?![\\p{L}])|mis en ligne|mise en ligne|met(?:s|tent)? en ligne|diffus(?:e|ent|er|é|ée|és|ées|ait|aient|ion)(?![\\p{L}])|tweet(?:e|es|ent|er|é|ée|és|ées|ait|aient)(?![\\p{L}])");
const PUBLISH_WEAK = stems("sort(?:ent|ir|ie|ies|ait|aient)(?![\\p{L}])|sor(?:s|tez)(?![\\p{L}])");
const publishes = (t) => PUBLISH_STRONG.test(t) || (PUBLISH_WEAK.test(t) && PUB_NOUN.test(t));
const PUBLISH_NOUN_TIME = new RegExp(`(?<![\\p{L}])(?:${PUB_NOUNS}|créneaux?|rendez-vous|rubriques?|chroniques?|séries?)\\s+(?:du|de|le|la|en|à|au|des|chaque|(?:postée?s?|publiée?s?|sortie?s?) (?:le|la|en|à|au))\\s+(?:${SLOT_TIME})(?![\\p{L}])|(?<![\\p{L}])(?:${PUB_NOUNS}|rendez-vous)\\s+(?:dominica(?:l|le|ux|les)|matina(?:l|le|ux|les)|nocturnes?|vespéra(?:l|le|ux|les)|du soir|du matin)(?![\\p{L}])`, "iu");
const SLOT_WORDS = words("heures? de publication|horaires? de publication|horaires? de diffusion|moments? de publication|moments? pour (?:publier|poster)|créneaux? de publication|jours? de publication|quand publier|quand poster|timing de publication|jours? forts?|(?:revoi|change|adapte|ajuste|décale)\\p{L}* (?:tes|ses|vos|leurs) horaires|l'heure de (?:tes|ses|vos|leurs) (?:" + PUB_NOUNS + ")|(?:avanc|décal|recul|retard)\\p{L}*\\s+(?:l'heure de\\s+)?(?:tes|ses|vos|leurs)\\s+(?:" + PUB_NOUNS + ")");
const SLOT_QUAL = words("(?:meilleure?s?|pires?|bons?|bonnes?|mauvaise?s?|idéale?s?|parfaite?s?|porteu(?:r|se|rs|ses)) (?:jours?|créneaux?|moments?(?! (?:de|des|du|d'|pour))|heures?|horaires?|soirs?|matins?|soirées?)");
const CRENEAU = words("créneaux?");
const RECO_TIME = new RegExp(`(?<![\\p{L}])(?:privilégi|vis(?:e|es|er|ez|ent)(?![\\p{L}])|cibl|test|mis(?:e|es|er|ez|ent)? sur|réserv|évit|gard|choisi|concentr\\p{L}*(?:-toi|-vous)? sur|cal(?:e|es|er|ez)(?![\\p{L}])|planifi)\\p{L}*\\s+(?:plutôt\\s+|surtout\\s+|davantage\\s+)?(?:(?:le|la|les|l'|un|une|en|ton|ta|tes|son|sa|ses|ce|cette|ces)\\s*)?(?:${SLOT_TIME_NO_MEAL})(?![\\p{L}])(?!\\s+pour\\s+[\\p{L}'-]+(?:er|ir|re)(?![\\p{L}]))`, "iu");
const AUDIENCE_ACTIVE = new RegExp(`(?<![\\p{L}])(?:public|audiences?|abonnée?s?|communautés?|followers?|fans?|spectateurs)(?![\\p{L}])[^.!?]{0,30}?(?<![\\p{L}])(?:actifs?|actives?|en ligne|connectée?s?|présente?s?|disponibles?|réveillée?s?|là|réagi\\p{L}*|répond\\p{L}*|interagi\\p{L}*|commente\\p{L}*|regarde\\p{L}*|scroll\\p{L}*)(?![\\p{L}])`, "iu");
const WHEN_ACTIVE = new RegExp(`(?<![\\p{L}])(?:quand|lorsque|au moment où|à l'heure où|aux heures où|dès que)\\s+(?:ta|sa|son|ton|tes|ses|leur|leurs|la|le|les|l')\\s*(?:communauté|audience|public|abonnée?s|followers|fans|spectateurs|lecteurs)[^.!?]{0,25}?(?:connect|en ligne|réveill|disponible|dispo|actif|active|scroll|rentr\\p{L}* du travail)`, "iu");
const PUBLISH_ONLY_TIME = words("heures? creuses|heure du goûter|(?:à l'heure|pause) du café|pause café|sortie des bureaux|(?:avant|après) (?:la |ta |sa |les )?(?:première |dernière )?réunions?|rentr\\p{L}* du travail|retour du travail|à l'heure où|aux heures où|au moment où");
const SERIES_TIME = new RegExp(`(?<![\\p{L}])(?:${PUB_NOUNS}|rendez-vous|séries?|rubriques?|chroniques?|formats?)(?![\\p{L}])(?:(?!\\s(?:qu'|que\\s|qui\\s|comment\\s|ce\\s+qu|où\\s))[^.!?]){0,40}?(?:chaque|tous les|toutes les)\\s+(?:${SLOT_TIME})(?![\\p{L}])`, "iu");
const TIME_PERF = words("jours? forts?|(?:marche|marchent|fonctionne|fonctionnent|cartonne|cartonnent) (?:bien|très bien|fort|le mieux)");
const HOUR = /(?<![\p{L}\p{N}])\p{Nd}{1,2}\s?h(?:\s?\p{Nd}{2})?(?![\p{L}])/iu;

// --- Rythme de publication ---
const FREQ_PUB = "(?:publications?|posts?|vidéos?|reels?|contenus?|carrousels?|shorts?|tweets?|threads?|stories|épisodes?|lives?|rendez-vous|séries?|newsletters?|tiktoks?|rubriques?|chroniques?|vlogs?)";
const FREQ_GAP = "(?:(?!\\s(?:qu'|que\\s|qui\\s|à\\s|pour\\s|dont\\s|où\\s|comment\\s|combien\\s|quels?\\s|quelles?\\s|lequel\\s|laquelle\\s))[^.!?])*?";
const FREQ_ADVERB = "régulièrement|irrégulièrement|rarement|fréquemment|souvent|peu souvent|assidûment|sans relâche|sans interruption|tous les jours|chaque jour|chaque semaine|toutes les semaines|tous les soirs|tous les matins|chaque soir|chaque matin|quotidiennement|plusieurs fois par|une fois par|de temps en temps|par intermittence|en continu|à intervalles|à un rythme|au même rythme|tous les deux jours|avec constance|par vagues|par à-coups|sporadiquement|de (?:façon|manière) (?:plus |moins )?(?:régulière|irrégulière|sporadique|constante)";
const PERIODIC = "(?:par|chaque|tous les|toutes les) (?:jours?|semaines?|mois|soirs?|matins?|week-ends?)|(?:tous|toutes) les (?:deux|trois|quatre|quinze|dix|\\p{Nd}+) (?:jours|semaines|mois)|un (?:jour|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|soir|matin|week-end|mois) sur (?:deux|trois|quatre|\\p{Nd}+)";
const FREQUENCY = [
  words("rythmes? de publication|cadences? de publication|fréquences? de publication|régularité de publication|régularité des publications|flux (?:constant|continu|régulier|ininterrompu)|aliment(?:é|ée|és|ées) sans relâche|pas une (?:semaine|journée|jour) sans|gagn\\p{L}* en régularité|(?:augment|baiss|rédui|ralenti|accélèr)\\p{L}* (?:ta|sa|la|votre|leur) fréquence|présence (?:est |reste )?(?:régulière|quotidienne|hebdomadaire|constante|irrégulière|assidue|sporadique)|dispara(?:î|i)\\p{L}* (?:pendant|durant) (?:des|plusieurs|quelques) (?:semaines|mois|jours)"),
  /(?<![\p{L}])(?:sois|reste|soyez|restez) (?:plus )?(?:régulier|régulière|réguliers|présente?s?)(?=\s*(?:[.!]|$|chaque|tous|toutes))/iu,
  /(?<![\p{L}])(?:sa|ta|une) régularité(?!\s+(?:de|du|des|d'|dans|à|au|aux|en)(?![\p{L}]))/iu,
  new RegExp(`(?<![\\p{L}])${FREQ_PUB}\\s+(?:quotidien(?:ne)?s?|hebdomadaires?|hebdos?|mensuel(?:le)?s?|bihebdomadaires?|bimensuel(?:le)?s?)(?![\\p{L}])`, "iu"),
  new RegExp(`(?<![\\p{L}])${FREQ_PUB}\\s+se (?:font|fait) rares?|(?<![\\p{L}])${FREQ_PUB}\\s+se raréfi|espac\\p{L}* (?:\\p{L}+ )?(?:ses|tes|vos|leurs) ${FREQ_PUB}|(?:pauses|absences|silences|trous) (?:entre|dans) (?:ses|tes|deux|les|chaque) ${FREQ_PUB}`, "iu"),
  new RegExp(`(?<![\\p{L}])${FREQ_PUB}(?![\\p{L}])${FREQ_GAP}(?<![\\p{L}])(?:hebdomadaires?|hebdos?|mensuel(?:le)?s?|bihebdomadaires?|quotidiennement|${PERIODIC})(?![\\p{L}])`, "iu"),
  new RegExp(`(?<![\\p{L}])(?:publi(?!c)\\p{L}*|post(?:e|es|ent|er|ez|é|ée|és|ées|ait|aient|ais)|partag\\p{L}*|sort(?:ent|ir|ait|aient)|met(?:s|tent)? en ligne|tweet\\p{L}*|alimente\\p{L}*)(?![\\p{L}])${FREQ_GAP}(?<![\\p{L}])(?:${FREQ_ADVERB})(?![\\p{L}])(?!\\s+(?:[\\p{L}-]+(?:ifs?|ives?|é|ée|és|ées|ants?|antes?|ables?|ibles?|eux|euses?|aux|ales?|iques?))(?![\\p{L}]))`, "iu"),
];
// « Rythme », « cadence » : de la publication seulement avec une publication, un verbe de publication ou un
// verbe qui le règle (« il a ralenti la cadence », « garde ce rythme ») ; pas « des rythmes latinos ».
const RHYTHM = words("rythmes?|cadences?");
const RHYTHM_CTX = stems("ralenti|accélér|soutenu|effréné|gard|maintien|mainten|ten(?:ir|u|ue)(?![\\p{L}])|tient|irréguli|réguli|constant|retrouv|repr(?:end|endre|is)(?![\\p{L}])|cass|perd|tenable|intenable");

// --- Croissance des abonnés ---
const CHANGE_ALTS = "doubl|tripl|augment|hausse|baiss|chut|diminu|recul|progress|déclin|décli|effondr|dégringol|explos|grimp|envol|ralenti|essouffl|décoll|repart|remont|plong(?!ée|eant)|dégrad|amélior|stagn|plafonn|fléchi|érod|érosion|boost|gonfl|bondi|bond(?![\\p{L}])|redress|rebond|perd|pertes?(?![\\p{L}])|gagn|croiss(?!ant)|croît|grandi|grossi|multipli|fond(?:e|ent|re|u|ait|aient)(?![\\p{L}])|s'effrit|effrit|flamb|s'élargi|élargi|rétréci|évolu|se lass|lassitude|en hausse|en baisse|monte en flèche|en flèche|agrandi|s'agrandi|étoff|s'étoff|étend|expansion";
const CHANGE = stems(CHANGE_ALTS);
// Un public ou un compteur et un changement proches l'un de l'autre (« sa communauté s'agrandit », « perte d'abonnés »).
const AUDIENCE_CHANGE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${AUDIENCE_WORDS})(?![\\p{L}\\p{N}])[^.!?]{0,40}?(?<![\\p{L}])(?:${CHANGE_ALTS})|(?<![\\p{L}])(?:${CHANGE_ALTS})[^.!?]{0,25}?(?<![\\p{L}\\p{N}])(?:${AUDIENCE_WORDS})(?![\\p{L}\\p{N}])`, "iu");
const PERF_CHANGE = new RegExp(`(?<![\\p{L}])(?:vues|lectures|impressions|engagement|performances?|résultats|portée|réactions|interactions|j'aime|likes?|commentaires|partages|enregistrements|statistiques|stats|chiffres|visibilité|succès|popularité|traction)(?![\\p{L}])[^.!?]{0,40}?(?<![\\p{L}])(?:${CHANGE_ALTS})|(?<![\\p{L}])(?:${CHANGE_ALTS})[^.!?]{0,25}?(?<![\\p{L}])(?:vues|lectures|impressions|engagement|performances?|résultats|portée|réactions|interactions|j'aime|likes?|commentaires|partages|enregistrements|statistiques|stats|visibilité)(?![\\p{L}])`, "iu");
const GROWTH = words("croissance (?:du compte|de la chaîne|de la page|des abonnés|de l'audience|de la communauté)|(?:compte|chaîne|page) en (?:pleine )?croissance|sa croissance|croissance (?:rapide|forte|fulgurante|régulière|soutenue|lente|nulle|exponentielle)|(?:forte|belle|rapide|vraie) croissance|nouveaux (?:abonnés|fans|followers|lecteurs|spectateurs|abonnements)|nouvelles abonnées|désabonnements?|se désabonnent|(?:gagn|perd)\\p{L}* (?:en |des |du |de la |de l'|d')?(?:notoriété|influence|visibilité|popularité|audience|abonnés|abonnées|followers|fans|portée|lecteurs|spectateurs)|(?:public|audience|communauté|lectorat)s? (?:croissante?s?|grandissante?s?)|compte qui monte|chaîne qui monte|(?:figure|étoile) montante|(?:son|leur) lot d'(?:abonnements|abonnés|followers)|(?:abonnements|abonnés|followers) affluent|nombre (?:croissant|grandissant) de [^.!?]{0,40}(?:suiv|abonn|regard)");
const GROWTH_RE = new RegExp(`(?<![\\p{L}])(?:convert|transform)\\p{L}*[^.!?]{0,30}en (?:abonnée?s|followers|fans)|(?<![\\p{L}])recrut\\p{L}*[^.!?]{0,20}(?:abonnée?s|followers|fans|abonnements)`, "iu");
// Le compte sujet d'un changement (« Le compte stagne », « La chaîne a changé de dimension ») ; pas « Le
// compte gagnerait à développer… », « Le compte explique comment décoller un papier peint ».
const ACCOUNT_CHANGE_ALTS = "ralenti(?:t|ssent|ssait|ssaient)?(?![\\p{L}])|décoll(?:e|ent|ait|aient|é)(?![\\p{L}])|stagn(?:e|ent|ait|aient|é)(?![\\p{L}])|plafonn(?:e|ent|ait|aient|é)(?![\\p{L}])|s'essouffl\\p{L}*|essoufflé|progress(?:e|ent|ait|aient|é)(?![\\p{L}])|recul(?:e|ent|ait|aient|é)(?![\\p{L}])|décli(?:ne|nent|nait|naient|né)(?![\\p{L}])|régress\\p{L}*|s'envol\\p{L}*|explos(?:e|ent|ait|aient|é)(?![\\p{L}])|accélèr(?:e|ent)(?![\\p{L}])|chut(?:e|ent|ait|aient|é)(?![\\p{L}])|repart(?:ent|ait|aient|i)?(?![\\p{L}])|rebondi\\p{L}*|redress\\p{L}*|grandi(?:t|ssent|ssait|ssaient)?(?![\\p{L}])|grossi\\p{L}*|(?:se |s'est |s'était )développ\\p{L}*|développé|prend de l'ampleur|prend son envol|marque le pas|piétin\\p{L}*|fléchi\\p{L}*|s'effondr\\p{L}*|dégringol\\p{L}*|remont(?:e|ent|ait|aient|é)(?![\\p{L}])|grimp(?:e|ent|ait|aient|é)(?![\\p{L}])|monte en (?:puissance|flèche)|monte(?![\\p{L}])|est en forme|a le vent en poupe|essor|ascension|cartonn\\p{L}*|perd (?:du terrain|de la vitesse|de l'élan)|en hausse|en baisse|en perte de vitesse|franchi\\p{L}* un (?:cap|palier)|chang\\p{L}* de dimension|se fait un nom|séduit (?:chaque \\p{L}+ )?davantage|nombre (?:croissant|grandissant)|élargit|s'élargit|étend";
const ACCOUNT_GAP = "(?:\\s+(?!(?:comment|pour|à|explique|expliquent|montre|montrent|aide|aident|parle|parlent|présente|présentent|met|mettent|pourrait|pourraient|gagnerait|gagneraient|devrait|devraient|propose|proposent|raconte|racontent|apprend|décrit|décrypte|filme|teste)(?![\\p{L}]))[\\p{L}'-]+){0,3}?";
const ACCOUNT_CHANGE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ACCOUNT_WORDS})(?![\\p{L}\\p{N}])${ACCOUNT_GAP}\\s+(?:ne\\s+|n')?(?:${ACCOUNT_CHANGE_ALTS})`, "iu");
const ACCOUNT_CHANGE_AFTER = new RegExp(`(?:nombre (?:croissant|grandissant)|toujours plus)[^.!?]{0,40}(?:suiv|abonn)\\p{L}*[^.!?]{0,10}(?:${ACCOUNT_WORDS})`, "iu");

// --- Évolution des performances ---
const EVOLUTION = words("de plus en plus|de moins en moins|toujours plus|toujours moins|en perte de vitesse|perte de vitesse|s'essouffle|s'essoufflent|essoufflement|chute libre|tendance (?:à la (?:hausse|baisse)|haussière|baissière|positive|négative|générale)|(?:la )?tendance (?:est|reste) (?:bonne|mauvaise|positive|négative|favorable|défavorable|encourageante|inquiétante|à la hausse|à la baisse)|évolution (?:positive|négative|favorable|défavorable|des (?:vues|lectures|performances|résultats|réactions|abonnés))|dégringole|dégringolent|s'effondre|s'effondrent|repart à la hausse|rebondit|rebondissent|de publication en publication|au fur et à mesure des (?:publications|posts|vidéos|semaines|mois)|au fil des (?:publications|posts|vidéos)");
// Hausse, baisse, tendance : du compte seulement si elles qualifient un compteur, l'audience, le compte ou
// une publication (pas « les taux sont en hausse », « des secteurs en croissance »).
const EVOLUTION_CTX = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PERF_NOUNS}|${AUDIENCE_WORDS}|${ACCOUNT_WORDS}|${PUB_NOUNS})(?![\\p{L}\\p{N}])(?:\\s+[\\p{L}'-]+){0,3}?\\s+(?:en hausse|en baisse|en chute|en recul|en progression|en déclin|en croissance|au fil des (?:mois|semaines|jours|années))`, "iu");
const TEMPORAL_STRONG = stems("dernièrement|qu'avant|qu'auparavant|auparavant|autrefois|jadis|naguère|désormais|depuis qu(?:e|')|depuis (?:quelques|plusieurs|peu|le début|la rentrée|cet|ce|cette|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|l'été|l'hiver|le printemps|l'automne|un moment|longtemps)|depuis (?:(?:son|sa|ses|le|la) |l')(?:arrivée|passage|déménagement|lancement|changement|retour|départ|reconversion|nouveau|nouvelle|ouverture)|ces temps|ces derniers temps|ces dernières semaines|ces derniers mois|le mois dernier|l'an dernier|l'année dernière|il y a (?:quelques |plusieurs |)(?:jours|semaines|mois|ans)|il y a (?:un|une) (?:an|année|mois|semaine)|qu'il y a|au fil du temps|précédente?s?(?![\\p{L}])|qu'(?:en|au|à l'|à la) (?:printemps|été|automne|hiver|début|rentrée)|qu'(?:à|a) (?:ses|leurs|son|mes|tes) débuts");
// Mots du temps qui servent aussi aux sujets (« chaudières récentes », « tenues de cet hiver ») : une
// évolution seulement s'ils accompagnent une comparaison de résultats d'une publication ou d'un compteur.
const TEMPORAL_WEAK = stems("récemment|récent|dernièr(?!e (?:slide|image|étape|ligne|phrase|diapo|page|scène|partie|question)|es (?:slides|images|étapes|lignes|diapos|pages|scènes))|dernier(?! (?:conseil|plan|mot|geste|étage|coup))|derniers(?! (?:conseils|plans|mots|gestes|détails|réglages|coups))|maintenant|aujourd'hui|actuellement|en ce moment|cette année|ce mois|ces jours-ci|ces derniers jours|cette saison|la saison (?:passée|dernière)|à l'époque|cet été|cet hiver|ce printemps|cet automne|l'été|l'hiver|au printemps|en été|en hiver|en automne|anciens?(?![\\p{L}])|anciennes?(?![\\p{L}])|la rentrée");
const HABITUAL_DATED = new RegExp(`(?:mieux|moins bien|plus|moins) que d'habitude[^.!?]*(?<![\\p{L}])(?:récemment|récente?s?|derni(?:er|ers|ère|ères)|maintenant|aujourd'hui|actuellement|en ce moment|cette année|ce mois|ces jours-ci|ces derniers jours|cette saison|la saison (?:passée|dernière)|à l'époque)(?![\\p{L}])|(?<![\\p{L}])(?:récemment|récente?s?|derni(?:er|ers|ère|ères)|maintenant|aujourd'hui|actuellement|en ce moment|cette année|ce mois|ces jours-ci|ces derniers jours|cette saison|la saison (?:passée|dernière)|à l'époque)(?![\\p{L}])[^.!?]*(?:mieux|moins bien|plus|moins) que d'habitude`, "iu");
const PAST_PERF = /(?<![\p{L}])(?:marchai|fonctionnai|performai|cartonnai|plaisai)\p{L}*[^.!?]{0,40}(?:mieux|moins bien|davantage|plus)|(?<![\p{L}])faisai\p{L}* mieux/iu;
const NO_LONGER = /(?<![\p{L}])ne \p{L}+ plus autant|(?<![\p{L}])n'\p{L}+ plus (?:le même|la même|autant)/iu;
// Une publication sujet d'un verbe d'évolution (« Ses Reels progressent », « Les tutos font un carton »).
const CONTENT_CHANGE = new RegExp(`(?<![\\p{L}])${SUBJ}(?:\\s+[\\p{L}'-]+)?\\s+(?:ne\\s+|n')?(?:(?:progress|recul|régress)(?:e|ent|ait|aient)(?![\\p{L}])(?!\\s+(?:du|de|d'|pas à pas|vers|en difficulté|avec))|déclin(?:e|ent|ait|aient)(?![\\p{L}])|ralenti(?:t|ssent|ssait|ssaient)(?![\\p{L}])|mont\\p{L}* en puissance|commence\\p{L}* à percer|reprenn?\\p{L}* des couleurs|(?:ont |a )?perd\\p{L}* (?:de leur|de sa|de son) (?:superbe|impact|éclat|attrait)|gagn\\p{L}* en (?:impact|portée|visibilité|vues)|s'envol\\p{L}*|décoll(?:e|ent|ait|aient)(?![\\p{L}])|plafonn(?:e|ent|ait|aient)(?![\\p{L}])|s'essouffl\\p{L}*|explos(?:e|ent|ait|aient)(?![\\p{L}])|cartonn(?:e|ent|ait|aient)(?![\\p{L}])|stagn(?:e|ent|ait|aient)(?![\\p{L}])|dégringol\\p{L}*|s'effondr\\p{L}*|piétin\\p{L}*|marque(?:nt)? le pas|(?:font|fait) (?:un carton|le buzz|un tabac)|(?:affol|font exploser|fait exploser)\\p{L}* les compteurs|(?:sont |est )?devenue?s? vira(?:l|le|les|ux)|prenn?\\p{L}* de l'ampleur)`, "iu");
const INTEREST_FADE = /(?<![\p{L}])(?:intérêt|attention|engouement|enthousiasme)[^.!?]{0,40}(?:retomb|s'émouss|émouss|s'essouffl|faibli|diminu|décli|s'érod)/iu;
const LEN_CHANGE = new RegExp(`(?<![\\p{L}])(?:vidéos?|reels?|shorts?|formats?|contenus?|tiktoks?|lives?|textes?|posts?|légendes?)\\s+(?:se sont |sont )?(?:nettement )?(?:raccourci|rallong|allong)\\p{L}*[^.!?]*(?:${COMPARE_PERF_ALTS})`, "iu");

// --- Formats, durées, hashtags ---
// Formats par réseau : un mot n'est un format que là où il existe (« shorts » en mode, « article » de
// vêtement ne sont pas des formats sur Instagram).
const FORMAT_WORDS = {
  reel: stems("reels?"), carrousel: words("carrousels?|diaporamas?|slides?"), image: words("photos?|images?|visuels?"),
  long: words("vidéos? longues?|longues? vidéos?|longs? formats?"), short: words("shorts?"), vidéo: words("vidéos?|clips?"),
  document: words("documents?|pdf"), article: words("articles?"), texte: words("posts? textes?|textes? seuls?|posts? écrits?|tweets?"),
  thread: words("threads?|fils? de discussion"),
  live: words("lives?|en direct|vidéos? en direct"), story: words("stor(?:y|ies)"),
};
// Noms de format sans ambiguïté, pour les comparaisons et les preuves (« visuels », « image de marque »,
// « tweets » sur X, « articles de loi » n'en sont pas).
const PROOF_WORDS = {
  ...FORMAT_WORDS,
  image: words("photos?|images? fixes?|posts? photos?"),
  texte: words("posts? textes?|textes? seuls?|posts? écrits?"),
  thread: /(?!)/,
  document: words("posts? documents?|documents? pdf|pdf|format document|carrousels? pdf"),
  article: words("posts? articles?|articles? linkedin|format article"),
};
const CMP_WORDS = { ...PROOF_WORDS, thread: FORMAT_WORDS.thread, texte: words("posts? textes?|textes? seuls?|posts? écrits?|tweets?") };
const PLATFORM_FORMATS = {
  instagram: ["reel", "carrousel", "image", "vidéo", "story", "live"],
  tiktok: ["vidéo", "carrousel", "image", "live", "story"],
  youtube: ["short", "long", "vidéo", "live"],
  linkedin: ["texte", "image", "carrousel", "document", "article", "vidéo", "live"],
  x: ["texte", "thread", "image", "vidéo", "live"],
};
const FORMAT_TYPES = { reel: ["reel", "vidéo"], carrousel: ["carrousel"], image: ["image", "carrousel"], long: ["long"], short: ["short"], vidéo: ["vidéo", "reel", "short", "long"], document: ["document"], article: ["article"], texte: ["texte"], thread: ["texte"], live: ["vidéo", "reel", "short", "long"], story: [] };

function namedFormats(t, platform, table = FORMAT_WORDS) {
  const keys = PLATFORM_FORMATS[platform] || Object.keys(FORMAT_WORDS);
  const named = keys.filter((k) => table[k].test(t));
  // « vidéo » est générique : nommée avec un format précis (Reel, Short, vidéo longue), elle ne compte pas à part.
  return named.filter((k) => !(k === "vidéo" && named.some((x) => ["reel", "long", "short"].includes(x))));
}
// Formats précis : sur TikTok et YouTube, tout est vidéo, « vidéo » ne désigne pas un format à part.
const specificFormats = (named, platform) => named.filter((k) => !(k === "vidéo" && (platform === "tiktok" || platform === "youtube")));

const SUPERLATIVE = new RegExp(`(?<![\\p{L}])(?:meilleur format|format roi|format phare|format star|format préféré|format gagnant|format le plus|formats? qui (?:marche|marchent|fonctionne|fonctionnent) le mieux|de loin (?:le|la|les|mieux|plus|moins)|meilleure?s? (?:publications|posts|vidéos|contenus|formats?))(?![\\p{L}])`, "iu");
const FORMAT_VS = stems("devanc|surclass|batt(?:ent|re)(?![\\p{L}])|bat (?:les|ses|leurs)|éclips|distanc|domin(?:e|ent)(?![\\p{L}])|supplant|détrôn|talonn|rivalis\\p{L}* avec|prenn?\\p{L}* le pas|creus\\p{L}* l'écart|(?:loin )?derrière (?:les|ses|leurs)|à la traîne|au profit d(?:es|e ses|u)|tien\\p{L}* pas la comparaison|se val(?:ent|aient)(?![\\p{L}])|jeu égal|à côté d(?:es|e ses|e leurs)|l'emport");
const PERF_ADJ = "vus|vues|regardée?s?|partagée?s?|commentée?s?|enregistrée?s?|sauvegardée?s?|aimée?s?|likée?s?|repartagée?s?|retweetée?s?|lue?s|suivie?s?|efficaces?|performante?s?|populaires?|engageante?s?|porteu(?:r|se|rs|ses)|vira(?:l|le|les|ux)";
const DET = "(?:^|(?<![\\p{L}])(?:les|ses|des|leurs|le|la|son|sa|ce|ces|cette|chaque|un|une|l'|tes|ton|ta))\\s*";
// Un format sujet direct d'une comparaison de résultats (« Ses carrousels marchent mieux », « Les vidéos
// longues font mieux que d'habitude ») ou d'un jugement (« Les carrousels sont son point fort ») ; pas « Les
// carrousels pédagogiques marchent mieux », « Ses Reels les plus drôles », « pensés pour mieux expliquer ».
const formatCompared = (t, keys) => keys.some((k) => {
  const f = CMP_WORDS[k].source;
  return new RegExp(`${DET}(?:${f})\\s+(?:qui\\s+)?(?:ne\\s+|n')?(?:${PERF_VERBS})(?![\\p{L}])${WINDOW}(?:${COMPARE_PERF_ALTS})`, "iu").test(t)
    || new RegExp(`(?:${f})\\s+(?:(?:sont|restent|qui sont|semblent|demeurent|figurent parmi|font partie des|,)\\s+)?(?:de loin\\s+)?(?:le|la|les) (?:plus|moins) (?:${PERF_ADJ})(?![\\p{L}])`, "iu").test(t)
    || new RegExp(`${DET}(?:${f})(?:\\s+(?:sont|est|restent|reste))?\\s+(?:(?:son|sa|leur|ses|le|la|les|un|une)\\s+)?(?:points? forts?|points? faibles?|valeurs? sûres?|atouts?|locomotives?|plébiscitée?s?|boudée?s?|fon?t l'unanimité|passe(?:nt)? inaperçue?s?|pein\\p{L}* à (?:exister|percer|trouver leur public)|tire(?:nt)? (?:le compte )?vers le haut|porte(?:nt)? le compte|tire(?:nt)? leur épingle du jeu)(?![\\p{L}])`, "iu").test(t);
});
// Classement sur un compteur (« obtiennent le plus de partages », « Les carrousels sont les plus enregistrés »).
const RANK_SUBJ = `(?:${PUB_NOUNS}|tutos?|tutoriels?|avant / après|formats?)`;
const METRIC_RANK = new RegExp(`(?<![\\p{L}])(?:(?:le|la|les) (?:plus|moins) d(?:e |')(?:${METRICS})|${RANK_SUBJ}(?:\\s+[\\p{L}'-]+)?\\s+(?:le|la|les) (?:plus|moins) (?:${PERF_ADJ})|${RANK_SUBJ}(?:\\s+[\\p{L}'-]+){0,4}?\\s+(?:sont|restent|est|reste)\\s+(?:le|la|les) (?:plus|moins) (?:${PERF_ADJ})|(?:font|fait) le plus (?:réagir|parler|commenter|partager|cliquer)|en tête (?:des|du) (?:${METRICS}|classement)|haut du classement|(?:sont|est|restent|reste) (?:très|largement|massivement|abondamment|énormément|peu) (?:vue?s|partagée?s?|commentée?s?|enregistrée?s?|sauvegardée?s?|likée?s?|regardée?s?|repartagée?s?))(?![\\p{L}])`, "iu");
// Quantités sans chiffre (« un bon tiers de ses Reels », « beaucoup de commentaires », « plusieurs fois plus »).
const QUANTITY = new RegExp(`(?<![\\p{L}])(?:(?:un bon tiers|un bon quart|une bonne (?:partie|moitié)|une (?:large|grande) (?:part|partie)|le gros|presque (?:tous|toutes)|quasiment (?:tous|toutes)|l'immense majorité)\\s+(?:de |d'|des )?(?:ses |leurs |les |des )?(?:${PUB_NOUNS})|(?:beaucoup|énormément|peu|tant|pas mal|un maximum|plein|des tonnes|une avalanche|une pluie|un déluge|un flot|un grand nombre|un nombre (?:impressionnant|important|record|incroyable)) d(?:e |')(?:${METRICS})|(?:fait|font) pleuvoir les (?:${METRICS})|démultipli\\p{L}* (?:les|ses|leurs) (?:${METRICS})|plusieurs fois plus|(?:plus|moins) d(?:e |')(?:${METRICS})[^.!?]{0,40}que (?:les|ses|leurs|ceux|celles|des)|(?:surtout|principalement|essentiellement|majoritairement|en majorité|avant tout|pour l'essentiel|(?:presque )?exclusivement|quasi exclusivement)\\s+(?:des |de |en |sur des |par des |à des )?(?:reels?|carrousels?|photos?|vidéos?|shorts?|documents?|posts? textes?|tweets?|threads?|lives?|stories|diaporamas?))(?![\\p{L}])`, "iu");
// ↑ « surtout des vidéos courtes » : une part des formats, que le tableau « Formats et durées » mesure.
// Durées : unités de temps, ou longueur d'un contenu (« vidéos longues », « longues vidéos », « Reels brefs »).
// Sur YouTube, « vidéos longues » est un format (comparé par les règles des formats).
const LEN_NOUNS = "vidéos?|reels?|shorts?|formats?|contenus?|tiktoks?|lives?|textes?|posts?|légendes?";
const durationRe = (platform) => {
  const longNouns = platform === "youtube" ? LEN_NOUNS.replace("vidéos?|", "").replace("formats?|", "") : LEN_NOUNS;
  return new RegExp(`(?<![\\p{L}])(?:durées?|secondes?|minutes?|\\p{Nd}+\\s?(?:s|sec|min|mn)(?![\\p{L}])|(?:${LEN_NOUNS})\\s+(?:plus\\s+|moins\\s+|très\\s+|trop\\s+)?(?:courte?s?|courts|br(?:ef|efs|ève|èves)|express|éclairs?|condensée?s?)|(?:${longNouns})\\s+(?:plus\\s+|moins\\s+|très\\s+|trop\\s+)?(?:longue?s?|longs|à rallonge|fleuves?)|(?:courte?s?|courts|petite?s?|petits|brèves?|brefs?)\\s+(?:${LEN_NOUNS})|(?:longue?s?|longs)\\s+(?:${longNouns})|formats? (?:éclairs?|express))(?![\\p{L}])`, "iu");
};
const DURATION_EFFECT = /(?<![\p{L}])(?:perd|retien|retient|décroch|accroch|fidélis|lass)\p{L}*/iu;
const HASHTAG_WORD = /(?<![\p{L}])(?:hashtags?|mots?-dièses?|mots?-clics?|tags?)(?![\p{L}])/iu;

// --- Jugements de niveau et comparaisons avec d'autres comptes ---
const BENCH_GAP = "(?:(?!\\s(?:de|d'|des|du|aux?|en|qui|que|qu'|pour|sur|avec|dont|où)\\s)[^.!?]){0,40}?";
const LEVEL_ADJ = "solides?|élevée?s?|faibles?|forts?|fortes?|bons?|bonnes?|bas|basses?|hauts?|hautes?|mauvaise?s?|correcte?s?|honorables?|modestes?|excellente?s?|médiocres?|remarquables?|exceptionnel(?:le)?s?|impressionnante?s?|énormes?|massive?s?|engagée?s?|fidèles?|réactive?s?|réactifs|(?:très|plutôt|est|sont|reste|restent|et) actives?|actifs|limitée?s?|réduite?s?|records?|enviables?|satisfaisante?s?|timides?|décevante?s?|confidentiel(?:le)?s?|nombreu(?:x|se|ses)|hors du commun|au rendez-vous|ne suivent pas|ne suit pas|dignes? (?:des|d'un|d'une)|supérieure? à celui|supérieure? à celle";
const BENCH_CONC = /(?:mieux|plus|moins|davantage) que (?:ses|leurs|la|les) concurren|(?:démarqu|distingu|devanc|surpass|dépass|écras|domin|bat)\p{L}*(?:\s+\p{L}+)?\s+(?:de |d')?(?:ses|leurs|la|les) concurren|perd\p{L}* du terrain face à (?:ses|leurs|la|les) concurren/iu;
const BENCHMARK = [
  words("(?:que|qu'|par rapport à|comparée? à|face à|devant|derrière) (?:la |les |d'|ses |leurs |d'autres |des )?(?:moyenne|autres comptes|autres créateurs|autres créatrices|autres chaînes|autres pages|secteur|marché|norme|standards?)|(?:au-dessus|en dessous|au-dessous|au-delà) (?:de la|de sa|des) (?:moyenne|norme|standards?)|dans la moyenne|moyenne du (?:secteur|marché)|norme du secteur|standard du secteur|(?:engagement|vues|portée|audience|résultats|chiffres|statistiques|performances?) hors normes?|pour (?:la|sa) taille|pour un compte de|pour (?:un|une) (?:petite?|grande?|jeune|nouveau|nouvelle) (?:compte|chaîne|page|créateur|créatrice|profil)|comptes? de (?:cette|sa|même) taille|benchmark|(?:comptes?|créateurs?|créatrices?|chaînes?|pages?|profils?) de (?:sa|la même|cette|même) (?:niche|taille|catégorie|thématique)|(?:dépass|surpass|bat|battent|excèd)\\p{L}* (?:la|sa|leur) moyenne|records? de (?:vues|lectures|j'aime|likes|abonnés|partages|commentaires)|comptes? (?:similaires|comparables|équivalents|voisins|plus gros|établis)|plus gros comptes|(?:ses|leurs) (?:confrères|consœurs|pairs|homologues)|créat\\p{L}* du même (?:domaine|secteur|créneau|univers)|cour des grands|rivalis\\p{L}* avec (?:les|des|d')|(?:large|vaste|immense|petite) (?:communauté|audience)|(?:compte|chaîne|page|profil)s? (?:très |plutôt |si )?(?:suivie?s?|populaires?|influente?s?|en vue)|les plus suivie?s?"),
  new RegExp(`(?<![\\p{L}])(?:${PUB_NOUNS})(?:\\s+[\\p{L}'-]+){0,4}?\\s+bat (?:des|tous les|ses|son) records?|(?<![\\p{L}])(?:peu|aucune?|rares) (?:de |d')?(?:comptes|chaînes|pages|créat\\p{L}*)[^.!?]{0,40}(?:niveau|atteign)|(?<![\\p{L}])(?:${PUB_NOUNS})(?:\\s+[\\p{L}'-]+){0,3}?\\s+passe\\p{L}* inaperçue?s?`, "iu"),
  new RegExp(`(?<![\\p{L}])(?:engagement|taux d'engagement|taux de (?:clic|conversion|rétention)|portée|visibilité|audiences?|communautés?|public|(?:ses|son|sa|leurs?|les|l'|la|le) (?:vues|lectures|impressions|réactions|interactions|partages|commentaires|résultats|performances|chiffres|statistiques|stats)|des (?:réactions|interactions|partages|commentaires))(?![\\p{L}])${BENCH_GAP}\\s?(?<![\\p{L}])(?:${LEVEL_ADJ})(?![\\p{L}])`, "iu"),
  words("(?:solide|fort|forte|faible|excellent|excellente|énorme|belle|beau|bon|bonne|gros|grosse|haut|bas|mauvais|mauvaise|réel|vrai|vraie|grande|immense) (?:engagement|taux d'engagement|portée|visibilité|audience|communauté)"),
  words("(?:communautés?|audiences?|abonnés|abonnées|fans) (?:très |plutôt |)?(?:actives?|actifs|réactives?|réactifs|soudée?s?|fidèles?|impliquée?s?|investie?s?|assidue?s?|fidélisée?s?|restreinte?s?|nombreu(?:x|se|ses))"),
  BENCH_CONC,
];

// Résultat chiffré du compte dans une idée (« l'avant / après à 90 000 lectures », « vu 90 000 fois »,
// « 3 fois plus de vues ») ; pas les nombres pour le public de la personne (« tes 1 000 premiers abonnés »,
// « si tu as moins de 1 000 abonnés ») ni les petits nombres d'un titre (« Mes 5 lectures préférées »).
const BIG = "(?:\\p{Nd}{1,3}(?:[\\s\\u00a0\\u202f.]\\p{Nd}{3})+|\\p{Nd}{3,}|\\p{Nd}+(?:[.,]\\p{Nd}+)?\\s?(?:k|K|M|millions?|milliers?|mille))";
const METRIC_NUMBER = new RegExp(`(?<!(?:tes|ton|ta|vos|votre|mes|mon|ma|nos|notre|moins de|si tu as|tu as|premiers|premières)\\s+)(?<!\\p{N}[\\s\\u00a0\\u202f.,]?)${BIG}\\s+(?:premiers?\\s+|premières?\\s+)?(?:de |d')?(?:${METRICS})(?![\\p{L}])|(?<![\\p{L}])(?:des (?:milliers|millions|centaines)|un million|cent mille) d(?:e |')(?:${METRICS})(?![\\p{L}])`, "iu");
const METRIC_TIMES = new RegExp(`(?<![\\p{L}])(?:(?:vue?s?|lue?s?|regardée?s?|partagée?s?|aimée?s?|likée?s?|commentée?s?|enregistrée?s?)\\s+(?:plus de\\s+|près de\\s+|environ\\s+)?${BIG}(?:\\s+de)?\\s+fois|\\p{Nd}+(?:[.,]\\p{Nd}+)?\\s?(?:fois|x|×)\\s+(?:plus|moins)\\s+d(?:e |')(?:${METRICS})|(?:au|aux|à)\\s+(?:millions?|milliers?|centaines?|dizaines?)\\s+(?:de |d')(?:${METRICS})|(?:a |qui a |ont )?(?:dépassé|franchi|atteint) (?:le|les|la barre (?:des|du)) (?:million|\\p{Nd}))(?![\\p{L}])`, "iu");
const IDEA_RESULT = stems("(?:a|ont|avait|avaient) (?:explosé|cartonné)|(?:a|ont) fait (?:un carton|le buzz|un tabac|un malheur|exploser)|affolé les compteurs|(?:avant / après|tutos?|reels?|vidéos?|posts?|recettes?|carrousels?|publications?|contenus?|tiktoks?|shorts?)\\s+vira(?:l|le|les|ux)(?![\\p{L}])|devenue?s? vira|(?:son|sa|ses|leur) (?:carton|tube|hit|best-seller|succès)(?![\\p{L}])|format qui (?:lui|le|la) (?:réussit|porte)|là où (?:il|elle) (?:performe|cartonne)");
// « Ses vues », « son engagement » : les résultats du compte analysé (dans une idée, « tes abonnés » est le
// public de la personne, pas le compte).
const THIRD_PERF = new RegExp(`(?<![\\p{L}])(?:ses|son|sa) (?:vues|lectures|impressions|réactions|interactions|commentaires|partages|abonnés|abonnées|followers|engagement|résultats|performances|stats|statistiques|chiffres|portée|audience|communauté)(?![\\p{L}])${WINDOW}(?<![\\p{L}])(?:${CHANGE_ALTS}|${COMPARE_PERF_ALTS})|(?<![\\p{L}])(?:${CHANGE_ALTS})\\p{L}*\\s+(?:ses|son|sa) (?:vues|lectures|impressions|réactions|interactions|commentaires|partages|abonnés|abonnées|followers|engagement|résultats|performances|stats|chiffres|portée|audience)(?![\\p{L}])`, "iu");
// Référence « P3 » dans le texte : le numéro n'est montré nulle part, les publications citées le sont.
const POST_REF = /(?<![\p{L}\p{N}])P\p{Nd}+(?![\p{L}\p{N}])/u;

// Apostrophe typographique (’) ramenée à l'apostrophe droite pour les tests, jamais dans le texte affiché.
const straight = (t) => String(t || "").replace(/[’ʼ‘]/gu, "'");

// Raison d'écarter une phrase, ou null. `only` restreint aux sujets donnés (champs des idées) ;
// « accountClaim », « ideaResult » ne s'appliquent qu'aux idées (demandés explicitement).
function topicProblem(text, { numbers = true, only = null, platform = null } = {}) {
  const raw = straight(text);
  const t = neutral(raw);
  const tq = unquoted(t);
  const on = (k) => !only || only.includes(k);
  const asked = (k) => Boolean(only?.includes(k));
  const named = namedFormats(t, platform, CMP_WORDS);
  if (POST_REF.test(raw)) return "désigne une publication par son numéro : les publications citées sont montrées sous le constat";
  if (numbers && on("numbers")) {
    const nums = writtenNumbers(raw);
    if (nums.length) return `nombre écrit par Claude (${nums.join(", ")}) : les chiffres viennent uniquement des calculs`;
    if (QUANTITY.test(t)) return "donne une quantité ou une proportion : les chiffres viennent uniquement des calculs";
  }
  if (on("metricNumber") && (METRIC_NUMBER.test(raw) || METRIC_TIMES.test(raw))) return "donne un résultat chiffré du compte : les chiffres viennent uniquement des calculs";
  if (asked("ideaResult") && IDEA_RESULT.test(t)) return "affirme un résultat du compte analysé : c'est aux calculs de le dire";
  if (asked("accountClaim") && THIRD_PERF.test(t)) return "affirme un résultat du compte analysé : c'est aux calculs de le dire";
  const slot = SLOT_WORDS.test(t) || HOUR.test(t) || RECO_TIME.test(t) || PUBLISH_NOUN_TIME.test(t)
    || (SLOT_QUAL.test(t) && (TIME_WORD.test(t) || publishes(t) || PUB_NOUN.test(t)))
    || (TIME_WORD.test(t) && (publishes(t) || CRENEAU.test(t) || PUB_PERF_CMP.test(t) || PERF_SUBJ_CMP.test(t) || AUDIENCE_ACTIVE.test(t) || TIME_PERF.test(t)))
    || ((WHEN_ACTIVE.test(t) || PUBLISH_ONLY_TIME.test(t)) && (publishes(t) || /(?<![\p{L}])posée?s?(?![\p{L}])/iu.test(t) || WHEN_ACTIVE.test(t)))
    || SERIES_TIME.test(t);
  if (on("time") && slot) return "parle d'un jour ou d'un moment de publication : c'est aux calculs (« Moments de publication ») de le dire";
  if (on("frequency") && (FREQUENCY.some((r) => r.test(t)) || (RHYTHM.test(t) && (publishes(t) || PUB_NOUN.test(t) || RHYTHM_CTX.test(t))) || (platform === "youtube" && /(?<![\p{L}])sorties? (?:par|chaque) (?:jour|semaine|mois)/iu.test(t)))) {
    return "parle du rythme de publication : c'est aux calculs (tuile « Rythme ») de le dire";
  }
  if (on("growth") && (GROWTH.test(t) || GROWTH_RE.test(t) || AUDIENCE_CHANGE.test(t) || ACCOUNT_CHANGE.test(t) || ACCOUNT_CHANGE_AFTER.test(t))) {
    return "parle de la croissance des abonnés : seule une mesure entre deux analyses peut le dire";
  }
  if (on("trend") && (EVOLUTION.test(t) || EVOLUTION_CTX.test(t) || PERF_CHANGE.test(t) || CONTENT_CHANGE.test(t) || INTEREST_FADE.test(t) || LEN_CHANGE.test(t)
    || (TEMPORAL_STRONG.test(tq) && COMPARE.test(tq)) || (TEMPORAL_WEAK.test(tq) && (PUB_PERF_CMP.test(tq) || PERF_SUBJ_CMP.test(tq)))
    || HABITUAL_DATED.test(tq) || PAST_PERF.test(tq) || (NO_LONGER.test(tq) && (PUB_NOUN.test(tq) || PERF.test(tq) || /tutos?|recettes?|avant \/ après|réagir|impact|effet|écho|succès/iu.test(tq))))) {
    return "parle d'une évolution dans le temps : c'est aux calculs (tuile « Évolution ») de le dire";
  }
  if (on("benchmark") && BENCHMARK.some((r) => r.test(t)) && !(BENCH_CONC.test(t) && /(?<![\p{L}])(?:comment|aide|aider|explique)/iu.test(t.slice(0, t.search(BENCH_CONC))))) {
    return "juge un niveau ou se compare à d'autres comptes sans mesure de référence";
  }
  if (on("formats")) {
    const specific = specificFormats(named, platform);
    if ((named.length >= 2 && (formatCompared(t, named) || FORMAT_VS.test(t) || new RegExp(`(?:que|qu'|contrairement aux?|plutôt que|face aux?|par rapport aux?|à côté des?|derrière les?)\\s+(?:les |ses |leurs |des |aux )?(?:${named.map((k) => CMP_WORDS[k].source).join("|")})`, "iu").test(t)))
      || (specific.length >= 1 && (SUPERLATIVE.test(t) || formatCompared(t, specific)))) {
      return "compare des formats : c'est au tableau « Formats et durées » de le dire";
    }
    if (METRIC_RANK.test(t)) return "classe des publications sur un compteur : c'est aux calculs de le dire";
    if (durationRe(platform).test(t) && (COMPARE_PERF.test(t) || SUPERLATIVE.test(t) || DURATION_EFFECT.test(t))) return "compare des durées : c'est au tableau « Formats et durées » de le dire";
    if (/#[\p{L}\p{N}_]/u.test(t) || (HASHTAG_WORD.test(t) && (COMPARE.test(t) || SUPERLATIVE.test(t)))) return "juge des hashtags : c'est au relevé des hashtags de le dire";
  }
  return null;
}

// Un constat qui nomme un ou plusieurs formats est illustré par des publications de ces formats.
function proofFormatProblem(text, posts, platform) {
  if (!posts.length) return null;
  const named = namedFormats(neutral(straight(text)), platform, PROOF_WORDS);
  if (!named.length) return null;
  const allowed = new Set(named.flatMap((k) => FORMAT_TYPES[k] || []));
  return posts.some((p) => !allowed.has(p.type)) ? "illustré par des publications d'un autre format que celui qu'il nomme" : null;
}

// Phrases d'un paragraphe ; une phrase qui pose problème est retirée, le reste est gardé.
const sentences = (text) => String(text || "").match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((x) => x.trim()).filter(Boolean) || [];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Valide la réponse de Claude contre les données ; renvoie l'analyse à afficher et ce qui a été écarté. */
export function validateInsights(out, a) {
  const list = numbering(a);
  const platform = a.platform;
  const topic = (x, opts = {}) => topicProblem(x, { ...opts, platform });
  const dropped = [];
  const drop = (where, texte, raison) => {
    dropped.push({ where, texte: String(texte || "").slice(0, 300), raison });
    return null;
  };
  const post = (n) => list[n - 1] || null;
  const usable = (p) => p && p.status !== "épinglé" && p.status !== "trop récent";
  const refs = (ns, test = () => true) => [...new Set(Array.isArray(ns) ? ns : [])].map(post).filter((p) => usable(p) && test(p));
  const isUp = (p) => p.status === "au-dessus";
  const isDown = (p) => p.status === "en dessous";
  const notDown = (p) => p.ratio !== null && p.ratio >= 1;
  const arr = (x) => (Array.isArray(x) ? x : []);
  const str = (x) => (typeof x === "string" ? x.trim() : "");

  // Un constat se prouve par des publications : au-dessus de leur médiane pour ce qui marche et les forces,
  // en dessous pour ce qui marche moins et les faiblesses. Les pistes (opportunités, recommandations)
  // peuvent citer des exemples, jamais une publication en dessous de sa médiane.
  const claim = (c, where, { proof = () => true, required = false } = {}) => {
    const texte = str(c?.texte);
    if (!texte) return null;
    const posts = refs(c.publications, proof);
    if (required && !posts.length) {
      return drop(where, texte, `aucune publication ${proof === isDown ? "en dessous" : "au-dessus"} de sa médiane ne l'appuie`);
    }
    const problem = topic(texte) || proofFormatProblem(texte, posts, platform);
    if (problem) return drop(where, texte, problem);
    return { texte, posts: posts.map((p) => p.id), ...(c.priorite ? { priorite: c.priorite } : {}) };
  };
  const claims = (items, where, opts) => arr(items).map((c) => claim(c, where, opts)).filter(Boolean);

  const paragraph = (text, where) =>
    sentences(str(text))
      .filter((x) => {
        const problem = topic(x);
        if (problem) drop(where, x, problem);
        return !problem;
      })
      .join(" ");

  // Thèmes : des étiquettes de sujet (« Routine du matin » est un sujet, pas un créneau), contrôlées comme
  // le reste, et illustrées par des publications de ce thème.
  const themes = arr(out.themes)
    .map((t) => ({ nom: str(t?.nom), posts: refs(t?.publications) }))
    .filter((t) => {
      if (!t.nom) return false;
      const problem = topic(t.nom);
      if (problem) return drop("thèmes", t.nom, problem);
      if (!t.posts.length) return drop("thèmes", t.nom, "aucune publication de ce thème n'est citée");
      return true;
    })
    .map((t) => ({ nom: t.nom, posts: t.posts.map((p) => p.id) }));

  const accroches = arr(out.accroches)
    .map((h) => ({ type: str(h?.type), post: post(h?.publication), pourquoi: str(h?.pourquoi) }))
    .filter((h) => {
      const label = `${h.type} · ${h.pourquoi}`;
      if (!usable(h.post) || !isUp(h.post)) return drop("accroches", label, "la publication citée n'est pas au-dessus de sa médiane");
      const problem = topic(`${h.type}. ${h.pourquoi}`);
      if (problem) return drop("accroches", label, problem);
      return true;
    })
    .map((h) => ({ type: h.type, post: h.post.id, pourquoi: h.pourquoi }));

  // Idées : le titre, le format et l'accroche sont des propositions pour la personne (« Carrousel
  // 6 slides », une accroche chiffrée sont permis) : ils ne fixent ni créneau ni rythme, ne disent rien
  // des formats ni des résultats du compte (« à 90 000 lectures », « qui a fait exploser ses vues ») ; le
  // mécanisme repris vient de publications au-dessus de leur médiane et ne touche aucun sujet réservé. La
  // seconde lecture contrôle le reste.
  const idees = arr(out.idees)
    .map((i) => ({ ...i, titre: str(i?.titre), format: str(i?.format), accroche: str(i?.accroche), angle: str(i?.angle), inspiree_de: refs(i?.inspiree_de, isUp).map((p) => p.id) }))
    .filter((i) => {
      if (!i.titre) return false;
      if (!i.inspiree_de.length) return drop("idées", i.titre, "aucune publication au-dessus de sa médiane ne la fonde");
      const problem = topic(i.angle) || topic(i.angle, { only: ["ideaResult", "accountClaim"] })
        || [i.titre, i.format].map((x) => topic(x, { only: ["time", "frequency", "formats", "benchmark", "metricNumber", "accountClaim", "ideaResult"] })).find(Boolean)
        || topic(i.accroche, { only: ["time", "frequency", "metricNumber", "accountClaim", "ideaResult"] });
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
    marche: claims(out.ce_qui_marche, "ce qui marche", { proof: isUp, required: true }),
    marcheMoins: claims(out.ce_qui_marche_moins, "ce qui marche moins", { proof: isDown, required: true }),
    accroches,
    swot: {
      forces: claims(out.forces, "forces", { proof: isUp, required: true }),
      faiblesses: claims(out.faiblesses, "faiblesses", { proof: isDown, required: true }),
      opportunites: claims(out.opportunites, "opportunités", { proof: notDown }),
      menaces: claims(out.menaces, "menaces"),
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

// Seconde lecture : Claude classe chaque texte gardé, thèmes compris (un sujet réservé abordé autrement ?).
// Ce qu'il signale est écarté, comme un verdict illisible. Champs des idées (titre, format, accroche) :
// les nombres y sont permis, pas un résultat du compte analysé.
export async function semanticCheck(ins, { timeoutMs, onUsage } = {}) {
  const items = [];
  const add = (id, texte, ideaField = false) => texte && items.push({ id: items.length + 1, key: id, texte, ideaField });
  sentences(ins.positionnement).forEach((s, i) => add(`portrait:${i}`, s));
  sentences(ins.voix.resume).forEach((s, i) => add(`style:${i}`, s));
  ins.themes.forEach((t, i) => add(`themes:${i}`, t.nom));
  const lists = { marche: ins.marche, marcheMoins: ins.marcheMoins, recommandations: ins.recommandations, ...Object.fromEntries(Object.entries(ins.swot).map(([k, v]) => [`swot.${k}`, v])) };
  for (const [k, v] of Object.entries(lists)) v.forEach((c, i) => add(`${k}:${i}`, c.texte));
  ins.accroches.forEach((h, i) => add(`accroches:${i}`, `${h.type}. ${h.pourquoi}`));
  ins.idees.forEach((d, i) => {
    add(`idees:${i}`, d.angle);
    add(`idees:${i}`, [d.titre, d.format, d.accroche].join(" · "), true);
  });
  if (!items.length) return ins;
  const verdicts = await classifyAccountTexts({ items: items.map(({ id, texte, ideaField }) => ({ id, texte, propositions: ideaField })), timeoutMs, onUsage });
  // Un verdict pour chaque texte, ni plus ni moins : un texte non classé n'est pas contrôlé, donc rien n'est montré.
  const byId = new Map();
  for (const v of verdicts) {
    if (byId.has(v.id) || !items.some((x) => x.id === v.id)) throw new Error("verdicts incohérents");
    byId.set(v.id, v);
  }
  if (byId.size !== items.length) throw new Error(`${items.length - byId.size} texte(s) sans verdict`);
  const flagged = new Map();
  for (const item of items) {
    const v = byId.get(item.id);
    if (!v.sujet || v.sujet === "aucun") continue;
    // Propositions d'idées : les nombres y sont permis.
    if (item.ideaField && v.sujet === "chiffre") continue;
    flagged.set(item.key, [...(flagged.get(item.key) || []), { texte: item.texte, sujet: v.sujet }]);
  }
  if (!flagged.size) return ins;
  const details = [...ins.controle.details];
  const why = (f) => `seconde lecture : aborde un sujet réservé aux calculs (${f.sujet})`;
  const where = { portrait: "portrait", style: "style d'écriture", themes: "thèmes", marche: "ce qui marche", marcheMoins: "ce qui marche moins", recommandations: "recommandations", "swot.forces": "forces", "swot.faiblesses": "faiblesses", "swot.opportunites": "opportunités", "swot.menaces": "menaces", accroches: "accroches", idees: "idées" };
  for (const [key, fs] of flagged) for (const f of fs) details.push({ where: where[key.split(":")[0]], texte: f.texte.slice(0, 300), raison: why(f) });
  const keep = (k, i) => !flagged.has(`${k}:${i}`);
  const keepSentences = (text, k) => sentences(text).filter((_, i) => keep(k, i)).join(" ");
  return {
    ...ins,
    positionnement: keepSentences(ins.positionnement, "portrait"),
    voix: { ...ins.voix, resume: keepSentences(ins.voix.resume, "style") },
    themes: ins.themes.filter((_, i) => keep("themes", i)),
    marche: ins.marche.filter((_, i) => keep("marche", i)),
    marcheMoins: ins.marcheMoins.filter((_, i) => keep("marcheMoins", i)),
    recommandations: ins.recommandations.filter((_, i) => keep("recommandations", i)),
    swot: Object.fromEntries(Object.entries(ins.swot).map(([k, v]) => [k, v.filter((_, i) => keep(`swot.${k}`, i))])),
    accroches: ins.accroches.filter((_, i) => keep("accroches", i)),
    idees: ins.idees.filter((_, i) => keep("idees", i)),
    controle: { ecartes: details.length, details },
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
      // Le temps est partagé : la lecture, puis la seconde lecture de contrôle (45 s réservées).
      const deadline = timeoutMs ? Date.now() + timeoutMs : null;
      const out = await analyzeAccount({
        platformLabel: ACCOUNT_LABELS[cur.platform],
        profileText: profileText(cur),
        summaryText: indicatorLines(cur),
        postsText: postLines(cur),
        images: imgs.map((im) => ({ n: nOf.get(im.key), mediaType: im.mediaType, data: im.data })),
        timeoutMs: deadline ? Math.max(30000, timeoutMs - 45000) : undefined,
        onUsage: (usd) => (cost += usd || 0),
      }).catch((err) => {
        // L'effort de cette lecture est fixe : le conseil général sur CLAUDE_EFFORT ne s'applique pas ici.
        if (err.timeout) throw new Error("La lecture du compte a dépassé le temps disponible. Relance-la : les chiffres sont gardés, seule la lecture par Claude est refaite.");
        throw err;
      });
      // Rien n'est montré sans la seconde lecture : si elle échoue, la lecture est à relancer.
      let checked;
      try {
        checked = await semanticCheck(validateInsights(out, cur), {
          timeoutMs: deadline ? Math.max(10000, deadline - Date.now() - 3000) : undefined,
          onUsage: (usd) => (cost += usd || 0),
        });
      } catch (err) {
        const why = err.timeout ? "temps disponible dépassé" : err.message;
        throw new Error(`La seconde lecture de contrôle n'a pas abouti (${why}) : rien n'est montré sans elle. Relance la lecture.`);
      }
      return await save({ insights: { ...checked, images: imgs.length, checked: true }, insightsError: null }, cost);
    } catch (err) {
      await save({ insightsError: err.message }, cost);
      throw err;
    }
  } finally {
    await releaseLock(lockKey).catch(() => {});
  }
}
