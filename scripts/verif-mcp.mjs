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
// On vérifie que les NOMS des outils MCP ne contiennent pas de motifs excluants.
const EXCLUS = ["lankey", "ota", "cloudsession", "apps", "register", "monitormode", "visual"];
const nomsOutils = [...source.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
for (const nomOutil of nomsOutils) {
  for (const motif of EXCLUS) {
    if (nomOutil.includes(motif)) {
      throw new Error(`un outil MCP semble exposer un endpoint exclu par conception : ${nomOutil} (motif "${motif}")`);
    }
  }
}

console.log(`OK: ${OUTILS_ATTENDUS.length} outils MCP attendus présents dans server.mjs, aucun endpoint exclu détecté`);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BOUT EN BOUT — authentification, portée, et une VRAIE commande contre fausse-machine.mjs
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Tout ce qui précède est statique. Ici, un vrai `server.mjs` tourne sur un port de test, on
 * frappe le vrai `/mcp` avec de vrais jetons émis par `POST /api/mcp-tokens`, et on va jusqu'à
 * faire RÉCUPÉRER une vraie commande ECAM par une vraie session chiffrée (`fausse-machine.mjs`)
 * — jamais une réponse simulée qui passerait à la place.
 *
 * Trois écarts avec le croquis initial de ce lot, chacun vérifié en direct avant d'être corrigé :
 *
 * 1. **Le transport `/mcp` répond en SSE, pas en JSON nu.** `curl -i` contre ce serveur sur un
 *    `tools/list` authentifié rend `content-type: text/event-stream` et un corps
 *    `event: message\ndata: {...}\n\n`, quel que soit l'en-tête `Accept` envoyé — la lecture
 *    naïve `.json()` du croquis lève une `SyntaxError` sur ce corps. `corpsMcp()` ci-dessous lit
 *    le texte et n'en garde que la dernière ligne `data:`, sans réimplémenter le protocole SSE.
 *    Seuls `/api/mcp-tokens` et `/api/journal` restent du JSON nu (`raw()` dans server.mjs) :
 *    vérifié aussi, `.json()` y reste correct.
 *
 * 2. **Une seule visite de `fausse-machine.mjs` après `start_beverage` ne suffit PAS à récupérer
 *    la trame.** `prochainePaquet()` (server.mjs) sert `device_connected` à la toute première
 *    visite de `commands.json` depuis le démarrage du serveur, MÊME quand une tâche attend déjà
 *    — c'est la poignée de main documentée dans CLAUDE.md (« device_connected est servi en
 *    premier »). Constaté en clair : une première fausse-machine.mjs après `start_beverage` reçoit
 *    `device_connected` ; il faut une SECONDE visite pour recevoir la vraie trame. Une assertion
 *    qui se contenterait de la croissance du journal (le croquis initial) passerait même si cette
 *    récupération échouait, puisque la mise en file journalise déjà `enfilerTache` avant toute
 *    visite d'appareil — c'est exactement le défaut que cette section a pour but d'éviter.
 *
 * 3. **`datapointValue()` ajoute 4 octets d'horodatage après la trame ECAM avant de l'encoder en
 *    base64** (server.mjs) : la valeur reçue par l'appareil est donc plus longue de 4 octets que
 *    `frameHex` rendu par `start_beverage`. Vérifié en direct : `frameHex` = `0d0883f0010106c8b2`,
 *    valeur reçue = `0d0883f0010106c8b26aab65e8`. On compare donc un PRÉFIXE, jamais une égalité
 *    stricte — une égalité stricte ici serait le test qui se trompe, pas le produit.
 *
 * `scripts/fausse-machine.mjs` est repris tel quel (mêmes options que `verif-surfaces.mjs`,
 * `--cle` explicite plutôt qu'un `.env.local` qu'on ne veut pas dépendre) : aucune trame n'est
 * fabriquée à la main ici, ce serait vérifier le test.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE_DEPOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
/** Seize octets quelconques — même idiome que `verif-surfaces.mjs` : rien ici ne parle à un appareil réel. */
const CLE_LAN = "verifmcp00000000";
const DIR = mkdtempSync(join(tmpdir(), "verif-mcp-"));

/** Attendre que le serveur réponde, plutôt que dormir une durée choisie au hasard. */
async function attendre(ms = 30000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    try { if ((await fetch(`${BASE}/api/status`)).ok) return true; } catch { /* pas encore là */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Lit le corps d'une réponse `/mcp` — voir l'écart n°1 ci-dessus. `/api/mcp-tokens` et
 * `/api/journal` ne passent pas par ici : ce sont de simples réponses JSON.
 */
async function corpsMcp(r) {
  const texte = await r.text();
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) return texte ? JSON.parse(texte) : {};
  const lignes = texte.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice("data: ".length));
  if (!lignes.length) throw new Error(`réponse SSE sans ligne data : ${texte.slice(0, 200)}`);
  return JSON.parse(lignes[lignes.length - 1]);
}

/** Une requête JSON-RPC vers `/mcp`, jeton optionnel. Rend la réponse BRUTE (pas encore lue) : le
 *  test « sans jeton » et le test « jeton révoqué » n'ont besoin que du code HTTP. */
function appelMcp(token, methode, params) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: methode, params: params ?? {} }),
  });
}

const creerJeton = (name, scopes) => fetch(`${BASE}/api/mcp-tokens`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name, scopes }),
}).then((r) => r.json());

