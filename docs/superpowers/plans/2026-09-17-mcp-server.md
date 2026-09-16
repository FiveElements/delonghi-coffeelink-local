# Serveur MCP de pilotage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exposer un sous-ensemble de contrôle du lan-server (statut, boissons, profils, grains, recettes, réglages) comme des outils MCP, servis sur `/mcp` en Streamable HTTP, protégés par des jetons nommés à portée (catégorie × nature) configurable depuis une page web.

**Architecture:** `/mcp` rejoint la liste des préfixes que `createServer` (server.mjs:6333) intercepte avant Next, au même niveau que `/api/*` et `/local_lan/*`. Le SDK `@modelcontextprotocol/sdk` gère le protocole (transport `StreamableHTTPServerTransport`) ; l'authentification par jeton et le filtrage de portée se font avant que la requête n'atteigne le transport. Les outils MCP appellent les mêmes fonctions internes que `handleApi` (pas d'aller-retour HTTP sur soi-même) — ce qui, après lecture du code, place le catalogue d'outils **dans `server.mjs` lui-même** plutôt que dans un fichier `src/lib` séparé : `handleApi`, la liste des machines, `startProgram`, `postLocalReg` etc. sont tous des closures sur l'état de module de `server.mjs` (comme `handleLan`/`handleMachines`/`sseSubscribe` déjà présents), pas des fonctions pures important-friendly. C'est un ajustement de lieu de code découvert pendant la planification — le comportement, lui, reste exactement celui validé dans la spec.

**Tech Stack:** Node 26, `node:sqlite`, `@modelcontextprotocol/sdk` (transport Streamable HTTP), Next 16 / React 19 / shadcn pour la page de gestion des jetons.

**Spec:** `docs/superpowers/specs/2026-09-17-mcp-server-design.md`

## Global Constraints

- Node ≥ 26, pnpm 11 (`packageManager` figé dans `package.json`) — toute nouvelle dépendance passe par `pnpm add`, jamais un édit manuel de `pnpm-lock.yaml`.
- ESLint 10 ne couvre que les `.mjs` ; tout nouveau `.mjs` doit passer `pnpm lint`. Les `.tsx` sont couverts par `node_modules/.bin/tsc --noEmit`.
- `for f in server.mjs src/lib/*.mjs; do node --check "$f"; done` doit rester vert — aucun nouveau fichier `.mjs` ne doit contenir d'erreur de syntaxe.
- Schéma SQLite : `STRICT` tables, migration additive et **chaînée** (`migrateSchema` enchaîne v1→v2→v3→v4, jamais un raccourci direct) — voir `src/lib/store.mjs:289-355` pour le patron exact à reproduire.
- Jamais de succès simulé : un outil MCP qui échoue à parler à la machine le dit (`isError: true`), avec le même message que l'API donnerait.
- `/api/mcp-tokens` n'est **jamais** exposé comme outil MCP.
- Pas de nouvelle dépendance avec script d'installation tiers sans passer par `pnpm-workspace.yaml` § `allowBuilds` (voir ce fichier) — à vérifier avant d'ajouter le SDK.

---

## File Structure

| Fichier | Rôle |
|---|---|
| `src/lib/store.mjs` | + table `mcp_tokens` (migration v3→v4), + fonctions `createMcpToken`, `listMcpTokens`, `findMcpTokenByHash`, `revokeMcpToken`, `touchMcpTokenUse` |
| `server.mjs` | + constante partagée `MCP_SCOPES` (catégories × natures), + section `handleMcpTokens` (`/api/mcp-tokens`), + section `handleMcp` (`/mcp`, transport SDK, auth, catalogue d'outils, filtrage de portée) |
| `src/app/mcp-tokens/page.tsx` (nouveau) | page de gestion des jetons (créer/lister/révoquer) |
| `scripts/verif-mcp.mjs` (nouveau) | dérive-catalogue + bout-en-bout (auth, portée, `start_beverage` contre `fausse-machine.mjs`) |
| `.github/workflows/ci.yml` | + étape `node scripts/verif-mcp.mjs` |

---

### Task 1: Dépendance MCP SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Installer la dépendance**

Run: `pnpm add @modelcontextprotocol/sdk`

- [ ] **Step 2: Vérifier qu'aucun script d'installation tiers n'est bloqué**

Run: `pnpm install`
Expected: pas de message `allowBuilds`/`ignoredBuiltDependencies` concernant `@modelcontextprotocol/sdk` (le SDK est du JS pur, sans binaire natif). Si un message apparaît, l'ajouter à `pnpm-workspace.yaml` sous `allowBuilds: false` (même choix conservateur que `@parcel/watcher`/`@swc/core`) et documenter pourquoi dans un commentaire, avant de continuer.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
Le SDK MCP entre au catalogue des dépendances

Prépare le serveur MCP de pilotage (voir docs/superpowers/specs/2026-09-17-mcp-server-design.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Schéma v4 — table `mcp_tokens` et fonctions de stockage

**Files:**
- Modify: `src/lib/store.mjs`
- Test: script `node -e` inline (pas de fichier dédié — voir Step 4)

**Interfaces:**
- Produces (utilisées par les tâches 3 et suivantes) :
  - `export function createMcpToken({ name, scopes })` → `{ id, name, token, scopes, createdAt }` — `token` est le secret en clair, **rendu une seule fois**, jamais restocké.
  - `export function listMcpTokens()` → `Array<{ id, name, scopes, createdAt, lastUsedAt, revokedAt }>` (jamais le hash ni le jeton).
  - `export function findMcpTokenByHash(hash)` → la ligne complète (`{ id, name, scopes, revokedAt, ... }`) ou `null`.
  - `export function touchMcpTokenUse(id)` → met à jour `last_used_at = Date.now()`.
  - `export function revokeMcpToken(id)` → met `revoked_at = Date.now()` ; renvoie `true`/`false` selon qu'une ligne existait.
  - `export const MCP_SCOPE_CATEGORIES` : `["statut", "journal", "boissons", "profils", "grains", "recettes", "reglages"]`.
  - `export const MCP_SCOPE_NATURES_PAR_CATEGORIE` : `{ statut: ["lecture"], journal: ["lecture","action"], boissons: ["lecture","action"], profils: ["lecture","action"], grains: ["lecture","action"], recettes: ["lecture","action"], reglages: ["lecture","action"] }` — c'est la **seule** définition de la matrice ; `server.mjs` et la page Next l'importent, aucune des deux ne la reconstruit.
  - `export function hasScope(tokenRow, categorie, nature)` → `boolean`, lit `tokenRow.scopes` (array de `"categorie:nature"`).

Table (à ajouter en constante `DDL_MCP_TOKENS`, sur le modèle de `DDL_BEAN_IMAGES` à `src/lib/store.mjs:156-165` — **purement additive**, machine-indépendante comme `settings`) :

```sql
CREATE TABLE mcp_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
) STRICT;
```

- [ ] **Step 1: Ajouter la constante DDL et l'inclure dans le schéma courant**

Dans `src/lib/store.mjs`, juste après `DDL_BEAN_IMAGES` (ligne 165) :

```js
const DDL_MCP_TOKENS = `
CREATE TABLE mcp_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
) STRICT;
`;
```

Modifier la ligne 58 : `const SCHEMA_VERSION = 3;` → `const SCHEMA_VERSION = 4;`

Modifier la ligne 168 : `const DDL = DDL_V2 + DDL_BEAN_IMAGES;` → `const DDL = DDL_V2 + DDL_BEAN_IMAGES + DDL_MCP_TOKENS;`

- [ ] **Step 2: Ajouter la migration v3→v4**

Après `migrateV2toV3` (ligne 355), sur le modèle exact de cette fonction (purement additive, un seul `CREATE TABLE`, un message `bootMessages`) :

```js
/**
 * v3 → v4 : la table des jetons d'API MCP.
 *
 * Purement additive, comme v2 → v3 : un `CREATE TABLE`, aucune table recréée, aucune ligne
 * recopiée. Une coupure laisse la base en v3, où elle fonctionne exactement comme avant.
 */
function migrateV3toV4() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(DDL_MCP_TOKENS);
    db.exec("PRAGMA user_version = 4");
    db.exec("COMMIT");
    bootMessages.push("schéma v3 → v4 : table des jetons d'API MCP ajoutée");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(`migration du schéma v3 → v4 impossible (${e.message}) — la base est restée en v3`, { cause: e });
  }
}
```

Modifier `migrateSchema` (ligne 289-296) :

```js
function migrateSchema(fromVersion) {
  let v = fromVersion;
  if (v === 1) { migrateV1toV2(); v = 2; }
  if (v === 2) { migrateV2toV3(); v = 3; }
  if (v === 3) { migrateV3toV4(); v = 4; }
  if (v !== SCHEMA_VERSION) {
    throw new Error(`schéma v${fromVersion} inconnu de cette version du serveur (attendu v1 à v${SCHEMA_VERSION})`);
  }
}
```

- [ ] **Step 3: Ajouter les requêtes préparées et les fonctions exportées**

Dans le bloc `const q = { ... }` (après la ligne 250, avant la fermeture) :

```js
  putMcpToken: db.prepare("INSERT INTO mcp_tokens(name, token_hash, scopes, created_at) VALUES(:name, :token_hash, :scopes, :created_at)"),
  listMcpTokens: db.prepare("SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM mcp_tokens ORDER BY created_at"),
  getMcpTokenByHash: db.prepare("SELECT * FROM mcp_tokens WHERE token_hash = ?"),
  touchMcpToken: db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?"),
  revokeMcpToken: db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),
```

À la fin du fichier (après `storageInfo`, en s'inspirant de la section « réglages globaux » lignes 420-434) :

```js
// ---------------------------------------------------------------- jetons MCP
import { randomBytes, createHash } from "node:crypto";

export const MCP_SCOPE_CATEGORIES = ["statut", "journal", "boissons", "profils", "grains", "recettes", "reglages"];
export const MCP_SCOPE_NATURES_PAR_CATEGORIE = {
  statut: ["lecture"],
  journal: ["lecture", "action"],
  boissons: ["lecture", "action"],
  profils: ["lecture", "action"],
  grains: ["lecture", "action"],
  recettes: ["lecture", "action"],
  reglages: ["lecture", "action"],
};

const hashToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");

/** `scopes` : tableau de "categorie:nature", ex. ["boissons:lecture"]. Rien par défaut. */
export function createMcpToken({ name, scopes = [] }) {
  const token = randomBytes(32).toString("base64url");
  const createdAt = Date.now();
  const info = q.putMcpToken.run({
    name: String(name),
    token_hash: hashToken(token),
    scopes: JSON.stringify(scopes),
    created_at: createdAt,
  });
  return { id: Number(info.lastInsertRowid), name: String(name), token, scopes, createdAt };
}

const rowToTokenSummary = (row) => ({
  id: row.id,
  name: row.name,
  scopes: JSON.parse(row.scopes),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

export function listMcpTokens() {
  return q.listMcpTokens.all().map(rowToTokenSummary);
}

/** Renvoie la ligne complète (avec `revokedAt`) ou `null` — jamais le hash au-delà de cette fonction. */
export function findMcpTokenByHash(rawToken) {
  const row = q.getMcpTokenByHash.get(hashToken(rawToken));
  return row ? rowToTokenSummary(row) : null;
}

export function touchMcpTokenUse(id) {
  q.touchMcpToken.run(Date.now(), id);
}

export function revokeMcpToken(id) {
  const info = q.revokeMcpToken.run(Date.now(), id);
  return info.changes > 0;
}

export function hasScope(tokenRow, categorie, nature) {
  return tokenRow.scopes.includes(`${categorie}:${nature}`);
}
```

- [ ] **Step 4: Vérifier la migration et les fonctions sur une base jetable**

Run:
```bash
cd /c/project/ai-project/delonghi-coffee-link/lan-server
rm -rf /tmp/verif-mcp-tokens-data
DATA_DIR=/tmp/verif-mcp-tokens-data node -e "
const s = await import('./src/lib/store.mjs');
const info = s.storageInfo();
if (info.schemaVersion !== 4) throw new Error('schema v4 attendu, obtenu v' + info.schemaVersion);
if (!s.bootMessages.some((x) => x.includes('v3 → v4'))) throw new Error('le pas v3 → v4 ne s est pas annonce');
const created = s.createMcpToken({ name: 'test-agent', scopes: ['boissons:lecture'] });
if (!created.token || created.token.length < 32) throw new Error('jeton trop court ou absent');
const found = s.findMcpTokenByHash(created.token);
if (!found || found.name !== 'test-agent') throw new Error('le jeton cree n a pas ete retrouve par son hash');
if (!s.hasScope(found, 'boissons', 'lecture')) throw new Error('portee boissons:lecture attendue');
if (s.hasScope(found, 'boissons', 'action')) throw new Error('portee boissons:action ne doit pas etre accordee');
s.touchMcpTokenUse(found.id);
const listed = s.listMcpTokens();
if (listed.length !== 1 || listed[0].lastUsedAt == null) throw new Error('last_used_at pas mis a jour');
if (!s.revokeMcpToken(found.id)) throw new Error('revocation a echoue');
const revoked = s.findMcpTokenByHash(created.token);
if (!revoked.revokedAt) throw new Error('revokedAt absent apres revocation');
console.log('OK: migration v4 et fonctions mcp_tokens');
"
rm -rf /tmp/verif-mcp-tokens-data
```
Expected: `OK: migration v4 et fonctions mcp_tokens` sans erreur.

- [ ] **Step 5: Lint et vérification syntaxique**

Run: `pnpm lint && node --check src/lib/store.mjs`
Expected: aucune erreur.

- [ ] **Step 6: Commit**

```bash
git add src/lib/store.mjs
git commit -m "$(cat <<'EOF'
Les jetons MCP prennent leur table, hachés dès la création

Schéma v4, purement additive comme v2→v3. Le jeton en clair n'est
jamais restocké — seul son sha256 l'est.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `/api/mcp-tokens` — gestion des jetons

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes : `createMcpToken`, `listMcpTokens`, `revokeMcpToken`, `MCP_SCOPE_CATEGORIES`, `MCP_SCOPE_NATURES_PAR_CATEGORIE` (Task 2).
- Produces : endpoints `GET /api/mcp-tokens`, `POST /api/mcp-tokens`, `DELETE /api/mcp-tokens/:id`, consommés par la Task 4.

- [ ] **Step 1: Importer les fonctions du store**

Dans `server.mjs`, repérer la ligne qui importe déjà `src/lib/store.mjs` (`import * as store from "./src/lib/store.mjs"` ou équivalent — vérifier le nom exact importé en tête de fichier) et ajouter les nouveaux noms à la même ligne d'import (ou, si le fichier importe le module entier sous un espace de noms, les utiliser via ce même espace de noms — ne pas dupliquer un second import du même fichier).

- [ ] **Step 2: Ajouter la route dans `handleApi`, avant la résolution de machine**

`/api/mcp-tokens` est **global**, comme `/api/machines` et `/api/apps` — donc à ajouter dans `handleApi` (server.mjs:4726+) **avant** l'appel à `pickMachine` (ligne 4816 environ, juste après le bloc `/api/apps` qui se termine avant cette résolution) :

```js
  if (url === "/api/mcp-tokens" && req.method === "GET") {
    return raw(res, JSON.stringify({ tokens: listMcpTokens(), categories: MCP_SCOPE_CATEGORIES, naturesParCategorie: MCP_SCOPE_NATURES_PAR_CATEGORIE }));
  }
  if (url === "/api/mcp-tokens" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const name = String(b.name ?? "").trim();
    if (!name) return raw(res, JSON.stringify({ error: "nom de jeton requis" }), 400);
    const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s) => typeof s === "string") : [];
    const valides = scopes.every((s) => {
      const [cat, nat] = s.split(":");
      return MCP_SCOPE_CATEGORIES.includes(cat) && (MCP_SCOPE_NATURES_PAR_CATEGORIE[cat] ?? []).includes(nat);
    });
    if (!valides) return raw(res, JSON.stringify({ error: "portee invalide : attendu categorie:nature parmi " + MCP_SCOPE_CATEGORIES.join(", ") }), 400);
    const created = createMcpToken({ name, scopes });
    L("sys", "jeton MCP", `créé « ${name} » (${scopes.length} portée(s))`);
    return raw(res, JSON.stringify(created), 201);
  }
  if (url.startsWith("/api/mcp-tokens/") && req.method === "DELETE") {
    const id = Number(url.slice("/api/mcp-tokens/".length));
    if (!Number.isInteger(id)) return raw(res, JSON.stringify({ error: "identifiant de jeton invalide" }), 400);
    const ok = revokeMcpToken(id);
    if (ok) L("sys", "jeton MCP", `révoqué #${id}`);
    return raw(res, JSON.stringify({ revoked: ok }), ok ? 200 : 404);
  }
```

- [ ] **Step 2: Vérifier la syntaxe**

Run: `node --check server.mjs`
Expected: aucune erreur.

- [ ] **Step 3: Test bout-en-bout sur un serveur de dev**

Run (dans un terminal, en arrière-plan) :
```bash
cd /c/project/ai-project/delonghi-coffee-link/lan-server
DATA_DIR=/tmp/verif-mcp-api-data SERVER_PORT=3128 node server.mjs &
sleep 2
curl -sS http://127.0.0.1:3128/api/mcp-tokens
curl -sS -X POST http://127.0.0.1:3128/api/mcp-tokens -H "Content-Type: application/json" -d '{"name":"agent-test","scopes":["statut:lecture"]}'
curl -sS http://127.0.0.1:3128/api/mcp-tokens
kill %1
rm -rf /tmp/verif-mcp-api-data
```
Expected : le premier `GET` renvoie `{"tokens":[],"categories":[...7 entrées...],...}` ; le `POST` renvoie `201` avec un `token` en clair et un `id` ; le second `GET` liste une entrée **sans** champ `token` ni `token_hash`.

- [ ] **Step 4: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
/api/mcp-tokens gère la création et la révocation des jetons

Global comme /api/machines : traité avant toute résolution de machine.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Page de gestion des jetons

**Files:**
- Create: `src/app/mcp-tokens/page.tsx`

**Interfaces:**
- Consumes : `GET/POST/DELETE /api/mcp-tokens` (Task 3), `useConfirm` (`src/app/confirm.tsx`), composants shadcn (`Button`, `Input`, `Checkbox`, `Table` sous `@/ui`).

- [ ] **Step 1: Lire le patron d'une page d'administration existante**

Lire `src/app/machines/page.tsx` en entier avant d'écrire celle-ci : c'est le patron le plus proche (liste + actions + `useConfirm` + `mfetch`/`fetch` direct puisque `/api/mcp-tokens` n'est pas rattaché à une machine, donc pas de paramètre `?machine=`).

- [ ] **Step 2: Écrire la page**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useConfirm } from "@/app/confirm";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Checkbox } from "@/ui/checkbox";

type TokenSummary = {
  id: number;
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type Reponse = {
  tokens: TokenSummary[];
  categories: string[];
  naturesParCategorie: Record<string, string[]>;
};

export default function McpTokensPage() {
  const [data, setData] = useState<Reponse | null>(null);
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const confirm = useConfirm();

  const reload = () => fetch("/api/mcp-tokens").then((r) => r.json()).then(setData);
  useEffect(() => { reload(); }, []);

  const toggle = (key: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const create = async () => {
    if (!name.trim()) return;
    const r = await fetch("/api/mcp-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), scopes: [...checked] }),
    }).then((x) => x.json());
    if (r.token) {
      setFreshToken(r.token);
      setName("");
      setChecked(new Set());
      reload();
    }
  };

  const revoke = async (t: TokenSummary) => {
    const ok = await confirm({
      titre: `Révoquer le jeton « ${t.name} » ?`,
      description: "Toute connexion MCP utilisant ce jeton sera immédiatement rejetée.",
      geste: false,
    });
    if (!ok) return;
    await fetch(`/api/mcp-tokens/${t.id}`, { method: "DELETE" });
    reload();
  };

  if (!data) return null;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-medium">Jetons d&apos;API MCP</h1>

      {freshToken && (
        <div className="border border-ambre rounded-touche p-4 space-y-2">
          <p>Jeton créé — copie-le maintenant, il ne sera plus jamais affiché :</p>
          <code className="block break-all bg-creux p-2 rounded-touche">{freshToken}</code>
          <Button variant="outline" onClick={() => setFreshToken(null)}>J&apos;ai copié le jeton</Button>
        </div>
      )}

      <div className="space-y-3">
        <Input placeholder="Nom du jeton" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          {data.categories.map((cat) =>
            (data.naturesParCategorie[cat] ?? []).map((nat) => {
              const key = `${cat}:${nat}`;
              return (
                <label key={key} className="flex items-center gap-2">
                  <Checkbox checked={checked.has(key)} onCheckedChange={() => toggle(key)} id={key} />
                  <span id={`${key}-label`}>{cat} — {nat}</span>
                </label>
              );
            }),
          )}
        </div>
        <Button onClick={create} disabled={!name.trim()}>Créer le jeton</Button>
      </div>

      <table className="w-full text-left">
        <thead><tr><th>Nom</th><th>Portées</th><th>Créé</th><th>Dernier usage</th><th /></tr></thead>
        <tbody>
          {data.tokens.map((t) => (
            <tr key={t.id} className={t.revokedAt ? "opacity-45" : ""}>
              <td>{t.name}</td>
              <td>{t.scopes.join(", ") || "(aucune)"}</td>
              <td>{new Date(t.createdAt).toLocaleString()}</td>
              <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "jamais"}</td>
              <td>{!t.revokedAt && <Button variant="destructive" onClick={() => revoke(t)}>Révoquer</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Vérifier les types et le build**

Run: `node_modules/.bin/tsc --noEmit && pnpm build`
Expected: aucune erreur. Si `useConfirm` a une signature différente de `{ titre, description, geste }` (vérifiée en lisant `src/app/confirm.tsx` au Step 1), ajuster l'appel pour correspondre exactement à sa signature réelle — ne pas inventer une API qui n'existe pas.

- [ ] **Step 4: Vérification manuelle dans un vrai navigateur**

```bash
DATA_DIR=/tmp/verif-mcp-ui-data node server.mjs --dev
```
Ouvrir `http://localhost:3000/mcp-tokens`, créer un jeton avec une portée cochée, vérifier qu'il apparaît affiché une fois puis disparaît du champ après clic sur « J'ai copié », vérifier que la révocation demande confirmation et grise la ligne. Arrêter le serveur, `rm -rf /tmp/verif-mcp-ui-data`.

- [ ] **Step 5: Commit**

```bash
git add src/app/mcp-tokens/page.tsx
git commit -m "$(cat <<'EOF'
La page /mcp-tokens crée et révoque les jetons d'API MCP

Chaque portée Catégorie/Nature est une case à part, rien coché par défaut.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Transport MCP et authentification sur `/mcp`

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes : `findMcpTokenByHash`, `touchMcpTokenUse` (Task 2).
- Produces : fonction `handleMcp(req, res)`, montée dans `createServer` ; un `McpServer` du SDK par requête authentifiée, sans catalogue d'outils pour l'instant (ajouté en Task 6).

- [ ] **Step 1: Ajouter l'import du SDK**

En tête de `server.mjs`, avec les autres imports :

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
```

- [ ] **Step 2: Écrire `handleMcp`**

Ajouter cette fonction près de `handleApi` (avant sa définition, par exemple) :

```js
/**
 * `/mcp` — Streamable HTTP (transport courant de la spec MCP, un seul point d'entrée pour
 * POST/GET/DELETE), monté au même niveau que `/api/*` dans `createServer` ci-dessous.
 *
 * L'authentification est vérifiée AVANT que quoi que ce soit n'atteigne le SDK : un jeton
 * absent, inconnu ou révoqué ne doit jamais faire fonctionner le protocole, même partiellement.
 */
async function handleMcp(req, res) {
  const auth = req.headers.authorization ?? "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return raw(res, JSON.stringify({ error: "jeton d'API manquant (en-tête Authorization: Bearer <jeton>)" }), 401);
  const tokenRow = findMcpTokenByHash(m[1]);
  if (!tokenRow || tokenRow.revokedAt) return raw(res, JSON.stringify({ error: "jeton d'API invalide ou révoqué" }), 401);
  touchMcpTokenUse(tokenRow.id);

  const server = new McpServer({ name: "delonghi-lan-server", version: "0.1.0" });
  registerMcpTools(server, tokenRow); // défini en Task 6

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);

  const body = req.method === "POST" ? JSON.parse((await readBody(req)).toString("utf8") || "{}") : undefined;
  await transport.handleRequest(req, res, body);
}
```

- [ ] **Step 3: Monter la route dans `createServer`**

Dans `server.mjs`, à la ligne 6352 (juste avant `if (u.startsWith("/api/"))`) :

```js
  if (u === "/mcp" || u.startsWith("/mcp?")) return handleMcp(req, res).catch((e) => raw(res, JSON.stringify({ error: e.message }), 500));
