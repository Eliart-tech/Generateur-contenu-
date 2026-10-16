// Analyse de compte : calculs à partir des publications relevées. Fonctions pures, sans réseau.
//
// Règles qui évitent les erreurs repérées chez d'autres outils :
// - les publications épinglées sont écartées (anciennes et remontées en tête du profil, elles
//   faussent la fréquence et les comparaisons) ; les retweets et republications aussi (pas du contenu
//   de l'auteur) ;
// - les heures sont en heure de Paris ;
// - une publication n'est comparée qu'à celles de sa propre famille (Reels entre eux, photos et
//   carrousels entre eux, Shorts entre eux…), sur une même mesure (lectures, vues, impressions ou
//   engagement), jamais en mélangeant les compteurs ;
// - une publication trop récente n'est pas encore jugée : elle n'a pas fini d'accumuler ;
// - médianes plutôt que moyennes (une seule publication virale ne déforme pas le portrait) ;
// - pas de « meilleur jour » ni de « tendance » sans assez de publications pour le dire ;
// - aucune note globale : chaque indicateur affiche sa formule et le nombre de publications utilisées.

export const TIMEZONE = "Europe/Paris";
const DAY_MS = 864e5;

// Âge à partir duquel une publication a accumulé l'essentiel de son audience (heures).
const MATURE_H = { instagram: 72, tiktok: 72, x: 24, linkedin: 72, youtube: 72, youtube_long: 168 };
const MIN_GROUP = 4; // publications comparables minimum pour une médiane de référence
const MIN_SLOT = 3; // publications par créneau minimum pour comparer des jours ou des moments

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
    return post.views !== null && post.views !== undefined
      ? { key: "video", label: "Reels et vidéos", measure: "views" }
      : { key: "photo", label: "photos et carrousels", measure: "engagement" };
  }
  if (platform === "youtube") {
    return post.type === "short"
      ? { key: "short", label: "Shorts", measure: "views" }
      : { key: "long", label: "vidéos longues", measure: "views" };
  }
  if (platform === "tiktok") return { key: "video", label: "vidéos", measure: "views" };
  if (platform === "x") {
    return isNum(post.views) ? { key: "post", label: "posts", measure: "views" } : { key: "post", label: "posts", measure: "engagement" };
  }
  return { key: "post", label: "posts", measure: "engagement" };
}

// Engagement d'une publication : interactions publiques disponibles (j'aime masqués → inconnu).
export function engagementOf(post) {
  if (post.likesHidden || !isNum(post.likes)) return null;
  return post.likes + (post.comments || 0) + (post.shares || 0) + (post.saves || 0);
}

const ENGAGEMENT_PARTS = {
  instagram: ["j'aime", "commentaires"],
  tiktok: ["j'aime", "commentaires", "partages", "enregistrements"],
  youtube: ["j'aime", "commentaires"],
  x: ["j'aime", "réponses", "reposts et citations", "signets"],
  linkedin: ["réactions", "commentaires", "republications"],
};