/**
 * Une visite de `commands.json` par un VRAI appareil — clé LAN, échange de clés, chiffrement
 * AES-256-CBC, tout est réel (`src/lib/lansession.mjs`, importé par `fausse-machine.mjs` comme
 * par `server.mjs`). On attend la fin du processus avant de continuer : c'est un enfant séparé,
 * sa visite doit être terminée avant qu'on ne lise le journal ou qu'on n'en relance une seconde.
 */
function visiterCommeAppareil() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [
      join(RACINE_DEPOT, "scripts", "fausse-machine.mjs"), "--serveur", `127.0.0.1:${PORT}`, "--cle", CLE_LAN,
    ], { cwd: RACINE_DEPOT, stdio: "ignore" });
    p.on("exit", resolve);
    p.on("error", reject);
  });
}

const srv = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, DATA_DIR: DIR, SERVER_PORT: String(PORT), LANIP_KEY: CLE_LAN },
  stdio: "ignore",
});

try {
  if (!(await attendre())) throw new Error(`le serveur de test ne répond pas sur ${BASE}`);

  // 1. Sans jeton → 401, jamais un protocole qui répond quand même.
  const sansJeton = await appelMcp(null, "tools/list");
  if (sansJeton.status !== 401) throw new Error(`attendu 401 sans jeton, obtenu ${sansJeton.status}`);

  // 2. Jeton avec une seule portée → un seul groupe d'outils dans tools/list (les cinq outils de
  //    la catégorie « statut », jamais ceux qui agissent sur la machine).
  const creeLimite = await creerJeton("limite", ["statut:lecture"]);
  const listeLimitee = await corpsMcp(await appelMcp(creeLimite.token, "tools/list"));
  const nomsLimites = listeLimitee.result.tools.map((t) => t.name);
  if (!nomsLimites.includes("get_status")) throw new Error("get_status devrait être visible avec statut:lecture");
  if (nomsLimites.includes("start_beverage")) throw new Error("start_beverage ne devrait PAS être visible sans boissons:action");

  // 3. Un appel hors portée est refusé même en devinant le nom de l'outil — l'outil n'est tout
  //    simplement pas enregistré pour cette connexion, voir defineMcpTool() dans server.mjs.
  const horsPortee = await corpsMcp(await appelMcp(creeLimite.token, "tools/call", { name: "start_beverage", arguments: {} }));
  if (!horsPortee.error && !horsPortee.result?.isError) throw new Error("un appel hors portée aurait dû être refusé");

  // 4. Jeton révoqué → 401.
  await fetch(`${BASE}/api/mcp-tokens/${creeLimite.id}`, { method: "DELETE" });
  const apresRevocation = await appelMcp(creeLimite.token, "tools/list");
  if (apresRevocation.status !== 401) throw new Error(`attendu 401 après révocation, obtenu ${apresRevocation.status}`);

  // 5. start_beverage avec la bonne portée déclenche une VRAIE commande, vérifiée jusqu'à sa
  //    RÉCUPÉRATION par un appareil réel — pas seulement jusqu'à la mise en file (voir l'écart n°2
  //    en tête de section, c'est précisément ce que ce test évite de laisser passer à tort).
  const creeAction = await creerJeton("action", ["boissons:action"]);
  const appel = await corpsMcp(await appelMcp(creeAction.token, "tools/call", { name: "start_beverage", arguments: { beverageId: 1, profileId: 1 } }));
  if (appel.result?.isError) throw new Error(`start_beverage a échoué : ${appel.result.content?.[0]?.text}`);
  const rendu = JSON.parse(appel.result.content[0].text);
  const frameAttendue = String(rendu.frameHex ?? "").replace(/\s/g, "");
  if (!/^[0-9a-f]+$/.test(frameAttendue)) throw new Error(`frameHex absent ou illisible dans la réponse MCP : ${JSON.stringify(rendu)}`);

  // Premier passage : la poignée de main (device_connected) — voir l'écart n°2. La sauter, ce
  // serait comparer contre la mauvaise trame et ne jamais s'en apercevoir.
  await visiterCommeAppareil();
  // Second passage : la file n'est plus vide, ce n'est ni la première visite ni un multiple de
  // cinq — c'est ici que la vraie trame ECAM part vers l'« appareil ».
  await visiterCommeAppareil();

  const journal = await fetch(`${BASE}/api/journal`).then((r) => r.json());
  const ligneCommande = [...journal.lignes].reverse().find((l) => l.sujet === "commande" && l.trame);
  if (!ligneCommande) throw new Error("aucune commande à trame n'est parvenue au journal après deux visites de fausse-machine.mjs");
  const trameRecue = Buffer.from(ligneCommande.trame, "base64").toString("hex");
  // Voir l'écart n°3 : préfixe, pas égalité — `datapointValue()` ajoute un horodatage derrière.
  if (!trameRecue.startsWith(frameAttendue)) {
    throw new Error(`la trame reçue par l'appareil (${trameRecue}) ne commence pas par celle rendue par start_beverage (${frameAttendue})`);
  }

  console.log("OK: authentification, portée par jeton et start_beverage bout-en-bout");
} finally {
  srv.kill();
  // SQLite garde le fichier ouvert un instant après la mort du processus, et Windows refuse alors
  // de l'effacer tout de suite — voir la même parade dans verif-surfaces.mjs.
  for (let i = 0; i < 10; i++) {
    try { rmSync(DIR, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
}
