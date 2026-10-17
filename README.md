# Amorce — générateur de contenu (outil personnel)

Repère ce qui décolle cette semaine sur **TikTok, Instagram, X, LinkedIn et YouTube Shorts** dans ta niche, te propose des idées à publier, fait le portrait chiffré d'un compte (le tien ou un modèle), puis transforme une idée en scripts prêts à publier pour **LinkedIn, Instagram Reels, X et YouTube**, guidés par les **tendances du moment**, puis notés **avant publication** par un score de performance explicable. Après publication, saisis tes stats réelles : l'outil compare la prédiction au réalisé.

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

Claude intervient à chaque étape où il apporte de la pertinence :

1. **Veille web (Claude + recherche web)** : avant de chercher, Claude fait la veille de la semaine sur ta niche en France (actualités datées, événements à venir, mots et hashtags du moment, débats), avec les pages qu'il cite. Gardée 20 h par niche ; une veille en échec (réponse tronquée, aucune recherche aboutie, délai) n'est pas gardée et sera retentée au scan suivant.
2. **Requêtes (Claude)** : il traduit ta niche, éclairée par cette veille, en mots-clés et hashtags par réseau.
3. **Relevé** : TikTok, Instagram, X et LinkedIn via [Apify](https://apify.com) (scrapers lancés en parallèle, arrêtés au bout de 4 minutes en gardant ce qu'ils ont trouvé), YouTube Shorts via l'API YouTube, plus les sujets montants en France (tendances X, Google Trends, Google Actualités), gratuits.
4. **Score de viralité (0-100)** : un post compte quand il **dépasse l'audience habituelle de son auteur** (vues ÷ abonnés, ou ÷ sa moyenne), avec un engagement de qualité (partages et enregistrements pèsent plus que les likes) et vite après publication. Les petits comptes à ×5 et plus sont marqués « reproductible » : leur succès vient du format, pas de la notoriété. Les posts non francophones, trop anciens (> 14 jours), sponsorisés ou jeux-concours sont écartés ou signalés.
5. **Lecture du relevé (Claude, vision comprise)** : Claude lit 40 posts (ceux que la liste affiche en tête, puis les plus chauds du moment) et regarde la couverture des 12 premiers. Il voit aussi les signaux du score (sponsorisé, jeu-concours, chiffres suspects, reproductible) pour ne jamais prendre une pub pour un modèle. Pour chacun : hors-sujet ou non, public francophone ou non, format (avant/après, tuto, storytime…), type d'accroche, texte à l'écran, mécanisme qui le fait marcher. Il en tire 2 à 6 **tendances de format, d'accroche ou de sujet**, avec la manière de les reprendre, et ce qu'il vaut mieux éviter. Les posts hors sujet sont masqués, les non francophones retirés. Si la lecture échoue, « Relancer la lecture » la refait (et réécrit les idées si elles avaient été écrites sans elle) ; le passage planifié de 7 h la retente aussi.
6. **Tendances de hashtags et de sons** : celles reprises par plusieurs créateurs ou sur plusieurs réseaux, avec leur stade (émergent, en explosion, établi, saturé).
7. **Idées à publier (Claude)** : 6 idées nourries par tout ce qui précède **et par ton historique** (ce qui a marché pour toi, ce qui a déçu). Chacune avec sa plateforme, son accroche et deux variantes, son plan, son appel à l'action, ses hashtags, sa fenêtre (24 h → 2 semaines), les posts qui la prouvent et ce qu'il faut surveiller. « Écrire cette idée » lance directement la prévision avec tout ce contexte (angles → scripts → score).

Les posts relevés, leur analyse et la veille sont aussi injectés dans la prévision classique (onglet Créer) pendant 48 h, pour que les angles et le score s'appuient sur ce qui marche réellement.

**Coût** : environ **0,30 $ de crédit Apify par scan** (TikTok 0,14 · Instagram 0,10 · LinkedIn 0,05 · X 0,02), plafonné réseau par réseau. Relancer la même niche (même audience, mêmes réseaux) dans les 6 h réutilise le scan sans rien dépenser ; « Rafraîchir » force un nouveau relevé. L'offre gratuite d'Apify (5 $/mois) permet ~15 scans par mois ; sur cette offre, X passe par un scraper sans compteur de vues. L'offre Starter (19 $/mois) suffit pour un scan quotidien.

**Coût Claude d'un scan** (affiché sous les résultats) : de l'ordre de 0,40 à 0,80 $ avec le modèle par défaut — veille web (~0,20 $, refaite au plus une fois par 20 h : ~0,01 $ par recherche, 5 au plus, plus la lecture des pages), lecture des posts et des visuels (~0,20 $), rédaction des idées (~0,25 $). Pour l'alléger : `CLAUDE_ANALYSIS_MODEL=claude-haiku-5-5` (lecture des posts environ 40 fois moins chère, un peu moins fine) ou `CLAUDE_WEB_RESEARCH=off` (pas de veille web).

**Scan quotidien (optionnel)** : dans Réglages, coche « Scanner ma niche chaque matin ». Sur Vercel, une tâche planifiée (`vercel.json` → `crons`) lance le scan vers 6 h UTC ; les idées sont prêtes à l'ouverture. Elle ne tourne qu'une fois par jour (même si Vercel livre l'appel deux fois) et pas du tout si ta niche a été scannée depuis moins de 20 h ; un second passage vers 7 h UTC termine le scan et rédige les idées si le temps a manqué.

### Analyse de compte (Instagram, TikTok, X, LinkedIn, YouTube)

L'onglet **Comptes** fait le portrait chiffré d'un compte, le tien ou un modèle : colle le lien du profil (ou son @nom), choisis le réseau. L'outil relève le profil et ses **40 dernières publications**, calcule les indicateurs, puis Claude les lit. Chaque chiffre affiche sa formule et le nombre de publications qui le fondent.

**Ce qui est mesuré, et comment** (tout est recalculable à la main depuis « Toutes les publications relevées ») :

- **Échantillon** : les publications **épinglées** sont mises de côté (souvent anciennes, remontées en tête du profil, elles fausseraient le rythme et les comparaisons), ainsi que les republications, retweets et réponses à d'autres comptes ; sur X, un fil compte une fois, par son premier post.
- **Familles** : une publication n'est comparée qu'à sa famille, **sur la même mesure** — Reels et vidéos entre eux sur les lectures, photos et carrousels entre eux sur l'engagement (Instagram ne donne pas de vues publiques pour les photos), Shorts et vidéos longues séparément, posts X avec et sans compteur d'impressions séparément. Sur YouTube, les vidéos publiées avant le 24 août 2026 (ancien décompte des vues) forment leurs propres familles. Jamais deux compteurs mélangés.
- **Statut de chaque publication** : ratio à la **médiane** de sa famille, lu sur le ratio affiché. « Au-dessus » à ×1,5 ou plus, « en dessous » à ×0,67 ou moins. Les publications de moins de 3 jours (1 jour sur X, 7 jours pour une vidéo YouTube longue) sont « trop récentes » : elles accumulent encore et ne sont pas jugées.
- **Rythme** : (publications − 1) ÷ jours entre la première et la dernière × 7. **Régularité** : coefficient de variation des écarts entre publications, à partir de 6 publications. Un compte sans publication depuis nettement plus longtemps que son rythme est signalé « à l'arrêt » : son rythme décrit une période passée.
- **Engagement** : interactions publiques ÷ abonnés, en **médiane** — Instagram et YouTube : j'aime + commentaires ; TikTok : + partages et enregistrements ; X : j'aime + réponses + reposts et citations + signets ; LinkedIn : réactions + commentaires + republications. Un compteur que le relevé ne donne pas (les signets sur l'offre Apify gratuite) n'est compté pour personne ; une publication dont un compteur est masqué n'a pas d'engagement connu. La formule exacte est affichée sous la tuile.
- **Moments** : en **heure de Paris**. Un jour ou un moment ne « ressort » qu'avec au moins 5 publications comparables, face à au moins deux autres créneaux mesurés, une médiane au-dessus de la normale du compte et au moins 1,25 fois celle des autres créneaux comme celle du deuxième ; sinon l'outil le dit. Seul un créneau qui ressort par le haut est mesuré : aucun « mauvais jour » n'est affirmé.
- **Évolution** : à l'intérieur de chaque famille (6 publications au moins), médiane des ratios de la moitié récente contre la moitié précédente, sur les publications d'au moins deux fois leur période de démarrage (12 au minimum au total). Une famille présente d'un seul côté (passage des photos aux Reels, ancien et nouveau décompte YouTube) ne crée pas de fausse évolution. Les âges médians sont affichés : les plus anciennes ont eu plus de temps pour accumuler.
- **Croissance** : seulement entre deux analyses du même compte faites ici, à au moins 12 h d'écart, à partir des abonnés relevés à chaque fois. Sur YouTube, l'API arrondit les abonnés à trois chiffres : la croissance est marquée « ≈ », et une variation plus petite que l'arrondi n'est pas affichée. Aucune estimation, aucun score global.

**La lecture par Claude** (portrait, thèmes, ce qui marche, ce qui marche moins, accroches, forces / faiblesses / opportunités / menaces, recommandations, idées, style d'écriture) ne contient **aucun nombre écrit par Claude**, ni en chiffres ni en lettres (seuls le titre, le format et l'accroche des idées en ont le droit : ce sont des propositions). Chaque constat doit citer des publications qui le prouvent — marquées « au-dessus » (×1,5) pour ce qui marche, les forces, les accroches et les idées, « en dessous » (×0,67) pour ce qui marche moins — ou un indicateur réellement calculé. Les recommandations et opportunités ne prennent pas en exemple une publication en dessous de sa médiane. Un jour ou un moment de publication, une croissance ou une évolution (et leur sens : hausse ou baisse), un format ou un hashtag présenté comme meilleur ne sont gardés que s'ils correspondent à ce que les calculs trouvent ; une évolution de moins de 10 % n'est pas une hausse ni une baisse. Sinon le texte est écarté et listé dans « Ce que Claude a proposé et qui a été écarté », avec la raison. Les expressions du style d'écriture (au moins deux mots) doivent figurer mot pour mot dans au moins deux légendes. « Reprendre ce style comme ma voix » l'enregistre dans Réglages ; « Écrire cette idée » lance la prévision avec le mécanisme repris et les publications qui le prouvent.

**Coût** : Instagram ≈ 0,11 $, TikTok ≈ 0,12 $, LinkedIn ≈ 0,09 $, X ≈ 0,02 $ de crédit Apify par analyse ; YouTube gratuit avec la clé YouTube. La lecture par Claude coûte de l'ordre de quelques dizaines de centimes (affichée sur l'analyse). Le même compte réanalysé dans les 6 h est réutilisé sans frais ; « Réanalyser » force un nouveau relevé et alimente le suivi de croissance ; un relevé déjà en cours pour ce compte est repris, jamais relancé en double.

L'interface suit le thème clair ou sombre de l'appareil et respecte le réglage « réduire les animations ».

Le score est un **potentiel relatif, jamais une promesse de vues** : la viralité reste largement imprévisible, l'outil t'aide à comprendre et améliorer, et il affiche sa propre fiabilité au fil de tes posts mesurés.

## Configuration (`.env`)

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | clé API Claude (obligatoire) | — |
| `YOUTUBE_API_KEY` | source YouTube du radar, YouTube Shorts dans « Idées », analyse des chaînes dans « Comptes » (optionnelle) | désactivée |
| `APIFY_TOKEN` | relevé TikTok, Instagram, X et LinkedIn dans « Idées » et « Comptes » (optionnel, payant à l'usage) | désactivé |
| `CRON_SECRET` | protège le scan quotidien sur Vercel (optionnel, recommandé) | — |
| `CLAUDE_ANALYSIS_MODEL` | modèle qui lit les posts dans « Idées » | le modèle principal |
| `CLAUDE_WEB_RESEARCH` | `off` pour couper la veille web de Claude | activée |
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
lib/claude.mjs        appels Claude : angles, scripts, juge, réécriture ; veille web,
                      requêtes, lecture des posts (vision) et idées pour « Idées »
                      (sorties structurées validées par zod, fallback anti-refus)
lib/sources.mjs       radar de tendances (Google Trends, GDELT, YouTube, Google Actualités, HN)
lib/social.mjs        scan des réseaux : adaptateurs Apify, YouTube Shorts, sujets montants FR
lib/virality.mjs      score de viralité des posts et détection des tendances (hashtags, sons)
lib/accounts.mjs      analyse de compte : relevé (Apify, API YouTube), suivi, historique, contrôle de la lecture par Claude
lib/account-metrics.mjs indicateurs d'un compte (familles, médianes, rythme, moments en heure de Paris, croissance)
lib/apify.mjs         client minimal de l'API Apify (runs asynchrones, plafonds de dépense)
lib/heuristics.mjs    conformité aux codes de chaque format (règles locales)
lib/store.mjs         persistance : fichiers JSON en local, Redis (Upstash) en ligne
public/               interface (vanilla JS, aucune dépendance)
data/                 tes données locales (ignorées par git)
```

La stratégie produit complète (marché, concurrence, mécanisme de scoring, sources de données) est dans [`docs/STRATEGIE.md`](docs/STRATEGIE.md).
