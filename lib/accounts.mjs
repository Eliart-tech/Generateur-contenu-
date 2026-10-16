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
import { computeAccountMetrics, VIEW_LABEL, engagementFormula, PERIODS, writtenNumbers } from "./account-metrics.mjs";
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
async function withLock(key, fn, { ttlMs = 15000, waitMs = 8000 } = {}) {
  const until = Date.now() + waitMs;
  let got = await acquireLock(key, ttlMs).catch(() => false);
  while (!got && Date.now() < until) {
    await sleep(150);
    got = await acquireLock(key, ttlMs).catch(() => false);
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
    const list = (await cacheGet(INDEX_KEY, TTL)) || [];
    const next = list.filter((r) => r.id !== a.id);
    if (!remove) next.unshift(indexRow(a));
    next.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
    await cacheSet(INDEX_KEY, next.slice(0, 120), TTL);
  }).catch((err) => console.error(`Index des comptes non mis à jour : ${err.message}`));
}

async function updateHistory(a, change) {
  const hk = histKey(a.platform, a.key);
  await withLock(`${hk}-lock`, async () => {
    const hist = (await cacheGet(hk, TTL)) || [];
    await cacheSet(hk, change(hist.filter((h) => h.id !== a.id)).slice(-60), TTL);
  }).catch((err) => console.error(`Historique du compte non mis à jour : ${err.message}`));
}

export async function listAccountAnalyses() {
  return (await cacheGet(INDEX_KEY, TTL).catch(() => null)) || [];
}

export async function deleteAccountAnalysis(id) {
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
    await finalizeAnalysis(a, data, scrapedAt(a));
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
  // Historique illisible (panne passagère) : pas de croissance cette fois, mais rien n'est effacé.
  const hist = ((await cacheGet(hk, TTL).catch(() => null)) || []).filter((h) => h.id !== a.id);
  a.profile = data.profile;
  a.posts = data.posts.slice(0, 60);
  a.notes = data.notes || [];
  a.scrapedAt = new Date(at).toISOString();
  a.metrics = computeAccountMetrics({ platform: a.platform, profile: a.profile, posts: a.posts, now: at, history: hist });
  a.status = "done";
  a.finishedAt = new Date().toISOString();
  if (Number.isFinite(a.profile?.followers)) {
    const point = { id: a.id, at: a.scrapedAt, followers: a.profile.followers, postsCount: a.profile.postsCount ?? null };
    await updateHistory(a, (h) => [...h, point].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)));
  }
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
  return (await listAccountAnalyses()).filter((r) => sameAccount(r, platform, key));
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
    ? `[engagement] (${e.formula}) ÷ abonnés : médiane ${frPct(e.perFollower.median)} %, moyenne ${frPct(e.perFollower.mean)} % (${e.perFollower.n} publications)${e.perView ? ` ; ÷ ${m.performance.views.label} : médiane ${frPct(e.perView.median)} %` : ""}.`
    : "[engagement] nombre d'abonnés inconnu : pas d'engagement par abonné.");
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
    : "[croissance] inconnue (pas deux analyses comparables de ce compte) : n'en parle pas.");
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
    case "frequence": return Boolean(m.cadence?.perWeek !== null && m.cadence?.perWeek !== undefined);
    case "regularite": return Boolean(m.cadence?.regularity);
    case "engagement": return Boolean(m.engagement?.perFollower || m.engagement?.perView);
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

