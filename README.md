# Générateur de contenu — outil personnel

Transforme une idée brute en scripts prêts à publier pour **LinkedIn, Instagram Reels, X et YouTube**, guidés par les **tendances du moment**, puis notés **avant publication** par un score de performance explicable. Après publication, saisis tes stats réelles : l'outil compare la prédiction au réalisé.

Outil local, mono-utilisateur : pas de compte, pas d'abonnement, tes données restent dans le dossier `data/`.

## Démarrage

```bash
npm install
cp .env.example .env    # puis renseigne ANTHROPIC_API_KEY
npm start               # → http://127.0.0.1:3344
```

Prérequis : Node.js ≥ 20 et une clé API Anthropic (console [platform.claude.com](https://platform.claude.com)). La clé YouTube est optionnelle (elle ajoute la source YouTube au radar, quota gratuit).

## Le flux

1. **Créer** : tu saisis une idée, ta niche, ton audience, ton objectif et les plateformes visées.
2. **Radar** : l'outil collecte les tendances liées (Google Trends, actualité GDELT, YouTube, Reddit, Hacker News) — gratuites, interrogées en direct, mises en cache 30 min.
3. **Angles** : Claude propose 4-5 angles éditoriaux justifiés par les tendances réellement collectées, chacun noté.
4. **Scripts** : pour l'angle choisi, un script natif par plateforme (post LinkedIn, Reel 30-45 s, thread X, vidéo YouTube).
5. **Score avant publication** : chaque script reçoit un score 0-100 décomposé — juge IA critique (hook, structure, adéquation tendance, émotion, CTA) + conformité aux codes du format (heuristiques vérifiables) — avec une **bande de potentiel relatif** (« top 25 % »), un niveau de confiance et des suggestions de réécriture en un clic.
6. **Historique & calibration** : à J+2/J+7, saisis les vues réelles et ta médiane habituelle ; l'outil calcule le ratio (la mesure « outlier »), compare bande prédite vs observée, et affiche ta calibration cumulée.

Le score est un **potentiel relatif, jamais une promesse de vues** : la viralité reste largement imprévisible, l'outil t'aide à comprendre et améliorer, et il affiche sa propre fiabilité au fil de tes posts mesurés.

## Configuration (`.env`)

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | clé API Claude (obligatoire) | — |
| `YOUTUBE_API_KEY` | source YouTube du radar (optionnelle) | désactivée |
| `CLAUDE_MODEL` | modèle utilisé | `claude-opus-5-5` |
| `CLAUDE_EFFORT` | profondeur de raisonnement (`low`→`max`) | `high` en local, `medium` sur Vercel |
| `TREND_GEO` / `TREND_LANG` | pays / langue des tendances | `FR` / `fr` |
| `PORT` | port local | `3344` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` (ou `KV_REST_API_URL` / `_TOKEN`) | stockage Redis — requis en ligne, inutile en local | fichiers dans `data/` |

Note : les générations sont volontairement soignées (modèle Opus, effort élevé) — compte 1 à 3 minutes et quelques dizaines de centimes par génération complète. Pour aller plus vite et moins cher : `CLAUDE_EFFORT=medium`.

## Mettre en ligne sur Vercel

Le dépôt est prêt pour Vercel tel quel (`vercel.json` + `api/index.js`). Compte 10 minutes, plan gratuit (Hobby) suffisant.

1. **Importer le projet** : sur [vercel.com/new](https://vercel.com/new), choisis le dépôt `Generateur-contenu-`, laisse *Framework Preset* sur **Other**, ne touche à rien d'autre, et clique **Deploy**. Vérifie ensuite dans *Settings → Git* que la **Production Branch** est bien `main`.
2. **Protéger l'accès — indispensable.** Sans ça, n'importe qui avec l'URL utilise ta clé API. Dans le projet Vercel : *Settings → Deployment Protection* → méthode **Vercel Authentication**, portée **All Deployments** (gratuit sur tous les plans). Seul ton compte Vercel pourra ouvrir le site.
3. **Ajouter le stockage** (sinon l'historique est perdu à chaque redémarrage) : onglet *Storage* du projet → *Create* → **Upstash for Redis** (offre gratuite) → connecte-le au projet. Les variables `KV_REST_API_URL` / `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) sont ajoutées automatiquement ; l'app reconnaît les deux.
4. **Variables d'environnement** : *Settings → Environment Variables* → ajoute `ANTHROPIC_API_KEY` (obligatoire), et si tu veux `YOUTUBE_API_KEY`, `CLAUDE_EFFORT`, `TREND_GEO`.
5. **Redéployer** : *Deployments* → menu ⋯ du dernier déploiement → **Redeploy**, pour que les variables soient prises en compte. Dans l'app, l'onglet *Réglages* doit afficher « Stockage : Redis (persistant) ✓ » et « Clé Anthropic : présente ✓ ».

Ensuite, chaque push sur `main` redéploie automatiquement.

**Limite de durée.** Sur le plan Hobby, une requête est coupée à 5 minutes. L'app découpe déjà la génération en deux appels (écriture puis évaluation) et utilise par défaut l'effort `medium` en ligne. Si un message « délai dépassé » apparaît quand même, mets `CLAUDE_EFFORT=low` dans les variables Vercel.

## Architecture

```
server.mjs            serveur HTTP local (node:http, zéro framework)
api/index.js          fonction Vercel : sert toute l'API en ligne
vercel.json           config Vercel (public/ en statique, /api/* → api/index.js)
lib/app.mjs           routes de l'API, partagées par le local et Vercel
lib/claude.mjs        appels Claude : angles, scripts, juge, réécriture
                      (sorties structurées validées par zod, fallback anti-refus)
lib/sources.mjs       radar de tendances (Google Trends, GDELT, YouTube, Reddit, HN)
lib/heuristics.mjs    conformité aux codes de chaque format (règles locales)
lib/store.mjs         persistance : fichiers JSON en local, Redis (Upstash) en ligne
public/               interface (vanilla JS, aucune dépendance)
data/                 tes données locales (ignorées par git)
```

La stratégie produit complète (marché, concurrence, mécanisme de scoring, sources de données) est dans [`docs/STRATEGIE.md`](docs/STRATEGIE.md).
