// Analyse de compte : calculs à partir des publications relevées. Fonctions pures, sans réseau.
//
// Règles qui évitent les erreurs repérées chez d'autres outils :
// - les publications épinglées sont écartées (anciennes et remontées en tête du profil, elles
//   faussent la fréquence et les comparaisons) ; les retweets et republications aussi (pas du contenu
//   de l'auteur), ainsi que les suites de fil sur X (seul le premier post d'un fil compte) ;
// - les heures sont en heure de Paris ;
// - une publication n'est comparée qu'à celles de sa propre famille (Reels entre eux, photos et
//   carrousels entre eux, Shorts entre eux…), sur une même mesure (lectures, vues, impressions ou
//   engagement), jamais en mélangeant les compteurs ; sur YouTube, les vidéos publiées avant le
//   24 août 2026 (ancien décompte des vues) forment leurs propres familles ;
// - une publication trop récente n'est pas encore jugée : elle n'a pas fini d'accumuler ;
// - médianes plutôt que moyennes (une seule publication virale ne déforme pas le portrait) ;
// - pas de « meilleur jour » ni de « tendance » sans assez de publications pour le dire ;
// - aucune note globale : chaque indicateur affiche sa formule et le nombre de publications utilisées.

export const TIMEZONE = "Europe/Paris";
const DAY_MS = 864e5;

// Âge à partir duquel une publication a accumulé l'essentiel de son audience (heures).
const MATURE_H = { instagram: 72, tiktok: 72, x: 24, linkedin: 72, youtube: 72, youtube_long: 168 };
const MIN_GROUP = 4; // publications comparables minimum pour une médiane de référence
const MIN_SLOT = 3; // publications comparables minimum pour afficher la médiane d'un créneau, d'un format…
const MIN_BEST_SLOT = 5; // … et pour dire qu'un jour ou un moment « ressort »
const MIN_TREND = 12; // publications comparables (assez anciennes) minimum pour une évolution
// YouTube compte les vues dès le début de la lecture depuis cette date (tous formats) : avant / après
// ne se comparent pas.
const YOUTUBE_VIEWS_CHANGE = Date.parse("2026-08-24T00:00:00Z");