// Ce qu'un texte affirme sans le dire en chiffres : un jour ou un moment, une croissance, une évolution.
const L = "\\p{L}";
const word = (alts) => new RegExp(`(?<![${L}])(?:${alts})(?![${L}])`, "iu");
const DAY_RE = /(?<![\p{L}])(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)s?(?![\p{L}])/giu;
const WEEKEND_RE = word("week-ends?|weekends?|fins? de semaine");
const PERIOD_WORDS = [["après-midi", "après-midi"], ["matin", "matin"], ["matinée", "matin"], ["matinées", "matin"], ["matins", "matin"], ["soir", "soir"], ["soirs", "soir"], ["soirée", "soir"], ["soirées", "soir"], ["la nuit", "nuit"], ["de nuit", "nuit"], ["nuits", "nuit"]];
const PERIOD_RE = new RegExp(`(?<![\\p{L}-])(${PERIOD_WORDS.map(([w]) => w).join("|")})(?![\\p{L}-])`, "giu");
const HOUR_RE = word("heures? de publication|horaires?|créneaux?|moment de publication|moments de publication");
const GROWTH_RE = word("croissance|stagne|stagnent|stagnation|(?:gagne|gagnent|perd|perdent|attire|attirent|gagner|perdre|attirer)(?: de| des)?(?: nouveaux)? abonnés|nouveaux abonnés|abonnés en plus|abonnés en moins");
const UP_RE = word("en hausse|progresse|progressent|progression|repart|repartent|décolle|décollent|s'améliore|s'améliorent");
const DOWN_RE = word("en baisse|recule|reculent|recul|s'essouffle|s'essoufflent|essoufflement|décline|déclinent|déclin|en perte de vitesse");

/**
 * Ce que dit un texte doit être appuyé par ce que les calculs ont trouvé. Renvoie la raison d'écarter
 * le texte, ou null. `trendCheck` : le sens d'une évolution (hausse, baisse) doit être celui mesuré.
 */
function textProblem(text, m, { trendCheck = true } = {}) {
  const nums = writtenNumbers(text);
  if (nums.length) return `nombre écrit par Claude (${nums.join(", ")}) : les chiffres viennent uniquement des calculs`;
  const t = String(text || "");
  const days = [...t.matchAll(DAY_RE)].map((x) => x[1].toLowerCase());
  const periods = [...t.matchAll(PERIOD_RE)].map((x) => PERIOD_WORDS.find(([w]) => w === x[1].toLowerCase())?.[1]);
  const weekend = WEEKEND_RE.test(t);
  if (days.length || periods.length || weekend || HOUR_RE.test(t)) {
    const bd = m.timing?.bestDay?.key;
    const bp = m.timing?.bestPeriod?.key;
    if (!bd && !bp) return "parle d'un jour ou d'un moment alors qu'aucun ne ressort des publications";
    if (days.some((d) => d !== bd) || (weekend && !["samedi", "dimanche"].includes(bd)) || periods.some((p) => p !== bp)) {
      return `ne correspond pas au créneau qui ressort (${[bd && `le ${bd}`, bp && PERIOD_LABEL[bp]].filter(Boolean).join(", ")})`;
    }
  }
  if (GROWTH_RE.test(t) && !m.growth) return "parle de la croissance des abonnés alors qu'elle n'est pas mesurée";
  if (trendCheck && (UP_RE.test(t) || DOWN_RE.test(t))) {
    if (!m.trend) return "parle d'une évolution alors qu'elle n'est pas mesurable avec ces publications";
    const up = UP_RE.test(t);
    const down = DOWN_RE.test(t);
    const pct = m.trend.changePct ?? 0;
    if ((up && !down && pct <= 0) || (down && !up && pct >= 0)) return "contredit l'évolution mesurée";
  }
  return null;
}

