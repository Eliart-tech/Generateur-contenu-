// Heuristiques de conformité par plateforme : des règles vérifiables localement
// (longueurs, hook, structure, CTA). Elles complètent le juge LLM — elles ne
// prédisent pas la viralité, elles vérifient que le script respecte les codes
// du format. Chaque contrôle renvoie un score 0-100 + des drapeaux lisibles.

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

// Score en cloche : 100 dans [lo, hi], décroît linéairement jusqu'à 0 aux bornes extérieures.
function bandScore(value, [min, lo, hi, max]) {
  if (value >= lo && value <= hi) return 100;
  if (value <= min || value >= max) return 0;
  if (value < lo) return clamp(((value - min) / (lo - min)) * 100);
  return clamp(((max - value) / (max - hi)) * 100);
}

const CTA_RE = /\?|commente|abonne|partage|dis-moi|dites-moi|suivez|suis-moi|lien|sauvegarde|enregistre|réagis|votre avis|ton avis|like si/i;
const HOOK_PATTERN_RE = /\d|pourquoi|comment|secret|erreur|personne ne|arrêtez|stop|vérité|jamais|toujours|contrairement|voici|ce que|la raison/i;

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

function firstLine(text) {
  return (text.split("\n").find((l) => l.trim()) || "").trim();
}

function hashtagCount(text, hashtags) {
  // Déduplication : les mêmes tags apparaissent souvent à la fois dans le texte
  // du post et dans le champ hashtags renvoyé par le modèle.
  const all = new Set((text.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase()));
  for (const h of Array.isArray(hashtags) ? hashtags : []) {
    const tag = String(h).trim();
    if (tag) all.add((tag.startsWith("#") ? tag : `#${tag}`).toLowerCase());
  }
  return all.size;
}

function scoreLinkedin(script) {
  const text = script.contenu || "";
  const flags = [];
  const len = text.length;
  const lengthScore = bandScore(len, [300, 800, 1600, 3000]);
  if (len < 800) flags.push("Post court : sous ~800 caractères, LinkedIn récompense rarement.");
  if (len > 1600) flags.push("Post long : au-delà de ~1 600 caractères, la lecture décroche.");

  const hook = firstLine(text);
  let hookScore = 60;
  if (hook.length <= 140) hookScore += 20;
  else flags.push("Accroche trop longue : la coupure « …voir plus » tombe vers 140 caractères.");
  if (HOOK_PATTERN_RE.test(hook)) hookScore += 20;
  else flags.push("Accroche sans déclencheur (chiffre, question, affirmation contrariante).");

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const airScore = paragraphs >= 4 ? 100 : paragraphs * 25;
  if (paragraphs < 4) flags.push("Aérer davantage : des paragraphes de 1-2 lignes se lisent mieux sur mobile.");

  const ctaScore = CTA_RE.test(text.slice(-300)) ? 100 : 30;
  if (ctaScore < 100) flags.push("Pas de CTA en fin de post (question, invitation à commenter).");

  const tags = hashtagCount(text, script.hashtags);
  const tagScore = tags <= 5 ? 100 : clamp(100 - (tags - 5) * 20);
  if (tags > 5) flags.push("Trop de hashtags : 3 à 5 maximum sur LinkedIn.");

  return {
    facteurs: [
      { nom: "Accroche (2 premières lignes)", score: clamp(hookScore) },
      { nom: "Longueur (800-1600 car.)", score: lengthScore },
      { nom: "Aération / lisibilité", score: airScore },
      { nom: "Appel à l'action", score: ctaScore },
      { nom: "Hashtags", score: tagScore },
    ],
    flags,
  };
}

function scoreReel(script) {
  const text = script.contenu || "";
  const flags = [];
  // Voix off = le script sans la légende de publication ni les didascalies [plans, texte à l'écran].
  const voixOff = text.split(/^\s*(?:l[ée]gende|caption)\s*[:\-]/im)[0];
  const words = countWords(voixOff.replace(/\[[^\]]*\]/g, ""));
  // 30-45 s de voix off ≈ 75-120 mots.
  const durationScore = bandScore(words, [40, 75, 130, 220]);
  if (words < 75) flags.push("Script court : vise 30-45 s de voix off (≈ 75-120 mots).");
  if (words > 130) flags.push("Script long : au-delà de ~45 s, la rétention des Reels chute.");

  const hook = firstLine(text).replace(/\[[^\]]*\]/g, "");
  let hookScore = 50;
  if (countWords(hook) <= 14) hookScore += 25;
  else flags.push("Hook trop long : il doit tenir dans les 3 premières secondes (≤ ~14 mots).");
  if (HOOK_PATTERN_RE.test(hook)) hookScore += 25;
  else flags.push("Hook sans tension (question, chiffre, affirmation inattendue).");

  const onScreen = /\[/.test(text);
  const structureScore = onScreen ? 100 : 55;
  if (!onScreen) flags.push("Prévoir le texte à l'écran / les plans entre crochets [comme ceci].");

  const ctaScore = CTA_RE.test(text.slice(-250)) ? 100 : 30;
  if (ctaScore < 100) flags.push("Pas de CTA final (abonne-toi, commente, enregistre).");

  return {
    facteurs: [
      { nom: "Hook 3 secondes", score: clamp(hookScore) },
      { nom: "Durée (30-45 s)", score: durationScore },
      { nom: "Indications visuelles", score: structureScore },
      { nom: "Appel à l'action", score: ctaScore },
    ],
    flags,
  };
}

