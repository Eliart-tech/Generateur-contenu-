// Chargement minimal d'un fichier .env (pas de dépendance).
// Les variables déjà présentes dans l'environnement gardent la priorité.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(ROOT, "data");

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
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export const config = {
  get model() {
    return process.env.CLAUDE_MODEL || "claude-opus-5-5";
  },
  get effort() {
    const e = (process.env.CLAUDE_EFFORT || "high").toLowerCase();
    return ["low", "medium", "high", "xhigh", "max"].includes(e) ? e : "high";
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
  get port() {
    return Number(process.env.PORT) || 3344;
  },
  get host() {
    // Outil personnel : on n'écoute que localhost par défaut.
    return process.env.HOST || "127.0.0.1";
  },
};
