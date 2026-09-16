# Serveur MCP pour le pilotage du lan-server De'Longhi

Date : 2026-09-17
Statut : validé en brainstorming, prêt pour plan d'implémentation

## Contexte et objectif

Le lan-server expose déjà une API de contrôle HTTP (`/api/*`, ~35 endpoints dans
`handleApi`, `server.mjs`) utilisée par l'UI Next. L'objectif est d'exposer un
sous-ensemble de cette API comme des **outils MCP** (Model Context Protocol),
pour qu'un agent (Claude ou autre client MCP) puisse consulter l'état de la
cafetière et déclencher des actions physiques/persistantes directement, sans
passer par l'UI web.

Usage voulu : pilotage complet (lecture + actions), pas un simple monitoring
en lecture seule.

## Architecture

Le MCP est **intégré à `server.mjs`**, pas un service ou dépôt séparé.
`server.mjs` intercepte déjà plusieurs préfixes en HTTP brut avant de
retomber sur Next (`/local_lan/*`, `/ota_status.json`, `/api/*`) ; `/mcp`
rejoint cette liste.

Transport : SDK MCP officiel (`@modelcontextprotocol/sdk`), **Streamable
HTTP** — le transport courant de la spec MCP (remplace l'ancien couple
SSE+POST à deux endpoints des premières versions du protocole). Un seul point
d'entrée `/mcp` gère `POST` (requêtes/notifications), `GET` (flux SSE de
retour) et `DELETE` (fermeture de session), conformément à la version la plus
récente de la spec.

Les outils MCP appellent **directement les fonctions de `src/lib/*.mjs`**
utilisées par `handleApi` — pas d'aller-retour HTTP vers `localhost:PORT/api/*`
depuis le même process. `server.mjs` reste le point d'entrée unique ; le
module MCP est un nouveau consommateur interne de la même couche métier.

Nouveau fichier : `src/lib/mcp-tools.mjs` — définit le catalogue d'outils
(nom, schéma d'entrée, catégorie, nature, fonction d'exécution). Isomorphe
autant que possible avec les autres modules de `src/lib`, mais peut utiliser
`Buffer`/état serveur puisqu'il ne tourne jamais côté navigateur (contrairement
à `ecam-args.mjs`).

## Catalogue d'outils

| Catégorie | Outils (lecture) | Outils (action, `destructiveHint`) |
|---|---|---|
| Statut/monitoring | `get_status`, `list_machines`, `get_machine`, `get_model`, `get_system`, `get_stats` | — |
| Journal | `get_journal` | `clear_journal` |
| Boissons | `list_beverages`, `get_beverage` | `start_beverage` |
| Profils | `list_profiles` | `rename_profile`, `set_favorite_profile` |
| Grains/Bean Adapt | `list_bean_presets`, `get_bean_adapt`, `bean_adapt_simulate`, `bean_adapt_creation_rule` | `create_bean_preset`, `update_bean_preset`, `delete_bean_preset`, `bean_adapt_scan`, `bean_adapt_save` |
| Recettes | `list_recipes` | `write_recipe` |
| Réglages | `get_settings` | `write_settings` |

`bean_adapt_simulate` et `bean_adapt_creation_rule` sont des calculs purs
(`SANS_MACHINE` dans `server.mjs`) : classés lecture bien que dans la
catégorie « action » ci-dessus dans `handleApi`.

