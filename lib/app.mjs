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
  advanceScan,
  loadScan,
  latestScan,
  availableNetworks,
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

async function startScan({ niche, audience, networks, force }) {
  if (!niche || !String(niche).trim()) throw new Error("Indique ta niche (ex. : rénovation, coaching sportif, IA pour PME)");
  niche = String(niche).trim().slice(0, 120);
  audience = String(audience || "").trim().slice(0, 160);
  const queries = await queriesFor(niche, audience);
  return createScan({ niche, audience, networks, queries, force: Boolean(force) });
}

async function generateIdeas(scan) {
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
    });
    scan.ideas = {
      createdAt: new Date().toISOString(),
      synthese: out.synthese,
      items: out.idees.map((idea) => ({
        ...idea,
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
    await cacheSet(`scan-${scan.id}`, scan, 7 * 864e5).catch(() => {});
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
    const niche = body.niche ?? settings.profile.niche;
    const audience = body.audience ?? settings.profile.audience;
    const networks = Array.isArray(body.networks) ? body.networks : settings.socialNetworks;
    const scan = await startScan({ niche, audience, networks, force: body.force });
    // La niche scannée devient le profil par défaut (pré-remplissage, scan quotidien).
    await saveSettings({ profile: { niche: scan.niche, audience: scan.audience }, socialNetworks: networks });
    return scanView(scan);
  },

  "GET /api/scan": async (req) => {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    if (id === "latest") {
      const settings = await getSettings();
      return scanView((await latestScan(settings.profile.niche)) || (await latestScan()));
    }
    const scan = await loadScan(id);
    if (!scan) throw new Error("Scan introuvable (expiré ?)");
    return scanView(await advanceScan(scan));
  },

  "POST /api/ideas": async (_req, body) => {
    const scan = await loadScan(body.id);
    if (!scan) throw new Error("Scan introuvable (expiré ?)");
    if (scan.status !== "done") throw new Error("Le scan n'est pas terminé");
    if (scan.ideas && !body.force) return scanView(scan);
    return scanView(await generateIdeas(scan));
  },

  "GET /api/social/account": async () => {
    if (!hasApifyToken()) return { token: false };
    return { token: true, ...(await accountInfo()) };
  },

  // Scan quotidien (Vercel Cron, vercel.json). Ne fait rien tant qu'il n'est pas activé dans Réglages.
  "GET /api/cron/scan": async (req) => {
    const auth = req.headers?.authorization || "";
    const ua = req.headers?.["user-agent"] || "";
    if (config.cronSecret ? auth !== `Bearer ${config.cronSecret}` : !ua.includes("vercel-cron")) {
      throw new Error("Accès réservé au scan planifié");
    }
    const settings = await getSettings();
    if (!settings.autoScan || !settings.profile.niche) return { skipped: true };
    const t0 = Date.now();
    let scan = await startScan({ ...settings.profile, networks: settings.socialNetworks, force: true });
    while (scan.status === "running" && Date.now() - t0 < 200000) scan = await advanceScan(scan, { budgetSecs: 20 });
    if (scan.status === "done" && !scan.ideas && Date.now() - t0 < 150000 && hasApiCredentials()) {
      await generateIdeas(scan).catch(() => {});
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
    const body = req.method === "POST" ? await readBody(req) : null;
    return json(res, 200, await handler(req, body));
  } catch (error) {
    const message = String(error?.message || error);
    console.error(`[erreur] ${req.method} ${req.url} → ${message}`);
    return json(res, 400, { error: message });
  }
}
