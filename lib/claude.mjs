// Moteur IA : angles, scripts, juge de performance et réécriture.
// API Claude via le SDK officiel, sorties structurées validées par zod,
// fallback serveur anti-refus activé par défaut (betas server-side-fallback).
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "./env.mjs";

// Construit paresseusement : le .env est chargé par server.mjs APRÈS les imports,
// donc le client ne doit pas capturer process.env au chargement du module.
let clientInstance = null;
function getClient() {
  // timeout explicite : requis par le SDK pour les gros max_tokens non-streamés,
  // et les générations à effort élevé durent plusieurs minutes. Sur Vercel la
  // fonction est tuée à 300 s : on coupe avant, sans relance, pour renvoyer une
  // erreur lisible plutôt qu'un 504 brut.
  if (!clientInstance) {
    clientInstance = process.env.VERCEL
      ? new Anthropic({ timeout: 280 * 1000, maxRetries: 0 })
      : new Anthropic({ timeout: 15 * 60 * 1000 });
  }
  return clientInstance;
}

export const PLATFORMS = ["linkedin", "reels", "x", "youtube"];
export const PLATFORM_LABELS = {
  linkedin: "Post LinkedIn",
  reels: "Script Reel Instagram",
  x: "Thread X",
  youtube: "Vidéo YouTube",
};

const FORMAT_SPECS = {
  linkedin:
    "Post LinkedIn : 800-1600 caractères. Accroche de 1-2 lignes (≤140 caractères avant la coupure « voir plus ») avec un déclencheur (chiffre, question, affirmation contrariante). Paragraphes courts de 1-2 lignes, aérés. Termine par un appel à l'action (question ouverte). 3-5 hashtags maximum, à la fin.",
  reels:
    "Script de Reel Instagram de 30-45 secondes (≈75-120 mots de voix off). Hook parlé dans les 3 premières secondes (≤14 mots). Indique entre crochets les plans et le texte à l'écran, ex. [À l'écran : « 3 erreurs »]. Séquences courtes, rythme élevé. CTA final (commente, enregistre, abonne-toi). Ajoute une légende de publication avec hashtags.",
  x: "Thread X de 5 à 8 tweets séparés par des lignes vides. Tweet 1 = promesse claire et autonome, ≤280 caractères. Un seul point par tweet, chaque tweet ≤280 caractères. Dernier tweet = CTA (suivre, reposter, répondre).",
  youtube:
    "Vidéo YouTube : un titre ≤60 caractères qui crée de la curiosité, puis le script détaillé des 30 premières secondes (hook : promesse + enjeu), puis un plan en 3-6 chapitres numérotés avec les points clés de chacun, puis une description de 2-3 phrases. CTA en fin de vidéo.",
};

// ---------- Schémas de sortie ----------

const AnglesSchema = z.object({
  tendances_retenues: z.array(
    z.object({
      titre: z.string(),
      source: z.string(),
      pourquoi: z.string().describe("En quoi cette tendance sert l'idée de l'utilisateur"),
    }),
  ),
  angles: z.array(
    z.object({
      titre: z.string(),
      type: z.enum(["contrarian", "storytelling", "liste", "educatif", "reaction", "etude_de_cas"]),
      accroche: z.string().describe("Première phrase possible du contenu"),
      justification: z.string().describe("Pourquoi cet angle peut performer, appuyé sur les tendances"),
      score_tendance: z.number().int().min(0).max(100),
    }),
  ),
});

const ScriptSchema = z.object({
  plateforme: z.enum(["linkedin", "reels", "x", "youtube"]),
  titre: z.string().nullable().describe("Titre (YouTube) ou première ligne forte ; null sinon"),
  contenu: z.string().describe("Le script complet, prêt à publier"),
  hashtags: z.array(z.string()),
});

const ScriptsSchema = z.object({ scripts: z.array(ScriptSchema).min(1) });

const JudgeSchema = z.object({
  evaluations: z.array(
    z.object({
      plateforme: z.enum(["linkedin", "reels", "x", "youtube"]),
      bande: z
        .enum(["top10", "top25", "top50", "moitie_basse"])
        .describe("Potentiel relatif vs les contenus typiques de cette niche sur cette plateforme"),
      confiance: z.enum(["faible", "moyenne", "haute"]),
      verdict: z
        .string()
        .describe("Une seule phrase de 10 à 20 mots : le point fort principal, puis ce qui manque le plus"),
      facteurs: z
        .array(
          z.object({
            nom: z.enum(["hook", "structure", "adequation_tendance", "emotion", "cta"]),
            score: z.number().int().min(0).max(100),
            commentaire: z.string(),
          }),
        )
        .min(1),
      comparaison: z.string().describe("À quels patterns de contenus performants ce script ressemble, et ce qui lui manque"),
      suggestions: z
        .array(z.string())
        .describe("2-4 réécritures concrètes, par ordre d'impact, au format « Action à l'impératif en 8 mots maximum : détail ou exemple »"),
    }),
  ),
});

