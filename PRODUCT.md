# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Aujourd'hui, le fondateur lui-même : un créateur francophone qui publie sur LinkedIn, Instagram Reels, X et YouTube, et veut savoir avant de publier si un contenu a des chances de performer. Demain, des abonnés payants (SaaS) du même profil : créateurs, solopreneurs, indépendants et TPE qui doivent publier régulièrement sans en faire leur métier. Leur job : partir d'une idée brute et repartir avec un script prêt à publier, adapté à chaque plateforme, en sachant pourquoi il devrait marcher.

## Product Purpose

Transformer une idée en scripts natifs par plateforme, guidés par les tendances réelles du moment, et notés avant publication par un score de potentiel explicable. Après publication, l'utilisateur saisit ses statistiques réelles et l'outil compare prédiction et résultat. Succès : l'utilisateur publie plus souvent, comprend ce qui fait performer ses contenus, et voit la fiabilité du score progresser.

## Positioning

La boucle complète que les concurrents découpent en silos : radar de tendances → angles justifiés par ces tendances → scripts natifs pour 4 plateformes → score explicable avant publication → comparaison avec la performance réelle (calibration affichée). Le score est un potentiel relatif (bande « top 25 % »), jamais une promesse de vues, et l'outil publie sa propre précision.

## Operating Context

Session typique : saisir une idée et une niche, parcourir les tendances détectées, choisir un angle parmi 4-5, attendre 1 à 3 minutes la génération (deux étapes : écriture puis évaluation), lire le score et les suggestions, réécrire en un clic, copier le script. Plus tard (J+2/J+7) : saisir les vues réelles et la médiane habituelle dans l'historique. Usage au bureau en journée comme le soir ; le thème suit le réglage clair/sombre de l'appareil.

## Capabilities and Constraints

- Plateformes : LinkedIn (post), Instagram Reels (script 30-45 s), X (thread), YouTube (titre, hook, chapitres).
- Radar : Google Trends, actualité (GDELT), YouTube, Reddit, Hacker News ; certaines sources peuvent être indisponibles, l'interface doit le tolérer.
- Score : facteurs du juge IA (hook, structure, adéquation tendance, émotion, CTA) + conformité au format (heuristiques), bande de potentiel, confiance, suggestions.
- Générations longues (1-3 min) : états d'attente soignés obligatoires.
- Technique : interface statique en HTML/CSS/JS vanilla sans étape de build (servie telle quelle par Vercel depuis `public/`), API sous `/api/*`. Toute dépendance front doit venir d'un CDN autorisé, sans build.
- Mono-utilisateur aujourd'hui (pas de comptes, pas de paiement) ; le nom du produit est provisoire.

## Brand Commitments

- Nom propre au générateur, distinct de l'agence du fondateur ; nom provisoire, choisi pendant la refonte et facilement remplaçable.
- Langue : français, tutoiement.
- Le score n'est jamais présenté comme une promesse de vues.

## Evidence on Hand

Aucun témoignage, client, chiffre d'usage ni logo réel. Ne rien inventer de commercial (prix, clients, benchmarks). Les données affichées dans l'interface viennent de l'API ; les captures de démonstration utilisent des données marquées comme exemple.

## Product Principles

1. L'essentiel d'abord : un verdict lisible en 3 secondes, le détail à la demande.
2. Toujours expliquer pourquoi : chaque score s'appuie sur des facteurs et des tendances visibles.
3. Honnêteté du score : potentiel relatif, confiance affichée, calibration publique.
4. Le contenu est la star : le script prêt à publier doit être le plus lisible de l'écran.
5. L'attente fait partie du produit : une génération de 2 minutes doit rester rassurante et vivante.

## Accessibility & Inclusion

WCAG 2.2 AA visé : contrastes, navigation clavier complète, `prefers-reduced-motion` respecté pour toutes les animations.
