// Serveur local du générateur de contenu (outil personnel, mono-utilisateur).
// Démarrage : node server.mjs  →  http://127.0.0.1:3344
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadEnv, config, ROOT } from "./lib/env.mjs";
import { getTrends, trendsAsText } from "./lib/sources.mjs";
import { heuristicScore } from "./lib/heuristics.mjs";
import {
  PLATFORMS,
  proposeAngles,
  writeScripts,
  judgeScripts,
  rewriteScript,
  hasApiCredentials,
} from "./lib/claude.mjs";
import {
  listHistory,
  getEntry,
  createEntry,
  updateEntry,
  getSettings,
  saveSettings,
} from "./lib/store.mjs";

loadEnv();

const PUBLIC_DIR = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const BAND_RANK = { top10: 3, top25: 2, top50: 1, moitie_basse: 0 };

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req) {
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
function combineScores(platform, script, evaluation) {
  const heur = heuristicScore(platform, script);
  const judgeGlobal = evaluation
    ? Math.round(
        evaluation.facteurs.reduce((s, f) => s + f.score, 0) / (evaluation.facteurs.length || 1),
      )
    : null;
  const final =
    judgeGlobal === null ? heur.global : Math.round(0.45 * heur.global + 0.55 * judgeGlobal);
  return {
    final,
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

function calibrationSummary() {
  const pairs = [];
  for (const entry of listHistory()) {
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
    const entry = createEntry(brief);
    const trends = await getTrends({ query: [brief.idea, brief.niche].filter(Boolean).join(" ").slice(0, 120) });
    const trendsText = trendsAsText(trends);
    const settings = getSettings();
    const result = await proposeAngles({ brief, trendsText, voice: settings.voice });
    return updateEntry(entry.id, { trends, angles: result });
  },

  "POST /api/scripts": async (_req, body) => {
    const { id, angleIndex } = body;
    const entry = getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    const angle = entry.angles?.angles?.[angleIndex];
    if (!angle) throw new Error("Angle introuvable");
    const trendsText = trendsAsText(entry.trends || { sources: {} });
    const settings = getSettings();
    const { scripts } = await writeScripts({
      brief: entry.brief,
      angle,
      trendsText,
      voice: settings.voice,
      platforms: entry.brief.platforms,
    });
    const { evaluations } = await judgeScripts({ brief: entry.brief, scripts, trendsText });
    const byPlatform = {};
    for (const script of scripts) {
      const evaluation = evaluations.find((e) => e.plateforme === script.plateforme) || null;
      byPlatform[script.plateforme] = {
        ...script,
        score: combineScores(script.plateforme, script, evaluation),
      };
    }
    return updateEntry(id, { chosenAngle: angle, scripts: byPlatform });
  },

  "POST /api/rewrite": async (_req, body) => {
    const { id, platform } = body;
    const entry = getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    const current = entry.scripts?.[platform];
    if (!current) throw new Error("Script introuvable");
    const trendsText = trendsAsText(entry.trends || { sources: {} });
    const settings = getSettings();
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
    const scripts = {
      ...entry.scripts,
      [platform]: { ...rewritten, score: combineScores(platform, rewritten, evaluation) },
    };
    return updateEntry(id, { scripts });
  },

  "GET /api/history": async () => ({
    entries: listHistory(),
    calibration: calibrationSummary(),
  }),

  "POST /api/stats": async (_req, body) => {
    const { id, platform, views, likes, comments, medianViews } = body;
    const entry = getEntry(id);
    if (!entry) throw new Error("Génération introuvable");
    if (!entry.scripts?.[platform]) throw new Error("Pas de script pour cette plateforme");
    const v = Number(views);
    const median = Number(medianViews);
    if (!Number.isFinite(v) || v < 0) throw new Error("Nombre de vues invalide");
    if (!Number.isFinite(median) || median <= 0) {
      throw new Error("Renseigne tes vues médianes habituelles (pour normaliser)");
    }
    // Mémorise la médiane pour pré-remplir la prochaine fois.
    saveSettings({ medianViews: { [platform]: median } });
    const ratio = v / median;
    const realStats = {
      ...entry.realStats,
      [platform]: {
        views: v,
        likes: Number(likes) || 0,
        comments: Number(comments) || 0,
        medianViews: median,
        ratio: Math.round(ratio * 100) / 100,
        band: observedBand(ratio),
        recordedAt: new Date().toISOString(),
      },
    };
    const updated = updateEntry(id, { realStats });
    return { entry: updated, calibration: calibrationSummary() };
  },
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Introuvable");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
  res.end(fs.readFileSync(full));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      const key = `${req.method} ${new URL(req.url, "http://localhost").pathname}`;
      const handler = routes[key];
      if (!handler) return json(res, 404, { error: "Route inconnue" });
      const body = req.method === "POST" ? await readBody(req) : null;
      const result = await handler(req, body);
      return json(res, 200, result);
    }
    return serveStatic(req, res);
  } catch (error) {
    const message = String(error?.message || error);
    console.error(`[erreur] ${req.method} ${req.url} → ${message}`);
    return json(res, 400, { error: message });
  }
});

// Les générations (effort élevé) peuvent durer plusieurs minutes.
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(config.port, config.host, () => {
  console.log(`Générateur de contenu : http://${config.host}:${config.port}`);
  console.log(`Modèle : ${config.model} (effort ${config.effort}) · Géo tendances : ${config.geo}`);
  if (!hasApiCredentials()) {
    console.log("⚠ ANTHROPIC_API_KEY absente : copie .env.example vers .env et renseigne ta clé.");
  }
  if (!config.youtubeKey) {
    console.log("ℹ Pas de YOUTUBE_API_KEY : le radar fonctionnera sans la source YouTube (optionnelle).");
  }
});