// Phrases d'un paragraphe ; une phrase qui pose problème est retirée, le reste est gardé.
const sentences = (text) => String(text || "").match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((x) => x.trim()).filter(Boolean) || [];

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
  const refs = (ns, test = () => true) => [...new Set(ns || [])].map(post).filter((p) => usable(p) && test(p)).map((p) => p.id);
  const isUp = (p) => p.status === "au-dessus";
  const isDown = (p) => p.status === "en dessous";
  const notDown = (p) => p.ratio !== null && p.ratio >= 1;
  const notUp = (p) => p.ratio !== null && p.ratio <= 1;

  // proof : statut exigé des publications citées ; required : au moins une publication de ce statut,
  // quel que soit l'appui (« ce qui marche » se prouve par des publications au-dessus de leur médiane).
  const claim = (c, where, { proof = () => true, required = false } = {}) => {
    const posts = refs(c.publications, proof);
    const appui = ACCOUNT_SUPPORTS.includes(c.appui) ? c.appui : "publications";
    if (appui !== "publications" && !supportAvailable(appui, m)) {
      return drop(where, c.texte, `l'indicateur « ${appui} » n'est pas calculable avec ces données`);
    }
    if ((required || appui === "publications") && !posts.length) {
      return drop(where, c.texte, required ? `aucune publication ${where === "ce qui marche moins" ? "en dessous" : "au-dessus"} de sa médiane ne l'appuie` : "aucune publication ne l'appuie");
    }
    const problem = textProblem(c.texte, m, { trendCheck: where !== "recommandations" });
    if (problem) return drop(where, c.texte, problem);
    return { texte: c.texte, appui, posts, ...(c.priorite ? { priorite: c.priorite } : {}) };
  };
  const claims = (arr, where, opts) => (arr || []).map((c) => claim(c, where, opts)).filter(Boolean);

  // Paragraphes : chaque phrase est vérifiée ; celles qui posent problème sont retirées.
  const paragraph = (text, where) =>
    sentences(text)
      .filter((x) => {
        const problem = textProblem(x, m);
        if (problem) drop(where, x, problem);
        return !problem;
      })
      .join(" ");

  const themes = (out.themes || [])
    .map((t) => ({ nom: String(t.nom || "").trim(), posts: refs(t.publications) }))
    .filter((t) => {
      if (!t.nom) return false;
      const problem = textProblem(t.nom, m);
      if (problem) return drop("thèmes", t.nom, problem);
      if (!t.posts.length) return drop("thèmes", t.nom, "aucune publication de ce thème n'est citée");
      return true;
    });

  const accroches = (out.accroches || [])
    .map((h) => ({ type: String(h.type || "").trim(), post: post(h.publication), pourquoi: String(h.pourquoi || "").trim() }))
    .filter((h) => {
      if (!usable(h.post) || !isUp(h.post)) return drop("accroches", `${h.type} · ${h.pourquoi}`, "la publication citée n'est pas au-dessus de sa médiane");
      const problem = textProblem(`${h.type}. ${h.pourquoi}`, m);
      if (problem) return drop("accroches", `${h.type} · ${h.pourquoi}`, problem);
      return true;
    })
    .map((h) => ({ type: h.type, post: h.post.id, pourquoi: h.pourquoi }));

  // Idées : le titre, le format et l'accroche sont des propositions (un « carrousel 6 slides » est permis) ;
  // le mécanisme repris, lui, doit venir de publications au-dessus de leur médiane.
  const idees = (out.idees || [])
    .map((i) => ({ ...i, inspiree_de: refs(i.inspiree_de, isUp) }))
    .filter((i) => {
      if (!i.inspiree_de.length) return drop("idées", i.titre, "aucune publication au-dessus de sa médiane ne la fonde");
      const problem = textProblem(i.angle, m);
      if (problem) return drop("idées", i.angle, problem);
      return true;
    });

  // Expression récurrente : au moins deux mots, lus tels quels dans au moins deux légendes.
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
  const captions = list.filter((p) => p.status !== "épinglé").map((p) => norm(p.text));
  const expressions = (out.voix?.expressions || []).filter((x) => {
    const e = norm(x);
    if (e.split(" ").length < 2) return false;
    return captions.filter((t) => t.includes(e)).length >= 2;
  });

  return {
    createdAt: new Date().toISOString(),
    positionnement: paragraph(out.positionnement, "portrait"),
    themes,
    marche: claims(out.ce_qui_marche, "ce qui marche", { proof: isUp, required: true }),
    marcheMoins: claims(out.ce_qui_marche_moins, "ce qui marche moins", { proof: isDown, required: true }),
    accroches,
    swot: {
      forces: claims(out.forces, "forces", { proof: notDown }),
      faiblesses: claims(out.faiblesses, "faiblesses", { proof: notUp }),
      opportunites: claims(out.opportunites, "opportunités"),
      menaces: claims(out.menaces, "menaces"),
    },
    recommandations: claims(out.recommandations, "recommandations"),
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