// ---------- Appel générique ----------

function friendlyError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Clé API invalide ou absente. Renseigne ANTHROPIC_API_KEY dans le fichier .env.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Limite de débit atteinte côté API. Réessaie dans une minute.";
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return process.env.VERCEL
      ? "Génération trop longue pour la limite Vercel (5 min). Mets CLAUDE_EFFORT à « low » dans les variables Vercel, ou réessaie."
      : "Délai dépassé côté API Claude. Réessaie, ou baisse CLAUDE_EFFORT.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Impossible de joindre l'API Claude (réseau). Vérifie ta connexion.";
  }
  if (error instanceof Anthropic.APIError && (error.status === 529 || error.status >= 500)) {
    return `Claude est momentanément surchargé ou indisponible (erreur ${error.status}). Réessaie dans une minute.`;
  }
  if (error instanceof Anthropic.APIError) {
    return `Erreur API Claude (${error.status}) : ${error.message}`;
  }
  return String(error?.message || error);
}

function requireKey() {
  if (!hasApiCredentials()) {
    throw new Error(
      process.env.VERCEL
        ? "Clé API absente : ajoute ANTHROPIC_API_KEY dans Vercel (Settings → Environment Variables), puis redéploie."
        : "Clé API absente : copie .env.example vers .env et renseigne ANTHROPIC_API_KEY, puis relance le serveur.",
    );
  }
}

// Tarifs publics ($ par million de jetons, entrée / sortie) pour estimer le coût affiché d'un scan.
const PRICES = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
const WEB_SEARCH_USD = 0.01; // 10 $ les 1 000 recherches

export function usageCost(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const input = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0) + 0.1 * (usage.cache_read_input_tokens || 0);
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (input * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6 + searches * WEB_SEARCH_USD;
}

// Le SDK déplace les `enum` dans la description du schéma envoyé : le décodage ne les impose
// plus. On les remet, pour que Claude ne puisse répondre qu'avec une valeur prévue.
function outputFormat(schema) {
  const fmt = zodOutputFormat(schema);
  const restore = (raw, sent) => {
    if (!raw || !sent || typeof raw !== "object" || typeof sent !== "object") return;
    if (Array.isArray(raw.enum) && sent.type === "string") {
      sent.enum = raw.enum;
      if (typeof sent.description === "string") {
        const d = sent.description.replace(/\s*\{[^{}]*enum: \[.*\]\}$/s, "").trim();
        if (d) sent.description = d;
        else delete sent.description;
      }
    }
    for (const k of ["properties", "$defs"]) {
      if (raw[k]) for (const name of Object.keys(raw[k])) restore(raw[k][name], sent[k]?.[name]);
    }
    if (raw.items) restore(raw.items, sent.items);
    for (const k of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(raw[k])) raw[k].forEach((v, i) => restore(v, (sent[k] || sent.anyOf)?.[i]));
    }
  };
  restore(z.toJSONSchema(schema, { reused: "ref" }), fmt.schema);
  return { type: "json_schema", schema: fmt.schema };
}

// `user` : texte, ou blocs de contenu (images + texte). `onUsage(costUsd, usage)` : suivi du coût.
// Avec `timeoutMs` (budget fixé par l'appelant), pas de relance automatique : elle doublerait le délai.
async function structuredCall({ system, user, schema, maxTokens = 16000, effort, timeoutMs, model, onUsage }) {
  requireKey();
  const usedModel = model || config.model;
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: usedModel,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      output_config: { effort: effort || config.effort, format: outputFormat(schema) },
      messages: [{ role: "user", content: user }],
    }, timeoutMs ? { timeout: timeoutMs, maxRetries: 0 } : undefined);
  } catch (error) {
    throw new Error(friendlyError(error));
  }
  if (onUsage) onUsage(usageCost(response.model || usedModel, response.usage), response.usage);

  if (response.stop_reason === "refusal") {
    const why = response.stop_details?.explanation || "contenu refusé par les garde-fous";
    throw new Error(`La génération a été refusée (${why}). Reformule l'idée.`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Réponse tronquée (max_tokens atteint). Réessaie avec une demande plus courte.");
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Réponse illisible du modèle (JSON invalide). Réessaie.");
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    throw new Error(`Réponse hors schéma : ${checked.error.issues[0]?.message || "format inattendu"}`);
  }
  return checked.data;
}

// ---------- Prompts ----------

