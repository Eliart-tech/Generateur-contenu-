// API du générateur, partagée par le serveur local (server.mjs) et la fonction
// Vercel (api/index.js). Une seule fonction sert toutes les routes /api/*.
import crypto from "node:crypto";
import { config } from "./env.mjs";
import { getTrends, trendsAsText } from "./sources.mjs";
import { heuristicScore } from "./heuristics.mjs";
import {
  PLATFORMS,
  PLATFORM_LABELS,
  proposeAngles,
  writeScripts,
  judgeScripts,
  rewriteScript,
  hasApiCredentials,
  planQueries,
  researchNiche,
  analyzePosts,
  proposeIdeas,
} from "./claude.mjs";
import {
  createScan,
  reusableScan,
  advanceScan,
  loadScan,
  latestScan,
  latestDoneScan,
  availableNetworks,
  SOCIAL_NETWORKS,
  NETWORK_LABELS,
  socialAsText,
  postLine,
  clusterLine,
  externalLines,
  coverImages,
  aiTrendLine,
  researchLines,
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

const SCAN_ID_RE = /^[a-z0-9-]{4,40}$/i;
const DAY_MS = 864e5;
const PLAN_TTL = 20 * 3.6e6; // veille web et requêtes refaites une fois par jour au plus
const ANALYZE_POSTS = 40; // posts lus par Claude (texte + mesures)
const ANALYZE_IMAGES = 12; // couvertures regardées par Claude
const IDEA_POSTS = 25;
// Préparation d'un scan (veille web + requêtes) : bornée pour que la création du scan tienne
// dans les 300 s d'une fonction Vercel.
const RESEARCH_MS = 110000;
const PREP_MS = 170000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saveScanRaw = (scan) => cacheSet(`scan-${scan.id}`, scan, 7 * DAY_MS).catch(() => {});

// Champs écrits par chaque étape Claude. L'analyse et les idées peuvent tourner en même temps
// (scan planifié et interface) : chacune n'enregistre que les siens, sur une copie relue du scan.
const ANALYSIS_FIELDS = ["posts", "clusters", "excluded", "stats", "analysis", "analysisError"];
const IDEAS_FIELDS = ["ideas", "ideasError"];

async function patchScan(scan, fields, step, usd) {
  const fresh = (await loadScan(scan.id).catch(() => null)) || scan;
  for (const f of fields) fresh[f] = scan[f];
  addClaudeCost(fresh, step, usd);
  await saveScanRaw(fresh);
  return fresh;
}

// Erreur « déjà en cours ailleurs » : l'interface attend le résultat au lieu de conclure à un échec.
const busyError = (message) => Object.assign(new Error(message), { status: 409 });

// Coût Claude cumulé par scan, étape par étape (veille, analyse, idées).
function addClaudeCost(scan, step, usd) {
  if (!usd) return;
  const c = (scan.claude ||= { costUsd: 0, steps: {} });
  c.steps[step] = Math.round(((c.steps[step] || 0) + usd) * 10000) / 10000;
  c.costUsd = Math.round(Object.values(c.steps).reduce((a, b) => a + b, 0) * 10000) / 10000;
}

const basicQueries = (niche) => ({ tiktok: [niche], instagram: niche, x: `("${niche}")`, linkedin: [niche], youtube: niche, hashtags: [] });

/**
 * Préparation d'un scan par Claude : veille web de la semaine (recherche web), puis requêtes par
 * réseau appuyées sur cette veille. Plan et veille gardés 20 h par niche et audience ; un plan
 * préparé sans la veille (panne passagère) n'est pas gardé, le scan suivant la retente.
 * Sans clé, requêtes simples.
 */
async function planFor(niche, audience) {
  const hash = crypto.createHash("sha1").update(`${niche}|${audience}`.toLowerCase()).digest("hex").slice(0, 12);
  const key = `plan-${hash}`;
  const cached = await cacheGet(key, PLAN_TTL).catch(() => null);
  if (cached?.queries) return { ...cached, costUsd: 0, reused: true };
  if (!hasApiCredentials()) return { queries: basicQueries(niche), research: null, researchError: null, costUsd: 0 };

  const t0 = Date.now();
  let cost = 0;
  let research = null;
  let researchError = null;
  if (config.webResearch) {
    // Veille déjà payée aujourd'hui (plan non abouti) : reprise telle quelle.
    const researchKey = `veille-${hash}`;
    research = await cacheGet(researchKey, PLAN_TTL).catch(() => null);
    if (!research?.note) {
      research = null;
      try {
        const r = await researchNiche({ niche, audience, timeoutMs: RESEARCH_MS });
        cost += r.costUsd || 0;
        research = { note: r.note, sources: r.sources, createdAt: new Date().toISOString() };
        await cacheSet(researchKey, research, PLAN_TTL).catch(() => {});
      } catch (err) {
        cost += err.costUsd || 0;
        researchError = err.message;
      }
    }
  }
  const keptResearch = (veille) => (research ? { ...(veille || {}), note: research.note, sources: research.sources, createdAt: research.createdAt } : null);
  let plan;
  try {
    plan = await planQueries({
      niche,
      audience,
      researchNote: research?.note,
      timeoutMs: Math.max(30000, PREP_MS - (Date.now() - t0)),
      onUsage: (usd) => (cost += usd || 0),
    });
  } catch (err) {
    // Le scan reste possible sans Claude : requêtes simples tirées de la niche (veille conservée).
    return { queries: basicQueries(niche), research: keptResearch(null), researchError: researchError || err.message, costUsd: cost };
  }
  const queries = {
    tiktok: plan.tiktok.filter(Boolean).slice(0, 2),
    instagram: plan.instagram,
    x: plan.x,
    linkedin: plan.linkedin.filter(Boolean).slice(0, 2),
    youtube: plan.youtube,
    hashtags: plan.hashtags,
  };
  const result = { queries, research: keptResearch(plan.veille), researchError };
  if (research || !config.webResearch) await cacheSet(key, result, PLAN_TTL).catch(() => {});
  return { ...result, costUsd: cost };
}

// Ce que l'interface reçoit d'un scan.
function scanView(scan) {
  if (!scan) return null;
  const { note, ...research } = scan.research || {};
  // Veille sans résumé structuré (plan préparé sans elle) : un extrait de la note la remplace.
  if (note && !research.synthese && !research.a_savoir?.length) research.extrait = `${String(note).replace(/\s+/g, " ").slice(0, 600).trim()}${note.length > 600 ? "…" : ""}`;
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
    research: scan.research ? research : null,
    researchError: scan.researchError || null,
    planReused: Boolean(scan.planReused),
    analysis: scan.analysis || null,
    analysisError: scan.analysisError || null,
    ideas: scan.ideas || null,
    ideasError: scan.ideasError || null,
    errors: [...(scan.errors || []), ...((scan.external && scan.external.errors) || [])],
    costUsd: scan.costUsd ?? null,
    claude: scan.claude || null,
  };
}

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
  // Réutilisation vérifiée avant toute préparation : aucun appel IA inutile.
  if (!force) {
    const prev = await reusableScan(input);
    if (prev) return prev;
  }
  const plan = await planFor(input.niche, input.audience);
  const extra = {
    research: plan.research,
    researchError: plan.researchError,
    planReused: Boolean(plan.reused),
    claude: null,
  };
  addClaudeCost(extra, "veille", plan.costUsd);
  return createScan({ ...input, queries: plan.queries, force: Boolean(force), extra });
}

