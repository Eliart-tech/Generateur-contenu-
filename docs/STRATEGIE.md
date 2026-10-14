# Stratégie produit — SaaS Générateur de Contenu IA

*Version du 14 octobre 2026 — rédigée à partir d'une recherche marché menée le même jour (prix et quotas vérifiés sur les pages officielles quand c'était possible ; les montants marqués « ~ » viennent de sources tierces concordantes).*

Un SaaS qui transforme une idée brute en scripts prêts à publier pour LinkedIn, Instagram Reels, X et YouTube, guidés par les tendances en temps réel des réseaux, et notés avant publication par un score de performance prédictif que l'utilisateur peut comprendre.

---

## 1. Résumé exécutif

Le pari : la génération de contenu IA est commoditisée (Jasper et Copy.ai ont fui vers l'enterprise, Hypefury a divisé ses prix par 5), la valeur s'est déplacée vers ce qu'aucun acteur n'assemble — détecter les tendances en temps réel, en dériver des scripts natifs par plateforme, prédire la performance avant publication, puis confronter la prédiction au résultat réel. Cette boucle complète n'existe nulle part : chaque brique vit en silo (1of10 côté YouTube, FeedHive côté prédiction, InspireLab côté analyse d'inspiration).

Positionnement : **le copilote de performance**, pas un énième générateur. Trois différenciateurs :

1. **Radar de tendances cross-plateformes** : détecter ce qui explose sur un réseau et le décliner en 4 formats natifs (post LinkedIn, Reel, thread X, vidéo YouTube).
2. **Score prédictif explicable** : une bande de performance relative (« potentiel : top 20 % de votre niche ») décomposée par facteur (hook, structure, adéquation tendance, format), appuyée sur les posts viraux comparables — jamais un nombre de vues promis.
3. **Calibration affichée** : après publication, l'outil confronte prédit et réalisé, apprend le contexte du compte et publie sa propre précision. Ce dataset prédiction↔réel est la barrière défensive : aucun concurrent identifié ne le possède.

