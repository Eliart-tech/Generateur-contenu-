// API du générateur, partagée par le serveur local (server.mjs) et la fonction
// Vercel (api/index.js). Une seule fonction sert toutes les routes /api/*.
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
} from "./claude.mjs";
import {
  listHistory,
  getEntry,
  createEntry,
  updateEntry,
  updateEntryWith,
  getSettings,
  saveSettings,
  storageKind,
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

const routes = {
  "GET /api/health": async () => ({
    ok: true,
    model: config.model,
    effort: config.effort,
    geo: config.geo,
    hasAnthropicKey: hasApiCredentials(),
    hasYoutubeKey: Boolean(config.youtubeKey),
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
    const { idea, niche, audience, goal, platforms } = body;
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
    };
    const trends = await getTrends({
      query: [brief.idea, brief.niche].filter(Boolean).join(" ").slice(0, 120),
    });
    const trendsText = trendsAsText(trends);
    const settings = await getSettings();
    const result = await proposeAngles({ brief, trendsText, voice: settings.voice });
    // L'entrée n'est créée qu'en cas de succès : pas d'entrée fantôme en historique.
    return createEntry(brief, { trends, angles: result });
  },

  // Écrit les scripts (score provisoire = heuristiques). Le juge IA passe ensuite
  // via /api/judge : deux requêtes courtes tiennent dans la limite de durée de Vercel.
  "POST /api/scripts": async (_req, body) => {
    const { id, angleIndex } = body;
    const entry = await getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    const angle = entry.angles?.angles?.[angleIndex];
    if (!angle) throw new Error("Angle introuvable");
    const trendsText = trendsAsText(entry.trends || { sources: {} });
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
    const trendsText = trendsAsText(entry.trends || { sources: {} });
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
    const trendsText = trendsAsText(entry.trends || { sources: {} });
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
