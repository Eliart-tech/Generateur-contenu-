// Serveur local du générateur de contenu (outil personnel, mono-utilisateur).
// Démarrage : node server.mjs  →  http://127.0.0.1:3344
// En ligne, Vercel sert public/ en statique et api/index.js pour l'API.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadEnv, config, ROOT } from "./lib/env.mjs";
import { hasApiCredentials } from "./lib/claude.mjs";
import { handleApi } from "./lib/app.mjs";
import { storageKind } from "./lib/store.mjs";

loadEnv();

const PUBLIC_DIR = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
});

// Les générations (effort élevé) peuvent durer plusieurs minutes.
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(config.port, config.host, () => {
  console.log(`Générateur de contenu : http://${config.host}:${config.port}`);
  console.log(
    `Modèle : ${config.model} (effort ${config.effort}) · Géo tendances : ${config.geo} · Stockage : ${storageKind()}`,
  );
  if (!hasApiCredentials()) {
    console.log("⚠ ANTHROPIC_API_KEY absente : copie .env.example vers .env et renseigne ta clé.");
  }
  if (!config.youtubeKey) {
    console.log("ℹ Pas de YOUTUBE_API_KEY : le radar fonctionnera sans la source YouTube (optionnelle).");
  }
});