// Les idées citent les posts par numéro dans « preuves » ; dans le texte, un « P3 » éventuel
// est remplacé par une référence lisible (l'interface n'affiche pas les numéros).
function readableRefs(text, posts) {
  if (text === null || text === undefined) return text;
  return String(text).replace(/\bP(\d{1,2})\b/g, (m, n) => {
    const p = posts[Number(n) - 1];
    return p ? `@${p.authorHandle || "?"} (${NETWORK_LABELS[p.network] || p.network})` : m;
  });
}

// Une autre requête fait déjà ce travail sur ce scan : on attend son résultat plutôt que de payer deux fois.
async function waitForScanField(id, ok, errorField, label, maxMs = 240000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await sleep(3000);
    const s = await loadScan(id);
    if (s && ok(s)) return s;
    if (s?.[errorField]) throw new Error(s[errorField]);
  }
  throw busyError(`${label} toujours en cours. Réessaie dans un instant.`);
}

// Fenêtre lue par Claude : les posts que la liste affiche en tête (classés par score, au total et
// par réseau), puis ceux du moment (classés par nowScore), sans doublon.
function analysisWindow(posts) {
  const strong = posts.filter((p) => p.label !== "Dans la norme");
  const shown = (strong.length >= 3 ? strong : posts).slice().sort((a, b) => b.score - a.score);
  const perNet = SOCIAL_NETWORKS.flatMap((n) => shown.filter((p) => p.network === n).slice(0, 5));
  return [...new Map([...shown.slice(0, 15), ...perNet, ...posts].map((p) => [p.key, p])).values()].slice(0, ANALYZE_POSTS);
}