export const VIEW_LABEL = { instagram: "lectures", tiktok: "vues", youtube: "vues", x: "impressions", linkedin: "impressions" };

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function median(values) {
  const a = values.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(values) {
  const a = values.filter(isNum);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

const round = (v, d = 0) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// Jour et heure en heure de Paris (l'heure d'été est gérée par Intl).
const PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", hour: "2-digit", hourCycle: "h23" });
const WEEKDAYS = { Mon: "lundi", Tue: "mardi", Wed: "mercredi", Thu: "jeudi", Fri: "vendredi", Sat: "samedi", Sun: "dimanche" };
export const DAY_ORDER = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
export const PERIODS = [
  { key: "nuit", label: "la nuit (0 h – 6 h)", from: 0, to: 6 },
  { key: "matin", label: "le matin (6 h – 12 h)", from: 6, to: 12 },
  { key: "après-midi", label: "l'après-midi (12 h – 18 h)", from: 12, to: 18 },
  { key: "soir", label: "le soir (18 h – 24 h)", from: 18, to: 24 },
];

export function parisTime(iso) {
  const parts = Object.fromEntries(PARTS.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  return { day: WEEKDAYS[parts.weekday], hour, period: PERIODS.find((p) => hour >= p.from && hour < p.to)?.key };
}

// Famille de comparaison : on ne compare que des publications mesurées de la même façon.
function comparisonGroup(platform, post) {
  if (platform === "instagram") {
    if (isNum(post.views)) return { key: "video", label: "Reels et vidéos", measure: "views" };
    // Un Reel sans compteur de lectures n'a rien à faire avec les photos : sa propre famille.
    if (post.type === "reel" || post.type === "vidéo") return { key: "video-eng", label: "Reels sans compteur de lectures", measure: "engagement" };
    return { key: "photo", label: "photos et carrousels", measure: "engagement" };
  }
  if (platform === "youtube") {
    const before = Date.parse(post.createdAt) < YOUTUBE_VIEWS_CHANGE;
    const base = post.type === "short" ? { key: "short", label: "Shorts" } : { key: "long", label: "vidéos longues" };
    return before
      ? { key: `${base.key}-avant`, label: `${base.label} d'avant le 24 août 2026`, measure: "views", long: base.key === "long" }
      : { ...base, measure: "views", long: base.key === "long" };
  }
  if (platform === "tiktok") return { key: "video", label: "vidéos", measure: "views" };
  if (platform === "x") {
    // Impressions et engagement ne se mélangent jamais dans une même médiane.
    return isNum(post.views) ? { key: "post", label: "posts", measure: "views" } : { key: "post-eng", label: "posts sans compteur d'impressions", measure: "engagement" };
  }
  return { key: "post", label: "posts", measure: "engagement" };
}

// Interactions publiques de chaque réseau : [champ, libellé].
const ENGAGEMENT_PARTS = {
  instagram: [["likes", "j'aime"], ["comments", "commentaires"]],
  tiktok: [["likes", "j'aime"], ["comments", "commentaires"], ["shares", "partages"], ["saves", "enregistrements"]],
  youtube: [["likes", "j'aime"], ["comments", "commentaires"]],
  x: [["likes", "j'aime"], ["comments", "réponses"], ["shares", "reposts et citations"], ["saves", "signets"]],
  linkedin: [["likes", "réactions"], ["comments", "commentaires"], ["shares", "republications"]],
};

// Parties retenues pour un compte : les j'aime, plus chaque compteur présent sur au moins la moitié
// de ses publications (un relevé qui ne donne pas les signets ne les compte pour personne).
export function engagementParts(platform, posts = []) {
  const parts = ENGAGEMENT_PARTS[platform] || ENGAGEMENT_PARTS.instagram;
  return parts.filter(([field], i) => i === 0 || (posts.length && posts.filter((p) => isNum(p[field])).length >= posts.length / 2));
}

// Engagement d'une publication : somme des parties retenues ; inconnu si l'une manque (masquée).
export function engagementOf(post, parts) {
  if (post.likesHidden) return null;
  let sum = 0;
  for (const [field] of parts) {
    if (!isNum(post[field])) return null;
    sum += post[field];
  }
  return sum;
}

export function engagementFormula(platform, parts = ENGAGEMENT_PARTS[platform] || ENGAGEMENT_PARTS.instagram) {
  return parts.map(([, label]) => label).join(" + ");
}

function durationBucket(seconds) {
  if (!isNum(seconds)) return null;
  if (seconds < 15) return "moins de 15 s";
  if (seconds < 30) return "15 à 30 s";
  if (seconds < 60) return "30 à 60 s";
  if (seconds < 180) return "1 à 3 min";
  if (seconds < 600) return "3 à 10 min";
  if (seconds < 1200) return "10 à 20 min";
  return "plus de 20 min";
}
const DURATION_ORDER = ["moins de 15 s", "15 à 30 s", "30 à 60 s", "1 à 3 min", "3 à 10 min", "10 à 20 min", "plus de 20 min"];

/**
 * @param {object} args
 * @param {string} args.platform instagram | tiktok | x | linkedin | youtube
 * @param {object} args.profile  { followers, following, postsCount, … }
 * @param {object[]} args.posts  publications normalisées (lib/accounts.mjs)
 * @param {number} [args.now]
 * @param {object[]} [args.history] analyses précédentes du même compte : [{ at, followers, postsCount }]
 */
export function computeAccountMetrics({ platform, profile = {}, posts = [], now = Date.now(), history = [] }) {
  const warnings = [];
  const valid = posts.filter((p) => p && p.createdAt && Number.isFinite(Date.parse(p.createdAt)));
  const pinned = valid.filter((p) => p.pinned);
  const notOwn = valid.filter((p) => !p.pinned && p.own === false);
  // Suites de fil (X) : le fil compte une fois, par son premier post.
  const threadParts = valid.filter((p) => !p.pinned && p.own !== false && p.kind === "fil");
  const own = valid.filter((p) => !p.pinned && p.own !== false && p.kind !== "fil").sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const parts = engagementParts(platform, own);

  // --- Chaque publication : âge, famille, mesure, ratio à la médiane de sa famille ---
  const rows = own.map((p) => {
    const ageH = (now - Date.parse(p.createdAt)) / 3.6e6;
    const group = comparisonGroup(platform, p);
    const engagement = engagementOf(p, parts);
    const value = group.measure === "views" ? (isNum(p.views) ? p.views : null) : engagement;
    const matureH = group.long ? MATURE_H.youtube_long : MATURE_H[platform] || 72;
    return { ...p, ageH, ageDays: ageH / 24, group, value, matureH, mature: ageH >= matureH, engagement, time: parisTime(p.createdAt) };
  });

  const groups = {};
  for (const r of rows) {
    const g = (groups[r.group.key] ||= { key: r.group.key, label: r.group.label, measure: r.group.measure, posts: 0, comparable: 0, values: [] });
    g.posts += 1;
    if (r.mature && isNum(r.value)) {
      g.comparable += 1;
      g.values.push(r.value);
    }
  }
  for (const g of Object.values(groups)) {
    if (platform === "tiktok" && g.key === "video" && rows.some((r) => r.type === "carrousel")) g.label = "vidéos et diaporamas";
    g.median = g.values.length >= MIN_GROUP ? median(g.values) : null;
    g.mean = g.values.length >= MIN_GROUP ? mean(g.values) : null;
    g.max = g.values.length ? Math.max(...g.values) : null;
    g.enough = g.median !== null && g.median > 0;
    delete g.values;
  }
  for (const r of rows) {
    const g = groups[r.group.key];
    // Le statut se lit sur le ratio affiché (arrondi au centième) : « ×1,5 » est toujours « au-dessus ».
    r.ratio = r.mature && isNum(r.value) && g.enough ? round(r.value / g.median, 2) : null;
    r.status = !r.mature ? "trop récent" : r.ratio === null ? "non comparable" : r.ratio >= 1.5 ? "au-dessus" : r.ratio <= 0.67 ? "en dessous" : "dans la norme";
  }
  const rated = rows.filter((r) => isNum(r.ratio));
  const byRatio = [...rated].sort((a, b) => b.ratio - a.ratio);

  // --- Échantillon ---
  const sample = {
    fetched: valid.length,
    pinned: pinned.length,
    notOwn: notOwn.length,
    threadParts: threadParts.length,
    analysed: rows.length,
    tooRecent: rows.filter((r) => !r.mature).length,
    comparable: rated.length,
    accountPosts: isNum(profile.postsCount) ? profile.postsCount : null,
    from: rows.length ? rows[rows.length - 1].createdAt : null,
    to: rows.length ? rows[0].createdAt : null,
  };
  if (pinned.length) warnings.push(`${pinned.length} publication(s) épinglée(s) écartée(s) : remontées en tête du profil, elles fausseraient la fréquence et les comparaisons.`);
  if (rows.length < 10) warnings.push(`Seulement ${rows.length} publication(s) analysable(s) : les tendances ci-dessous sont fragiles.`);
  if (rows.some((r) => r.likesHidden)) warnings.push(`${rows.filter((r) => r.likesHidden).length} publication(s) ont leurs j'aime masqués : leur engagement est inconnu.`);

  // --- Rythme de publication (sur les publications de l'auteur, hors épinglées) ---
  let cadence = null;
  if (rows.length >= 2) {
    const times = rows.map((r) => Date.parse(r.createdAt)); // du plus récent au plus ancien
    const gaps = times.slice(1).map((t, i) => (times[i] - t) / DAY_MS);
    const spanDays = (times[0] - times[times.length - 1]) / DAY_MS;
    let longest = 0;
    gaps.forEach((g, i) => {
      if (g > gaps[longest]) longest = i;
    });
    const gMean = mean(gaps);
    const sd = gaps.length >= 2 ? Math.sqrt(gaps.reduce((s, g) => s + (g - gMean) ** 2, 0) / (gaps.length - 1)) : null;
    const cv = sd !== null && gMean > 0 ? sd / gMean : null;
    cadence = {
      posts: rows.length,
      from: rows[rows.length - 1].createdAt,
      to: rows[0].createdAt,
      spanDays: round(spanDays, 1),
      // (publications − 1) intervalles sur la période : le rythme réel entre la première et la dernière.
      perWeek: spanDays > 0 ? round(((rows.length - 1) / spanDays) * 7, 1) : null,
      medianGapDays: round(median(gaps), 1),
      longestGap: gaps.length ? { days: round(gaps[longest], 1), from: rows[longest + 1].createdAt, to: rows[longest].createdAt } : null,
      lastPostDaysAgo: round((now - times[0]) / DAY_MS, 1),
      regularity:
        gaps.length >= 5 && cv !== null
          ? { cv: round(cv, 2), label: cv < 0.5 ? "régulier" : cv < 1 ? "plutôt régulier" : "irrégulier" }
          : null,
    };
    // Compte à l'arrêt : le silence depuis la dernière publication dépasse nettement son rythme. Le
    // rythme décrit alors une période passée, pas le présent.
    const silence = (now - times[0]) / DAY_MS;
    cadence.dormant = silence > Math.max(14, 3 * (median(gaps) || 0), (gaps[longest] || 0) * 1.5);
    if (cadence.dormant) warnings.push(`Aucune publication depuis ${Math.round(silence)} jours au moment du relevé : le rythme ci-dessous décrit la période d'activité, pas le présent.`);
    if (!cadence.regularity) warnings.push("Pas assez d'intervalles entre publications (6 publications au moins) pour juger la régularité.");
  }

  // --- Performances brutes ---
  const pick = (key) => rows.filter((r) => r.mature).map((r) => r[key]);
  const followers = isNum(profile.followers) && profile.followers > 0 ? profile.followers : null;
  const performance = {
    likes: { median: round(median(pick("likes"))), mean: round(mean(pick("likes"))) },
    comments: { median: round(median(pick("comments"))), mean: round(mean(pick("comments"))) },
    shares: { median: round(median(pick("shares"))) },
    saves: { median: round(median(pick("saves"))) },
    // Pas de médiane de vues tous formats confondus : elle mélangerait des familles différentes.
    views: { label: VIEW_LABEL[platform] || "vues" },
    basedOn: rows.filter((r) => r.mature).length,
  };

  // --- Engagement ---
  const matureEng = rows.filter((r) => r.mature && isNum(r.engagement));
  // Pourcentages gardés à 4 décimales : un très gros compte peut être à 0,003 %, pas à « 0 % ».
  const engagement = {
    formula: engagementFormula(platform, parts),
    perFollower: followers && matureEng.length
      ? {
          median: round((median(matureEng.map((r) => r.engagement)) / followers) * 100, 4),
          mean: round((mean(matureEng.map((r) => r.engagement)) / followers) * 100, 4),
          n: matureEng.length,
        }
      : null,
    // Pourquoi l'engagement par abonné manque : abonnés inconnus ou à zéro, aucune publication assez
    // ancienne, ou engagement masqué partout.
    reason: !isNum(profile.followers) ? "no-followers" : !followers ? "zero-followers" : !rows.some((r) => r.mature) ? "no-mature" : !matureEng.length ? "hidden" : null,
    // Engagement rapporté aux vues, famille par famille (Shorts et vidéos longues, ancien et nouveau
    // décompte YouTube ne se mélangent pas).
    perView: [],
  };
  for (const g of Object.values(groups).filter((x) => x.measure === "views")) {
    const withViews = matureEng.filter((r) => r.group.key === g.key && isNum(r.views) && r.views > 0);
    if (withViews.length >= MIN_GROUP) {
      engagement.perView.push({ key: g.key, label: g.label, median: round(median(withViews.map((r) => (r.engagement / r.views) * 100)), 4), n: withViews.length });
    }
  }

  // --- Formats ---
  const formats = Object.values(
    rows.reduce((acc, r) => {
      const f = (acc[r.type || "autre"] ||= { type: r.type || "autre", count: 0, ratios: [], groups: new Set() });
      f.count += 1;
      f.groups.add(r.group.key);
      if (isNum(r.ratio)) f.ratios.push(r.ratio);
      return acc;
    }, {}),
  )
    // `groups` : familles de comparaison du format ; deux formats de familles différentes ne se comparent
    // pas (chacun est rapporté à la médiane de la sienne).
    .map((f) => ({ type: f.type, count: f.count, share: round((f.count / rows.length) * 100), medianRatio: f.ratios.length >= MIN_SLOT ? round(median(f.ratios), 2) : null, comparable: f.ratios.length, groups: [...f.groups] }))
    .sort((a, b) => b.count - a.count);

  // --- Durées (vidéos) ---
  const durRows = rows.filter((r) => isNum(r.duration));
  let durations = null;
  if (durRows.length) {
    const buckets = {};
    for (const r of durRows) {
      const b = (buckets[durationBucket(r.duration)] ||= { bucket: durationBucket(r.duration), count: 0, ratios: [] });
      b.count += 1;
      if (isNum(r.ratio)) b.ratios.push(r.ratio);
    }
    durations = {
      medianSeconds: round(median(durRows.map((r) => r.duration))),
      buckets: DURATION_ORDER.filter((k) => buckets[k]).map((k) => ({
        bucket: k,
        count: buckets[k].count,
        medianRatio: buckets[k].ratios.length >= MIN_SLOT ? round(median(buckets[k].ratios), 2) : null,
        comparable: buckets[k].ratios.length,
      })),
    };
  }

  // --- Textes, hashtags, sons ---
  const tagCounts = {};
  for (const r of rows) {
    for (const t of new Set((r.hashtags || []).map((h) => String(h).replace(/^#/, "").toLowerCase()).filter(Boolean))) {
      const e = (tagCounts[t] ||= { tag: t, count: 0, ratios: [] });
      e.count += 1;
      if (isNum(r.ratio)) e.ratios.push(r.ratio);
    }
  }
  const hashtags = {
    perPostMedian: round(median(rows.map((r) => (r.hashtags || []).length)), 1),
    perPostMean: round(mean(rows.map((r) => (r.hashtags || []).length)), 1),
    postsWithout: rows.filter((r) => !(r.hashtags || []).length).length,
    top: Object.values(tagCounts)
      .filter((t) => t.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((t) => ({ tag: t.tag, count: t.count, medianRatio: t.ratios.length >= MIN_SLOT ? round(median(t.ratios), 2) : null })),
  };
  // Légende : le texte publié, sans les liens (un « ? » d'URL n'est pas une question). Sur YouTube, le titre.
  const captionOf = (r) => String((platform === "youtube" ? r.title : r.text) || "").replace(/https?:\/\/\S+/g, "").trim();
  const captions = {
    source: platform === "youtube" ? "titre" : "légende",
    medianLength: round(median(rows.map((r) => captionOf(r).length))),
    withQuestion: rows.filter((r) => /\?/.test(captionOf(r))).length,
    posts: rows.length,
  };
  let sounds = null;
  const withSound = rows.filter((r) => r.sound);
  if (withSound.length) {
    const reused = withSound.filter((r) => !r.sound.original);
    const names = {};
    for (const r of reused) names[r.sound.name] = (names[r.sound.name] || 0) + 1;
    sounds = {
      withSound: withSound.length,
      original: withSound.length - reused.length,
      reused: reused.length,
      top: Object.entries(names)
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count })),
    };
  }

  // --- Moments de publication (heure de Paris) ---
  const slot = (keyFn, order) => {
    const m = {};
    for (const r of rows) {
      const k = keyFn(r);
      const e = (m[k] ||= { key: k, count: 0, ratios: [] });
      e.count += 1;
      if (isNum(r.ratio)) e.ratios.push(r.ratio);
    }
    return order.filter((k) => m[k]).map((k) => ({ key: k, count: m[k].count, comparable: m[k].ratios.length, medianRatio: m[k].ratios.length >= MIN_SLOT ? round(median(m[k].ratios), 2) : null }));
  };
  const byDay = slot((r) => r.time.day, DAY_ORDER);
  const byPeriod = slot((r) => r.time.period, PERIODS.map((p) => p.key));
  // Un créneau « ressort » s'il a au moins 5 publications comparables, face à au moins deux autres
  // créneaux mesurés, avec une médiane au moins 1,25 fois celle des autres. Sinon : rien ne ressort.
  const bestOf = (list, kind) => {
    const cands = list.filter((s) => s.medianRatio !== null);
    if (cands.length < 3) return null;
    const [best, second] = [...cands].sort((a, b) => b.medianRatio - a.medianRatio);
    if (best.comparable < MIN_BEST_SLOT) return null;
    const others = median(cands.filter((c) => c !== best).map((c) => c.medianRatio));
    // Il doit dépasser la normale du compte, les autres créneaux (médiane) et le deuxième : pas d'ex æquo.
    const stands = best.medianRatio > 1 && best.medianRatio >= 1.25 * others && best.medianRatio >= 1.25 * second.medianRatio;
    return stands ? { kind, key: best.key, medianRatio: best.medianRatio, comparable: best.comparable, othersMedianRatio: round(others, 2) } : null;
  };
  const timing = {
    timezone: TIMEZONE,
    byDay,
    byPeriod,
    bestDay: bestOf(byDay, "jour"),
    bestPeriod: bestOf(byPeriod, "moment"),
    minPerSlot: MIN_SLOT,
    minBestSlot: MIN_BEST_SLOT,
  };

  // --- Évolution récente : moitié récente contre moitié précédente ---
  // Seules les publications d'au moins deux fois leur période de démarrage comptent : une publication
  // à peine « mûre » face à des publications de plusieurs semaines serait désavantagée par son âge.
  // La comparaison se fait à l'intérieur de chaque famille (ses publications récentes contre ses
  // précédentes, sur la même mesure) : une famille présente d'un seul côté (passage des photos aux
  // Reels, ancien et nouveau décompte YouTube) ne crée pas de fausse évolution.
  let trend = null;
  const recentRows = [];
  const previousRows = [];
  for (const g of Object.keys(groups)) {
    const fam = rated.filter((r) => r.group.key === g && r.ageH >= 2 * r.matureH).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (fam.length < 6) continue;
    const half = Math.floor(fam.length / 2);
    recentRows.push(...fam.slice(0, half));
    previousRows.push(...fam.slice(half, half * 2));
  }
  if (recentRows.length + previousRows.length >= MIN_TREND) {
    const recent = median(recentRows.map((r) => r.ratio));
    const previous = median(previousRows.map((r) => r.ratio));
    trend = {
      n: recentRows.length,
      recentMedianRatio: round(recent, 2),
      previousMedianRatio: round(previous, 2),
      changePct: previous > 0 ? round(((recent - previous) / previous) * 100) : null,
      recentMedianAgeDays: round(median(recentRows.map((r) => r.ageDays)), 1),
      previousMedianAgeDays: round(median(previousRows.map((r) => r.ageDays)), 1),
    };
  } else {
    warnings.push("Moins de 12 publications comparables assez anciennes : pas d'évolution récente calculée.");
  }

  // --- Croissance réelle : analyses successives du même compte (jamais d'estimation) ---
  // Quand elle n'est pas mesurable, `growthNote.reason` dit pourquoi : « no-followers » (abonnés
  // inconnus aujourd'hui), « first » (première analyse), « no-history-followers » (les analyses
  // précédentes n'ont pas d'abonnés), « too-close » (moins de 12 h d'écart), « below-precision »
  // (YouTube arrondit les abonnés à 3 chiffres : variation plus petite que l'arrondi).
  // history === null : l'historique n'a pas pu être lu (panne passagère).
  const earlier = (history || []).filter((h) => h && Number.isFinite(Date.parse(h.at)) && Date.parse(h.at) < now);
  const points = [...earlier, { at: new Date(now).toISOString(), followers: profile.followers, postsCount: profile.postsCount }]
    .filter((h) => isNum(h.followers))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let growth = null;
  let growthNote = null;
  if (!isNum(profile.followers)) growthNote = { reason: "no-followers" };
  else if (history === null) growthNote = { reason: "history-unavailable" };
  else if (!earlier.length) growthNote = { reason: "first" };
  else if (points.length < 2) growthNote = { reason: "no-history-followers", analyses: earlier.length + 1 };
  else {
    const first = points[0];
    const last = points[points.length - 1];
    const days = (Date.parse(last.at) - Date.parse(first.at)) / DAY_MS;
    const delta = last.followers - first.followers;
    const top = Math.max(first.followers, last.followers);
    const precision = platform === "youtube" && top >= 1000 ? 10 ** (Math.floor(Math.log10(top)) + 1 - 3) : 1;
    if (days < 0.5) growthNote = { reason: "too-close", analyses: points.length };
    else if (precision > 1 && Math.abs(delta) < precision) growthNote = { reason: "below-precision", precision, days: round(days, 1), analyses: points.length };
    else {
      growth = {
        points: points.map((p) => ({ at: p.at, followers: p.followers, postsCount: isNum(p.postsCount) ? p.postsCount : null })),
        followersDelta: delta,
        followersPct: first.followers > 0 ? round((delta / first.followers) * 100, 2) : null,
        days: round(days, 1),
        perWeek: round((delta / days) * 7),
        postsDelta: isNum(last.postsCount) && isNum(first.postsCount) ? last.postsCount - first.postsCount : null,
        precision,
        approximate: precision > 1,
      };
    }
  }

  // --- Spécifique au réseau ---
  const specific = {};
  if (platform === "x") {
    const kinds = { original: 0, réponse: 0, citation: 0, retweet: 0 };
    for (const p of valid) kinds[p.kind || "original"] = (kinds[p.kind || "original"] || 0) + 1;
    specific.kinds = kinds;
    specific.saves = { median: performance.saves.median };
  }
  if (platform === "linkedin") {
    const totals = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.reactions || {})) if (isNum(v)) totals[k] = (totals[k] || 0) + v;
    const sum = Object.values(totals).reduce((s, v) => s + v, 0);
    specific.reactions = sum
      ? Object.entries(totals)
          .map(([type, count]) => ({ type, count, share: round((count / sum) * 100) }))
          .sort((a, b) => b.count - a.count)
      : null;
    specific.reposts = notOwn.length;
  }
  if (platform === "youtube") {
    // Médianes des vidéos publiées depuis le changement de décompte du 24 août 2026, puis d'avant.
    specific.formats = ["short", "long"].map((k) => ({
      type: k,
      count: rows.filter((r) => r.type === k).length,
      countAfter: groups[k]?.posts ?? 0,
      countBefore: groups[`${k}-avant`]?.posts ?? 0,
      medianViews: groups[k]?.median ?? null,
      medianViewsBefore: groups[`${k}-avant`]?.median ?? null,
    })).filter((f) => f.count);
  }

  // --- Publications, du plus récent au plus ancien, avec leur place ---
  const postsOut = [...rows, ...pinned.map((p) => ({ ...p, pinnedRow: true }))].map((r) => ({
    id: r.id,
    url: r.url || null,
    createdAt: r.createdAt,
    text: String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 400),
    type: r.type || null,
    pinned: Boolean(r.pinned),
    kind: r.kind || null,
    views: isNum(r.views) ? r.views : null,
    likes: isNum(r.likes) && !r.likesHidden ? r.likes : null,
    comments: isNum(r.comments) ? r.comments : null,
    shares: isNum(r.shares) ? r.shares : null,
    saves: isNum(r.saves) ? r.saves : null,
    engagement: isNum(r.engagement) ? r.engagement : null,
    duration: isNum(r.duration) ? r.duration : null,
    hashtags: (r.hashtags || []).slice(0, 12),
    sound: r.sound || null,
    cover: r.cover || null,
    group: r.group?.key || null,
    measure: r.group?.measure || null,
    ratio: isNum(r.ratio) ? round(r.ratio, 2) : null,
    status: r.pinnedRow ? "épinglé" : r.status,
    ageDays: round(r.ageDays ?? (now - Date.parse(r.createdAt)) / DAY_MS, 1),
    paris: parisTime(r.createdAt),
  }));

  return {
    computedAt: new Date(now).toISOString(),
    platform,
    sample,
    cadence,
    groups: Object.values(groups),
    performance,
    engagement,
    formats,
    durations,
    hashtags,
    captions,
    sounds,
    timing,
    trend,
    growth,
    growthNote,
    specific,
    top: byRatio.slice(0, 3).filter((r) => r.ratio > 1).map((r) => r.id),
    flop: byRatio.slice(-3).reverse().filter((r) => r.ratio < 1).map((r) => r.id),
    posts: postsOut,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Nombres écrits par l'IA : Claude ne doit en écrire aucun (les chiffres affichés viennent tous des
// calculs ci-dessus). On repère les chiffres et les quantités écrites en lettres.
// ---------------------------------------------------------------------------

const NUMBER_WORDS = [
  "zéro", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
  "vingt", "vingts", "trente", "quarante", "cinquante", "soixante", "cent", "cents", "mille", "million", "millions", "milliard", "milliards",
  "demi", "moitié", "moitiés", "tiers", "quart", "quarts", "pour cent", "pourcent", "une seule", "un seul",
  "dizaines?", "douzaines?", "quinzaines?", "vingtaines?", "trentaines?", "quarantaines?", "cinquantaines?", "soixantaines?", "centaines?", "milliers?",
  "le double", "au double", "le triple", "multipliée?s? par",
  "doubl(?:é|ée|és|ées|er|ent|ant)", "tripl(?:é|ée|és|ées|er|ent|ant)", "quadrupl\\p{L}*", "quintupl\\p{L}*", "décupl\\p{L}*", "centupl\\p{L}*",
];
// Un chiffre collé à une lettre (B2B, Web3, impression 3D) n'est pas une quantité ; « 12k », « 3M », « x3 » le sont.
const NUMBER_RE = new RegExp(
  `(?<![\\p{L}])[x×]\\s?\\p{Nd}+(?:[.,]\\p{Nd}+)?|(?<![\\p{L}\\p{Nd}])\\p{Nd}+(?:[\\s\u00a0\u202f.,]\\p{Nd}+)*(?:\\s?(?:k|K|M)(?![\\p{L}])|(?![\\p{L}\\p{Nd}]))|\\p{No}|(?<![\\p{L}\\p{N}])(?:${NUMBER_WORDS.join("|")})(?![\\p{L}\\p{N}])`,
  "giu",
);

/** Nombres écrits dans un texte (chiffres ou lettres) : [« 1 076 623 », « trois »…]. */
export function writtenNumbers(text) {
  return [...String(text || "").matchAll(NUMBER_RE)].map((m) => m[0].trim()).filter(Boolean);
}