```

- [ ] **Step 4: Ajouter un `registerMcpTools` vide temporaire (complété en Task 6)**

```js
function registerMcpTools(_server, _tokenRow) {
  // Catalogue ajouté en Task 6 — aucun outil pour l'instant, juste de quoi valider le transport.
}
```

- [ ] **Step 5: Vérifier la syntaxe**

Run: `node --check server.mjs`
Expected: aucune erreur.

- [ ] **Step 6: Test manuel de l'authentification**

```bash
cd /c/project/ai-project/delonghi-coffee-link/lan-server
DATA_DIR=/tmp/verif-mcp-transport SERVER_PORT=3129 node server.mjs &
sleep 2
echo "--- sans jeton (attendu 401) ---"
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3129/mcp -H "Content-Type: application/json" -d '{}'
TOKEN=$(curl -sS -X POST http://127.0.0.1:3129/api/mcp-tokens -H "Content-Type: application/json" -d '{"name":"t","scopes":[]}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
echo "--- avec jeton valide (attendu 200 ou 4xx du protocole MCP, jamais 401) ---"
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3129/mcp -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
kill %1
rm -rf /tmp/verif-mcp-transport
```
Expected: premier appel `401` ; second appel **pas** `401` (le SDK répond selon le protocole, pas d'erreur d'authentification).

- [ ] **Step 7: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
/mcp répond en Streamable HTTP, jeton vérifié avant tout protocole

Aucun outil encore enregistré — le transport et l'authentification
d'abord, le catalogue ensuite.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Filtrage de portée du catalogue d'outils

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes : `hasScope` (Task 2), `tokenRow` (Task 5).
- Produces : `registerMcpTools(server, tokenRow)` complet, `defineMcpTool(server, tokenRow, { name, categorie, nature, description, inputSchema, annotations, run })` — le point d'enregistrement unique que les Tasks 7-10 utilisent pour CHAQUE outil (jamais un appel direct à `server.registerTool` en dehors de cette fonction, pour que le filtrage de portée ne puisse pas être oublié sur un outil futur).

- [ ] **Step 1: Écrire le point d'enregistrement unique**

Remplacer le `registerMcpTools` vide de la Task 5 par :

```js
/**
 * Point d'enregistrement UNIQUE d'un outil MCP. Un outil hors de la portée du jeton
 * n'apparaît PAS dans `tools/list` (le SDK ne l'enregistre pas du tout pour cette
 * connexion) — ce n'est pas un filtre d'affichage après coup, l'outil n'existe simplement
 * pas pour ce jeton.
 */
function defineMcpTool(server, tokenRow, { name, categorie, nature, description, inputSchema, annotations = {}, run }) {
  if (!hasScope(tokenRow, categorie, nature)) return;
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try {
      const result = await run(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  });
}

function registerMcpTools(server, tokenRow) {
  // Les Tasks 7 à 10 ajoutent leurs appels à defineMcpTool ici.
}
```

- [ ] **Step 2: Vérifier la syntaxe**

Run: `node --check server.mjs`
Expected: aucune erreur.

- [ ] **Step 3: Test du filtrage avec un outil factice**

Ajouter temporairement dans `registerMcpTools` :
```js
  defineMcpTool(server, tokenRow, { name: "ping_test", categorie: "statut", nature: "lecture", description: "test", inputSchema: {}, run: async () => ({ ok: true }) });
```
Puis :
```bash
cd /c/project/ai-project/delonghi-coffee-link/lan-server
DATA_DIR=/tmp/verif-mcp-scopes SERVER_PORT=3130 node server.mjs &
sleep 2
SANS_SCOPE=$(curl -sS -X POST http://127.0.0.1:3130/api/mcp-tokens -H "Content-Type: application/json" -d '{"name":"sans","scopes":[]}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
AVEC_SCOPE=$(curl -sS -X POST http://127.0.0.1:3130/api/mcp-tokens -H "Content-Type: application/json" -d '{"name":"avec","scopes":["statut:lecture"]}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
init() { curl -sS -X POST http://127.0.0.1:3130/mcp -H "Content-Type: application/json" -H "Authorization: Bearer $1" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'; }
echo "--- sans portée (ping_test absent attendu) ---"; init "$SANS_SCOPE"
echo "--- avec portée statut:lecture (ping_test présent attendu) ---"; init "$AVEC_SCOPE"
kill %1
rm -rf /tmp/verif-mcp-scopes
```
Expected: `ping_test` absent de la première réponse `tools/list`, présent dans la seconde.

Retirer l'outil factice une fois vérifié.

- [ ] **Step 4: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
Le catalogue d'outils MCP se filtre par la portée du jeton

defineMcpTool est le seul point d'enregistrement : un outil hors
portée n'existe simplement pas pour la connexion, pas juste masqué.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Outils de lecture — statut, machines, journal

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes : `defineMcpTool` (Task 6), la logique déjà présente dans `handleApi` aux branches `/api/status` (server.mjs:4820), `/api/system` (5299), `/api/stats` GET (6167), `/api/journal` GET (4743), et les fonctions `listMachines`/`machineById`/`defaultMachine` déjà utilisées par `pickMachine`.
- Produces : outils `get_status`, `list_machines`, `get_machine`, `get_system`, `get_stats`, `get_journal`.

- [ ] **Step 1: Lire les branches existantes avant de les réutiliser**

Lire `server.mjs:4820-4857` (`/api/status`), `5299-5359` (`/api/system`), `6167-6271` (`/api/stats` GET), `4743-4754` (`/api/journal` GET) en entier — ce sont les corps exacts à réutiliser, pas à réinventer. Chacune construit un objet JSON avant de le passer à `raw(res, JSON.stringify(...))` : c'est cet objet, pas la réponse HTTP, que l'outil MCP doit renvoyer.

- [ ] **Step 2: Extraire chaque branche en fonction nommée réutilisable**

Pour chacune des quatre branches lues au Step 1, si la construction de l'objet de réponse n'est pas déjà isolée dans une fonction nommée, l'extraire en une fonction prenant `m` (et pour `/api/journal`, `depuis`) et retournant l'objet — puis faire pointer la branche `handleApi` existante vers cette même fonction. Nommer ces fonctions `buildStatusPayload(m)`, `buildSystemPayload(m)`, `buildStatsPayload(m)`, `buildJournalPayload(depuis)` (adapter le nom si une fonction équivalente existe déjà sous un autre nom trouvé au Step 1 — ne pas créer de doublon).

- [ ] **Step 3: Enregistrer les outils**

Dans `registerMcpTools` :

```js
  defineMcpTool(server, tokenRow, {
    name: "get_status", categorie: "statut", nature: "lecture",
    description: "État courant de la machine (statut d'un coup d'œil).",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildStatusPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "list_machines", categorie: "statut", nature: "lecture",
    description: "Liste des machines connues du serveur, avec leur identifiant (mN) et leur adresse.",
    inputSchema: {},
    run: async () => ({ machines: listMachines().map(rowToMachine) }),
  });

  defineMcpTool(server, tokenRow, {
    name: "get_machine", categorie: "statut", nature: "lecture",
    description: "Fiche d'une machine précise (adresse, DSN, clé LAN présente ou non).",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return rowToMachine(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "get_system", categorie: "statut", nature: "lecture",
    description: "Propriétés système Ayla de la machine.",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildSystemPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "get_stats", categorie: "statut", nature: "lecture",
    description: "Compteurs et statistiques brutes de la machine (paramètres 0xA2 0x0F et propriétés nommées).",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildStatsPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "get_journal", categorie: "journal", nature: "lecture",
    description: "Fenêtre du journal (déjà survenu, jamais un flux) — utiliser `depuis` pour ne récupérer que la suite d'une lecture précédente.",
    inputSchema: { depuis: z.number().optional() },
    run: async ({ depuis } = {}) => buildJournalPayload(depuis ?? 0),
  });
```

Vérifier en tête de `server.mjs` que `zod` (`z`) est déjà importé (le SDK MCP en dépend pour les schémas d'outils) ; sinon ajouter `import { z } from "zod";` — `zod` arrive comme dépendance transitive du SDK, vérifier avec `pnpm why zod` qu'elle est bien disponible avant de l'importer directement, et si besoin l'ajouter explicitement aux dépendances (`pnpm add zod`) plutôt que de compter sur une transitive.

- [ ] **Step 4: Vérifier la syntaxe**

Run: `node --check server.mjs`
Expected: aucune erreur.

- [ ] **Step 5: Test manuel avec un client MCP minimal**

```bash
cd /c/project/ai-project/delonghi-coffee-link/lan-server
DATA_DIR=/tmp/verif-mcp-t7 SERVER_PORT=3131 node scripts/fausse-machine.mjs --serveur 127.0.0.1:3131 &
sleep 1
DATA_DIR=/tmp/verif-mcp-t7 SERVER_PORT=3131 PROXY_APPS=0 node server.mjs &
sleep 2
TOKEN=$(curl -sS -X POST http://127.0.0.1:3131/api/mcp-tokens -H "Content-Type: application/json" -d '{"name":"t7","scopes":["statut:lecture","journal:lecture"]}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
curl -sS -X POST http://127.0.0.1:3131/mcp -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status","arguments":{}}}'
kill %1 %2
rm -rf /tmp/verif-mcp-t7
```
Expected: une réponse JSON-RPC contenant le statut de la machine, pas une erreur.

- [ ] **Step 6: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
Statut, machines, système et journal deviennent des outils MCP

Réutilisent exactement les payloads déjà construits pour /api/status,
/api/system, /api/stats et /api/journal — pas une seconde source.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Outils de lecture — boissons, profils, grains, recettes, réglages

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes : `defineMcpTool` (Task 6), branches `handleApi` `/api/beverages` GET (5059), `/api/profiles` GET (5162), `/api/beanadapt` GET (5456), `/api/beanpresets` GET (5495), `/api/beansystem` GET (5367), `/api/recipes` GET (6271), `/api/settings` GET (5881). `bean_adapt_simulate`/`bean_adapt_creation_rule` sont **pures** (`SANS_MACHINE`, server.mjs:4014) : `computeBeanAdapt`/`composeGrainNeuf` de `src/lib/bean-adapt.mjs`, appelées directement, sans `pickMachine`.

- [ ] **Step 1: Lire les sept branches avant de les réutiliser**

Mêmes précautions que Task 7 Step 1, pour : `5059-5162`, `5162-5299`, `5456-5495`, `5495-5525`, `5367-5375`, `6271` (jusqu'à la branche suivante), `5881-5889`. Repérer si `bean_adapt_simulate`/`bean_adapt_creation_rule` appellent déjà `computeBeanAdapt`/`composeGrainNeuf` de `src/lib/bean-adapt.mjs` directement (probable, puisque `SANS_MACHINE`) — dans ce cas l'outil MCP appelle la même fonction de `src/lib/bean-adapt.mjs`, sans passer par `handleApi` du tout.

- [ ] **Step 2: Extraire chaque branche « machine » en fonction nommée**

Même patron que Task 7 Step 2 : `buildBeveragesPayload(m)`, `buildProfilesPayload(m)`, `buildBeanAdaptPayload(m)`, `buildBeanPresetsPayload(m)`, `buildBeanSystemPayload(m)`, `buildRecipesPayload(m)`, `buildSettingsPayload()` (settings est machine-indépendant comme `mcp_tokens`).

- [ ] **Step 3: Enregistrer les outils**

```js
  defineMcpTool(server, tokenRow, {
    name: "list_beverages", categorie: "boissons", nature: "lecture",
    description: "Catalogue des boissons du modèle de la machine.",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildBeveragesPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "get_beverage", categorie: "boissons", nature: "lecture",
    description: "Détail d'une boisson du catalogue par son identifiant.",
    inputSchema: { beverageId: z.number(), machine: z.string().optional() },
    run: async ({ beverageId, machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      const bev = m.catalog.byId(Number(beverageId));
      if (!bev) throw new Error(`boisson ${beverageId} inconnue sur ${m.catalog.model.type}`);
      return bev;
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "list_profiles", categorie: "profils", nature: "lecture",
    description: "Profils de la machine (noms, favoris).",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildProfilesPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "get_bean_adapt", categorie: "grains", nature: "lecture",
    description: "Lecture du Bean System (configurations de grains de la machine).",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildBeanAdaptPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "list_bean_presets", categorie: "grains", nature: "lecture",
    description: "Presets de grain mémorisés côté serveur, avec leurs visuels.",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildBeanPresetsPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "bean_adapt_simulate", categorie: "grains", nature: "lecture",
    description: "Simule la règle d'affinage (computeBeanAdapt) sans toucher la machine.",
    inputSchema: { question1: z.number(), question2: z.number(), flowTimeMs: z.number() },
    run: async (args) => computeBeanAdapt(args),
  });

  defineMcpTool(server, tokenRow, {
    name: "bean_adapt_creation_rule", categorie: "grains", nature: "lecture",
    description: "Règle de création d'un nouveau grain (composeGrainNeuf), table figée De'Longhi.",
    inputSchema: { blend: z.number(), roast: z.number() },
    run: async (args) => composeGrainNeuf(args),
  });

  defineMcpTool(server, tokenRow, {
    name: "list_recipes", categorie: "recettes", nature: "lecture",
    description: "Recettes locales enregistrées sur le serveur.",
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return buildRecipesPayload(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "get_settings", categorie: "reglages", nature: "lecture",
    description: "Réglages persistés du serveur (indépendants de la machine).",
    inputSchema: {},
    run: async () => buildSettingsPayload(),
  });
```

Vérifier que `computeBeanAdapt`/`composeGrainNeuf` sont bien déjà importés en tête de `server.mjs` depuis `src/lib/bean-adapt.mjs` (utilisés par les branches `/api/beanadapt/simulate` et `/api/beanadapt/creation` lues au Step 1) — sinon ajouter l'import.

- [ ] **Step 4: Vérifier la syntaxe**

Run: `node --check server.mjs`

- [ ] **Step 5: Test manuel**

Même patron que Task 7 Step 5, avec `"name":"list_beverages"` puis `"name":"bean_adapt_simulate","arguments":{"question1":1,"question2":1,"flowTimeMs":25000}`.
Expected: réponses JSON cohérentes, pas d'erreur.

- [ ] **Step 6: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
Boissons, profils, grains, recettes et réglages en lecture MCP

bean_adapt_simulate et bean_adapt_creation_rule restent purs — aucune
résolution de machine, comme leurs équivalents SANS_MACHINE de l'API.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Outil d'action — `start_beverage`

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes : `defineMcpTool` (Task 6), `startProgram` (server.mjs:1108), `postLocalReg` (server.mjs:1171), `tacheRendue` (server.mjs:1156), `bevRef` (server.mjs:886), `frameDispense`, `MODE`, `ACT`, `actionPreparer`, `rememberActiveProfile` (déjà importés/définis, utilisés par la branche `dispense` de `/api/command`).

- [ ] **Step 1: Lire la branche `dispense` en entier**

Lire `server.mjs:5015-5056` (la branche `dispense` de `/api/command`, plus la queue commune qui suit `frame = ...` jusqu'au `return raw(...)` final).

- [ ] **Step 2: Extraire la logique en fonction réutilisable**

Créer, près de `startProgram`, une fonction qui fait exactement ce que fait la branche `dispense` puis la queue commune, et faire pointer la branche `handleApi` existante vers cette même fonction :

```js
/**
 * Prépare et met en file une boisson — logique exacte de la branche `dispense` de
 * `/api/command`, extraite pour être appelée aussi bien par l'API que par l'outil MCP
 * `start_beverage`. Lance une VRAIE commande : jamais de simulation.
 */
async function executeDispense(m, { beverageId, profileId, recipeId, params }) {
  let bev, prof, resolvedParams;
  if (recipeId) {
    const r = m.store.listRecipes().find((x) => x.id === recipeId);
    if (!r) throw new Error("recette inconnue");
    ({ beverageId: bev, profileId: prof, params: resolvedParams } = r);
  } else {
    bev = Number(beverageId ?? 1);
    prof = Number(profileId ?? 1);
    resolvedParams = params ?? [];
  }
  m.activeProfile = Number(prof) || 1;
  m.activeProfileConfirmed = true;
  rememberActiveProfile(m);
  const act = actionPreparer(resolvedParams);
  const frame = frameDispense(bev, prof, MODE.START, act, resolvedParams);
  const label = `Préparer ${bevLabel(m, bev)}${act === ACT.PREPARE_INVERSION ? " (lait d'abord)" : ""}`;
  const r = bevRef(m, bev);
  const cleLibelle = { k: "dispense", p: { inversion: act === ACT.PREPARE_INVERSION ? 1 : 0, ...(r.p ?? {}) }, refs: r.refs };
  const ecamB64 = datapointValue(frame);
  const t = startProgram(m, ecamB64, label, 75000, "monitor", { rang: RANG.COMMANDE, cle: cleFusion(ecamB64), i18n: cleLibelle, meta: { dispense: true } });
  const reg = await postLocalReg(m);
  return { program: label, frameHex: frame.toString("hex").replace(/(..)/g, "$1 ").trim(), register: reg, ...tacheRendue(t) };
}
```

Puis, dans la branche `dispense` de `/api/command` (server.mjs:5015-5026), remplacer son corps par un appel à `executeDispense(m, { beverageId: b.beverageId, profileId: b.profileId, recipeId: b.recipeId, params: b.params })`, en conservant le comportement de renvoi d'erreur existant (`recette inconnue` → 404, cf. logique déjà présente) — adapter l'appelant pour distinguer ce cas s'il doit garder son code HTTP 404 spécifique (vérifier en lisant le code existant si un renvoi 404 différencié doit être préservé, et le faire en inspectant l'erreur levée plutôt qu'en dupliquant la logique).

- [ ] **Step 3: Enregistrer l'outil**

```js
  defineMcpTool(server, tokenRow, {
    name: "start_beverage", categorie: "boissons", nature: "action",
    description: "Lance une VRAIE préparation sur la machine physique. Action irréversible une fois envoyée.",
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: {
      machine: z.string().optional(),
      beverageId: z.number().optional(),
      profileId: z.number().optional(),
      recipeId: z.string().optional(),
      params: z.array(z.object({ id: z.number(), value: z.number() })).optional(),
    },
    run: async ({ machine, ...args } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return executeDispense(m, args);
    },
  });
```

- [ ] **Step 4: Vérifier la syntaxe**

Run: `node --check server.mjs`

- [ ] **Step 5: Test bout-en-bout contre la fausse machine**

```bash
cd /c/project/ai-project/delonghi-coffee-link/lan-server
DATA_DIR=/tmp/verif-mcp-t9 SERVER_PORT=3132 node scripts/fausse-machine.mjs --serveur 127.0.0.1:3132 &
sleep 1
DATA_DIR=/tmp/verif-mcp-t9 SERVER_PORT=3132 node server.mjs &
sleep 2
TOKEN=$(curl -sS -X POST http://127.0.0.1:3132/api/mcp-tokens -H "Content-Type: application/json" -d '{"name":"t9","scopes":["boissons:action"]}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
curl -sS -X POST http://127.0.0.1:3132/mcp -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_beverage","arguments":{"beverageId":1,"profileId":1}}}'
sleep 1
curl -sS "http://127.0.0.1:3132/api/journal" | grep -o "Préparer[^\"]*" | head -1
kill %1 %2
rm -rf /tmp/verif-mcp-t9
```
Expected: la réponse `tools/call` contient `program` et `frameHex` ; le journal montre une ligne « Préparer … » — preuve qu'une vraie commande est partie, pas une réponse simulée.

- [ ] **Step 6: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
start_beverage déclenche une vraie préparation via le même chemin que /api/command

executeDispense factorise la branche `dispense` : l'API et l'outil MCP
mettent en file exactement la même trame.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Outils d'action restants — journal, profils, grains, recettes, réglages

**Files:**
- Modify: `server.mjs`

**Interfaces:**
- Consumes : `defineMcpTool` (Task 6), `viderJournal` (déjà utilisée par `/api/journal` DELETE, server.mjs:4754), branches `/api/profiles/name`, `/api/profiles/favorites`, `/api/beanpresets` POST/DELETE (5525, 5569), `/api/beanadapt/scan`, `/api/beanadapt/save`, `/api/recipes` POST (écriture, dans la branche `/api/recipes` à 6271), `/api/settings` POST (5889).

- [ ] **Step 1: Lire chaque branche avant de la réutiliser**

Mêmes précautions que les tâches précédentes : lire en entier `/api/profiles/name`, `/api/profiles/favorites` (chercher leurs branches par `grep -n '"/api/profiles/name"\|"/api/profiles/favorites"' server.mjs`, non listées dans le relevé initial car elles utilisent probablement `url.startsWith`), `5525-5569` (`/api/beanpresets` POST), `5569-...` (DELETE), les branches `beanadapt/scan` et `beanadapt/save` (`grep -n 'beanadapt/scan\|beanadapt/save' server.mjs`), la branche d'écriture de `/api/recipes`, et `5889-...` (`/api/settings` POST).

- [ ] **Step 2: Enregistrer les outils, un par un, chacun avec `annotations: { destructiveHint: true }`**

Pour chaque branche lue, extraire sa logique dans une fonction nommée (même patron que les tâches précédentes : `renameProfile(m, profileId, name)`, `setFavoriteProfile(m, profileId, favorite)`, `createBeanPreset(m, data)`, `updateBeanPreset(m, id, data)`, `deleteBeanPreset(m, id)`, `beanAdaptScan(m, args)`, `beanAdaptSave(m, args)`, `writeRecipe(m, data)`, `writeSettings(data)`, `clearJournal(source)`), faire pointer la branche HTTP existante vers cette fonction, puis enregistrer :

```js
  defineMcpTool(server, tokenRow, {
    name: "clear_journal", categorie: "journal", nature: "action",
    description: "Vide le journal (machine ou apps). Irréversible.",
    annotations: { destructiveHint: true },
    inputSchema: { source: z.enum(["machine", "apps"]) },
    run: async ({ source }) => ({ source, efface: clearJournal(source) }),
  });

  defineMcpTool(server, tokenRow, {
    name: "rename_profile", categorie: "profils", nature: "action",
    description: "Renomme un profil de la machine. Écriture persistante.",
    annotations: { destructiveHint: true },
    inputSchema: { profileId: z.number(), name: z.string(), machine: z.string().optional() },
    run: async ({ profileId, name, machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return renameProfile(m, profileId, name);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "set_favorite_profile", categorie: "profils", nature: "action",
    description: "Marque ou démarque un profil comme favori.",
    annotations: { destructiveHint: true },
    inputSchema: { profileId: z.number(), favorite: z.boolean(), machine: z.string().optional() },
    run: async ({ profileId, favorite, machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return setFavoriteProfile(m, profileId, favorite);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "create_bean_preset", categorie: "grains", nature: "action",
    description: "Crée un preset de grain côté serveur.",
    annotations: { destructiveHint: true },
    inputSchema: { name: z.string(), grinder: z.number(), temperature: z.number(), aroma: z.number(), roast: z.number().optional(), machine: z.string().optional() },
    run: async ({ machine, ...data } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return createBeanPreset(m, data);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "update_bean_preset", categorie: "grains", nature: "action",
    description: "Met à jour un preset de grain existant.",
    annotations: { destructiveHint: true },
    inputSchema: { id: z.string(), name: z.string().optional(), grinder: z.number().optional(), temperature: z.number().optional(), aroma: z.number().optional(), roast: z.number().optional(), machine: z.string().optional() },
    run: async ({ machine, id, ...data } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return updateBeanPreset(m, id, data);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "delete_bean_preset", categorie: "grains", nature: "action",
    description: "Supprime un preset de grain. Irréversible.",
    annotations: { destructiveHint: true },
    inputSchema: { id: z.string(), machine: z.string().optional() },
    run: async ({ machine, id } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return deleteBeanPreset(m, id);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "bean_adapt_scan", categorie: "grains", nature: "action",
    description: "Lance un balayage Bean Adapt sur la machine physique.",
    annotations: { destructiveHint: true },
    inputSchema: { machine: z.string().optional() },
    run: async ({ machine } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return beanAdaptScan(m);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "bean_adapt_save", categorie: "grains", nature: "action",
    description: "Sauvegarde un réglage Bean Adapt calculé.",
    annotations: { destructiveHint: true },
    inputSchema: { machine: z.string().optional(), index: z.number(), grinder: z.number(), temperature: z.number(), aroma: z.number() },
    run: async ({ machine, ...args } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return beanAdaptSave(m, args);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "write_recipe", categorie: "recettes", nature: "action",
    description: "Crée ou met à jour une recette locale.",
    annotations: { destructiveHint: true },
    inputSchema: { id: z.string().optional(), name: z.string(), beverageId: z.number(), profileId: z.number(), params: z.array(z.object({ id: z.number(), value: z.number() })), machine: z.string().optional() },
    run: async ({ machine, ...data } = {}) => {
      const { m, error } = pickMachine({ url: `/x${machine ? `?machine=${machine}` : ""}` });
      if (!m) throw new Error(error);
      return writeRecipe(m, data);
    },
  });

  defineMcpTool(server, tokenRow, {
    name: "write_settings", categorie: "reglages", nature: "action",
    description: "Écrit un réglage global du serveur (indépendant de la machine).",
    annotations: { destructiveHint: true },
    inputSchema: { key: z.string(), value: z.unknown() },
    run: async ({ key, value }) => writeSettings({ key, value }),
  });
```

- [ ] **Step 3: Vérifier la syntaxe**

Run: `node --check server.mjs`

- [ ] **Step 4: Test manuel d'au moins deux outils d'action**

Même patron de test que Task 9 Step 5, pour `clear_journal` (`{"source":"machine"}`) et `write_settings` (`{"key":"test-mcp","value":42}`), puis vérifier avec `curl http://.../api/settings` que la valeur écrite est bien lue par l'API existante (même stockage, pas une copie).

- [ ] **Step 5: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
Les dernières actions persistantes rejoignent le catalogue MCP

Journal, profils, grains, recettes, réglages : chaque outil réutilise
la fonction déjà extraite pour son endpoint /api/* équivalent.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `scripts/verif-mcp.mjs` — dérive du catalogue

**Files:**
- Create: `scripts/verif-mcp.mjs`

**Interfaces:**
- Consumes : la liste des routes `NEEDS_MACHINE`/`SANS_MACHINE` et les chemins `/api/*` gérés par `handleApi` (server.mjs), la liste des noms d'outils MCP enregistrés dans `registerMcpTools`.

- [ ] **Step 1: Écrire la vérification de non-dérive**

```js
/**
 * Vérifie que le catalogue d'outils MCP ne dérive pas de la surface /api/* réelle : chaque
 * outil déclaré dans server.mjs doit correspondre à un endpoint qui existe encore. Ne prouve
 * pas que l'implémentation est correcte (Task 12 s'en charge bout-en-bout) — seulement qu'un
 * outil ne pointe pas vers un endpoint renommé ou supprimé sans que quelqu'un s'en aperçoive.
 */
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

const OUTILS_ATTENDUS = [
  "get_status", "list_machines", "get_machine", "get_system", "get_stats", "get_journal",
  "list_beverages", "get_beverage", "start_beverage",
  "list_profiles", "rename_profile", "set_favorite_profile",
  "get_bean_adapt", "list_bean_presets", "bean_adapt_simulate", "bean_adapt_creation_rule",
  "create_bean_preset", "update_bean_preset", "delete_bean_preset", "bean_adapt_scan", "bean_adapt_save",
  "list_recipes", "write_recipe",
  "get_settings", "write_settings",
  "clear_journal",
];

for (const nom of OUTILS_ATTENDUS) {
  if (!source.includes(`name: "${nom}"`)) {
    throw new Error(`outil MCP attendu absent de server.mjs : ${nom}`);
  }
}

// Aucun outil ne doit exposer les endpoints explicitement exclus par la conception.
const EXCLUS = ["lankey", "ota", "cloudsession", "/api/apps", "beans/visual/import", "/api/register", "monitormode"];
for (const motif of EXCLUS) {
  if (source.includes(`categorie: "${motif}"`)) {
    throw new Error(`un outil MCP semble exposer un endpoint exclu par conception : ${motif}`);
  }
}

console.log(`OK: ${OUTILS_ATTENDUS.length} outils MCP attendus présents dans server.mjs, aucun endpoint exclu détecté`);
```

- [ ] **Step 2: Exécuter**

Run: `node scripts/verif-mcp.mjs`
Expected: `OK: 26 outils MCP attendus présents dans server.mjs, aucun endpoint exclu détecté`.

- [ ] **Step 3: Commit**

```bash
git add scripts/verif-mcp.mjs
git commit -m "$(cat <<'EOF'
verif-mcp.mjs attrape un outil MCP qui dériverait de la surface /api/*

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `scripts/verif-mcp.mjs` — bout-en-bout (auth, portée, action réelle)

**Files:**
- Modify: `scripts/verif-mcp.mjs`

**Interfaces:**
- Consumes : `server.mjs` démarré sur un port de test, `scripts/fausse-machine.mjs`, l'API `/api/mcp-tokens`, `/mcp`.

- [ ] **Step 1: Ajouter la partie bout-en-bout, à la suite de la vérification de dérive**

```js
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3199;
const DIR = mkdtempSync(join(tmpdir(), "verif-mcp-"));

function attendre(url, tentatives = 30) {
  return new Promise((resolve, reject) => {
    const essai = (n) => {
      fetch(url).then(() => resolve()).catch(() => {
        if (n <= 0) return reject(new Error(`rien ne répond sur ${url}`));
        setTimeout(() => essai(n - 1), 300);
      });
    };
    essai(tentatives);
  });
}

async function appelMcp(token, methode, params) {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: methode, params: params ?? {} }),
  });
  return r;
}

const fausse = spawn(process.execPath, ["scripts/fausse-machine.mjs", "--serveur", `127.0.0.1:${PORT}`], { stdio: "ignore" });
const srv = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, DATA_DIR: DIR, SERVER_PORT: String(PORT) },
  stdio: "ignore",
});

try {
  await attendre(`http://127.0.0.1:${PORT}/api/status`);

  // 1. Sans jeton → 401, jamais un protocole qui répond quand même.
  const sansJeton = await appelMcp(null, "tools/list");
  if (sansJeton.status !== 401) throw new Error(`attendu 401 sans jeton, obtenu ${sansJeton.status}`);

  // 2. Jeton avec une seule portée → un seul outil dans tools/list.
  const creeLimite = await fetch(`http://127.0.0.1:${PORT}/api/mcp-tokens`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "limite", scopes: ["statut:lecture"] }),
  }).then((r) => r.json());
  const listeLimitee = await appelMcp(creeLimite.token, "tools/list").then((r) => r.json());
  const nomsLimites = listeLimitee.result.tools.map((t) => t.name);
  if (!nomsLimites.includes("get_status")) throw new Error("get_status devrait être visible avec statut:lecture");
  if (nomsLimites.includes("start_beverage")) throw new Error("start_beverage ne devrait PAS être visible sans boissons:action");

  // 3. Un appel hors portée est refusé même en devinant le nom de l'outil.
  const horsPortee = await appelMcp(creeLimite.token, "tools/call", { name: "start_beverage", arguments: {} }).then((r) => r.json());
  if (!horsPortee.error && !horsPortee.result?.isError) throw new Error("un appel hors portée aurait dû être refusé");

  // 4. Jeton révoqué → 401.
  await fetch(`http://127.0.0.1:${PORT}/api/mcp-tokens/${creeLimite.id}`, { method: "DELETE" });
  const apresRevocation = await appelMcp(creeLimite.token, "tools/list");
  if (apresRevocation.status !== 401) throw new Error(`attendu 401 après révocation, obtenu ${apresRevocation.status}`);

  // 5. start_beverage avec la bonne portée déclenche une VRAIE commande, visible dans le journal.
  const creeAction = await fetch(`http://127.0.0.1:${PORT}/api/mcp-tokens`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "action", scopes: ["boissons:action"] }),
  }).then((r) => r.json());
  const avant = await fetch(`http://127.0.0.1:${PORT}/api/journal`).then((r) => r.json());
  await appelMcp(creeAction.token, "tools/call", { name: "start_beverage", arguments: { beverageId: 1, profileId: 1 } });
  await new Promise((r) => setTimeout(r, 500));
  const apres = await fetch(`http://127.0.0.1:${PORT}/api/journal`).then((r) => r.json());
  if (apres.lignes.length <= avant.lignes.length) throw new Error("start_beverage n'a laissé aucune trace dans le journal");

  console.log("OK: authentification, portée par jeton et start_beverage bout-en-bout");
} finally {
  srv.kill();
  fausse.kill();
  rmSync(DIR, { recursive: true, force: true });
}
```

- [ ] **Step 2: Exécuter**

Run: `node scripts/verif-mcp.mjs`
Expected: `OK: 26 outils MCP attendus présents dans server.mjs, aucun endpoint exclu détecté` suivi de `OK: authentification, portée par jeton et start_beverage bout-en-bout`.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: aucune erreur.

- [ ] **Step 4: Commit**

```bash
git add scripts/verif-mcp.mjs
git commit -m "$(cat <<'EOF'
verif-mcp.mjs prouve l'authentification et la portée bout-en-bout

Jusqu'à une vraie commande start_beverage contre fausse-machine.mjs,
vérifiée dans le journal — jamais une réponse simulée qui passerait.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Intégration CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Ajouter l'étape**

Repérer dans `.github/workflows/ci.yml` où les autres `node scripts/verif-*.mjs` sont invoqués (job `verify`, après `verif-args.mjs`), et ajouter à la suite :

```yaml
      - name: Vérifier le serveur MCP (catalogue, authentification, portée)
        run: node scripts/verif-mcp.mjs
```

- [ ] **Step 2: Vérifier localement que l'étape est cohérente avec l'ordre des autres**

Run: `grep -n "verif-" .github/workflows/ci.yml`
Expected: `verif-mcp.mjs` apparaît dans la liste, après les autres scripts `verif-*` et avant l'étape de build Docker.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
La CI fait tourner verif-mcp.mjs comme les autres vérifications pures

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Couverture de la spec** : transport Streamable HTTP (Task 5), auth par jeton haché (Task 2/5), portée catégorie/nature avec filtrage à `tools/list` ET à l'appel (Task 6), 26 outils couvrant les 7 catégories avec `destructiveHint` sur les actions (Tasks 7-10), page de gestion (Task 4), exclusion explicite des endpoints sensibles (Task 11 le vérifie), tests façon `verif-*.mjs` (Tasks 11-12), CI (Task 13).
- **Écart assumé par rapport à la spec** : le catalogue d'outils vit dans `server.mjs`, pas dans un `src/lib/mcp-tools.mjs` séparé — noté explicitement dans l'en-tête « Architecture » de ce plan, avec la raison (closures sur l'état de module que `src/lib` ne peut pas voir).
- **Cohérence des types** : `pickMachine` est appelé partout avec `{ url: "/x" + (machine ? "?machine=" + machine : "") }`, cohérent avec sa signature réelle (`pickMachine(req)` lit `req.url`). `defineMcpTool` a la même forme dans toutes les tâches qui l'utilisent.