**Explicitement exclu du MCP** (secrets et impersonation d'appareil) :
`/api/lankey`, `/api/ota`, `/api/cloudsession`, `/api/apps`
(multiplexeur), `/api/beans/visual/import`, `/api/register`,
`/api/machines` (admin création/suppression de machine), `/api/monitormode`.
`/api/mcp-tokens` lui-même (gestion des jetons, § plus bas) n'est **jamais**
exposé comme outil MCP — un jeton ne peut pas s'en servir pour créer ou
révoquer d'autres jetons, seule la page web authentifiée le peut.

Chaque outil ciblant une machine prend un paramètre `machine` optionnel
(id `mN`) — même sémantique de repli que `mfetch` (`src/app/machine.ts`) :
absent → machine par défaut du serveur ; id inconnu → erreur explicite, jamais
un mauvais choix silencieux. Pas d'équivalent `localStorage` : le MCP n'a pas
d'état « machine courante », le choix est explicite à chaque appel.

## Confirmation des actions physiques/persistantes

Pas de dialogue UI possible côté MCP. Chaque outil d'action porte l'annotation
MCP standard `destructiveHint: true` (et `idempotentHint: false` quand
pertinent) ; c'est au client MCP (Claude Desktop, etc.) de décider s'il
demande confirmation à l'utilisateur avant d'exécuter l'outil — pas de garde
supplémentaire côté serveur au-delà du contrôle de portée par jeton
(voir plus bas).

## Authentification et portée par jeton

Nouvelle table SQLite (migration schéma v3 → v4), machine-indépendante comme
`settings` :

```
mcp_tokens (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,   -- sha256 du jeton, jamais le jeton en clair
  scopes      TEXT NOT NULL,   -- JSON: liste de "categorie:nature", ex. ["boissons:lecture","boissons:action"]
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at  TEXT
)
```

- Génération : une page Next (shadcn, cohérente avec le reste de l'UI) où on
  saisit un **nom** et on coche les couples Catégorie/Nature à autoriser
  (voir matrice ci-dessus). **Rien de coché par défaut** — portée strictement
  opt-in. Le jeton (32 octets aléatoires, base64url) est affiché **une seule
  fois** à la création ; seul son hash sha256 est stocké.
- La page ne fait pas de mutation directe en base : comme le reste du projet,
  ses actions passent par de nouveaux endpoints `/api/mcp-tokens`
  (`GET` liste, `POST` création, `DELETE /api/mcp-tokens/:id` révocation) gérés
  par `handleApi` dans `server.mjs` — les routes sous `src/app/api/**/route.ts`
  sont mortes à l'exécution (cf. § *Shadowed code* de `CLAUDE.md`), donc toute
  logique doit vivre côté `.mjs`.
- Révocation protégée par le hook `useConfirm` partagé (`src/app/confirm.tsx`),
  comme toute action destructive de l'UI.
- `/mcp` exige `Authorization: Bearer <jeton>` : hash comparé à `token_hash`,
  rejet 401 si absent/invalide/révoqué, avant que la requête n'atteigne le
  transport MCP. `last_used_at` mis à jour à chaque requête authentifiée.
- Le catalogue d'outils renvoyé par `tools/list` est **filtré par les scopes du
  jeton** (pas seulement masqué côté client) ; un appel `tools/call` sur un
  outil hors scope est refusé côté serveur avec une erreur explicite, même si
  le nom de l'outil est deviné.

## Gestion des erreurs

Un échec d'outil renvoie une erreur MCP (`isError: true`) portant le même
message que l'API donnerait (`unknownMachine`, échec de mise en file de la
commande, etc.). Jamais de succès simulé : un outil qui échoue à parler à la
machine le dit, dans l'esprit du reste du projet (« Anything physical or
persistent is confirmed before it is sent, and a failure is reported as a
failure »).

## Tests

Pas de framework de test dans ce dépôt — même logique que les scripts
`verif-*.mjs` existants. Nouveau `scripts/verif-mcp.mjs` :

1. Vérifie que le catalogue d'outils de `mcp-tools.mjs` ne dérive pas de la
   table de routes de `handleApi` (même principe que `verif-args.mjs` pour la
   table de trames : un outil qui pointe vers un endpoint renommé ou supprimé
   doit faire échouer le script, pas juste 404 silencieusement en prod).
2. Démarre `server.mjs` sur un port de test avec une base SQLite jetable
   (comme `verif-surfaces.mjs`), génère un jeton via l'API de test, puis pilote
   un vrai client MCP (`@modelcontextprotocol/sdk/client`) contre `/mcp` :
   - `tools/list` sans jeton → rejeté (401) avant même d'atteindre le protocole
     MCP ;
   - `tools/list` avec jeton limité à `statut:lecture` → seuls ces outils
     apparaissent ;
   - un appel hors scope est refusé ;
   - un jeton révoqué est rejeté ;
   - `start_beverage` contre `scripts/fausse-machine.mjs` (déjà utilisé par
     `verif-lansession.mjs`/le rig de bouclage) déclenche bien une vraie
     commande mise en file, vérifiable dans le journal.

## Hors périmètre (YAGNI)

- Pas de restriction par machine dans les scopes du jeton — un jeton autorisé
  sur `boissons:action` peut agir sur n'importe quelle machine listée par
  `list_machines`. Si un besoin réel de cloisonnement par machine apparaît,
  ce sera une évolution du schéma `scopes`, pas une anticipation maintenant.
- Pas de rotation automatique ni d'expiration temporelle des jetons — la
  révocation manuelle suffit pour l'usage visé.