function briefText(brief) {
  return [
    `Idée brute : ${brief.idea}`,
    brief.niche ? `Niche / activité : ${brief.niche}` : null,
    brief.audience ? `Audience cible : ${brief.audience}` : null,
    brief.goal ? `Objectif : ${brief.goal}` : null,
    brief.context ? `Contexte (idée repérée sur les réseaux) : ${brief.context}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const BASE_SYSTEM =
  "Tu es un stratège de contenu pour les réseaux sociaux (LinkedIn, Instagram Reels, X, YouTube), francophone. " +
  "Tu raisonnes à partir de données de tendances réelles fournies dans le message, jamais de tendances inventées. " +
  "Tu écris des contenus natifs par plateforme, concrets, sans buzzwords creux, et tu n'inventes jamais de faits, de chiffres ni de témoignages : " +
  "si un exemple chiffré serait utile mais n'est pas fourni, laisse un emplacement [à compléter]. Réponds en français.";

export async function proposeAngles({ brief, trendsText, voice }) {
  const user = [
    "À partir du brief et des tendances ci-dessous, sélectionne les 3-6 tendances réellement exploitables pour cette idée, puis propose 4 à 5 angles éditoriaux distincts.",
    "Chaque angle doit être justifié par une ou plusieurs tendances listées (pas de tendance inventée) et noté sur son adéquation aux tendances (score_tendance).",
    "Varie les types d'angles (contrarian, storytelling, liste, éducatif, réaction, étude de cas).",
    voice ? `Voix de l'auteur à respecter : ${voice}` : null,
    "",
    "=== BRIEF ===",
    briefText(brief),
    "",
    "=== TENDANCES COLLECTÉES (données réelles) ===",
    trendsText,
  ]
    .filter((l) => l !== null)
    .join("\n");
  return structuredCall({ system: BASE_SYSTEM, user, schema: AnglesSchema });
}

export async function writeScripts({ brief, angle, trendsText, voice, platforms }) {
  const specs = platforms.map((p) => `- ${PLATFORM_LABELS[p]} (${p}) : ${FORMAT_SPECS[p]}`).join("\n");
  const user = [
    `Écris un script prêt à publier pour chacune de ces plateformes : ${platforms.join(", ")}.`,
    "Chaque script doit être NATIF de sa plateforme (pas une copie reformattée), décliner l'angle choisi et s'appuyer sur les tendances fournies.",
    voice ? `Voix de l'auteur à respecter : ${voice}` : null,
    "",
    "=== BRIEF ===",
    briefText(brief),
    "",
    `=== ANGLE CHOISI ===\n${angle.titre} (${angle.type})\nAccroche envisagée : ${angle.accroche}\nJustification : ${angle.justification}`,
    "",
    "=== FORMATS ATTENDUS ===",
    specs,
    "",
    "=== TENDANCES COLLECTÉES (données réelles) ===",
    trendsText,
  ]
    .filter((l) => l !== null)
    .join("\n");
  return structuredCall({ system: BASE_SYSTEM, user, schema: ScriptsSchema, maxTokens: 32000 });
}

const JUDGE_SYSTEM =
  "Tu es un évaluateur critique de contenus pour réseaux sociaux. Tu compares chaque script aux patterns des contenus qui sur-performent dans leur niche " +
  "(hook, structure, émotion, adéquation aux tendances du moment, appel à l'action). Tu es exigeant et concret : chaque commentaire doit pointer un passage précis du script. " +
  "La viralité est en grande partie imprévisible : tu évalues un POTENTIEL RELATIF (bande), jamais un nombre de vues. " +
  "Si les informations fournies ne te permettent pas de juger un critère, baisse ta confiance plutôt que d'inventer. Réponds en français.";

export async function judgeScripts({ brief, scripts, trendsText }) {
  const scriptBlocks = scripts
    .map(
      (s) =>
        `--- ${PLATFORM_LABELS[s.plateforme]} (${s.plateforme}) ---\n${s.titre ? `Titre : ${s.titre}\n` : ""}${s.contenu}\nHashtags : ${(s.hashtags || []).join(" ") || "(aucun)"}`,
    )
    .join("\n\n");
  const user = [
    "Évalue chacun des scripts ci-dessous pour sa plateforme. Pour chaque script : bande de potentiel relatif, confiance, une phrase-verdict (point fort principal puis ce qui manque le plus), 5 facteurs notés (hook, structure, adequation_tendance, emotion, cta) avec commentaire précis, comparaison aux patterns performants, puis 2-4 suggestions de réécriture classées par impact.",
    "",
    "=== BRIEF ===",
    briefText(brief),
    "",
    "=== TENDANCES DU MOMENT (contexte réel) ===",
    trendsText,
    "",
    "=== SCRIPTS À ÉVALUER ===",
    scriptBlocks,
  ].join("\n");
  return structuredCall({ system: JUDGE_SYSTEM, user, schema: JudgeSchema, maxTokens: 24000 });
}

