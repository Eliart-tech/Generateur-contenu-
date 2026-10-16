// API du générateur, partagée par le serveur local (server.mjs) et la fonction
// Vercel (api/index.js). Une seule fonction sert toutes les routes /api/*.
import crypto from "node:crypto";
import { config } from "./env.mjs";
import { getTrends, trendsAsText } from "./sources.mjs";
import { heuristicScore } from "./heuristics.mjs";
import {
  PLATFORMS,
  proposeAngles,
  writeScripts,
  judgeScripts,
  rewriteScript,
  hasApiCredentials,
  planQueries,
  proposeIdeas,
} from "./claude.mjs";
import {
  createScan,
  reusableScan,
  advanceScan,
  loadScan,
  latestScan,
  availableNetworks,
  SOCIAL_NETWORKS,
  NETWORK_LABELS,
  socialAsText,
  postLine,
  clusterLine,
  externalLines,
  SCAN_COST_USD,
} from "./social.mjs";
import { accountInfo, hasApifyToken } from "./apify.mjs";
import {
  listHistory,
  getEntry,
  createEntry,
  updateEntry,
  updateEntryWith,
  getSettings,
  saveSettings,
  storageKind,
  cacheGet,
  cacheSet,
  acquireLock,
  releaseLock,
} from "./store.mjs";