export function engagementFormula(platform) {
  return (ENGAGEMENT_PARTS[platform] || ["j'aime", "commentaires"]).join(" + ");
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
  const own = valid.filter((p) => !p.pinned && p.own !== false).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  // --- Chaque publication : âge, famille, mesure, ratio à la médiane de sa famille ---
  const rows = own.map((p) => {
    const ageH = (now - Date.parse(p.createdAt)) / 3.6e6;
    const group = comparisonGroup(platform, p);
    const value = group.measure === "views" ? (isNum(p.views) ? p.views : null) : engagementOf(p);
    const matureH = platform === "youtube" && group.key === "long" ? MATURE_H.youtube_long : MATURE_H[platform] || 72;
    return { ...p, ageH, ageDays: ageH / 24, group, value, mature: ageH >= matureH, engagement: engagementOf(p), time: parisTime(p.createdAt) };
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
    g.median = g.values.length >= MIN_GROUP ? median(g.values) : null;
    g.mean = g.values.length >= MIN_GROUP ? mean(g.values) : null;
    g.max = g.values.length ? Math.max(...g.values) : null;
    g.enough = g.median !== null && g.median > 0;
    delete g.values;
  }
  for (const r of rows) {
    const g = groups[r.group.key];
    r.ratio = r.mature && isNum(r.value) && g.enough ? r.value / g.median : null;
    r.status = !r.mature ? "trop récent" : r.ratio === null ? "non comparable" : r.ratio >= 1.5 ? "au-dessus" : r.ratio <= 0.67 ? "en dessous" : "dans la norme";
  }
  const rated = rows.filter((r) => isNum(r.ratio));
  const byRatio = [...rated].sort((a, b) => b.ratio - a.ratio);

  // --- Échantillon ---
  const sample = {
    fetched: valid.length,
    pinned: pinned.length,
    notOwn: notOwn.length,
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
    views: { median: round(median(rows.filter((r) => r.mature && isNum(r.views)).map((r) => r.views))), label: VIEW_LABEL[platform] || "vues" },
    basedOn: rows.filter((r) => r.mature).length,
  };

  // --- Engagement ---
  const matureEng = rows.filter((r) => r.mature && isNum(r.engagement));
  const engagement = {
    formula: engagementFormula(platform),
    perFollower: followers && matureEng.length
      ? {
          median: round((median(matureEng.map((r) => r.engagement)) / followers) * 100, 2),
          mean: round((mean(matureEng.map((r) => r.engagement)) / followers) * 100, 2),
          n: matureEng.length,
        }
      : null,
    perView: null,
  };
  const withViews = matureEng.filter((r) => isNum(r.views) && r.views > 0);
  if (withViews.length >= MIN_GROUP) {
    engagement.perView = { median: round(median(withViews.map((r) => (r.engagement / r.views) * 100)), 2), n: withViews.length };
  }

  // --- Formats ---
  const formats = Object.values(
    rows.reduce((acc, r) => {
      const f = (acc[r.type || "autre"] ||= { type: r.type || "autre", count: 0, ratios: [] });
      f.count += 1;
      if (isNum(r.ratio)) f.ratios.push(r.ratio);
      return acc;
    }, {}),
  )
    .map((f) => ({ type: f.type, count: f.count, share: round((f.count / rows.length) * 100), medianRatio: f.ratios.length >= MIN_SLOT ? round(median(f.ratios), 2) : null, comparable: f.ratios.length }))
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
  const captions = {
    medianLength: round(median(rows.map((r) => String(r.text || "").length))),
    withQuestion: rows.filter((r) => /\?/.test(String(r.text || ""))).length,
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
  const bestOf = (list, kind) => {
    const cands = list.filter((s) => s.medianRatio !== null);
    if (cands.length < 2) return null;
    const best = [...cands].sort((a, b) => b.medianRatio - a.medianRatio)[0];
    const others = median(cands.filter((c) => c !== best).map((c) => c.medianRatio));
    return best.medianRatio >= 1.25 * others ? { kind, key: best.key, medianRatio: best.medianRatio, comparable: best.comparable, othersMedianRatio: round(others, 2) } : null;
  };
  const timing = {
    timezone: TIMEZONE,
    byDay,
    byPeriod,
    bestDay: bestOf(byDay, "jour"),
    bestPeriod: bestOf(byPeriod, "moment"),
    minPerSlot: MIN_SLOT,
  };

  // --- Évolution récente : moitié récente contre moitié précédente ---
  let trend = null;
  const chrono = [...rated].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (chrono.length >= 12) {
    const half = Math.floor(chrono.length / 2);
    const recent = median(chrono.slice(0, half).map((r) => r.ratio));
    const previous = median(chrono.slice(half, half * 2).map((r) => r.ratio));
    trend = {
      n: half,
      recentMedianRatio: round(recent, 2),
      previousMedianRatio: round(previous, 2),
      changePct: previous > 0 ? round(((recent - previous) / previous) * 100) : null,
    };
  } else {
    warnings.push("Moins de 12 publications comparables : pas d'évolution récente calculée.");
  }

  // --- Croissance réelle : analyses successives du même compte ---
  const points = [...history, { at: new Date(now).toISOString(), followers: profile.followers, postsCount: profile.postsCount }]
    .filter((h) => h && isNum(h.followers) && Number.isFinite(Date.parse(h.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let growth = null;
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const days = (Date.parse(last.at) - Date.parse(first.at)) / DAY_MS;
    if (days >= 0.5) {
      growth = {
        points: points.map((p) => ({ at: p.at, followers: p.followers, postsCount: isNum(p.postsCount) ? p.postsCount : null })),
        followersDelta: last.followers - first.followers,
        followersPct: first.followers > 0 ? round(((last.followers - first.followers) / first.followers) * 100, 2) : null,
        days: round(days, 1),
        perWeek: round(((last.followers - first.followers) / days) * 7),
        postsDelta: isNum(last.postsCount) && isNum(first.postsCount) ? last.postsCount - first.postsCount : null,
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
    specific.formats = ["short", "long"].map((k) => ({
      type: k,
      count: rows.filter((r) => r.group.key === k).length,
      medianViews: groups[k]?.median ?? null,
    }));
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
    specific,
    top: byRatio.slice(0, 3).filter((r) => r.ratio > 1).map((r) => r.id),
    flop: byRatio.slice(-3).reverse().filter((r) => r.ratio < 1).map((r) => r.id),
    posts: postsOut,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Contrôle des chiffres dans un texte rédigé par l'IA : tout nombre doit exister dans les données.
// ---------------------------------------------------------------------------

/** Nombres présents dans les données d'une analyse (mesures, totaux, ratios, pourcentages). */
export function knownNumbers(metrics, profile = {}) {
  const out = [];
  const walk = (v) => {
    if (isNum(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(metrics);
  walk({ followers: profile.followers, following: profile.following, postsCount: profile.postsCount });
  // Variantes usuelles : ×N (ratio), N % (ratio en pourcentage d'écart).
  for (const p of metrics.posts || []) if (isNum(p.ratio)) out.push(p.ratio * 100, (p.ratio - 1) * 100);
  return out;
}

/** Extrait les nombres écrits dans un texte français (« 1 076 623 », « 7,72 % », « 12 k », « ×3,5 », « 1,2 M »). */
export function numbersIn(text) {
  const found = [];
  const re = /(\d{1,3}(?:[\s  ]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|K|M|millions?|milliers?)?/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const raw = m[1].replace(/[\s  ]/g, "").replace(",", ".");
    let v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const unit = (m[2] || "").toLowerCase();
    const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
    let step = 10 ** -decimals; // précision écrite : « 6,5 » vaut à 0,05 près, « 377 000 » à l'unité
    if (unit === "k" || unit.startsWith("millier")) (v *= 1e3), (step *= 1e3);
    if (unit === "m" || unit.startsWith("million")) (v *= 1e6), (step *= 1e6);
    found.push({ text: m[0].trim(), value: v, step });
  }
  return found;
}

/**
 * Nombres d'un texte qui ne correspondent à aucune donnée. Tolérance : l'arrondi du nombre écrit
 * (« 6,5 » à 0,05 près, « 12 k » à 500 près) ou 1 % de la valeur réelle.
 * Les petits entiers (≤ 10, « 3 idées ») et les années sont ignorés.
 */
export function unverifiedNumbers(text, known) {
  return numbersIn(text).filter(({ value, step }) => {
    if (Number.isInteger(value) && value <= 10) return false;
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) return false;
    return !known.some((k) => Math.abs(k - value) <= Math.max(step / 2 + 1e-9, Math.abs(k) * 0.01));
  });
}