/**
 * Lecture du relevé par Claude : pour chaque post, pertinence, langue, format, type d'accroche,
 * texte à l'écran (couvertures des meilleurs posts) et mécanisme ; puis tendances transverses.
 * Les posts hors public francophone sont retirés, les hors-sujet masqués.
 */
async function analyzeScan(scan, { force = false, timeoutMs } = {}) {
  const lockKey = `analyze-${scan.id}`;
  if (!(await acquireLock(lockKey, 300000).catch(() => true))) {
    return waitForScanField(scan.id, (s) => s.analysis, "analysisError", "La lecture des posts est");
  }
  try {
    const fresh = (await loadScan(scan.id)) || scan;
    if ((fresh.analysis && !force) || fresh.status !== "done") return fresh;
    scan = fresh;
    if (scan.analysisError) {
      scan.analysisError = null;
      scan = await patchScan(scan, ["analysisError"]);
    }
    const posts = analysisWindow(scan.posts || []);
    if (!posts.length) return scan;
    let cost = 0;
    try {
      const imgs = await coverImages(posts, ANALYZE_IMAGES);
      const nOf = new Map(posts.map((p, i) => [p.key, i + 1]));
      const out = await analyzePosts({
        niche: scan.niche,
        audience: scan.audience,
        postsText: posts.map((p, i) => postLine({ ...p, ai: null }, i)).join("\n"),
        images: imgs.map((im) => ({ n: nOf.get(im.key), mediaType: im.mediaType, data: im.data })),
        timeoutMs,
        onUsage: (usd) => (cost += usd || 0),
      });
      // Un « P3 » laissé dans un texte désigne un post de cette fenêtre : remplacé par @compte (réseau).
      const refs = (t) => readableRefs(t, posts);
      const byN = new Map(out.posts.map((a) => [a.n, a]));
      const dropped = new Set();
      const removedByNet = {};
      let offTopic = 0;
      let foreign = 0;
      const kept = [];
      for (const p of scan.posts) {
        const a = nOf.has(p.key) ? byN.get(nOf.get(p.key)) : null;
        if (a) {
          if (!a.francais) {
            foreign += 1;
            dropped.add(p.key);
            removedByNet[p.network] = (removedByNet[p.network] || 0) + 1;
            continue;
          }
          p.ai = { format: a.format, accroche_type: a.accroche_type, accroche: a.accroche, texte_ecran: a.texte_ecran || null, mecanisme: refs(a.mecanisme) };
          p.offTopic = !a.pertinent;
          if (p.offTopic) {
            offTopic += 1;
            dropped.add(p.key);
          }
        }
        kept.push(p);
      }
      const nToKey = (n) => posts[n - 1]?.key;
      scan.posts = kept;
      if (scan.excluded) scan.excluded.langue = (scan.excluded.langue || 0) + foreign;
      for (const [net, n] of Object.entries(removedByNet)) {
        if (scan.stats?.[net]) scan.stats[net].kept = Math.max(0, (scan.stats[net].kept ?? scan.stats[net].fetched ?? 0) - n);
      }
      // Tendances de hashtags et de sons sans les posts écartés : une tendance qui en perd et
      // n'a plus deux posts visibles disparaît ; sinon son nombre de créateurs est revu à la baisse.
      scan.clusters = (scan.clusters || [])
        .map((c) => {
          const keys = c.postKeys.filter((k) => !dropped.has(k));
          const removed = c.postKeys.length - keys.length;
          return removed ? { ...c, postKeys: keys, creators: Math.max(keys.length, Math.round((c.creators * keys.length) / c.postKeys.length)), cut: true } : c;
        })
        .filter((c) => c.postKeys.length >= 2 || (!c.cut && c.creators >= 3))
        .map(({ cut, ...c }) => c);
      scan.analysis = {
        createdAt: new Date().toISOString(),
        model: config.analysisModel,
        analysed: posts.length,
        images: imgs.length,
        horsSujet: offTopic,
        etrangers: foreign,
        tendances: out.tendances.slice(0, 6).map((t) => ({
          ...t,
          nom: refs(t.nom),
          explication: refs(t.explication),
          comment_l_utiliser: refs(t.comment_l_utiliser),
          postKeys: [...new Set(t.preuves)].map(nToKey).filter((k) => k && !dropped.has(k)).slice(0, 5),
        })),
        a_eviter: out.a_eviter.slice(0, 3).map(refs),
      };
      scan.analysisError = null;
    } catch (err) {
      scan.analysisError = err.message;
      throw err;
    } finally {
      scan = await patchScan(scan, scan.analysis && !scan.analysisError ? ANALYSIS_FIELDS : ["analysisError"], "analyse", cost);
    }
    return scan;
  } finally {
    await releaseLock(lockKey).catch(() => {});
  }
}

