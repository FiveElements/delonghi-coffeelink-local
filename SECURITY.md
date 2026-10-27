# Politique de sécurité

## Versions suivies

Seule la **dernière release** (et l'image `ghcr.io/fiveelements/delonghi-coffeelink-local:latest`)
reçoit des correctifs. Le projet est jeune et n'entretient pas de branches de maintenance.

## Signaler une vulnérabilité

**N'ouvrez pas d'issue publique.** Utilisez le signalement privé de GitHub :
[Security → Report a vulnerability](https://github.com/FiveElements/delonghi-coffeelink-local/security/advisories/new).

Indiquez la version (ou le commit), le mode de déploiement (Docker, archive, `pnpm dev`), les étapes
pour reproduire et l'impact que vous constatez. Un accusé de réception est envoyé sous 7 jours ;
un correctif ou une position argumentée suit dès que possible.

## Ce qui est dans le périmètre, et ce qui ne l'est pas

Ce serveur est conçu pour un **réseau local de confiance** — voir le README et `CLAUDE.md`,
§ *MCP server*. En particulier :

- `/api/*` n'est **pas authentifié**, par conception : quiconque atteint le serveur pilote la
  machine. Le signaler n'est pas une vulnérabilité ; un moyen de contourner une protection qui
  *existe* (jetons MCP et leur portée, refus d'action, filtrage d'une entrée) en est une.
- Sont dans le périmètre : exécution de code, lecture ou fuite de la clé LAN / de la base
  `data/lan-server.db`, injection dans les trames ECAM envoyées à l'appareil, XSS dans les
  interfaces, contournement de la portée d'un jeton MCP, dépendance vulnérable réellement atteinte.
- Hors périmètre : le cloud De'Longhi / Ayla et le firmware de la machine, qui ne nous appartiennent
  pas.

## Ce que la CI vérifie déjà

CodeQL, OpenSSF Scorecard, Dependabot (alertes et mises à jour : npm, actions, image Docker), actions
et image de base épinglées par empreinte.
