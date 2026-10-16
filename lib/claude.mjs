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
  if (error instanceof Anthropic.APIError) {
    return `Erreur API Claude (${error.status}) : ${error.message}`;
  }
  return String(error?.message || error);
}

async function structuredCall({ system, user, schema, maxTokens = 16000, effort, timeoutMs }) {
  if (!hasApiCredentials()) {
    throw new Error(
      process.env.VERCEL
        ? "Clé API absente : ajoute ANTHROPIC_API_KEY dans Vercel (Settings → Environment Variables), puis redéploie."
        : "Clé API absente : copie .env.example vers .env et renseigne ANTHROPIC_API_KEY, puis relance le serveur.",
    );
  }
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      output_config: { effort: effort || config.effort, format: zodOutputFormat(schema) },
      messages: [{ role: "user", content: user }],
    }, timeoutMs ? { timeout: timeoutMs } : undefined);
  } catch (error) {
    throw new Error(friendlyError(error));
  }

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

export async function planQueries({ niche, audience }) {
  const user = [
    "Prépare les requêtes de recherche pour relever, sur chaque réseau, les contenus récents qui marchent dans cette niche.",
    "Vise les mots que les créateurs francophones de la niche emploient vraiment (pas de jargon marketing), assez précis pour rester dans la niche, assez larges pour remonter des posts populaires.",
    `Niche : ${niche}`,
    audience ? `Audience : ${audience}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return structuredCall({ system: BASE_SYSTEM, user, schema: QueriesSchema, maxTokens: 2000, effort: "low" });
}

const IdeasSchema = z.object({
  synthese: z.string().describe("2 phrases : ce qui bouge dans la niche en ce moment, d'après les données"),
  idees: z
    .array(
      z.object({
        titre: z.string().describe("L'idée en une phrase, formulée comme un sujet de contenu"),
        plateforme: z.enum(["reels", "linkedin", "x", "youtube"]).describe("reels = vidéo courte Instagram/TikTok"),
        format: z.string().describe("Format précis, ex. « Reel face caméra 25 s », « Carrousel 6 slides », « Thread 6 tweets »"),
        accroche: z.string().describe("La première phrase ou les 3 premières secondes, prête à l'emploi"),
        deroule: z.string().describe("Le déroulé en 2-3 phrases : ce que montre ou dit le contenu"),
        pourquoi_maintenant: z
          .string()
          .describe("Pourquoi ça peut marcher cette semaine, en citant uniquement des chiffres présents dans les données ; désigne un post par son auteur et son réseau (« @compte sur TikTok »), jamais par son numéro"),
        preuves: z.array(z.number().int()).describe("Numéros des posts qui le prouvent (1 pour P1…), 0 à 3"),
        tendance: z.string().nullable().describe("Nom de la tendance détectée exploitée, ou null"),
        potentiel: z.number().int().min(0).max(100).describe("Potentiel relatif dans la niche, pas une promesse de vues"),
        fenetre: z.enum(["24 h", "48 h", "cette semaine", "2 semaines"]),
        effort: z.enum(["faible", "moyen", "élevé"]),
      }),
    )
    .min(3),
});

const IDEAS_SYSTEM =
  BASE_SYSTEM +
  " Tu repères ce qui sur-performe réellement (posts mesurés, ratios par rapport à l'audience de leur auteur, tendances partagées par plusieurs créateurs) " +
  "et tu en tires des idées que la personne peut publier vite dans SA niche, sans copier les posts : tu reprends le mécanisme (format, angle, accroche, émotion), pas le contenu. " +
  "Tu ne cites que des chiffres présents dans les données ; s'il n'y a pas de données sociales, tu le dis dans la synthèse et tu t'appuies sur les sujets montants.";

export async function proposeIdeas({ niche, audience, voice, postsText, clustersText, externalText, count = 6, timeoutMs }) {
  const user = [
    `Propose ${count} idées de contenus à publier, classées de la plus prometteuse à la moins prometteuse, variées en plateformes et en formats.`,
    "Chaque idée doit s'appuyer sur un mécanisme observé dans les posts ou les tendances ci-dessous : dans « pourquoi maintenant », désigne les posts par leur auteur et leur réseau (« @compte sur TikTok ») et jamais par leur numéro ; mets leurs numéros dans « preuves ».",
    "Privilégie les mécanismes « reproductibles » : posts de petits comptes qui dépassent largement leur audience, tendances émergentes partagées par plusieurs créateurs.",
    voice ? `Voix de l'auteur à respecter : ${voice}` : null,
    "",
    "=== PROFIL ===",
    `Niche : ${niche}`,
    audience ? `Audience : ${audience}` : null,
    "",
    "=== POSTS RELEVÉS (mesures réelles) ===",
    postsText || "(aucun post relevé : pas de jeton Apify ou aucun résultat)",
    "",
    "=== TENDANCES DÉTECTÉES ===",
    clustersText || "(aucune tendance partagée par plusieurs créateurs dans ce relevé)",
    "",
    "=== SUJETS MONTANTS EN FRANCE ===",
    externalText || "(indisponibles)",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return structuredCall({ system: IDEAS_SYSTEM, user, schema: IdeasSchema, maxTokens: 16000, timeoutMs });
}

export function hasApiCredentials() {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_PROFILE,
  );
}