// Historique « prévu · relevé » des prévisions : Claude adapte les idées à ce qui marche pour toi.
async function historyText() {
  const entries = (await listHistory().catch(() => [])).filter((e) => e.scripts).slice(0, 12);
  const lines = [];
  for (const e of entries) {
    for (const [pf, sc] of Object.entries(e.scripts || {})) {
      const real = e.realStats?.[pf];
      lines.push(`- ${PLATFORM_LABELS[pf] || pf} « ${String(e.brief?.idea || "").slice(0, 90)} » : prévu ${sc.score?.bande || "?"} (${sc.score?.final ?? "?"}/100)${real ? `, relevé ×${String(real.ratio).replace(".", ",")} de sa médiane (${real.band})` : ", pas encore relevé"}`);
    }
  }
  return lines.slice(0, 15).join("\n") || null;
}

async function generateIdeas(scan, { force = false, timeoutMs } = {}) {
  // Une seule génération à la fois par scan (deux onglets, cron et interface).
  const lockKey = `ideas-${scan.id}`;
  if (!(await acquireLock(lockKey, 300000).catch(() => true))) {
    return waitForScanField(scan.id, (s) => s.ideas, "ideasError", "La rédaction des idées est");
  }
  try {
    const fresh = (await loadScan(scan.id)) || scan;
    if (fresh.ideas && !force) return fresh;
    scan = fresh;
    // Une erreur d'une tentative précédente ne doit pas être rendue à qui attend celle-ci.
    if (scan.ideasError) {
      scan.ideasError = null;
      scan = await patchScan(scan, ["ideasError"]);
    }
    const settings = await getSettings();
    const posts = (scan.posts || []).filter((p) => !p.offTopic).slice(0, IDEA_POSTS);
    let cost = 0;
    try {
      const research = scan.research
        ? [...researchLines(scan.research), scan.research.note ? `Note complète :\n${String(scan.research.note).slice(0, 2500)}` : null].filter(Boolean).join("\n")
        : "";
      // Posts qui illustrent chaque tendance, dans la numérotation de ce prompt.
      const nOf = new Map(posts.map((p, i) => [p.key, i + 1]));
      const proofs = (t) => (t.postKeys || []).map((k) => nOf.get(k)).filter(Boolean).map((n) => `P${n}`).join(", ");
      const out = await proposeIdeas({
        niche: scan.niche,
        audience: scan.audience,
        voice: settings.voice,
        postsText: posts.map((p, i) => postLine(p, i)).join("\n"),
        trendsText: (scan.analysis?.tendances || []).map((t) => `- ${aiTrendLine(t, proofs(t))}`).join("\n")
          + (scan.analysis?.a_eviter?.length ? `\nÀ éviter : ${scan.analysis.a_eviter.join(" ; ")}` : ""),
        clustersText: (scan.clusters || []).slice(0, 6).map((c) => `- ${clusterLine(c)}`).join("\n"),
        researchText: research,
        historyText: await historyText(),
        externalText: externalLines(scan.external).map((l) => `- ${l}`).join("\n"),
        timeoutMs,
        onUsage: (usd) => (cost += usd || 0),
      });
      const refs = (t) => readableRefs(t, posts);
      scan.ideas = {
        createdAt: new Date().toISOString(),
        withAnalysis: Boolean(scan.analysis),
        synthese: refs(out.synthese),
        items: out.idees.slice(0, 8).map((idea) => ({
          ...idea,
          potentiel: Math.max(0, Math.min(100, Math.round(Number(idea.potentiel) || 0))),
          pourquoi_maintenant: refs(idea.pourquoi_maintenant),
          pourquoi_toi: refs(idea.pourquoi_toi),
          risque: refs(idea.risque),
          deroule: refs(idea.deroule),
          plan: (idea.plan || []).map(refs).slice(0, 6),
          variantes_accroche: (idea.variantes_accroche || []).slice(0, 2),
          hashtags: (idea.hashtags || []).map((h) => String(h).replace(/^#/, "")).slice(0, 5),
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
      scan = await patchScan(scan, scan.ideasError ? ["ideasError"] : IDEAS_FIELDS, "idees", cost);
    }
    return scan;
  } finally {
    await releaseLock(lockKey).catch(() => {});
  }
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
    ai: { model: config.model, analysisModel: config.analysisModel, webResearch: config.webResearch },
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
      context: typeof context === "string" ? context.trim().slice(0, 2000) : "",
    };
    const trends = await getTrends({
      query: [brief.idea, brief.niche].filter(Boolean).join(" ").slice(0, 120),
    });
    // Signaux des réseaux : dernier scan de la même niche s'il date de moins de 48 h.
    const scan = brief.niche ? await latestDoneScan(brief.niche).catch(() => null) : null;
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

  // Lecture du relevé par Claude (pertinence, mécanismes, visuels, tendances) avant les idées.
  "POST /api/scan/analyze": async (_req, body) => {
    const scan = SCAN_ID_RE.test(String(body.id || "")) ? await loadScan(String(body.id)) : null;
    if (!scan) throw new Error("Scan introuvable (expiré ?)");
    if (scan.status !== "done") throw new Error("Le scan n'est pas terminé");
    if (scan.analysis && !body.force) return scanView(scan);
    // Sur Vercel, coupée avant la fonction (300 s) : l'erreur est enregistrée et la lecture peut être relancée.
    return scanView(await analyzeScan(scan, { force: Boolean(body.force), timeoutMs: process.env.VERCEL ? 270000 : undefined }));
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
    // Lecture des posts puis idées, seulement s'il reste assez de temps pour les deux ;
    // sinon le passage de 7 h s'en charge.
    const left = () => t0 + 285000 - Date.now();
    if (scan.status === "done" && !scan.analysis && left() > 230000 && hasApiCredentials()) {
      scan = await analyzeScan(scan, { timeoutMs: Math.min(170000, left() - 100000) }).catch(() => scan);
    }
    if (scan.status === "done" && scan.analysis && !scan.ideas && left() > 90000 && hasApiCredentials()) {
      scan = await generateIdeas(scan, { timeoutMs: left() - 10000 }).catch(() => scan);
    }
    return { id: scan.id, status: scan.status, reused: Boolean(recent), analysis: Boolean(scan.analysis), ideas: Boolean(scan.ideas) };
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
    const left = () => t0 + 285000 - Date.now();
    // Lecture manquante (absente ou en échec) : retentée, en gardant au moins 100 s pour les idées.
    if (scan.status === "done" && !scan.analysis && left() > 160000) {
      scan = await analyzeScan(scan, { timeoutMs: Math.min(170000, left() - 100000) }).catch(() => scan);
    }
    // Idées absentes, ou écrites avant que la lecture des posts n'aboutisse : (ré)écrites.
    const stale = scan.ideas && scan.analysis && !scan.ideas.withAnalysis;
    if (scan.status === "done" && (!scan.ideas || stale) && left() > 70000) {
      scan = await generateIdeas(scan, { force: Boolean(stale), timeoutMs: left() - 10000 }).catch(() => scan);
    }
    return { id: scan.id, status: scan.status, analysis: Boolean(scan.analysis), ideas: Boolean(scan.ideas) };
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
    return json(res, error?.status === 409 ? 409 : 400, { error: message });
  }
}
