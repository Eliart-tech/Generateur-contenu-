// Score de viralité des posts relevés sur les réseaux, et regroupement en tendances.
// Fonctions pures : entrées = posts normalisés (lib/social.mjs), sortie = posts notés.
//
// Idée directrice : un post est un signal quand il dépasse ce que son auteur obtient
// d'habitude (ratio « outlier »), avec un engagement de qualité (partages, enregistrements)
// et une vitesse élevée, le tout pondéré par la fraîcheur.

const FLOOR = { tiktok: 1000, instagram: 1000, x: 500, youtube: 1000 }; // vues minimales
const T_FULL = { tiktok: 24, instagram: 24, x: 12, linkedin: 48, youtube: 48 }; // h avant volume « mûr »
const HALF_LIFE = { x: 12, linkedin: 48, tiktok: 72, instagram: 72, youtube: 96 }; // h, décroissance de NOW
const F_MIN = { tiktok: 1000, instagram: 1000, x: 500, linkedin: 500, youtube: 1000 };
const MAX_AGE_H = 14 * 24;

// Taux d'engagement « attendus » par vue (a priori, remplacés par la médiane du lot si absent).
const PRIORS = {
  tiktok: { likes: 0.046, comments: 0.00083, shares: 0.0012 },
  instagram: { likes: 0.015, comments: 0.00032, shares: 0.002 },
};
const WEIGHTS = {
  tiktok: { shares: 0.45, saves: 0.25, likes: 0.2, comments: 0.1 },
  instagram: { shares: 0.5, saves: 0.1, likes: 0.3, comments: 0.1 },
  x: { shares: 0.4, saves: 0.25, likes: 0.2, comments: 0.15 },
  youtube: { likes: 0.6, comments: 0.4 },
};
const SHRINK_K = 2000;

const GENERIC_TAGS = new Set([
  "fyp", "foryou", "foryoupage", "pourtoi", "viral", "reels", "reel", "explore", "explorepage", "trending",
  "tiktok", "instagram", "xyzbca", "linkedin", "fy", "pourtoii", "viralvideo", "shorts", "short", "france",
]);

const CONTEST_RE = /concours|giveaway|tag(ue)?\s*\d+\s*amis?|commente\s.{1,20}\spour\s(recevoir|gagner)/i;
const FR_WORDS = /\b(le|la|les|des|est|une|pour|dans|pas|que|qui|avec|vous|nous|sur|mais|plus|tout|faire|c'est|j'ai)\b/gi;

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const median = (arr) => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function normalizeTag(tag) {
  return String(tag || "")
    .replace(/^#/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// Le réseau donne parfois la langue (TikTok, X) ; sinon heuristique de mots-outils français.
export function isFrench(post) {
  if (post.lang) return String(post.lang).toLowerCase().startsWith("fr");
  const text = String(post.text || "");
  if (!text.trim()) return true; // sans texte (Reel muet) : on ne peut pas juger, on garde
  const hits = (text.match(FR_WORDS) || []).length;
  return hits >= 2 || (hits >= 1 && /[éèêàùçœ]/i.test(text));
}

// Engagement pondéré « brut » (sans les vues).
const weightedEngagement = (p) => (p.likes || 0) + 2 * (p.comments || 0) + 3 * (p.shares || 0);

function volume(p) {
  if (p.network === "linkedin") return weightedEngagement(p);
  if (isNum(p.views) && p.views > 0) return p.views;
  return null; // X sans vues (source de repli) : traité comme LinkedIn plus bas
}

function percentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    if (sorted.length < 2) return 0.5;
    let below = 0;
    for (const s of sorted) if (s < v) below++;
    return below / (sorted.length - 1);
  });
}

/**
 * Note chaque post. `snapshots` : { "<network>:<id>": { vol, t } } d'un scan précédent
 * (vitesse réelle sur deux relevés). Retourne { posts, excluded }.
 */
