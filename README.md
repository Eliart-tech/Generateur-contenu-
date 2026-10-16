# Amorce — générateur de contenu (outil personnel)

Repère ce qui décolle cette semaine sur **TikTok, Instagram, X, LinkedIn et YouTube Shorts** dans ta niche, te propose des idées à publier, puis transforme une idée en scripts prêts à publier pour **LinkedIn, Instagram Reels, X et YouTube**, guidés par les **tendances du moment**, puis notés **avant publication** par un score de performance explicable. Après publication, saisis tes stats réelles : l'outil compare la prédiction au réalisé.

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
2. **Radar** : l'outil collecte les tendances liées (Google Trends, actualité GDELT, YouTube, Google Actualités, Hacker News) — gratuites, interrogées en direct, mises en cache 30 min.
3. **Angles** : Claude propose 4-5 angles éditoriaux justifiés par les tendances réellement collectées, chacun noté.
4. **Scripts** : pour l'angle choisi, un script natif par plateforme (post LinkedIn, Reel 30-45 s, thread X, vidéo YouTube).
5. **Bulletin de prévision** : chaque script reçoit un score 0-100 décomposé — juge IA critique (hook, structure, adéquation tendance, émotion, CTA) + conformité aux codes du format (heuristiques vérifiables) — avec une **bande de potentiel relatif** (« top 25 % »), un niveau de confiance et des suggestions de réécriture en un clic.
6. **Historique & calibration** : à J+2/J+7, saisis les vues réelles et ta médiane habituelle ; l'outil calcule le ratio (la mesure « outlier »), compare bande prédite vs observée, et affiche ta calibration cumulée.

### Idées tendance (TikTok, Instagram, X, LinkedIn, YouTube Shorts)

L'onglet **Idées** part de ta niche, pas d'une idée : il relève les posts de la semaine sur chaque réseau et te propose directement quoi publier.

1. **Requêtes** : Claude traduit ta niche en mots-clés et hashtags par réseau (mis en cache 7 jours).
2. **Relevé** : TikTok, Instagram, X et LinkedIn via [Apify](https://apify.com) (scrapers lancés en parallèle, arrêtés au bout de 4 minutes en gardant ce qu'ils ont trouvé), YouTube Shorts via l'API YouTube, plus les sujets montants en France (tendances X, Google Trends, Google Actualités), gratuits.
3. **Score de viralité (0-100)** : un post compte quand il **dépasse l'audience habituelle de son auteur** (vues ÷ abonnés, ou ÷ sa moyenne), avec un engagement de qualité (partages et enregistrements pèsent plus que les likes) et vite après publication. Les petits comptes à ×5 et plus sont marqués « reproductible » : leur succès vient du format, pas de la notoriété. Les posts non francophones, trop anciens (> 14 jours), sponsorisés ou jeux-concours sont écartés ou signalés.
4. **Tendances** : hashtags et sons repris par plusieurs créateurs ou sur plusieurs réseaux, avec leur stade (émergent, en explosion, établi, saturé).
5. **Idées à publier** : 6 idées, chacune avec sa plateforme, son accroche, son déroulé, sa fenêtre (24 h → 2 semaines) et les posts qui la prouvent. « Écrire cette idée » lance directement la prévision (angles → scripts → score).

Les posts relevés sont aussi injectés dans la prévision classique (onglet Créer) pendant 48 h, pour que les angles et le score s'appuient sur ce qui marche réellement.

**Coût** : environ **0,30 $ de crédit Apify par scan** (TikTok 0,14 · Instagram 0,10 · LinkedIn 0,05 · X 0,02), plafonné réseau par réseau. Un scan est réutilisé pendant 6 h sans rien dépenser. L'offre gratuite d'Apify (5 $/mois) permet ~15 scans par mois ; sur cette offre, X passe par un scraper sans compteur de vues. L'offre Starter (19 $/mois) suffit pour un scan quotidien.

**Scan quotidien (optionnel)** : dans Réglages, coche « Scanner ma niche chaque matin ». Sur Vercel, une tâche planifiée (`vercel.json` → `crons`) lance le scan vers 6 h UTC ; les idées sont prêtes à l'ouverture.

L'interface suit le thème clair ou sombre de l'appareil et respecte le réglage « réduire les animations ».

Le score est un **potentiel relatif, jamais une promesse de vues** : la viralité reste largement imprévisible, l'outil t'aide à comprendre et améliorer, et il affiche sa propre fiabilité au fil de tes posts mesurés.

## Configuration (`.env`)

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | clé API Claude (obligatoire) | — |
| `YOUTUBE_API_KEY` | source YouTube du radar et YouTube Shorts dans « Idées » (optionnelle) | désactivée |
| `APIFY_TOKEN` | relevé TikTok, Instagram, X et LinkedIn dans « Idées » (optionnel, payant à l'usage) | désactivé |
| `CRON_SECRET` | protège le scan quotidien sur Vercel (optionnel, recommandé) | — |
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
4. **Variables d'environnement** : *Settings → Environment Variables* → ajoute `ANTHROPIC_API_KEY` (obligatoire), et si tu veux `YOUTUBE_API_KEY`, `APIFY_TOKEN`, `CRON_SECRET`, `CLAUDE_EFFORT`, `TREND_GEO`.
   - **`APIFY_TOKEN`** (pour TikTok, Instagram, X, LinkedIn) : crée un compte sur [apify.com](https://apify.com), puis *Settings → API & Integrations* → copie le **Personal API token**. Pense à fixer une limite de dépense mensuelle dans *Billing → Limits*.
   - **`CRON_SECRET`** : n'importe quelle longue chaîne aléatoire ; Vercel l'envoie automatiquement à la tâche planifiée et l'app refuse tout autre appel.
5. **Redéployer** : *Deployments* → menu ⋯ du dernier déploiement → **Redeploy**, pour que les variables soient prises en compte. Dans l'app, la page *Réglages* → *État du système* doit afficher « Historique : Redis, persistant », « Clé Anthropic : Présente » (et « Jeton Apify » avec ton offre et ton crédit restant si tu l'as ajouté) (le point d'état en bas de la barre latérale passe au vert).

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
lib/sources.mjs       radar de tendances (Google Trends, GDELT, YouTube, Google Actualités, HN)
lib/social.mjs        scan des réseaux : adaptateurs Apify, YouTube Shorts, sujets montants FR
lib/virality.mjs      score de viralité des posts et détection des tendances (hashtags, sons)
lib/apify.mjs         client minimal de l'API Apify (runs asynchrones, plafonds de dépense)
lib/heuristics.mjs    conformité aux codes de chaque format (règles locales)
lib/store.mjs         persistance : fichiers JSON en local, Redis (Upstash) en ligne
public/               interface (vanilla JS, aucune dépendance)
data/                 tes données locales (ignorées par git)
```

La stratégie produit complète (marché, concurrence, mécanisme de scoring, sources de données) est dans [`docs/STRATEGIE.md`](docs/STRATEGIE.md).