export async function rewriteScript({ brief, script, suggestions, trendsText, voice }) {
  const p = script.plateforme;
  const user = [
    `Réécris ce ${PLATFORM_LABELS[p]} en appliquant les suggestions listées, sans changer le fond ni la plateforme.`,
    `Format attendu : ${FORMAT_SPECS[p]}`,
    voice ? `Voix de l'auteur à respecter : ${voice}` : null,
    "",
    "=== BRIEF ===",
    briefText(brief),
    "",
    "=== SCRIPT ACTUEL ===",
    `${script.titre ? `Titre : ${script.titre}\n` : ""}${script.contenu}`,
    "",
    "=== SUGGESTIONS À APPLIQUER ===",
    ...(suggestions || []).map((s) => `- ${s}`),
    "",
    "=== TENDANCES DU MOMENT ===",
    trendsText,
    "",
    "Renvoie un seul script (scripts = tableau d'un élément) pour la même plateforme.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const out = await structuredCall({ system: BASE_SYSTEM, user, schema: ScriptsSchema, maxTokens: 24000 });
  const rewritten = out.scripts.find((s) => s.plateforme === p) || out.scripts[0];
  if (!rewritten) throw new Error("La réécriture n'a produit aucun script.");
  return rewritten;
}

// ---------- Réseaux sociaux : requêtes de scan et idées tendance ----------

const QueriesSchema = z.object({
  tiktok: z.array(z.string()).min(1).describe("2 recherches TikTok en français, 2-3 mots chacune, telles qu'un utilisateur les taperait"),
  instagram: z.string().describe("1 mot-clé ou expression Instagram en français, sans virgule"),
  x: z
    .string()
    .describe("1 requête booléenne X : 2 à 5 variantes en français entre parenthèses reliées par OR (expressions entre guillemets si plusieurs mots), sans autre opérateur"),
  linkedin: z.array(z.string()).min(1).describe("1-2 expressions LinkedIn en français, telles qu'elles apparaissent dans des posts"),
  youtube: z.string().describe("1 recherche YouTube Shorts en français"),
  hashtags: z.array(z.string()).describe("5 hashtags de niche en français, sans #, sans hashtags génériques (fyp, viral…)"),
});

// Requêtes + veille structurée, préparées à partir de la note de veille web quand elle existe.
const PlanSchema = QueriesSchema.extend({
  veille: z
    .object({
      synthese: z.string().describe("2 phrases : ce qui occupe la niche cette semaine en France, d'après la note de veille"),
      a_savoir: z.array(z.string()).describe("3 à 5 faits récents et utiles pour un créateur de la niche, chacun en une phrase datée si possible"),
      dates: z
        .array(z.object({ date: z.string().describe("AAAA-MM-JJ ou période, ex. « fin octobre »"), evenement: z.string() }))
        .describe("Événements à venir dans les 4 semaines qui peuvent porter un contenu (0 à 5)"),
      mots_du_moment: z.array(z.string()).describe("5 à 10 mots, expressions ou hashtags que la niche emploie en ce moment"),
      angles: z.array(z.string()).describe("2 à 4 débats ou angles qui circulent en ce moment"),
    })
    .nullable()
    .describe("null s'il n'y a pas de note de veille"),
});

const RESEARCH_SYSTEM =
  "Tu fais la veille hebdomadaire d'un créateur de contenu francophone. Tu cherches sur le web ce qui se passe CETTE SEMAINE dans sa niche, en France : " +
  "actualités, annonces, chiffres publiés, réglementation, saisonnalité, événements datés à venir, débats, formats et expressions qui circulent chez les créateurs. " +
  "Tu privilégies les sources de moins de 14 jours, tu n'inventes rien et tu signales l'incertitude. Réponds en français, en texte simple.";

/**
 * Veille web de la niche (recherche web côté Anthropic). Renvoie { note, sources[], costUsd } ;
 * la note est du texte libre (les citations de la recherche web excluent une sortie JSON imposée).
 * `timeoutMs` borne la veille entière, relances après pause comprises. Une veille tronquée ou
 * faite sans aucune recherche aboutie est refusée : elle serait écrite de mémoire.
 * En cas d'échec, l'erreur porte `costUsd`, le coût déjà facturé.
 */
export async function researchNiche({ niche, audience, timeoutMs = 120000 }) {
  requireKey();
  const today = new Date().toISOString().slice(0, 10);
  const messages = [{
    role: "user",
    content: [
      `Nous sommes le ${today}. Fais la veille de la semaine pour la niche « ${niche} »${audience ? ` (audience : ${audience})` : ""}.`,
      "Fais au plus 5 recherches ciblées. Rends une note de 250 mots maximum avec ces rubriques :",
      "1. Ce qui fait parler cette semaine (faits datés)",
      "2. Dates et événements à venir dans les 4 semaines",
      "3. Mots, expressions et hashtags employés en ce moment par les créateurs de la niche",
      "4. Débats et angles qui circulent",
    ].join("\n"),
  }];
  const usedModel = config.model;
  const deadline = Date.now() + timeoutMs;
  let cost = 0;
  const fail = (message) => Object.assign(new Error(message), { costUsd: cost });
  const found = new Map(); // résultats bruts des recherches
  const cited = new Map(); // pages réellement citées dans la note
  let searched = false;
  let stop = null;
  let text = "";
  for (let turn = 0; turn < 3; turn++) {
    const left = deadline - Date.now();
    if (left < 5000) break;
    let response;
    try {
      response = await getClient().beta.messages.create({
        model: usedModel,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: RESEARCH_SYSTEM,
        output_config: { effort: "low" },
        tools: [{
          type: "web_search_20260209",
          name: "web_search",
          max_uses: 5,
          user_location: { type: "approximate", country: config.geo, timezone: "Europe/Paris" },
        }],
        messages,
      }, { timeout: left, maxRetries: 0 });
    } catch (error) {
      throw fail(friendlyError(error));
    }
    cost += usageCost(response.model || usedModel, response.usage) || 0;
    stop = response.stop_reason;
    if (stop === "refusal") throw fail("La veille web a été refusée par les garde-fous.");
    for (const block of response.content) {
      // Une recherche en échec renvoie un objet d'erreur, pas une liste de résultats.
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        searched = true;
        for (const r of block.content) {
          if (r?.url && !found.has(r.url)) found.set(r.url, { url: r.url, title: r.title || r.url, age: r.page_age || null });
        }
      }
      if (block.type === "text") {
        text += block.text;
        for (const c of block.citations || []) {
          if (c.type === "web_search_result_location" && c.url && !cited.has(c.url)) {
            cited.set(c.url, { url: c.url, title: c.title || c.url, age: found.get(c.url)?.age || null });
          }
        }
      }
    }
    // Recherche longue mise en pause côté serveur : on relance le même tour, sans message ajouté.
    if (stop !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  if (stop === "max_tokens") throw fail("Veille web incomplète (réponse tronquée).");
  if (stop === "pause_turn" || stop === null) throw fail("Veille web incomplète (délai dépassé).");
  if (!searched) throw fail("Veille web : aucune recherche n'a abouti.");
  if (!text.trim()) throw fail("La veille web n'a rien renvoyé.");
  return { note: text.trim(), sources: [...(cited.size ? cited : found).values()].slice(0, 10), costUsd: cost };
}

export async function planQueries({ niche, audience, researchNote, timeoutMs, onUsage }) {
  const user = [
    "Prépare les requêtes de recherche pour relever, sur chaque réseau, les contenus récents qui marchent dans cette niche.",
    "Vise les mots que les créateurs francophones de la niche emploient vraiment (pas de jargon marketing), assez précis pour rester dans la niche, assez larges pour remonter des posts populaires.",
    researchNote ? "Appuie-toi sur la note de veille ci-dessous pour viser les sujets et le vocabulaire de cette semaine, et résume-la dans « veille »." : "Il n'y a pas de note de veille : mets « veille » à null.",
    `Niche : ${niche}`,
    audience ? `Audience : ${audience}` : null,
    researchNote ? `\n=== NOTE DE VEILLE (recherche web de cette semaine) ===\n${researchNote}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return structuredCall({ system: BASE_SYSTEM, user, schema: PlanSchema, maxTokens: 4000, effort: "low", timeoutMs, onUsage });
}

// ---------- Analyse des posts relevés (texte + visuels) ----------

const FORMATS = ["face caméra", "tutoriel", "avant / après", "liste", "storytime", "sketch / POV", "coulisses", "réaction", "démonstration", "carrousel éducatif", "texte / citation", "interview", "autre"];
const HOOKS = ["question", "chiffre choc", "promesse", "contre-intuitif", "erreur à éviter", "curiosité", "émotion", "polémique", "défi", "tendance reprise", "autre"];

const AnalysisSchema = z.object({
  posts: z.array(
    z.object({
      n: z.number().int().describe("Numéro du post (1 pour P1)"),
      pertinent: z.boolean().describe("Le post traite vraiment de la niche (pas un hors-sujet remonté par la recherche)"),
      francais: z.boolean().describe("Le post s'adresse à un public francophone"),
      format: z.enum(FORMATS).catch("autre"),
      accroche_type: z.enum(HOOKS).catch("autre"),
      accroche: z.string().describe("L'accroche du post, telle qu'on la lit ou l'entend au début, 15 mots maximum"),
      texte_ecran: z.string().nullable().describe("Texte incrusté visible sur l'image du post, ou null"),
      mecanisme: z.string().describe("Pourquoi ce post marche, en une phrase concrète et réutilisable"),
    }),
  ),
  tendances: z
    .array(
      z.object({
        nom: z.string().describe("Nom court et parlant, ex. « Avant/après en 5 secondes »"),
        type: z.enum(["format", "sujet", "accroche", "son", "hashtag"]).catch("sujet"),
        stade: z.enum(["émergent", "en hausse", "installé", "saturé"]).catch("en hausse"),
        explication: z.string().describe("Ce qui se passe, en une phrase, avec un chiffre des données si possible"),
        comment_l_utiliser: z.string().describe("Comment le reprendre dans la niche, en une phrase à l'impératif"),
        preuves: z.array(z.number().int()).describe("Numéros des posts qui l'illustrent, 2 à 5"),
      }),
    )
    .describe("2 à 6 tendances transverses : formats, sujets, types d'accroche ou sons repris par plusieurs créateurs"),
  a_eviter: z.array(z.string()).describe("0 à 3 schémas saturés ou qui ne marchent pas dans ce relevé"),
});

// Lecture commune des lignes de posts (voir postLine dans social.mjs).
const DATA_LEGEND =
  "Dans les lignes de posts, « score » est un score de viralité de 0 à 100 calculé sur ce relevé ; « ×N son audience » compare les vues aux abonnés de l'auteur ; " +
  "les autres « ×N » disent à quoi ils comparent (ses autres posts, les comptes du relevé, la médiane du relevé). " +
  "Les « signaux » sponsorisé, concours et anomalie (vues ou likes suspects) ne sont jamais un modèle à reproduire ; « reproductible » désigne un petit compte qui dépasse largement son audience.";

const ANALYSIS_SYSTEM =
  "Tu es analyste des réseaux sociaux. Tu lis des posts réels (texte, mesures, et quand elle est fournie l'image de couverture) " +
  "et tu identifies ce qui les fait marcher : format, type d'accroche, texte à l'écran, mécanisme. Tu restes factuel, tu ne cites que des chiffres présents. " +
  DATA_LEGEND +
  " Réponds en français.";

/**
 * `postsText` : une ligne par post (P1…). `images` : [{ n, mediaType, data }] (base64), couvertures des meilleurs posts.
 */
export async function analyzePosts({ niche, audience, postsText, images = [], timeoutMs, onUsage }) {
  const content = [];
  for (const img of images) {
    content.push({ type: "text", text: `Image de couverture de P${img.n} :` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  content.push({
    type: "text",
    text: [
      `Niche : ${niche}${audience ? ` · audience : ${audience}` : ""}.`,
      "Analyse chaque post ci-dessous (un objet par post, dans l'ordre), puis dégage les tendances transverses.",
      "« pertinent » est faux pour un post hors niche ; « francais » est faux pour un post qui ne vise pas un public francophone.",
      "Dans les textes (mécanisme, explication, comment l'utiliser, à éviter), désigne un post par son @compte et son réseau, jamais par son numéro : les numéros vont seulement dans « preuves ».",
      "Pour le « stade » d'une tendance, appuie-toi sur l'âge des posts, leur croissance relevée quand elle est donnée et le nombre de créateurs qui la reprennent.",
      images.length ? "Pour les posts dont l'image est fournie, lis le texte incrusté et le cadrage." : "Aucune image n'est fournie : texte_ecran vaut null.",
      "",
      "=== POSTS (mesures réelles) ===",
      postsText,
    ].join("\n"),
  });
  return structuredCall({
    system: ANALYSIS_SYSTEM,
    user: content,
    schema: AnalysisSchema,
    maxTokens: 16000,
    effort: "low",
    model: config.analysisModel,
    timeoutMs,
    onUsage,
  });
}

// ---------- Idées à publier ----------

const IdeasSchema = z.object({
  synthese: z.string().describe("2 phrases : ce qui bouge dans la niche en ce moment, d'après les données"),
  idees: z
    .array(
      z.object({
        titre: z.string().describe("L'idée en une phrase, formulée comme un sujet de contenu"),
        plateforme: z.enum(["reels", "linkedin", "x", "youtube"]).describe("reels = vidéo courte Instagram/TikTok").catch("reels"),
        format: z.string().describe("Format précis, ex. « Reel face caméra 25 s », « Carrousel 6 slides », « Thread 6 tweets »"),
        accroche: z.string().describe("La première phrase ou les 3 premières secondes, prête à l'emploi"),
        variantes_accroche: z.array(z.string()).describe("2 autres accroches possibles, d'un autre type (question, chiffre, contre-intuitif…)"),
        deroule: z.string().describe("Le déroulé en 2-3 phrases : ce que montre ou dit le contenu"),
        plan: z.array(z.string()).describe("3 à 6 étapes ou plans, dans l'ordre, chacun en une ligne (avec le texte à l'écran si c'est une vidéo)"),
        cta: z.string().describe("L'appel à l'action final, prêt à l'emploi"),
        hashtags: z.array(z.string()).describe("3 à 5 hashtags, sans #, tirés des données quand c'est possible"),
        pourquoi_maintenant: z
          .string()
          .describe("Pourquoi ça peut marcher cette semaine, en citant uniquement des chiffres présents dans les données ; désigne un post par son auteur et son réseau (« @compte sur TikTok »), jamais par son numéro"),
        pourquoi_toi: z
          .string()
          .nullable()
          .describe("Pourquoi c'est adapté à cette personne, d'après son historique de publications ; null sans historique"),
        risque: z.string().nullable().describe("Le principal risque (saturation, polémique, effort de tournage), ou null"),
        preuves: z.array(z.number().int()).describe("Numéros des posts qui le prouvent (1 pour P1…), 0 à 3"),
        tendance: z.string().nullable().describe("Nom de la tendance détectée exploitée, ou null"),
        potentiel: z.number().describe("Potentiel relatif dans la niche, de 0 à 100, pas une promesse de vues"),
        fenetre: z.enum(["24 h", "48 h", "cette semaine", "2 semaines"]).catch("cette semaine"),
        effort: z.enum(["faible", "moyen", "élevé"]).catch("moyen"),
      }),
    )
    .min(1),
});

const IDEAS_SYSTEM =
  BASE_SYSTEM +
  " Tu repères ce qui sur-performe réellement (posts mesurés, ratios par rapport à l'audience de leur auteur, mécanismes analysés, tendances partagées par plusieurs créateurs, veille de la semaine) " +
  "et tu en tires des idées que la personne peut publier vite dans SA niche, sans copier les posts : tu reprends le mécanisme (format, angle, accroche, émotion), pas le contenu. " +
  "Tu ne cites que des chiffres présents dans les données, avec ce à quoi ils comparent ; s'il n'y a pas de données sociales, tu le dis dans la synthèse et tu t'appuies sur la veille et les sujets montants. " +
  DATA_LEGEND +
  " " +
  "Avant de répondre, écarte les idées génériques qu'on pourrait publier n'importe quelle semaine.";

export async function proposeIdeas({ niche, audience, voice, postsText, trendsText, clustersText, researchText, historyText, externalText, count = 6, timeoutMs, onUsage }) {
  const user = [
    `Propose ${count} idées de contenus à publier, classées de la plus prometteuse à la moins prometteuse, variées en plateformes et en formats.`,
    "Chaque idée doit s'appuyer sur un mécanisme observé dans les posts, les tendances ou la veille ci-dessous : dans « pourquoi maintenant », désigne les posts par leur auteur et leur réseau (« @compte sur TikTok ») et jamais par leur numéro ; mets leurs numéros dans « preuves ».",
    "Privilégie les mécanismes « reproductibles » : posts de petits comptes qui dépassent largement leur audience, tendances émergentes partagées par plusieurs créateurs, dates à venir de la veille.",
    historyText ? "Tiens compte de l'historique de la personne : ce qui a marché pour elle, ce qui a déçu, les formats qu'elle publie." : null,
    voice ? `Voix de l'auteur à respecter : ${voice}` : null,
    "",
    "=== PROFIL ===",
    `Niche : ${niche}`,
    audience ? `Audience : ${audience}` : null,
    "",
    "=== POSTS RELEVÉS (mesures réelles, avec l'analyse de leur mécanisme) ===",
    postsText || "(aucun post relevé : pas de jeton Apify ou aucun résultat)",
    "",
    "=== TENDANCES ANALYSÉES ===",
    trendsText || "(pas d'analyse des tendances pour ce relevé)",
    "",
    "=== HASHTAGS ET SONS REPRIS PAR PLUSIEURS CRÉATEURS ===",
    clustersText || "(aucun dans ce relevé)",
    "",
    "=== VEILLE WEB DE LA SEMAINE ===",
    researchText || "(pas de veille web pour ce scan)",
    "",
    "=== SUJETS MONTANTS EN FRANCE ===",
    externalText || "(indisponibles)",
    historyText ? `\n=== HISTORIQUE DE LA PERSONNE (prévu · relevé) ===\n${historyText}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
  return structuredCall({ system: IDEAS_SYSTEM, user, schema: IdeasSchema, maxTokens: 24000, timeoutMs, onUsage });
}

// ---------- Analyse d'un compte (le sien ou un modèle) ----------

// Indicateurs calculés par l'application, auxquels chaque constat de Claude doit se rattacher.
export const ACCOUNT_SUPPORTS = [
  "frequence", "regularite", "engagement", "mesures", "formats", "durees", "hashtags", "legendes", "sons",
  "moments", "evolution", "croissance", "reactions", "types_x", "publications",
];

const AccountClaim = z.object({
  texte: z.string().describe("Une ou deux phrases, SANS AUCUN CHIFFRE : l'application affiche la mesure à côté"),
  appui: z.enum(ACCOUNT_SUPPORTS).describe("L'indicateur calculé (entre crochets dans les données) qui fonde la phrase, ou « publications » si elle repose sur des publications précises").catch("publications"),
  publications: z.array(z.number().int()).describe("Numéros des publications qui l'illustrent (1 pour P1), 0 à 4"),
});

const AccountInsightsSchema = z.object({
  positionnement: z.string().describe("2 phrases sans chiffre : de quoi parle le compte, pour qui, sous quelle forme"),
  themes: z
    .array(z.object({ nom: z.string(), publications: z.array(z.number().int()).describe("2 à 4 publications de ce thème") }))
    .describe("2 à 5 thèmes, du plus présent au moins présent"),
  ce_qui_marche: z.array(AccountClaim).describe("2 à 4 constats, chacun illustré par des publications marquées « au-dessus »"),
  ce_qui_marche_moins: z.array(AccountClaim).describe("0 à 3 constats, chacun illustré par des publications marquées « en dessous »"),
  accroches: z
    .array(z.object({
      type: z.string().describe("Type d'accroche, ex. « question », « promesse », « chiffre choc », « récit »"),
      publication: z.number().int().describe("Numéro de la publication qui l'illustre"),
      pourquoi: z.string().describe("Ce qu'elle fait au lecteur, en une phrase sans chiffre"),
    }))
    .describe("2 à 4 accroches typiques du compte"),
  forces: z.array(AccountClaim).describe("2 à 3 forces"),
  faiblesses: z.array(AccountClaim).describe("1 à 3 faiblesses"),
  opportunites: z.array(AccountClaim).describe("1 à 3 opportunités"),
  menaces: z.array(AccountClaim).describe("0 à 2 menaces"),
  recommandations: z
    .array(AccountClaim.extend({ priorite: z.enum(["haute", "moyenne", "basse"]).catch("moyenne") }))
    .describe("3 à 5 recommandations concrètes, à l'impératif, propres à ce compte"),
  idees: z
    .array(z.object({
      titre: z.string().describe("Le sujet du contenu, en une phrase"),
      plateforme: z.enum(["reels", "linkedin", "x", "youtube"]).describe("reels = vidéo courte Instagram/TikTok").catch("reels"),
      format: z.string().describe("Format précis, ex. « Reel face caméra 30 s », « Carrousel 6 slides »"),
      accroche: z.string().describe("La première phrase, prête à l'emploi"),
      angle: z.string().describe("Le mécanisme repris et comment, en une ou deux phrases sans chiffre"),
      inspiree_de: z.array(z.number().int()).describe("Publications « au-dessus » dont l'idée reprend le mécanisme, 1 à 3"),
    }))
    .describe("3 à 5 idées pour la personne qui utilise l'outil, inspirées de ce qui marche sur ce compte, sans le copier"),
  voix: z.object({
    resume: z.string().describe("Le style d'écriture des légendes en 2 ou 3 phrases : ton, tutoiement ou vouvoiement, longueur, emojis, structure"),
    expressions: z.array(z.string()).describe("0 à 6 expressions récurrentes copiées telles quelles des légendes"),
  }),
});

const ACCOUNT_SYSTEM =
  "Tu analyses un compte de réseau social pour un créateur francophone. Tu t'appuies uniquement sur les indicateurs calculés et les publications fournies : " +
  "chaque publication porte sa place mesurée dans le compte (« au-dessus », « dans la norme », « en dessous » de la médiane de sa famille, « trop récent » ou « épinglée »). " +
  "Règles : (1) n'écris AUCUN chiffre dans tes phrases, l'application affiche la mesure exacte à côté de chaque constat ; " +
  "(2) un constat sur ce qui marche s'illustre par des publications « au-dessus », un constat sur ce qui marche moins par des publications « en dessous » ; " +
  "(3) ne tire aucune conclusion d'une publication « trop récente » ou « épinglée » ; " +
  "(4) quand un indicateur dit qu'il n'y a pas assez de publications pour conclure, ne conclus pas ; " +
  "(5) pas de conseil générique valable pour n'importe quel compte ; (6) désigne une publication par son numéro dans les champs prévus, jamais dans le texte. Réponds en français.";

/**
 * `summaryText` : indicateurs calculés, une ligne par clé ([frequence] …). `postsText` : une ligne par publication (P1…).
 * `images` : [{ n, mediaType, data }] couvertures de publications (base64).
 */
export async function analyzeAccount({ platformLabel, profileText, summaryText, postsText, images = [], timeoutMs, onUsage }) {
  const content = [];
  for (const img of images) {
    content.push({ type: "text", text: `Couverture de P${img.n} :` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  content.push({
    type: "text",
    text: [
      `Compte ${platformLabel} à analyser.`,
      "",
      "=== PROFIL ===",
      profileText,
      "",
      "=== INDICATEURS CALCULÉS (clé entre crochets) ===",
      summaryText,
      "",
      "=== PUBLICATIONS (de la plus récente à la plus ancienne) ===",
      postsText,
    ].join("\n"),
  });
  return structuredCall({
    system: ACCOUNT_SYSTEM,
    user: content,
    schema: AccountInsightsSchema,
    maxTokens: 16000,
    effort: "medium",
    timeoutMs,
    onUsage,
  });
}

export function hasApiCredentials() {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_PROFILE,
  );
}
