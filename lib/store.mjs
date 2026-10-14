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
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
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
  return readJson(HISTORY_PATH, []);
}

export function getEntry(id) {
  return listHistory().find((e) => e.id === id) || null;
}

export function createEntry(brief) {
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
  };
  entries.unshift(entry);
  writeJson(HISTORY_PATH, entries);
  return entry;
}

export function updateEntry(id, patch) {
  const entries = listHistory();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch };
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
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) };
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