function scoreX(script) {
  const text = script.contenu || "";
  const flags = [];
  // Tweets séparés par des lignes vides (le format demandé), avec tolérance pour
  // la numérotation de thread "2/" ou "2/8" en début de ligne — pas pour un
  // simple chiffre, qui couperait les listes à l'intérieur d'un tweet.
  const tweets = text
    .split(/\n\s*\n|\n(?=\d{1,2}\/(?:\d{1,2})?\s)/)
    .map((t) => t.trim())
    .filter(Boolean);

  const countScore = bandScore(tweets.length, [1, 4, 9, 15]);
  if (tweets.length < 4) flags.push("Thread court : 5 à 8 tweets portent mieux une idée.");
  if (tweets.length > 9) flags.push("Thread long : au-delà de 9 tweets, l'audience décroche.");

  const first = tweets[0] || "";
  let hookScore = 50;
  if (first.length <= 280) hookScore += 20;
  else flags.push("Le premier tweet dépasse 280 caractères.");
  if (HOOK_PATTERN_RE.test(first)) hookScore += 30;
  else flags.push("Premier tweet sans promesse claire (chiffre, bénéfice, tension).");

  const tooLong = tweets.filter((t) => t.length > 280).length;
  const fitScore = tooLong === 0 ? 100 : clamp(100 - tooLong * 25);
  if (tooLong > 0) flags.push(`${tooLong} tweet(s) dépassent 280 caractères.`);

  const ctaScore = CTA_RE.test(tweets[tweets.length - 1] || "") ? 100 : 40;
  if (ctaScore < 100) flags.push("Dernier tweet sans CTA (suivre, RT, répondre).");

  return {
    facteurs: [
      { nom: "Tweet d'ouverture", score: clamp(hookScore) },
      { nom: "Nombre de tweets (5-8)", score: countScore },
      { nom: "Limite 280 caractères", score: fitScore },
      { nom: "Appel à l'action", score: ctaScore },
    ],
    flags,
  };
}

function scoreYoutube(script) {
  const text = script.contenu || "";
  const title = script.titre || firstLine(text);
  const flags = [];

  let titleScore = 50;
  if (title.length <= 60) titleScore += 25;
  else flags.push("Titre > 60 caractères : il sera tronqué dans les résultats.");
  if (HOOK_PATTERN_RE.test(title)) titleScore += 25;
  else flags.push("Titre sans déclencheur de curiosité (chiffre, enjeu, contraste).");

  const hasHookSection = /hook|accroche|intro|0[:\s-]*30|30 premières secondes/i.test(text);
  const hookScore = hasHookSection ? 100 : 50;
  if (!hasHookSection) flags.push("Prévoir explicitement les 30 premières secondes (le hook décide de la rétention).");

  const chapters = (text.match(/^#{0,3}\s*(?:chapitre|partie|\d+[\).:])/gim) || []).length;
  const structureScore = chapters >= 3 ? 100 : clamp(40 + chapters * 20);
  if (chapters < 3) flags.push("Structurer en 3+ chapitres/sections identifiables.");

  const ctaScore = CTA_RE.test(text.slice(-400)) ? 100 : 40;
  if (ctaScore < 100) flags.push("Pas de CTA final (abonnement, vidéo suivante, commentaire).");

  return {
    facteurs: [
      { nom: "Titre (< 60 car., curiosité)", score: clamp(titleScore) },
      { nom: "Hook des 30 premières secondes", score: hookScore },
      { nom: "Structure en chapitres", score: structureScore },
      { nom: "Appel à l'action", score: ctaScore },
    ],
    flags,
  };
}

const SCORERS = { linkedin: scoreLinkedin, reels: scoreReel, x: scoreX, youtube: scoreYoutube };

export function heuristicScore(platform, script) {
  const scorer = SCORERS[platform];
  if (!scorer) return { global: 50, facteurs: [], flags: [`Plateforme inconnue : ${platform}`] };
  const { facteurs, flags } = scorer(script);
  const global = clamp(facteurs.reduce((s, f) => s + f.score, 0) / (facteurs.length || 1));
  return { global, facteurs, flags };
}