export function scorePosts(rawPosts, { now = Date.now(), snapshots = {} } = {}) {
  const excluded = { langue: 0, ancien: 0, faible: 0, invalide: 0 };
  const posts = [];
  const seen = new Set();
  for (const p of rawPosts) {
    if (!p || !p.id || !p.network) {
      excluded.invalide++;
      continue;
    }
    const key = `${p.network}:${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const created = Date.parse(p.createdAt);
    const ageH = Number.isFinite(created) ? Math.max(1, (now - created) / 3.6e6) : null;
    if (ageH === null) {
      excluded.invalide++;
      continue;
    }
    if (ageH > MAX_AGE_H) {
      excluded.ancien++;
      continue;
    }
    if (!isFrench(p)) {
      excluded.langue++;
      continue;
    }
    let vol = volume(p);
    const noViews = vol === null;
    if (noViews) vol = weightedEngagement(p);
    const floor = p.network === "linkedin" || noViews ? 10 : FLOOR[p.network] || 500;
    if (!(vol >= floor)) {
      excluded.faible++;
      continue;
    }
    const a = Math.min(1, Math.sqrt(ageH / (T_FULL[p.network] || 24)));
    posts.push({ ...p, key, ageH, vol, volAdj: vol / a, ageFactor: a, noViews, flags: [...(p.flags || [])] });
  }

  // --- Ratio outlier R et confiance c, par réseau ---
  const byNet = groupBy(posts, (p) => p.network);
  for (const [net, list] of Object.entries(byNet)) {
    const fmin = F_MIN[net] || 500;
    const ratioF = list.map((p) => (isNum(p.authorFollowers) && p.authorFollowers > 0 ? p.volAdj / Math.max(p.authorFollowers, fmin) : null));
    const rho = median(ratioF.filter(isNum)) || null;
    const medVol = median(list.map((p) => p.volAdj)) || 1;
    list.forEach((p, i) => {
      const rf = rho && isNum(ratioF[i]) ? ratioF[i] / rho : null;
      let rc = null;
      if (net === "tiktok" && isNum(p.authorTotalLikes) && isNum(p.likes)) {
        const perVideo = p.authorTotalLikes / Math.max(p.authorPostCount || 1, 1);
        rc = p.likes / p.ageFactor / Math.max(perVideo, 10);
      } else if (net === "instagram" && isNum(p.authorLikesMedian) && isNum(p.likes) && p.likes >= 0) {
        rc = p.likes / p.ageFactor / Math.max(p.authorLikesMedian, 10);
      }
      if (isNum(rf) && isNum(rc)) {
        p.R = Math.sqrt(Math.max(rf, 0.01) * Math.max(rc, 0.01));
        p.conf = 0.85;
      } else if (isNum(rf)) {
        p.R = rf;
        p.conf = 0.6;
      } else if (isNum(rc)) {
        p.R = rc;
        p.conf = 0.7;
      } else {
        p.R = p.volAdj / medVol;
        p.conf = 0.3;
      }
      // Ratio brut vues / abonnés, plus parlant à afficher que R (relatif au lot).
      p.reach = isNum(p.authorFollowers) && p.authorFollowers > 0 && !p.noViews ? p.vol / p.authorFollowers : null;
      p.O = clamp(Math.log2(Math.max(p.R, 1)) / Math.log2(20), 0, 1);
    });
  }

  // --- Qualité d'engagement E ---
  for (const [net, list] of Object.entries(byNet)) {
    if (net === "linkedin" || list.every((p) => p.noViews)) {
      const qs = list.map((p) => ((p.comments || 0) + 2 * (p.shares || 0) + 1) / ((p.likes || 0) + 5));
      const mq = median(qs) || 1;
      list.forEach((p, i) => {
        p.E = clamp(0.5 + clamp(Math.log2(qs[i] / mq), -2, 2) / 4, 0, 1);
      });
    } else {
      const metrics = ["likes", "comments", "shares", "saves"];
      const priors = { ...(PRIORS[net] || {}) };
      for (const m of metrics) {
        if (!isNum(priors[m])) {
          priors[m] = median(list.filter((p) => isNum(p[m]) && p.views > 0).map((p) => p[m] / p.views)) || null;
        }
      }
      const w = WEIGHTS[net] || WEIGHTS.x;
      list.forEach((p) => {
        let sum = 0;
        let wsum = 0;
        const contest = CONTEST_RE.test(p.text || "");
        if (contest) p.flags.push("concours");
        const polemic = (net === "x") && isNum(p.comments) && isNum(p.likes) && p.comments > p.likes;
        if (polemic) p.flags.push("polémique");
        for (const m of metrics) {
          if (!isNum(p[m]) || p[m] < 0 || !isNum(priors[m]) || !priors[m] || !w[m] || p.noViews) continue;
          if (m === "comments" && contest) continue;
          const r = (p[m] + SHRINK_K * priors[m]) / (p.views + SHRINK_K);
          let L = clamp(Math.log2(r / priors[m]), -2, 3);
          if (m === "comments" && polemic) L = Math.min(L, 0);
          sum += w[m] * L;
          wsum += w[m];
        }
        p.E = wsum ? clamp(0.5 + sum / wsum / 4, 0, 1) : 0.5;
      });
    }
  }

  // --- Vitesse V : deux relevés si possible, sinon rang de vol/heure dans le lot ---
  for (const list of Object.values(byNet)) {
    const ranks = percentileRanks(list.map((p) => Math.log(p.vol / p.ageH)));
    list.forEach((p, i) => {
      const prev = snapshots[p.key];
      const dtH = prev ? (now - prev.t) / 3.6e6 : 0;
      if (prev && dtH >= 3 && isNum(prev.vol)) {
        const g24 = ((p.vol - prev.vol) / Math.max(prev.vol, 1)) * (24 / dtH);
        p.growth24h = g24;
        p.V = g24 <= 0.05 ? 0 : g24 <= 0.25 ? (g24 - 0.05) / 0.4 : g24 < 1 ? 0.5 + (g24 - 0.25) / 1.5 : 1;
      } else {
        p.V = ranks[i] * (p.ageH > 72 ? 0.5 : 1);
      }
    });
  }

  // --- Score final, rang « à reprendre maintenant », étiquettes ---
  for (const p of posts) {
    p.pvs = Math.round(100 * (0.45 * p.O + 0.3 * p.E + 0.25 * p.V) * (0.6 + 0.4 * p.conf));
    p.nowScore = Math.round(p.pvs * Math.pow(0.5, p.ageH / (HALF_LIFE[p.network] || 72)));
    p.label = p.pvs >= 75 ? "Viral" : p.pvs >= 55 ? "En décollage" : p.pvs >= 40 ? "Au-dessus de la normale" : "Dans la norme";
    if (isNum(p.authorFollowers) && p.authorFollowers < 50000 && p.R >= 5) p.flags.push("reproductible");
    const sharesPerK = isNum(p.shares) && p.views ? (p.shares / p.views) * 1000 : null;
    if ((p.views >= 100000 && sharesPerK !== null && sharesPerK < 0.2) || (p.views && isNum(p.likes) && p.likes / p.views > 0.3)) {
      p.flags.push("anomalie");
    }
    p.flags = [...new Set(p.flags)];
  }
  posts.sort((a, b) => b.nowScore - a.nowScore);
  return { posts, excluded };
}

function groupBy(list, keyFn) {
  const out = {};
  for (const item of list) (out[keyFn(item)] ||= []).push(item);
  return out;
}

function weightedMedian(pairs) {
  const sorted = pairs.filter(([v]) => isNum(v)).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return null;
}

/**
 * Regroupe les posts notés en tendances (hashtag ou son partagés par plusieurs créateurs
 * ou plusieurs réseaux). `externalTerms` : sujets montants hors réseaux (Google Trends, X France…).
 */
export function clusterPosts(posts, { externalTerms = [], excludeTerms = [] } = {}) {
  const ext = externalTerms.map(normalizeTag).filter(Boolean);
  // Les mots de la niche et les hashtags recherchés sont partout par construction : ce ne sont pas des tendances.
  const excluded = new Set(excludeTerms.flatMap((t) => [normalizeTag(t), normalizeTag(t).replace(/\s+/g, "")]).filter(Boolean));
  const groups = new Map();
  const add = (key, label, kind, post) => {
    if (!groups.has(key)) groups.set(key, { key, label, kind, posts: [] });
    groups.get(key).posts.push(post);
  };
  for (const p of posts) {
    if (p.flags.includes("sponsorisé")) continue;
    for (const tag of new Set((p.hashtags || []).map(normalizeTag))) {
      if (tag.length < 3 || GENERIC_TAGS.has(tag) || excluded.has(tag)) continue;
      add(`#${tag}`, `#${tag}`, "hashtag", p);
    }
    if (p.soundId && !p.soundOriginal) add(`son:${p.soundId}`, p.sound || "Son tendance", "son", p);
  }

  const clusters = [];
  for (const g of groups.values()) {
    // Au plus 2 posts par créateur : un compte prolifique ne fait pas une tendance.
    const perCreator = groupBy(g.posts, (p) => `${p.network}:${p.authorHandle || p.id}`);
    const kept = Object.values(perCreator).flatMap((list) => list.sort((a, b) => b.pvs - a.pvs).slice(0, 2));
    const creators = new Set(kept.map((p) => `${p.network}:${p.authorHandle || p.id}`));
    const networks = new Set(kept.map((p) => p.network));
    if (creators.size < 3 && networks.size < 2) continue;

    const wOf = (p) => 1 / (1 + Math.log10(Math.max(p.authorFollowers || 1000, 1000) / 1000));
    const medR = weightedMedian(kept.map((p) => [p.R, wOf(p)])) || 1;
    const hit = kept.filter((p) => p.R >= 3).length / kept.length;
    const volByCreator = {};
    for (const p of kept) volByCreator[`${p.network}:${p.authorHandle}`] = (volByCreator[`${p.network}:${p.authorHandle}`] || 0) + p.volAdj;
    const volTotal = Object.values(volByCreator).reduce((s, v) => s + v, 0) || 1;
    const sTop = Math.max(...Object.values(volByCreator)) / volTotal;
    const extHits = ext.filter((t) => t && (t.includes(g.key.replace(/^#/, "")) || g.key.replace(/^#/, "").includes(t))).length;

    const M = 0.6 * clamp(Math.log2(medR) / Math.log2(10), 0, 1) + 0.4 * Math.min(1, hit / 0.5);
    const C = clamp(Math.log(creators.size) / Math.log(15), 0, 1) * (1 - 0.5 * sTop);
    const P = Math.min(1, (networks.size - 1) / 2 + 0.25 * Math.min(extHits, 2));
    const G = kept.reduce((s, p) => s + p.V, 0) / kept.length;
    const medAge = median(kept.map((p) => p.ageH)) || 24;
    const ts = 100 * (0.35 * M + 0.25 * G + 0.2 * C + 0.2 * P) * Math.pow(0.5, medAge / 48);

    const small = kept.filter((p) => (p.authorFollowers ?? 0) < 50000).length;
    const huge = kept.filter((p) => (p.authorFollowers ?? 0) >= 1e6).length;
    // R est relatif au lot (médiane ≈ 1 par construction) : la saturation se lit aux gros
    // comptes et à la rareté des posts qui sur-performent, pas au seul ratio médian.
    let stage = "Établi";
    let stageWeight = 0.5;
    if (huge > kept.length / 2 || (creators.size >= 12 && hit < 0.15)) {
      stage = "Saturé";
      stageWeight = 0.2;
    } else if (creators.size <= 10 && hit >= 0.3 && small >= kept.length / 2) {
      stage = "Émergent";
      stageWeight = 1;
    } else if (G >= 0.6 && hit >= 0.2) {
      stage = "En explosion";
      stageWeight = 0.9;
    }
    clusters.push({
      key: g.key,
      label: g.label,
      kind: g.kind,
      stage,
      score: Math.round(ts),
      opportunity: Math.round(ts * stageWeight),
      creators: creators.size,
      networks: [...networks],
      medianRatio: Math.round(medR * 10) / 10,
      hitRate: Math.round(hit * 100),
      external: extHits > 0,
      postKeys: kept.sort((a, b) => b.pvs - a.pvs).slice(0, 5).map((p) => p.key),
    });
  }
  clusters.sort((a, b) => b.opportunity - a.opportunity);
  return clusters.slice(0, 8);
}