Cible initiale : créateurs B2B et solopreneurs francophones (vivier estimé 400-800 k comptes), extension bilingue ensuite. Objectif 12 mois : 2 000 abonnés payants (~550-700 k€ d'ARR à 24 €/mois).

## 2. Inspiration : getinspirelab.com

[InspireLab](https://www.getinspirelab.com/) (SaaS français lancé fin 2025, porté par le créateur « Zaki ») vend un « laboratoire de viralité » : coller un lien (YouTube, TikTok, Reel, X, article), l'outil décortique structure, angle, émotion et hook, puis régénère un contenu original « dans ta voix ». 6 dashboards (YouTube, Instagram, LinkedIn, site web, TikTok, X), 9 types de contenus, analyses de profils « leaders », carrousels templatés. [Pricing](https://app.getinspirelab.com/pricing) freemium : Free 0 € (1 contenu par type/mois) ; Starter 19 €/mois en offre de lancement (~180 contenus/mois). Distribution portée par l'audience du fondateur (TikTok/Instagram, automation de DM) et un blog SEO.

**À reprendre :**
- le paradigme inspiration → déconstruction → régénération : l'IA analyse un contenu qui a marché avant d'écrire — exactement le pont entre « idée » et « script orienté performance » ;
- la cible « créateurs malgré eux » (commerçants, indépendants) et le wording anti-charge-mentale ;
- un pricing d'attaque simple (19 €, sans engagement) avec quotas lisibles par plateforme ;
- la distribution founder-led à coût d'acquisition quasi nul.

**Ce qu'InspireLab ne fait pas — notre terrain :**
- aucun score prédictif du contenu généré ;
- pas de radar de tendances automatique (l'utilisateur apporte lui-même l'inspiration) ;
- pas de publication connectée ni de boucle de feedback sur les stats réelles ;
- marché 100 % francophone, exécution encore early-stage (pas d'apps mobiles, pas de preuve sociale indépendante).

## 3. Marché et concurrence

Le marché a montré ses dangers en 2025-2026 : Hypefury est passé de 29-199 $ à 6-19 $/mois et a abandonné X ; LinkedIn a fait fermer l'extension Kleo (~70 000 utilisateurs).

| Outil | Prix/mois | Tendances temps réel | Score prédictif | Faiblesse clé |
| --- | --- | --- | --- | --- |
| Taplio | 39-199 $ | bibliothèque statique | non | IA absente du 1er palier, Trustpilot 2,4/5, hors API LinkedIn |
| Supergrow | 19-39 $ | non | non | LinkedIn seul, analytics payants |
| EasyGen | ~60 $ | non | non | LinkedIn seul, le plus cher des générateurs |
| Hypefury | 6-19 $ | bibliothèque statique | non | a abandonné X ; guerre des prix |
| FeedHive | 19-299 $ | non | oui, boîte noire | texte seul, précision jamais validée, pas de scripts vidéo |
| Buffer | ~5-6 $/canal | non | non | scheduler générique, plancher de prix |
| Predis.ai | ~19-32 $ | analyse concurrents | non | crédits vidéo vite épuisés |
| Blotato | 29-499 $ | non | non | volume sans intelligence, avis volatils |
| Opus Clip | 0-29 $ | non | score 0-99 (outil de tri) | clips uniquement |
| vidIQ | 0-39 $ | outliers YouTube | score titres/miniatures | YouTube seul |
| 1of10 | 0-69 $ | outliers YouTube | non | YouTube seul, pas de scripts multi-plateformes |
| InspireLab | 0-19 € | non (inspiration manuelle) | non | early-stage, FR uniquement |

**Espaces blancs** : (1) la boucle complète n'existe nulle part ; (2) aucun score n'est calibré ni explicable — aucun acteur ne publie sa précision ; (3) personne ne fait l'arbitrage cross-plateformes (« ce format explose sur TikTok, déclinez-le sur LinkedIn ») ; (4) le marché francophone est quasi vide.

## 4. Le moteur de raisonnement

Le cœur du produit n'est pas un prompt, c'est une boucle fermée alimentée par des données fraîches des réseaux :

```
Idée + brief → Angles (scorés par les tendances) → Scripts (LinkedIn, Reels, X, YouTube)
     → Score (0-100 décomposé) ⇄ réécriture → Publier (export ou API)
          ↓
   Stats réelles (J+2 / J+7) ──→ réentraîne le score, enrichit l'index
          ↑                                      ↓
   Index de tendances (APIs + scrapers + embeddings) → alimente les angles (RAG posts viraux)
```

Les tendances indexées justifient les angles proposés ; après publication, les statistiques réelles reviennent recalibrer le score et enrichir l'index : plus on publie, plus la prédiction devient fiable.

## 5. Sources de données

Jamais de cookies de comptes clients (c'est ce qui a tué Kleo et expose Taplio). Short-list MVP, ~175-335 €/mois :

| Source | Données | Coût/mois | Risque |
| --- | --- | --- | --- |
| YouTube Data API v3 | mostPopular par région + stats vidéos | 0 € (10 000 unités/jour) | faible |
| Apify · X scraper | recherche de tweets, 0,15 $/1 000 | ~30 € | ToS X (logged-out) |
| Apify · Instagram + TikTok | reels, hashtags, outliers, 2,6-3,7 $/1 000 | ~80-110 € | ToS Meta/TikTok (logged-out) |
| Apify · LinkedIn posts (harvestapi) | recherche de posts sans cookies, 2 $/1 000 | ~40 € | ToS LinkedIn — aucune API officielle de lecture |
| SerpApi | Google Trends + Trending Now | 25-70 € | faible |
| GDELT + NewsAPI.ai | actualité mondiale (~15 min), clustering | 0-85 € | faible |
| Reddit API | signaux précoces 24-72 h avant les autres réseaux | 0 € | approbation commerciale à régulariser |

À retenir : l'API X officielle (pay-per-use) coûte ~30× plus cher que les scrapers ; LinkedIn n'offre aucune API de lecture des contenus publics ; le TikTok Creative Center (gratuit) donne hashtags, sons et créateurs tendance. Scale-up : Bright Data (~1 $/1 000, posture juridique éprouvée), BuzzSumo, Exploding Topics, candidatures Google Trends API alpha et Instagram Public Content Access à lancer tôt.

## 6. Auto-évaluation : prédire la performance avant publication

Constat : aucun outil du marché ne publie de validation de son score (vidIQ pèse titre 48 % + miniature 48 %), et la littérature ML plafonne à AUC ~0,66-0,75 en classement pré-publication — prédire un nombre de vues exact est impossible (R² négatif). Le mécanisme crédible : **un classement relatif, calibré sur données réelles, avec incertitude affichée.**

**Étage 1 — MVP (sans entraînement lourd)**
- heuristiques par plateforme : hook (3 premières secondes d'un Reel, 2 premières lignes d'un post), longueur, structure, lisibilité, CTA ;
- similarité d'embeddings avec le top-décile de la niche, normalisée par taille d'audience (ratio vs médiane du compte — le modèle « outlier » de 1of10) ; restitution avec les 3-5 posts viraux les plus proches comme preuve ;
- LLM-judge en comparaison par paires (« lequel de ces deux posts performera ? »), calibré sur des paires historiques réelles, avec abstention ;
- sortie : bande de performance (« top 20 % de votre niche »), 3-5 facteurs expliqués, suggestions de réécriture.

**Étage 2 — V2, la barrière défensive**
- comptes connectés en OAuth → stats réelles à J+2 et J+7 → dataset propriétaire prédit↔réalisé par niche et par compte ;
- modèle GBDT (CatBoost/XGBoost) sur embeddings + features + rationales LLM, recalibration continue (Platt/isotonique) ;
- « re-prédiction » 1 h après publication (les signaux précoces sont bien plus prédictifs) ;
- option « validation réelle » : A/B de 2-3 hooks avec 20-50 € de budget pub Meta (lecture du hook rate à 3 s).

Boucle publication/stats : via agrégateur au départ — Upload-Post (~1,3 $/utilisateur/mois) ou Zernio (3-6 $/compte) — puis APIs directes Meta et YouTube (gratuites, app review 1-2 mois) au-delà de ~500 utilisateurs. LinkedIn reste le goulot (stats des profils personnels non exposées).

Honnêteté produit : afficher la fiabilité, publier la précision mesurée, vendre « comprendre et améliorer » plutôt que « prédire exactement ». Le score du MVP est copiable ; le dataset prédiction↔réel ne l'est pas.

## 7. Parcours utilisateur

1. **Brief** : l'utilisateur saisit une idée brute, choisit ses plateformes, son audience cible et son objectif.
2. **Radar** : le moteur affiche les tendances du moment liées à l'idée : sujets chauds, formats qui performent, posts viraux comparables.
3. **Angles** : 3 à 5 angles éditoriaux scorés, justifiés par les signaux de tendance détectés.
4. **Scripts** : un script par plateforme — post LinkedIn (hook, corps, CTA), Reel 30-45 s (hook 3 s, séquences, incrustations), thread X, vidéo YouTube (titre, hook 30 s, chapitres).
5. **Score** : score 0-100 décomposé par dimension, suggestions de réécriture en un clic.
6. **Publier et mesurer** : export ou publication directe ; à J+2 et J+7 les stats réelles sont rapatriées, comparées à la prédiction, et affinent le modèle et le profil du créateur.

## 8. Architecture technique

| Composant | Rôle | Techno recommandée |
| --- | --- | --- |
| Front + API | App SaaS, éditeur de scripts, dashboard | Next.js (App Router), Tailwind, Vercel |
| Auth + données | Comptes, abonnements, posts, scores | Supabase (Postgres + Auth), Stripe |
| Index de tendances | Posts et tendances collectés, recherche sémantique | Postgres + pgvector (embeddings) |
| Ingestion | Collecte périodique des APIs et scrapers | Workers cron (Inngest ou Trigger.dev) + Apify |
| Génération | Angles et scripts par plateforme | API Claude (claude-sonnet-5-5), prompts par plateforme |
| Scoring MVP | Évaluation avant publication | LLM-judge calibré + heuristiques |
| Scoring V2 | Modèle prédictif entraîné | Service Python (FastAPI + XGBoost) |
| Mesure | Rapatriement des stats réelles | Upload-Post/Zernio puis APIs natives via OAuth |

## 9. Roadmap

| Phase | Période | Cap | Contenu |
| --- | --- | --- | --- |
| 1 · MVP | Mois 0-3 | générer + scorer v0 | génération multi-format, veille sur 2-3 sources fiables, score v0 (LLM calibré + heuristiques), bêta privée — **jalon : 20 créateurs actifs/sem.** |
| 2 · V1 | Mois 3-6 | publier + mesurer | OAuth, publication directe, rapatriement des stats, dashboard prédit vs réalisé, lancement payant — **jalon : précision du score validée** |
| 3 · V2 | Mois 6-12 | prédire + scaler | modèle entraîné sur les données accumulées, sources étendues, offre équipes/agences, API publique |

## 10. Modèle économique

Éviter le terrain sous 19 € (guerre des prix des schedulers) et au-dessus de 99 € en solo. L'IA incluse dès l'entrée (l'erreur inverse de Taplio est unanimement critiquée).

| Palier | Prix | Contenu |
| --- | --- | --- |
| Free | 0 € | 3 scripts scorés/mois, radar limité — une démo |
| Starter | 24 €/mois | radar complet, scripts 4 plateformes, score explicable, 1 compte connecté |
| Pro | 49 €/mois | 4 comptes connectés, boucle prédit vs réalisé, re-prédiction 1 h, tests pub |
| Équipe/Agence | 119 €/mois | 10 comptes, multi-marques, marque blanche, API |

Viabilité (données France 2025) : vivier adressable 400-800 k comptes (47 200 créateurs pros, 300-500 k semi-pros, TPE présentes sur les réseaux à 75 % mais actives à 35 % seulement). 83 % des créateurs français utilisent déjà l'IA générative. À 3-5 % de conversion freemium, 2 000 abonnés payants demandent 40-80 k inscrits gratuits (0,5-1,5 % du vivier) : atteignable en 12 mois. Marge brute > 70 % dès le Starter (coût variable ~2,5-7 €/abonné/mois).

## 11. Risques et conformité

1. **Dépendance aux plateformes** (matérialisé : Hypefury a abandonné X, LinkedIn a tué Kleo) → APIs officielles ou agrégateurs déclarés, jamais de cookies clients, sources diversifiées.
2. **Juridique UE/France** : scraping défendable sur la base de l'intérêt légitime (CNIL 19/06/2025) à condition d'analyser des **tendances agrégées de contenus, pas des personnes** (sanction Kaspr 240 k€ pour base de profils ; Meta v. Bright Data a validé la collecte logged-out publique en droit US). Mesures : agrégation/pseudonymisation, exclusion mineurs/données sensibles, AIPD, droit d'opposition, purge < 12 mois.
3. **Confiance dans le score** : fourchettes calibrées, précision publiée, abstention assumée — jamais de promesse de vues.
4. **Churn créateurs** (apps IA : ~30 % de rétention en moins) → rétention structurelle : historique prédit vs réalisé, mémoire de voix, données accumulées.
5. **Commoditisation** → le data moat prédiction↔réel et la distribution founder-led.

## 12. KPIs et boucle d'apprentissage

| KPI | Définition | Cible V1 |
| --- | --- | --- |
| Activation | % d'inscrits qui génèrent et scorent un post sous 7 jours | 40 % |
| North star | posts publiés par utilisateur actif et par semaine | 3 |
| Fiabilité du score | % de posts dont la perf. réelle tombe dans le tercile prédit | 55 % puis 70 % |
| Rétention | créateurs encore actifs à S12 | 35 % |
| Boucle de données | stats réelles rapatriées par mois | 10 000 |

## 13. Sources principales

- InspireLab : [site](https://www.getinspirelab.com/) · [pricing](https://app.getinspirelab.com/pricing)
- APIs : [YouTube quotas](https://developers.google.com/youtube/v3/determine_quota_cost) · [Instagram Hashtag Search](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search) · [LinkedIn CM API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-09) · [TikTok Research API](https://developers.tiktok.com/docs/en/research-api-faq) · [X API 2026](https://postproxy.dev/blog/x-api-pricing-2026/) · [Ayrshare](https://www.ayrshare.com/pricing/) · [Upload-Post](https://www.upload-post.com/pricing) · [Zernio](https://zernio.com/pricing)
- Prédiction : [vidIQ Scorecard](https://support.vidiq.com/en/articles/9696241-the-vidiq-scorecard) · [GNN AUC 0,66](https://kinetik.umm.ac.id/index.php/kinetik/article/view/2686) · [IC-Mamba](https://arxiv.org/abs/2502.04655) · [CReAM paires](https://arxiv.org/abs/2403.09702) · [HyperFusion SMP 2025](https://arxiv.org/abs/2507.00926) · [LLM-as-judge](https://arxiv.org/pdf/2306.05685)
- Juridique : [CNIL intérêt légitime](https://www.cnil.fr/fr/recommandations-developpement-ia-interet-legitime) · [Kaspr 240 k€](https://www.cnil.fr/en/data-scraping-kaspr-fined-eu240000) · [Meta v. Bright Data](https://www.quinnemanuel.com/the-firm/news-events/client-alert-meta-v-bright-data-significant-decision-for-web-scraping-industry/)
- Marché : [Effinity 2025](https://www.effinity.fr/blog/barometre-influence-2025-chiffres-cles-marketing-influence-france/) · [Digital Report FR 2025](https://www.blogdumoderateur.com/internet-reseaux-sociaux-france-chiffres-2025/) · [Adobe IA créateurs FR](https://news.adobe.com/fr/news/downloads/pdfs/2025/10/28/alerte-media-etude-adobe-83-des-createurs-francais-utilisent-l-ia-generative-et-y-voient-un-levier-de-croissance-pour-l-economie-de-la-creation.pdf) · [RevenueCat 2025](https://www.revenuecat.com/blog/company/the-state-of-subscription-apps-2025-launch)