const BAND_RANK = { top10: 3, top25: 2, top50: 1, moitie_basse: 0 };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  // Sur Vercel, le corps JSON est déjà lu et exposé par le getter req.body.
  if ("body" in req) {
    let b;
    try {
      b = req.body;
    } catch {
      return Promise.reject(new Error("JSON invalide"));
    }
    if (b && typeof b === "object" && !Buffer.isBuffer(b)) return Promise.resolve(b);
    if (typeof b === "string" || Buffer.isBuffer(b)) {
      try {
        return Promise.resolve(b.length ? JSON.parse(b.toString()) : {});
      } catch {
        return Promise.reject(new Error("JSON invalide"));
      }
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("Corps de requête trop grand"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

// Combine heuristiques locales + évaluation du juge en un score affichable.
// Sans évaluation (juge pas encore passé), le score repose sur les seules heuristiques.
function combineScores(platform, script, evaluation) {
  const heur = heuristicScore(platform, script);
  const judgeGlobal = evaluation?.facteurs?.length
    ? Math.round(evaluation.facteurs.reduce((s, f) => s + f.score, 0) / evaluation.facteurs.length)
    : null;
  const final =
    judgeGlobal === null ? heur.global : Math.round(0.45 * heur.global + 0.55 * judgeGlobal);
  return {
    final,
    juge: judgeGlobal !== null,
    bande: evaluation?.bande || null,
    confiance: evaluation?.confiance || null,
    verdict: evaluation?.verdict || "",
    facteurs: evaluation?.facteurs || [],
    comparaison: evaluation?.comparaison || "",
    suggestions: evaluation?.suggestions || [],
    heuristique: heur,
  };
}

function observedBand(ratio) {
  if (ratio >= 3) return "top10";
  if (ratio >= 1.5) return "top25";
  if (ratio >= 0.8) return "top50";
  return "moitie_basse";
}

function calibrationSummary(entries) {
  const pairs = [];
  for (const entry of entries) {
    for (const [platform, stat] of Object.entries(entry.realStats || {})) {
      const predicted = entry.scripts?.[platform]?.score?.bande;
      if (predicted && stat.band) {
        pairs.push({ predicted, observed: stat.band });
      }
    }
  }
  const n = pairs.length;
  if (!n) return { n: 0, exact: null, adjacent: null };
  const exact = pairs.filter((p) => p.predicted === p.observed).length;
  const adjacent = pairs.filter(
    (p) => Math.abs(BAND_RANK[p.predicted] - BAND_RANK[p.observed]) <= 1,
  ).length;
  return {
    n,
    exact: Math.round((exact / n) * 100),
    adjacent: Math.round((adjacent / n) * 100),
  };
}

// Contexte complet d'une prévision : tendances générales + signaux des réseaux (si scannés).
function contextText(entry) {
  const base = trendsAsText(entry.trends || { sources: {} });
  return entry.socialText ? `${base}\n\n${entry.socialText}` : base;
}

// Requêtes de recherche par réseau, préparées une fois par niche (7 jours).
async function queriesFor(niche, audience) {
  const key = `queries-${crypto.createHash("sha1").update(`${niche}|${audience}`.toLowerCase()).digest("hex").slice(0, 12)}`;
  const cached = await cacheGet(key, 7 * 864e5).catch(() => null);
  if (cached) return cached;
  let q;
  if (hasApiCredentials()) {
    q = await planQueries({ niche, audience });
  } else {
    q = { tiktok: [niche], instagram: niche, x: `("${niche}")`, linkedin: [niche], youtube: niche, hashtags: [] };
  }
  q.tiktok = q.tiktok.filter(Boolean).slice(0, 2);
  q.linkedin = q.linkedin.filter(Boolean).slice(0, 2);
  await cacheSet(key, q, 7 * 864e5).catch(() => {});
  return q;
}

const IDEA_POSTS = 25;

// Ce que l'interface reçoit d'un scan.
function scanView(scan) {
  if (!scan) return null;
  return {
    id: scan.id,
    createdAt: scan.createdAt,
    finishedAt: scan.finishedAt || null,
    status: scan.status,
    reused: Boolean(scan.reused),
    niche: scan.niche,
    audience: scan.audience,
    networks: scan.networks,
    skipped: scan.skipped || [],
    queries: scan.queries,
    account: scan.account,
    runs: Object.fromEntries(
      Object.entries(scan.runs || {})
        .filter(([k]) => k !== "instagramProfiles")
        .map(([k, r]) => [k, { status: r.status, error: r.error || null }]),
    ),
    stats: scan.stats || null,
    excluded: scan.excluded || null,
    posts: scan.posts || [],
    clusters: scan.clusters || [],
    external: scan.external || null,
    ideas: scan.ideas || null,
    ideasError: scan.ideasError || null,
    errors: [...(scan.errors || []), ...((scan.external && scan.external.errors) || [])],
    costUsd: scan.costUsd ?? null,
  };
}

const SCAN_ID_RE = /^[a-z0-9-]{4,40}$/i;
const DAY_MS = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanScanInput({ niche, audience, networks }) {
  if (!niche || !String(niche).trim()) throw new Error("Indique ta niche (ex. : rénovation, coaching sportif, IA pour PME)");
  const nets = Array.isArray(networks) ? networks.filter((n) => SOCIAL_NETWORKS.includes(n)) : null;
  if (nets && !nets.length) throw new Error("Choisis au moins un réseau à scanner.");
  return {
    niche: String(niche).trim().slice(0, 120),
    audience: String(audience || "").trim().slice(0, 160),
    networks: nets && nets.length ? nets : SOCIAL_NETWORKS,
  };
}

async function startScan({ niche, audience, networks, force }) {
  const input = cleanScanInput({ niche, audience, networks });
  // Réutilisation vérifiée avant de préparer les requêtes : aucun appel IA inutile.
  if (!force) {
    const prev = await reusableScan(input);
    if (prev) return prev;
  }
  const queries = await queriesFor(input.niche, input.audience);
  return createScan({ ...input, queries, force: Boolean(force) });
}

// Les idées citent les posts par numéro dans « preuves » ; dans le texte, un « P3 » éventuel
// est remplacé par une référence lisible (l'interface n'affiche pas les numéros).
function readableRefs(text, posts) {
  return String(text || "").replace(/\bP(\d{1,2})\b/g, (m, n) => {
    const p = posts[Number(n) - 1];
    return p ? `@${p.authorHandle || "?"} (${NETWORK_LABELS[p.network] || p.network})` : m;
  });
}

async function generateIdeas(scan, { force = false, timeoutMs } = {}) {
  // Une seule génération à la fois par scan (deux onglets, cron et interface).
  const lockKey = `ideas-${scan.id}`;
  if (!(await acquireLock(lockKey, 300000).catch(() => true))) return waitForIdeas(scan.id);
  try {
    const fresh = (await loadScan(scan.id)) || scan;
    if (fresh.ideas && !force) return fresh;
    scan = fresh;
    const settings = await getSettings();
    const posts = (scan.posts || []).slice(0, IDEA_POSTS);
    try {
      const out = await proposeIdeas({
        niche: scan.niche,
        audience: scan.audience,
        voice: settings.voice,
        postsText: posts.map((p, i) => postLine(p, i)).join("\n"),
        clustersText: (scan.clusters || []).slice(0, 6).map((c) => `- ${clusterLine(c)}`).join("\n"),
        externalText: externalLines(scan.external).map((l) => `- ${l}`).join("\n"),
        timeoutMs,
      });
      scan.ideas = {
        createdAt: new Date().toISOString(),
        synthese: readableRefs(out.synthese, posts),
        items: out.idees.map((idea) => ({
          ...idea,
          pourquoi_maintenant: readableRefs(idea.pourquoi_maintenant, posts),
          deroule: readableRefs(idea.deroule, posts),
          preuves: [...new Set(idea.preuves)]
            .filter((n) => n >= 1 && n <= posts.length)
            .slice(0, 3)
            .map((n) => posts[n - 1].key),
        })),
      };
      scan.ideasError = null;
    } catch (err) {
      scan.ideasError = err.message;
      throw err;
    } finally {
      await cacheSet(`scan-${scan.id}`, scan, 7 * DAY_MS).catch(() => {});
    }
    return scan;
  } finally {
    await releaseLock(lockKey).catch(() => {});
  }
}

// Une autre requête rédige déjà les idées de ce scan : on attend son résultat plutôt que de payer deux fois.
async function waitForIdeas(id, maxMs = 240000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await sleep(3000);
    const s = await loadScan(id);
    if (s?.ideas) return s;
    if (s?.ideasError) throw new Error(s.ideasError);
  }
  throw new Error("Les idées sont toujours en cours de rédaction. Réessaie dans un instant.");
}

function cronAllowed(req) {
  const auth = req.headers?.authorization || "";
  const ua = req.headers?.["user-agent"] || "";
  return config.cronSecret ? auth === `Bearer ${config.cronSecret}` : ua.includes("vercel-cron");
}

// Fait avancer un scan jusqu'à la fin, dans le temps accordé à la fonction (300 s sur Vercel).
async function driveScan(scan, untilMs) {
  while (scan.status === "running" && Date.now() < untilMs - 5000) {
    const budget = Math.max(1, Math.min(20, Math.floor((untilMs - Date.now()) / 1000) - 25));
    scan = await advanceScan(scan, { budgetSecs: budget });
  }
  return scan;
}

const routes = {
  "GET /api/health": async () => ({
    ok: true,
    model: config.model,
    effort: config.effort,
    geo: config.geo,
    hasAnthropicKey: hasApiCredentials(),
    hasYoutubeKey: Boolean(config.youtubeKey),
    hasApifyToken: hasApifyToken(),
    social: availableNetworks(),
    scanCostUsd: SCAN_COST_USD,
    storage: storageKind(),
    deployed: Boolean(process.env.VERCEL),
  }),

  "GET /api/settings": async () => getSettings(),
  "POST /api/settings": async (_req, body) => saveSettings(body),

  "GET /api/trends": async (req) => {
    const url = new URL(req.url, "http://localhost");
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) throw new Error("Paramètre q requis");
    return getTrends({ query });
  },

  "POST /api/angles": async (_req, body) => {
    const { idea, niche, audience, goal, platforms, context } = body;
    if (!idea || !idea.trim()) throw new Error("L'idée est requise");
    const chosen = (Array.isArray(platforms) ? platforms : []).filter((p) =>
      PLATFORMS.includes(p),
    );
    if (!chosen.length) throw new Error("Choisis au moins une plateforme");
    const brief = {
      idea: idea.trim(),
      niche: (niche || "").trim(),
      audience: (audience || "").trim(),
      goal: (goal || "").trim(),
      platforms: chosen,
      // Idée venue du scan des réseaux : son « pourquoi maintenant » guide les angles.
      context: typeof context === "string" ? context.trim().slice(0, 1200) : "",
    };
    const trends = await getTrends({
      query: [brief.idea, brief.niche].filter(Boolean).join(" ").slice(0, 120),
    });
    // Signaux des réseaux : dernier scan de la même niche s'il date de moins de 48 h.
    const scan = brief.niche ? await latestScan(brief.niche).catch(() => null) : null;
    const fresh = scan && scan.status === "done" && Date.now() - Date.parse(scan.finishedAt || scan.createdAt) < 48 * 3.6e6;
    const socialText = fresh ? socialAsText(scan) : "";
    const settings = await getSettings();
    const result = await proposeAngles({
      brief,
      trendsText: socialText ? `${trendsAsText(trends)}\n\n${socialText}` : trendsAsText(trends),
      voice: settings.voice,
    });
    // L'entrée n'est créée qu'en cas de succès : pas d'entrée fantôme en historique.
    return createEntry(brief, { trends, angles: result, socialText, socialScanId: fresh ? scan.id : null });
  },

  // Écrit les scripts (score provisoire = heuristiques). Le juge IA passe ensuite
  // via /api/judge : deux requêtes courtes tiennent dans la limite de durée de Vercel.
  "POST /api/scripts": async (_req, body) => {
    const { id, angleIndex } = body;
    const entry = await getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    const angle = entry.angles?.angles?.[angleIndex];
    if (!angle) throw new Error("Angle introuvable");
    const trendsText = contextText(entry);
    const settings = await getSettings();
    const out = await writeScripts({
      brief: entry.brief,
      angle,
      trendsText,
      voice: settings.voice,
      platforms: entry.brief.platforms,
    });
    const scripts = out.scripts.filter((s) => entry.brief.platforms.includes(s.plateforme));
    const missing = entry.brief.platforms.filter((p) => !scripts.some((s) => s.plateforme === p));
    if (missing.length) {
      throw new Error(
        `Le modèle n'a pas produit de script pour : ${missing.join(", ")}. Relance la génération.`,
      );
    }
    const byPlatform = {};
    for (const script of scripts) {
      byPlatform[script.plateforme] = { ...script, score: combineScores(script.plateforme, script, null) };
    }
    const updated = await updateEntry(id, { chosenAngle: angle, scripts: byPlatform });
    if (!updated) throw new Error("Génération introuvable");
    return updated;
  },

  "POST /api/judge": async (_req, body) => {
    const { id } = body;
    const entry = await getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    const scripts = Object.values(entry.scripts || {});
    if (!scripts.length) throw new Error("Aucun script à évaluer");
    const trendsText = contextText(entry);
    const { evaluations } = await judgeScripts({ brief: entry.brief, scripts, trendsText });
    const updated = await updateEntryWith(id, (fresh) => {
      const next = { ...fresh.scripts };
      for (const [platform, script] of Object.entries(next)) {
        const evaluation = evaluations.find((e) => e.plateforme === platform) || null;
        if (evaluation) next[platform] = { ...script, score: combineScores(platform, script, evaluation) };
      }
      return { scripts: next };
    });
    if (!updated) throw new Error("Génération introuvable");
    return updated;
  },

  "POST /api/rewrite": async (_req, body) => {
    const { id, platform } = body;
    const entry = await getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    const current = entry.scripts?.[platform];
    if (!current) throw new Error("Script introuvable");
    const trendsText = contextText(entry);
    const settings = await getSettings();
    const suggestions = [
      ...(current.score?.suggestions || []),
      ...(current.score?.heuristique?.flags || []),
    ];
    const rewritten = await rewriteScript({
      brief: entry.brief,
      script: current,
      suggestions,
      trendsText,
      voice: settings.voice,
    });
    const { evaluations } = await judgeScripts({
      brief: entry.brief,
      scripts: [rewritten],
      trendsText,
    });
    const evaluation = evaluations.find((e) => e.plateforme === platform) || evaluations[0] || null;
    // Patch calculé sur l'état relu : une autre réécriture terminée pendant
    // les appels IA ne sera pas écrasée par notre instantané périmé.
    const updated = await updateEntryWith(id, (fresh) => ({
      scripts: {
        ...fresh.scripts,
        [platform]: { ...rewritten, score: combineScores(platform, rewritten, evaluation) },
      },
    }));
    if (!updated) throw new Error("Génération introuvable");
    return updated;
  },

  // ---------- Réseaux sociaux : scan, suivi, idées ----------

  "POST /api/scan": async (_req, body) => {
    const settings = await getSettings();
    const input = cleanScanInput({
      niche: body.niche ?? settings.profile.niche,
      audience: body.audience ?? settings.profile.audience,
      networks: Array.isArray(body.networks) ? body.networks : settings.socialNetworks,
    });
    const scan = await startScan({ ...input, force: body.force });
    // La niche demandée devient le profil par défaut (pré-remplissage, scan quotidien).
    await saveSettings({ profile: { niche: input.niche, audience: input.audience }, socialNetworks: input.networks });
    return scanView(scan);
  },

  "GET /api/scan": async (req) => {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    if (id === "latest") {
      const settings = await getSettings();
      return scanView((await latestScan(settings.profile.niche)) || (await latestScan()));
    }
    const scan = SCAN_ID_RE.test(id || "") ? await loadScan(id) : null;
    if (!scan) throw new Error("Scan introuvable (expiré ?)");
    return scanView(await advanceScan(scan));
  },

  "POST /api/ideas": async (_req, body) => {
    const scan = SCAN_ID_RE.test(String(body.id || "")) ? await loadScan(String(body.id)) : null;
    if (!scan) throw new Error("Scan introuvable (expiré ?)");
    if (scan.status !== "done") throw new Error("Le scan n'est pas terminé");
    if (scan.ideas && !body.force) return scanView(scan);
    return scanView(await generateIdeas(scan, { force: Boolean(body.force) }));
  },

  "GET /api/social/account": async () => {
    if (!hasApifyToken()) return { token: false };
    return { token: true, ...(await accountInfo()) };
  },

  // Scan quotidien (Vercel Cron, vercel.json). Ne fait rien tant qu'il n'est pas activé dans Réglages.
  // Une seule fois par jour, même si Vercel livre l'appel deux fois, et jamais si un scan de
  // la niche a moins de 20 h (manuel ou non).
  "GET /api/cron/scan": async (req) => {
    if (!cronAllowed(req)) throw new Error("Accès réservé au scan planifié");
    const t0 = Date.now();
    const settings = await getSettings();
    if (!settings.autoScan || !settings.profile.niche) return { skipped: "désactivé" };
    const day = new Date().toISOString().slice(0, 10);
    if (!(await acquireLock(`cron-scan-${day}`, 20 * 3.6e6).catch(() => true))) return { skipped: "déjà lancé aujourd'hui" };
    let scan = await latestScan(settings.profile.niche);
    const recent = scan && Date.now() - Date.parse(scan.createdAt) < 20 * 3.6e6 && (scan.status === "running" || scan.posts?.length);
    if (!recent) scan = await startScan({ ...settings.profile, networks: settings.socialNetworks, force: true });
    scan = await driveScan(scan, t0 + 270000);
    const left = t0 + 285000 - Date.now();
    // Les idées ne partent que s'il reste le temps de les écrire ; sinon le passage de 7 h s'en charge.
    if (scan.status === "done" && !scan.ideas && left > 140000 && hasApiCredentials()) {
      scan = await generateIdeas(scan, { timeoutMs: left - 15000 }).catch(() => scan);
    }
    return { id: scan.id, status: scan.status, reused: Boolean(recent), ideas: Boolean(scan.ideas) };
  },

  // Rattrapage, une heure plus tard : termine un scan resté en cours et rédige ses idées.
  "GET /api/cron/ideas": async (req) => {
    if (!cronAllowed(req)) throw new Error("Accès réservé au scan planifié");
    const t0 = Date.now();
    const settings = await getSettings();
    if (!settings.autoScan || !settings.profile.niche || !hasApiCredentials()) return { skipped: "désactivé" };
    let scan = await latestScan(settings.profile.niche);
    if (!scan || Date.now() - Date.parse(scan.createdAt) > 20 * 3.6e6) return { skipped: "aucun scan récent" };
    scan = await driveScan(scan, t0 + 60000);
    if (scan.status === "done" && !scan.ideas) {
      scan = await generateIdeas(scan, { timeoutMs: t0 + 280000 - Date.now() }).catch(() => scan);
    }
    return { id: scan.id, status: scan.status, ideas: Boolean(scan.ideas) };
  },

  "GET /api/history": async () => {
    const entries = await listHistory();
    return { entries, calibration: calibrationSummary(entries) };
  },

  "POST /api/stats": async (_req, body) => {
    const { id, platform, views, likes, comments, medianViews } = body;
    const entry = await getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    if (!entry.scripts?.[platform]) throw new Error("Pas de script pour cette plateforme");
    if (views === "" || views === null || views === undefined) {
      throw new Error("Renseigne le nombre de vues");
    }
    const v = Number(views);
    const median = Number(medianViews);
    if (!Number.isFinite(v) || v < 0) throw new Error("Nombre de vues invalide");
    if (!Number.isFinite(median) || median <= 0) {
      throw new Error("Renseigne tes vues médianes habituelles (pour normaliser)");
    }
    // Mémorise la médiane pour pré-remplir la prochaine fois.
    await saveSettings({ medianViews: { [platform]: median } });
    const ratio = v / median;
    const updated = await updateEntryWith(id, (fresh) => ({
      realStats: {
        ...fresh.realStats,
        [platform]: {
          views: v,
          likes: Number(likes) || 0,
          comments: Number(comments) || 0,
          medianViews: median,
          ratio: Math.round(ratio * 100) / 100,
          band: observedBand(ratio),
          recordedAt: new Date().toISOString(),
        },
      },
    }));
    return { entry: updated, calibration: calibrationSummary(await listHistory()) };
  },
};

// Sur Vercel, vercel.json réécrit /api/<route> vers /api/index?__route=<route>.
function routePath(req) {
  const url = new URL(req.url, "http://localhost");
  const rewritten = url.searchParams.get("__route");
  if (rewritten && (url.pathname === "/api/index" || url.pathname === "/api")) {
    return `/api/${rewritten}`;
  }
  return url.pathname;
}

export async function handleApi(req, res) {
  try {
    const handler = routes[`${req.method} ${routePath(req)}`];
    if (!handler) return json(res, 404, { error: "Route inconnue" });
    // JSON exigé : un formulaire d'un autre site (text/plain, sans pré-vérification CORS)
    // ne peut pas déclencher de génération ni de scan payant.
    if (req.method === "POST" && !/^application\/json\b/i.test(String(req.headers?.["content-type"] || ""))) {
      return json(res, 415, { error: "Requête refusée : JSON attendu." });
    }
    const body = req.method === "POST" ? await readBody(req) : null;
    return json(res, 200, await handler(req, body));
  } catch (error) {
    const message = String(error?.message || error);
    console.error(`[erreur] ${req.method} ${req.url} → ${message}`);
    return json(res, 400, { error: message });
  }
}
