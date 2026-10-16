// Chargement minimal d'un fichier .env (pas de dépendance).
// Les variables déjà présentes dans l'environnement gardent la priorité.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
// Sur Vercel le disque du projet est en lecture seule : seul /tmp (éphémère) est inscriptible.
export const DATA_DIR = process.env.VERCEL ? "/tmp/generateur-contenu" : path.join(ROOT, "data");

export function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Commentaire de fin de ligne sur une valeur non quotée : "PORT=3344  # local"
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export const config = {
  get model() {
    return process.env.CLAUDE_MODEL || "claude-opus-5-5";
  },
  get effort() {
    // Sur Vercel (plan gratuit : 5 min max par requête), "medium" garde de la marge.
    const fallback = process.env.VERCEL ? "medium" : "high";
    const e = (process.env.CLAUDE_EFFORT || fallback).toLowerCase();
    return ["low", "medium", "high", "xhigh", "max"].includes(e) ? e : fallback;
  },
  get geo() {
    return process.env.TREND_GEO || "FR";
  },
  get lang() {
    return process.env.TREND_LANG || "fr";
  },
  get youtubeKey() {
    return process.env.YOUTUBE_API_KEY || "";
  },
  // Jeton Apify : active TikTok, Instagram, X et LinkedIn dans le scan des réseaux.
  get apifyToken() {
    return process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || "";
  },
  get apifyBase() {
    return (process.env.APIFY_API_BASE || "https://api.apify.com").replace(/\/$/, "");
  },
  // Modèle de l'analyse des posts (tri, mécanismes, visuels) : le modèle principal par défaut.
  // claude-haiku-5-5 la rend environ 40 fois moins chère, au prix d'une lecture moins fine.
  get analysisModel() {
    return process.env.CLAUDE_ANALYSIS_MODEL || this.model;
  },
  // Veille web de Claude avant chaque scan (recherche web côté Anthropic, ~0,01 $ par recherche).
  get webResearch() {
    return !/^(0|off|false|non)$/i.test(process.env.CLAUDE_WEB_RESEARCH || "");
  },
  // Secret envoyé par Vercel Cron (Authorization: Bearer …) pour le scan quotidien.
  get cronSecret() {
    return process.env.CRON_SECRET || "";
  },
  get port() {
    return Number(process.env.PORT) || 3344;
  },
  get host() {
    // Outil personnel : on n'écoute que localhost par défaut.
    return process.env.HOST || "127.0.0.1";
  },
};
