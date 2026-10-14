// Persistance locale en JSON (outil mono-utilisateur) : data/history.json + data/settings.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./env.mjs";

const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
export const CACHE_DIR = path.join(DATA_DIR, "cache");

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Fichier présent mais illisible : on le met de côté pour que la prochaine
    // écriture n'efface pas silencieusement les données existantes.
    try {
      const backup = `${file}.corrompu-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(file, backup);
      console.error(`[store] ${path.basename(file)} illisible — sauvegarde : ${backup}`);
    } catch {
      /* au pire on continue avec le fallback */
    }
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---- Historique des générations ----

export function listHistory() {
  const h = readJson(HISTORY_PATH, []);
  return Array.isArray(h) ? h : [];
}

export function getEntry(id) {
  return listHistory().find((e) => e.id === id) || null;
}

export function createEntry(brief, extra = {}) {
  const entries = listHistory();
  const entry = {
    id: crypto.randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    brief, // { idea, niche, audience, goal, platforms }
    trends: null,
    angles: null,
    chosenAngle: null,
    scripts: null, // { [plateforme]: { contenu, titre?, hashtags, score } }
    realStats: {}, // { [plateforme]: { views, likes, comments, medianViews, ratio, band } }
    ...extra,
  };
  entries.unshift(entry);
  writeJson(HISTORY_PATH, entries);
  return entry;
}

export function updateEntry(id, patch) {
  return updateEntryWith(id, () => patch);
}

// Calcule le patch sur l'état FRAÎCHEMENT relu (lecture + écriture synchrones,
// sans await entre les deux) : évite qu'un instantané pris avant un long appel
// IA écrase les modifications faites entre-temps.
export function updateEntryWith(id, compute) {
  const entries = listHistory();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...compute(entries[idx]) };
  writeJson(HISTORY_PATH, entries);
  return entries[idx];
}

// ---- Réglages ----

const DEFAULT_SETTINGS = {
  // Vues médianes habituelles par plateforme : sert à normaliser les stats
  // réelles (ratio vs médiane = la mesure "outlier", indépendante de la taille du compte).
  medianViews: { linkedin: 0, reels: 0, x: 0, youtube: 0 },
  voice: "", // description libre du ton / de la voix de l'auteur
};

export function getSettings() {
  const raw = readJson(SETTINGS_PATH, {});
  const safe = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULT_SETTINGS,
    ...safe,
    medianViews: { ...DEFAULT_SETTINGS.medianViews, ...(safe.medianViews || {}) },
  };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  if (patch && typeof patch.medianViews === "object") {
    next.medianViews = { ...getSettings().medianViews, ...patch.medianViews };
  }
  writeJson(SETTINGS_PATH, next);
  return next;
}

// ---- Cache disque générique (tendances) ----

export function cacheGet(key, maxAgeMs) {
  ensureDirs();
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function cacheSet(key, value) {
  ensureDirs();
  const file = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
}
