// Persistance (outil mono-utilisateur), deux backends derrière la même API async :
// - Redis (Upstash, via son API REST) quand ses variables d'environnement sont là — requis sur Vercel ;
// - fichiers JSON dans data/ sinon (usage local).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./env.mjs";

// ---------------------------------------------------------------------------
// Backend Redis (Upstash REST)
// ---------------------------------------------------------------------------

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(...command) {
  const cfg = redisConfig();
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Stockage Redis indisponible (${data.error || `HTTP ${res.status}`})`);
  }
  return data.result;
}

const K = {
  index: "gc:index", // liste des ids, plus récent en tête
  entry: (id) => `gc:entry:${id}`,
  settings: "gc:settings",
  cache: (key) => `gc:cache:${key}`,
};

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

const redisBackend = {
  async listHistory() {
    const ids = (await redis("LRANGE", K.index, "0", "-1")) || [];
    if (!ids.length) return [];
    const raw = (await redis("MGET", ...ids.map(K.entry))) || [];
    return raw.map(parse).filter(Boolean);
  },
  async getEntry(id) {
    return parse(await redis("GET", K.entry(id)));
  },
  async insertEntry(entry) {
    await redis("SET", K.entry(entry.id), JSON.stringify(entry));
    await redis("LPUSH", K.index, entry.id);
  },
  async saveEntry(entry) {
    await redis("SET", K.entry(entry.id), JSON.stringify(entry));
  },
  async readSettings() {
    return parse(await redis("GET", K.settings));
  },
  async writeSettings(value) {
    await redis("SET", K.settings, JSON.stringify(value));
  },
  async cacheGet(key) {
    return parse(await redis("GET", K.cache(key)));
  },
  async cacheSet(key, value, ttlMs) {
    await redis("SET", K.cache(key), JSON.stringify(value), "PX", String(ttlMs));
  },
};

// ---------------------------------------------------------------------------
// Backend fichiers (local, ou /tmp éphémère sur Vercel faute de Redis)
// ---------------------------------------------------------------------------

const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const CACHE_DIR = path.join(DATA_DIR, "cache");

function ensureDirs() {
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

function readHistoryFile() {
  const h = readJson(HISTORY_PATH, []);
  return Array.isArray(h) ? h : [];
}

const fileBackend = {
  async listHistory() {
    return readHistoryFile();
  },
  async getEntry(id) {
    return readHistoryFile().find((e) => e.id === id) || null;
  },
  async insertEntry(entry) {
    const entries = readHistoryFile();
    entries.unshift(entry);
    writeJson(HISTORY_PATH, entries);
  },
  async saveEntry(entry) {
    const entries = readHistoryFile();
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx === -1) return;
    entries[idx] = entry;
    writeJson(HISTORY_PATH, entries);
  },
  async readSettings() {
    return readJson(SETTINGS_PATH, null);
  },
  async writeSettings(value) {
    writeJson(SETTINGS_PATH, value);
  },
  async cacheGet(key, maxAgeMs) {
    const file = path.join(CACHE_DIR, `${key}.json`);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) return null;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  },
  async cacheSet(key, value) {
    ensureDirs();
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  },
};

const backend = () => (redisConfig() ? redisBackend : fileBackend);

// "redis" | "fichiers" | "temporaire" (Vercel sans Redis : /tmp, perdu à chaque redémarrage)
export function storageKind() {
  if (redisConfig()) return "redis";
  return process.env.VERCEL ? "temporaire" : "fichiers";
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

export function listHistory() {
  return backend().listHistory();
}

export function getEntry(id) {
  return backend().getEntry(id);
}

export async function createEntry(brief, extra = {}) {
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
  await backend().insertEntry(entry);
  return entry;
}

export function updateEntry(id, patch) {
  return updateEntryWith(id, () => patch);
}

// Relit l'entrée juste avant d'écrire et calcule le patch sur cet état frais :
// un instantané pris avant un long appel IA n'écrase pas les modifications
// faites entre-temps.
export async function updateEntryWith(id, compute) {
  const b = backend();
  const fresh = await b.getEntry(id);
  if (!fresh) return null;
  const next = { ...fresh, ...compute(fresh) };
  await b.saveEntry(next);
  return next;
}

const DEFAULT_SETTINGS = {
  // Vues médianes habituelles par plateforme : sert à normaliser les stats
  // réelles (ratio vs médiane = la mesure "outlier", indépendante de la taille du compte).
  medianViews: { linkedin: 0, reels: 0, x: 0, youtube: 0 },
  voice: "", // description libre du ton / de la voix de l'auteur
};

export async function getSettings() {
  const raw = await backend().readSettings();
  const safe = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULT_SETTINGS,
    ...safe,
    medianViews: { ...DEFAULT_SETTINGS.medianViews, ...(safe.medianViews || {}) },
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (patch && typeof patch.medianViews === "object") {
    next.medianViews = { ...current.medianViews, ...patch.medianViews };
  }
  await backend().writeSettings(next);
  return next;
}

export function cacheGet(key, maxAgeMs) {
  return backend().cacheGet(key, maxAgeMs);
}

export function cacheSet(key, value, ttlMs) {
  return backend().cacheSet(key, value, ttlMs);
}
