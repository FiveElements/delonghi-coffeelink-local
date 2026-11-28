/**
 * Stockage persistant du serveur LAN — **SQLite** via `node:sqlite`, un seul fichier
 * `data/lan-server.db`. Remplace les trois fichiers JSON (`machine-beverages.json`,
 * `recipes.json`, `lan-key.json`), migrés automatiquement au premier démarrage.
 *
 * Pourquoi : le cache machine était réécrit **en entier** à chaque propriété reçue — 80 ko de
 * JSON sérialisés puis `rename`, une soixantaine de fois pendant un import, pour ne modifier
 * qu'une ligne. Ici chaque propriété est un `UPSERT` d'une ligne, dans sa propre transaction.
 * Le coût d'une écriture ne dépend plus de la taille du cache, et une coupure au milieu d'un
 * import ne peut plus laisser qu'une transaction inachevée — jamais un cache vide.
 *
 * Choix de robustesse, délibérés :
 * - `journal_mode = WAL` : les lectures ne bloquent pas l'écriture, et une coupure brutale se
 *   rejoue au prochain démarrage au lieu de corrompre le fichier.
 * - `synchronous = FULL` : chaque transaction est réellement sur le disque avant de rendre la
 *   main. Le volume est minuscule (quelques dizaines d'écritures par import), le coût est donc
 *   invisible, et on ne perd rien sur une coupure de courant — la machine, elle, ne rejouera
 *   pas ses propriétés.
 * - tables `STRICT` : une valeur du mauvais type est refusée à l'écriture au lieu d'être
 *   découverte à la lecture, six mois plus tard, dans une page qui affiche « NaN ».
 *
 * ## Plusieurs machines (schéma v2)
 *
 * Toutes les tables de données portent une colonne `machine` et une clé primaire composite. Une
 * machine est identifiée par un **identifiant que nous frappons nous-mêmes** (`m1`, `m2`…), et
 * non par son DSN : le DSN est découvert *après* la saisie de l'adresse, il ne peut donc pas
 * servir de clé à la création. Il reste rangé comme une donnée de la machine (`meta.dsn`).
 *
 * Les réglages qui ne concernent aucune machine en particulier vivent dans `settings`, une table
 * à part — plutôt qu'une machine sentinelle dans `meta`, qui aurait fait mentir la clé étrangère.
 *
 * `ON DELETE CASCADE` sur chaque table : supprimer une machine emporte ses données en une seule
 * instruction, sans liste de tables à tenir à jour ailleurs. C'est aussi ce qui rend impossible
 * l'oubli d'une table lors d'un ajout futur.
 *
 * ⚠️ **Ce fichier contient du matériel secret** : les clés LAN (table `meta`, clé `lanKey`, une
 * par machine), les numéros de série et les noms de profils saisis sur les machines. `data/` est
 * gitignoré et doit être traité comme tel — ne jamais joindre `lan-server.db` à un rapport de bug
 * sans l'avoir purgé.
 */
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementResultingChanges } from "node:sqlite";
import type { BeanSystem, SommesControle } from "./profiles.ts";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Où vivent les données. Deux réglages, dans cet ordre :
 *
 * - `DATA_DIR` — répertoire de tout l'état persistant (défaut : `./data`). C'est aussi là que la
 *   migration va chercher les anciens fichiers JSON.
 * - `DATABASE_FILE` — chemin complet du fichier de base, si on veut le sortir de `DATA_DIR`
 *   (défaut : `<DATA_DIR>/lan-server.db`).
 *
 * Indispensable en conteneur : l'image est en lecture seule, les données dans un volume monté.
 * Voir DOCKER.md.
 */
const DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(process.cwd(), "data");
const DBFILE = process.env.DATABASE_FILE ? resolve(process.env.DATABASE_FILE) : join(DIR, "lan-server.db");
const SCHEMA_VERSION = 4;

/**
 * Identifiant de la première machine. Il est **figé** : c'est celui que la migration attribue à
 * toutes les données existantes, et celui auquel les variables d'environnement historiques
 * (`MACHINE_IP`, `LANIP_KEY`, `MACHINE_DSN`…) continuent de s'appliquer. Une installation
 * mono-machine ne voit donc aucune différence.
 */
export const DEFAULT_MACHINE = "m1";

/**
 * Schéma. Les colonnes `at` sont des millisecondes unix ; `data` porte le JSON de ce qui n'est pas
 * indexé. On ne duplique pas `at`/`kind` dans le JSON des propriétés : ils sont reconstitués à la
 * lecture, ce qui évite deux sources de vérité pour la même valeur.
 */
const DDL_V2 = `
CREATE TABLE machines (
  id        TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  data      TEXT NOT NULL
) STRICT;

CREATE TABLE props (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  kind    TEXT,
  data    TEXT NOT NULL,
  PRIMARY KEY (machine, name)
) STRICT;

CREATE TABLE bean_systems (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (machine, idx)
) STRICT;

CREATE TABLE stats (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  id      INTEGER NOT NULL,
  value   INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
) STRICT;

CREATE TABLE recipes (
  machine   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  data      TEXT NOT NULL,
  PRIMARY KEY (machine, id)
) STRICT;

CREATE TABLE meta (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (machine, key)
) STRICT;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    INTEGER NOT NULL
) STRICT;
`;

/**
 * Schéma v3 : l'image d'une configuration de grains mémorisée.
 *
 * **Une table, et pas un champ de plus dans `meta.beanPresets`.** Le tableau des configurations
 * est relu et **réécrit en entier** à chaque enregistrement (`putBeanPreset`) : y ranger des
 * images en base64 rejouerait, en plus petit, le défaut qui a fait naître ce fichier — réécrire
 * tout un cache pour ne modifier qu'une ligne. Ici l'image est une ligne, servie par sa propre
 * URL, donc cachée par le navigateur et jamais retransmise avec la liste.
 *
 * `bytes` est un vrai BLOB : `STRICT` accepte ce type, et garder les octets tels quels évite
 * les 33 % de la base64 et une conversion à chaque lecture.
 *
 * ⚠️ **`id` porte DEUX espaces de noms, et le préfixe est ce qui les sépare.**
 *
 * - `b1`, `b2`… — une configuration mémorisée par le serveur, dont c'est l'identifiant ;
 * - `s1`…`s6` — un emplacement de la MACHINE, dont c'est l'index préfixé.
 *
 * Cette table n'en sait rien et n'a pas à en savoir : elle range des octets sous une clé. C'est
 * `server.ts` qui frappe les deux formes (`putBeanPreset`, `ID_VISUEL_EMPLACEMENT`), et c'est le
 * préfixe qui garantit qu'un `b3` et un `s3` ne se marchent pas dessus. Le second espace a été
 * ouvert pour donner une photo aux six emplacements sans imposer une version de schéma — donc une
 * migration — pour une seule colonne. La torréfaction, elle, ne pèse rien et reste dans `meta`.
 *
 * Déclarée à part de `DDL_V2` pour que chaque migration ne joue QUE son propre pas : une base v1
 * passe en v2 avec les sept tables d'origine, puis en v3 avec celle-ci. Les concaténer en un seul
 * bloc ferait créer cette table par la migration v1 → v2, et le pas suivant échouerait sur une
 * table déjà présente.
 */
const DDL_BEAN_IMAGES = `
CREATE TABLE bean_images (
  machine TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  id      TEXT NOT NULL,
  mime    TEXT NOT NULL,
  bytes   BLOB NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
) STRICT;
`;

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

/** Le schéma courant, en entier — ce que reçoit une base neuve. */
const DDL = DDL_V2 + DDL_BEAN_IMAGES + DDL_MCP_TOKENS;

// Les deux répertoires : celui des données (migration, anciens JSON) et celui de la base, qui peut
// être ailleurs si `DATABASE_FILE` la déplace.
mkdirSync(DIR, { recursive: true });
mkdirSync(dirname(DBFILE), { recursive: true });
const db = new DatabaseSync(DBFILE);

/**
 * **Une requête préparée dont on DÉCLARE la forme des lignes.** `node:sqlite` rend des
 * `Record<string, SQLOutputValue>` : il ne peut pas savoir ce que dit le schéma. Ce module, lui, le
 * sait — c'est lui qui l'écrit, en tables `STRICT` qui refusent un mauvais type à l'écriture. Le
 * cast vit donc ici, une seule fois, au lieu d'un `as` à chaque lecture de colonne.
 *
 * `L` doit refléter la liste de colonnes du `SELECT` : c'est la seule chose que ce cast ne
 * vérifie pas, et la raison pour laquelle chaque requête nomme ses colonnes juste à côté.
 */
interface Requete<L> {
  get(...anonymes: SQLInputValue[]): L | undefined;
  get(nommes: Record<string, SQLInputValue>, ...anonymes: SQLInputValue[]): L | undefined;
  all(...anonymes: SQLInputValue[]): L[];
  all(nommes: Record<string, SQLInputValue>, ...anonymes: SQLInputValue[]): L[];
  run(...anonymes: SQLInputValue[]): StatementResultingChanges;
  run(nommes: Record<string, SQLInputValue>, ...anonymes: SQLInputValue[]): StatementResultingChanges;
}
const prep = <L = never>(sql: string) => db.prepare(sql) as unknown as Requete<L>;

/**
 * Une requête qui rend **toujours exactement une ligne** — un agrégat (`count(*)`) ou un `PRAGMA`.
 * Son `get` ne peut donc pas rendre `undefined`, et le dire ici évite un test impossible à
 * chaque appel (même cast, même justification que `prep`).
 */
interface RequeteUne<L> { get(...anonymes: SQLInputValue[]): L }
const prepUne = <L>(sql: string) => db.prepare(sql) as unknown as RequeteUne<L>;

/** Le message d'une erreur levée — SQLite lève des `Error`, mais `catch` reçoit un `unknown`. */
const messageErreur = (e: unknown): string => (e instanceof Error ? e.message : String(e));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = FULL");
// Hors transaction, donc effectif : c'est ce pragma qui fait marcher les CASCADE ci-dessus.
db.exec("PRAGMA foreign_keys = ON");

/** Messages produits par la migration, pour que `server.ts` les journalise à sa façon. */
export const bootMessages: string[] = [];

const version = (): number => prepUne<{ user_version: number }>("PRAGMA user_version").get().user_version;

// L'ordre compte : les tables d'abord, sinon les `prepare` ci-dessous échouent ; les migrations
// ensuite, puisqu'elles s'appuient sur ces mêmes requêtes préparées.
const from = version();
const fresh = from === 0;
if (fresh) {
  db.exec("BEGIN");
  db.exec(DDL);
  db.exec(`INSERT INTO machines(id, createdAt, data) VALUES('${DEFAULT_MACHINE}', ${Date.now()}, '{"label":null}')`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec("COMMIT");
} else if (from < SCHEMA_VERSION) {
  migrateSchema(from);
} else if (from > SCHEMA_VERSION) {
  // Une base écrite par une version plus récente du serveur. On refuse tout de suite : continuer
  // reviendrait à échouer plus loin sur une colonne inconnue, au milieu d'une écriture.
  throw new Error(`${DBFILE} est en schéma v${from}, ce serveur ne connaît que v${SCHEMA_VERSION} — utiliser une version plus récente, ou restaurer une sauvegarde`);
}

/** Fermeture propre : le WAL est intégré au fichier principal, qui reste lisible tel quel. */
process.on("exit", () => { try { db.close(); } catch {} });

// ---------------------------------------------------------------- lignes et requêtes préparées
interface LigneMachine { id: string; createdAt: number; data: string }
interface LigneProp { machine: string; name: string; at: number; kind: string | null; data: string }
interface LigneBean { machine: string; idx: number; at: number; data: string }
interface LigneStat { machine: string; id: number; value: number; at: number }
interface LigneRecette { machine: string; id: string; updatedAt: number; data: string }
interface LigneValeur { value: string; at: number }
interface LigneJeton {
  id: number;
  name: string;
  token_hash?: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
type Compte = { n: number };

const q = {
  listMachines: prep<LigneMachine>("SELECT * FROM machines ORDER BY createdAt, id"),
  getMachine: prep<LigneMachine>("SELECT * FROM machines WHERE id = ?"),
  putMachine: prep("INSERT INTO machines(id, createdAt, data) VALUES(:id, :createdAt, :data) ON CONFLICT(id) DO UPDATE SET data = :data"),
  delMachine: prep("DELETE FROM machines WHERE id = ?"),

  putProp: prep("INSERT INTO props(machine, name, at, kind, data) VALUES(:machine, :name, :at, :kind, :data) ON CONFLICT(machine, name) DO UPDATE SET at = :at, kind = :kind, data = :data"),
  getProp: prep<LigneProp>("SELECT * FROM props WHERE machine = ? AND name = ?"),
  allProps: prep<LigneProp>("SELECT * FROM props WHERE machine = ?"),
  countProps: prepUne<Compte>("SELECT count(*) AS n FROM props WHERE machine = ?"),

  putBean: prep("INSERT INTO bean_systems(machine, idx, at, data) VALUES(:machine, :idx, :at, :data) ON CONFLICT(machine, idx) DO UPDATE SET at = :at, data = :data"),
  allBeans: prep<LigneBean>("SELECT * FROM bean_systems WHERE machine = ? ORDER BY idx"),
  countBeans: prepUne<Compte>("SELECT count(*) AS n FROM bean_systems WHERE machine = ?"),

  putStat: prep("INSERT INTO stats(machine, id, value, at) VALUES(:machine, :id, :value, :at) ON CONFLICT(machine, id) DO UPDATE SET value = :value, at = :at"),
  allStats: prep<LigneStat>("SELECT * FROM stats WHERE machine = ? ORDER BY id"),
  countStats: prepUne<Compte>("SELECT count(*) AS n FROM stats WHERE machine = ?"),

  putRecipe: prep("INSERT INTO recipes(machine, id, updatedAt, data) VALUES(:machine, :id, :updatedAt, :data) ON CONFLICT(machine, id) DO UPDATE SET updatedAt = :updatedAt, data = :data"),
  delRecipe: prep("DELETE FROM recipes WHERE machine = ? AND id = ?"),
  allRecipes: prep<LigneRecette>("SELECT * FROM recipes WHERE machine = ? ORDER BY updatedAt"),
  countRecipes: prepUne<Compte>("SELECT count(*) AS n FROM recipes WHERE machine = ?"),

  putBeanImage: prep("INSERT INTO bean_images(machine, id, mime, bytes, at) VALUES(:machine, :id, :mime, :bytes, :at) ON CONFLICT(machine, id) DO UPDATE SET mime = :mime, bytes = :bytes, at = :at"),
  getBeanImage: prep<{ mime: string; bytes: Uint8Array; at: number }>("SELECT mime, bytes, at FROM bean_images WHERE machine = ? AND id = ?"),
  delBeanImage: prep("DELETE FROM bean_images WHERE machine = ? AND id = ?"),
  countBeanImages: prepUne<Compte>("SELECT count(*) AS n FROM bean_images WHERE machine = ?"),
  datesBeanImages: prep<{ id: string; at: number }>("SELECT id, at FROM bean_images WHERE machine = ?"),

  putMeta: prep("INSERT INTO meta(machine, key, value, at) VALUES(:machine, :key, :value, :at) ON CONFLICT(machine, key) DO UPDATE SET value = :value, at = :at"),
  // Remise à zéro d'une machine : une instruction par table, jouées dans une seule transaction.
  wipeProps: prep("DELETE FROM props WHERE machine = ?"),
  wipeBeans: prep("DELETE FROM bean_systems WHERE machine = ?"),
  wipeStats: prep("DELETE FROM stats WHERE machine = ?"),
  wipeRecipes: prep("DELETE FROM recipes WHERE machine = ?"),
  wipeMeta: prep("DELETE FROM meta WHERE machine = ?"),
  wipeBeanImages: prep("DELETE FROM bean_images WHERE machine = ?"),
  getMeta: prep<LigneValeur>("SELECT value, at FROM meta WHERE machine = ? AND key = ?"),
  delMeta: prep("DELETE FROM meta WHERE machine = ? AND key = ?"),

  putSetting: prep("INSERT INTO settings(key, value, at) VALUES(:key, :value, :at) ON CONFLICT(key) DO UPDATE SET value = :value, at = :at"),
  getSetting: prep<LigneValeur>("SELECT value, at FROM settings WHERE key = ?"),
  delSetting: prep("DELETE FROM settings WHERE key = ?"),

  putMcpToken: prep("INSERT INTO mcp_tokens(name, token_hash, scopes, created_at) VALUES(:name, :token_hash, :scopes, :created_at)"),
  listMcpTokens: prep<LigneJeton>("SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM mcp_tokens ORDER BY created_at"),
  getMcpTokenByHash: prep<LigneJeton>("SELECT * FROM mcp_tokens WHERE token_hash = ?"),
  touchMcpToken: prep("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?"),
  revokeMcpToken: prep("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),
};

if (fresh) migrateFromJson();

/** Toute écriture de données lues sur la machine passe par ici, dans une seule transaction. */
function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// ---------------------------------------------------------------- migration de schéma
/**
 * v1 → v2 : ajout de la dimension machine.
 *
 * SQLite ne sait pas changer une clé primaire : on recrée les tables et on recopie. Toutes les
 * lignes existantes appartiennent à la **première** machine (`m1`) — c'est la seule interprétation
 * possible, la base ne pouvait en décrire qu'une.
 *
 * Le tout dans une seule transaction : une coupure au milieu laisse la base en v1, réessayable au
 * prochain démarrage, jamais à moitié convertie. `foreign_keys` est temporairement désactivée le
 * temps de la bascule — les tables sont détruites et recréées, l'intégrité est rétablie à la fin.
 */
/**
 * Enchaîne les pas de migration jusqu'au schéma courant.
 *
 * Une **chaîne** et non un aiguillage : une base v1 doit pouvoir arriver en v4 sans qu'on ait
 * écrit un chemin direct v1 → v4, qui serait un troisième code à vérifier et le seul jamais
 * exercé. Chaque pas stampe SA version — jamais `SCHEMA_VERSION`, sinon un pas intermédiaire
 * marquerait la base à jour alors que le suivant n'a pas encore tourné, et un plantage entre les
 * deux laisserait une base qui ment sur sa forme.
 */
function migrateSchema(fromVersion: number): void {
  let v = fromVersion;
  if (v === 1) { migrateV1toV2(); v = 2; }
  if (v === 2) { migrateV2toV3(); v = 3; }
  if (v === 3) { migrateV3toV4(); v = 4; }
  if (v !== SCHEMA_VERSION) {
    throw new Error(`schéma v${fromVersion} inconnu de cette version du serveur (attendu v1 à v${SCHEMA_VERSION})`);
  }
}

function migrateV1toV2() {
  db.exec("PRAGMA foreign_keys = OFF");
  const at = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const copied: Record<string, number> = {};
    for (const t of ["props", "bean_systems", "stats", "recipes", "meta"]) {
      db.exec(`ALTER TABLE ${t} RENAME TO ${t}_v1`);
      copied[t] = prepUne<Compte>(`SELECT count(*) AS n FROM ${t}_v1`).get().n;
    }
    db.exec(DDL_V2);
    db.exec(`INSERT INTO machines(id, createdAt, data) VALUES('${DEFAULT_MACHINE}', ${at}, '{"label":null}')`);
    db.exec(`INSERT INTO props(machine, name, at, kind, data) SELECT '${DEFAULT_MACHINE}', name, at, kind, data FROM props_v1`);
    db.exec(`INSERT INTO bean_systems(machine, idx, at, data) SELECT '${DEFAULT_MACHINE}', idx, at, data FROM bean_systems_v1`);
    db.exec(`INSERT INTO stats(machine, id, value, at) SELECT '${DEFAULT_MACHINE}', id, value, at FROM stats_v1`);
    db.exec(`INSERT INTO recipes(machine, id, updatedAt, data) SELECT '${DEFAULT_MACHINE}', id, updatedAt, data FROM recipes_v1`);
    db.exec(`INSERT INTO meta(machine, key, value, at) SELECT '${DEFAULT_MACHINE}', key, value, at FROM meta_v1`);
    for (const t of ["props", "bean_systems", "stats", "recipes", "meta"]) db.exec(`DROP TABLE ${t}_v1`);
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
    bootMessages.push(
      `schéma v1 → v2 (plusieurs machines) : ${copied.props} propriétés, ${copied.stats} statistiques, ` +
      `${copied.bean_systems} profils de grains, ${copied.recipes} recettes et ${copied.meta} valeurs ` +
      `rattachées à « ${DEFAULT_MACHINE} »`,
    );
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    // `cause` attachée : c'est la SEULE opération de ce projet qui puisse détruire les données
    // d'un utilisateur, et le message seul perdait la pile de l'erreur SQLite d'origine — donc
    // précisément ce qu'on voudrait lire si elle échouait un jour chez quelqu'un.
    throw new Error(`migration du schéma v1 → v2 impossible (${messageErreur(e)}) — la base est restée en v1`, { cause: e });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * v2 → v3 : la table des images de configurations de grains.
 *
 * **Purement additive** — un `CREATE TABLE`, aucune table recréée, aucune ligne recopiée,
 * contrairement à v1 → v2 qui devait changer une clé primaire. Rien d'existant n'est lu ni
 * réécrit, donc rien d'existant ne peut être perdu ; une coupure laisse la base en v2, où elle
 * fonctionne exactement comme avant, et le pas se rejoue au démarrage suivant.
 *
 * Pas de message dans `bootMessages` quand il n'y a rien à raconter : aucune donnée n'a bougé.
 */
function migrateV2toV3() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(DDL_BEAN_IMAGES);
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
    bootMessages.push("schéma v2 → v3 : table des images de configurations de grains ajoutée");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(`migration du schéma v2 → v3 impossible (${messageErreur(e)}) — la base est restée en v2`, { cause: e });
  }
}

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
    throw new Error(`migration du schéma v3 → v4 impossible (${messageErreur(e)}) — la base est restée en v3`, { cause: e });
  }
}

// ---------------------------------------------------------------- machines
/** Une machine du registre. `data` peut porter d'autres champs qu'une version antérieure y a mis. */
export interface MachineEnregistree { id: string; createdAt: number; label: string | null; [champ: string]: unknown }

function rowToMachine(row: LigneMachine): MachineEnregistree {
  // `label: null` avant l'étalement : la forme rendue ne dépend alors pas de ce que contient la
  // colonne `data`, y compris pour une ligne écrite par une version antérieure.
  const data: Record<string, unknown> = JSON.parse(row.data);
  return { id: row.id, createdAt: row.createdAt, label: null, ...data };
}

/** Les machines connues, dans l'ordre de leur création. La première est celle par défaut. */
export function listMachines(): MachineEnregistree[] {
  return q.listMachines.all().map(rowToMachine);
}

export function getMachine(id: string): MachineEnregistree | null {
  const row = q.getMachine.get(String(id));
  return row ? rowToMachine(row) : null;
}

/** Vrai si cet identifiant désigne une machine connue. Le seul contrôle à faire avant d'écrire. */
export function machineExists(id: string): boolean {
  return !!q.getMachine.get(String(id));
}

/**
 * Crée une machine et rend son identifiant.
 *
 * L'identifiant est **frappé ici**, jamais fourni par l'appelant : c'est ce qui garantit qu'il
 * reste dans la forme `m<n>`, qu'il ne collisionne pas, et qu'aucune requête ne peut se voir
 * imposer une valeur choisie ailleurs.
 */
export function createMachine({ label = null }: { label?: string | null } = {}): { id: string; createdAt: number; label: string | null } {
  return tx(() => {
    const used = q.listMachines.all().map((r) => Number(String(r.id).replace(/^m/, "")) || 0);
    const id = `m${Math.max(0, ...used) + 1}`;
    const createdAt = Date.now();
    q.putMachine.run({ id, createdAt, data: JSON.stringify({ label }) });
    return { id, createdAt, label };
  });
}

/** Renomme (ou dénomme, avec `null`) une machine. Le libellé est purement décoratif. */
export function setMachineLabel(id: string, label: string | null | undefined): MachineEnregistree | null {
  const current = getMachine(id);
  if (!current) return null;
  const next: Record<string, unknown> & { label: string | null } = { ...current, label: label ?? null };
  delete next.id;
  delete next.createdAt;
  q.putMachine.run({ id: String(id), createdAt: current.createdAt, data: JSON.stringify(next) });
  return { id: String(id), createdAt: current.createdAt, ...next };
}

/**
 * Supprime une machine **et toutes ses données** (propriétés lues, statistiques, recettes, clé
 * LAN mémorisée). Les `ON DELETE CASCADE` s'en chargent : il n'y a pas de liste de tables à tenir
 * à jour ici, donc rien à oublier lors d'un ajout futur.
 */
export function deleteMachine(id: string): boolean {
  return tx(() => {
    if (!q.getMachine.get(String(id))) return false;
    q.delMachine.run(String(id));
    return true;
  });
}

// ---------------------------------------------------------------- réglages globaux
/**
 * Réglages qui ne concernent aucune machine en particulier (machine par défaut, par exemple).
 *
 * `T` est DÉCLARÉ par l'appelant, qui possède la clé et sa forme : rien n'est revalidé ici, la
 * valeur est celle que ce même serveur a écrite. `unknown` par défaut, pour qu'un appel non
 * annoté soit forcé de rétrécir.
 */
export function getSetting<T = unknown>(key: string): T | null {
  const row = q.getSetting.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function setSetting(key: string, value: unknown): void {
  q.putSetting.run({ key, value: JSON.stringify(value), at: Date.now() });
}

export function clearSetting(key: string): void {
  q.delSetting.run(key);
}

// ---------------------------------------------------------------- API par machine
/** Une propriété telle que stockée : `at` et `kind` sont des colonnes, le reste vient du JSON. */
export interface ProprieteStockee { at: number; kind?: string; [champ: string]: unknown }
/** Un profil de grains tel que stocké : la trame décodée, plus l'instant de son écriture. */
export type BeanSystemStocke = BeanSystem & { at: number };
/** Un relevé `0xA3` tel que stocké. */
export type ChecksumsStockes = SommesControle & { at: number };
/** Une recette locale : sa forme appartient à `server.ts`, ce module ne lit que `id`. */
export interface RecetteStockee { id: unknown; updatedAt: number; [champ: string]: unknown }
/** La clé LAN mémorisée. La valeur EST le secret : ne pas la journaliser. */
export interface CleLanStockee { lanip_key: string; lanip_key_id: number | string; at?: number }
export interface ImageGrain { mime: string; bytes: Uint8Array; at: number }
export interface ComptesMachine { props: number; stats: number; beanSystems: number; recipes: number; beanImages: number }

/** Ce que `machineView()` rend — l'ancien objet `store` complet. */
export interface VueMachineStockee {
  props: Record<string, ProprieteStockee>;
  beanSystems: Record<number, BeanSystemStocke>;
  stats: Record<number, { value: number; at: number }>;
  checksums: ChecksumsStockes | null;
  checksumsPrev: ChecksumsStockes | null;
  checksumsAtImport: unknown;
  dsn: string | null;
  activeProfile: number | null;
  importedAt: number | null;
}

const bound = new Map<string, StoreMachine>();

/**
 * Rend l'API de stockage **liée à une machine**. Toutes les lectures et écritures de données
 * passent par là — il n'existe volontairement aucune version « sans machine » de ces fonctions :
 * un appel qui aurait oublié de préciser laquelle écrirait dans la mauvaise, et rien ne le
 * signalerait avant des semaines.
 */
export type StoreMachine = ReturnType<typeof creerStoreMachine>;

export function forMachine(machine: string): StoreMachine {
  const id = String(machine);
  const hit = bound.get(id);
  if (hit) return hit;
  const api = creerStoreMachine(id);
  bound.set(id, api);
  return api;
}

/** L'API liée à une machine — séparée de `forMachine` pour que son type se déduise d'elle seule. */
function creerStoreMachine(machine: string) {
  const id = machine;

  /**
   * Horodatage de la dernière donnée **lue sur la machine**. Volontairement pas touché par
   * l'écriture du DSN ou du profil actif : c'est la date d'import que les pages affichent, et
   * l'ancien code la faisait bouger à chaque enregistrement du profil actif.
   */
  const touchImport = (at: number) => q.putMeta.run({ machine: id, key: "importedAt", value: JSON.stringify(at), at });

  /** `T` est déclaré par l'appelant, propriétaire de la clé — même règle que `getSetting`. */
  const getMeta = <T = unknown>(key: string): T | null => {
    const row = q.getMeta.get(id, key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  };
  const setMeta = (key: string, value: unknown) => q.putMeta.run({ machine: id, key, value: JSON.stringify(value), at: Date.now() });
  const clearMeta = (key: string) => q.delMeta.run(id, key);

  const rowToProp = (row: LigneProp): ProprieteStockee => {
    const reste: Record<string, unknown> = JSON.parse(row.data);
    return { at: row.at, kind: row.kind ?? undefined, ...reste };
  };
  const allProps = () => {
    const out: Record<string, ProprieteStockee> = {};
    for (const row of q.allProps.all(id)) out[row.name] = rowToProp(row);
    return out;
  };
  const allBeanSystems = () => {
    const out: Record<number, BeanSystemStocke> = {};
    for (const row of q.allBeans.all(id)) out[row.idx] = JSON.parse(row.data);
    return out;
  };
  const allStats = () => {
    const out: Record<number, { value: number; at: number }> = {};
    for (const row of q.allStats.all(id)) out[row.id] = { value: row.value, at: row.at };
    return out;
  };

  const api = {
    id,
    getMeta,
    setMeta,
    clearMeta,
    importedAt: () => getMeta("importedAt"),

    /**
     * Enregistre une propriété décodée. `at` et `kind` sont des colonnes, le reste part en JSON.
     * Une ligne écrite = une transaction : le coût ne dépend pas du nombre de propriétés connues.
     */
    putProp(name: string, prop: { at?: number; kind?: string | null; [champ: string]: unknown }) {
      const { at = Date.now(), kind = null, ...rest } = prop;
      tx(() => {
        q.putProp.run({ machine: id, name, at, kind, data: JSON.stringify(rest) });
        touchImport(at);
      });
    },
    getProp(name: string): ProprieteStockee | null {
      const row = q.getProp.get(id, name);
      return row ? rowToProp(row) : null;
    },
    /** Vue `{ nom: propriété }`, telle que l'attendent les endpoints de lecture. */
    allProps,
    countProps: () => q.countProps.get(id).n,

    putBeanSystem(bs: BeanSystem) {
      const at = Date.now();
      tx(() => {
        q.putBean.run({ machine: id, idx: bs.index, at, data: JSON.stringify({ ...bs, at }) });
        touchImport(at);
      });
    },
    /** Vue `{ index: profil de grains }` (clés numériques en chaîne, comme l'ancien JSON). */
    allBeanSystems,

    /** Une réponse `0xA2` porte jusqu'à 10 entrées : elles entrent toutes ou aucune. */
    putStats(entries: readonly { id: number; value: number }[]) {
      const at = Date.now();
      tx(() => {
        for (const e of entries) q.putStat.run({ machine: id, id: e.id, value: e.value, at });
        touchImport(at);
      });
    },
    /** Vue `{ id: { value, at } }`. */
    allStats,
    countStats: () => q.countStats.get(id).n,

    /**
     * Enregistre un relevé `0xA3` en décalant le précédent vers `checksumsPrev`, dans une seule
     * transaction : c'est le couple (avant, après) qui sert à dire ce qui a changé, il ne doit
     * jamais pouvoir être à moitié écrit.
     */
    putChecksums(cs: SommesControle) {
      const at = Date.now();
      return tx(() => {
        const prev = getMeta<ChecksumsStockes>("checksums");
        const current: ChecksumsStockes = { at, ...cs };
        if (prev) q.putMeta.run({ machine: id, key: "checksumsPrev", value: JSON.stringify(prev), at });
        q.putMeta.run({ machine: id, key: "checksums", value: JSON.stringify(current), at });
        touchImport(at);
        return { prev, current };
      });
    },

    listRecipes: (): RecetteStockee[] => q.allRecipes.all(id).map((row) => JSON.parse(row.data)),
    putRecipe<R extends { id: unknown }>(r: R): R & { updatedAt: number } {
      const updatedAt = Date.now();
      const recipe = { ...r, updatedAt };
      q.putRecipe.run({ machine: id, id: String(r.id), updatedAt, data: JSON.stringify(recipe) });
      return recipe;
    },
    deleteRecipe: (recipeId: unknown) => q.delRecipe.run(id, String(recipeId)),

    /**
     * L'image d'une configuration de grains mémorisée, rangée sous l'identifiant de cette
     * configuration.
     *
     * `bytes` entre et sort en octets bruts (`Uint8Array`), jamais en base64 : c'est un BLOB des
     * deux côtés, et convertir à chaque lecture ne servirait qu'à gonfler d'un tiers ce qui part
     * ensuite sur le réseau.
     *
     * ⚠️ Ces trois fonctions ne touchent PAS `importedAt` — comme `setMeta`, et pour la même
     * raison : cette date dit quand la MACHINE a écrit quelque chose, pas quand l'utilisateur a
     * rangé une photo. C'est `machineSummary` qui publie de quoi détecter le changement.
     */
    putBeanImage(presetId: string, mime: string, bytes: Uint8Array): number {
      const at = Date.now();
      q.putBeanImage.run({ machine: id, id: String(presetId), mime: String(mime), bytes, at });
      return at;
    },
    /** `null` si cette configuration n'a pas d'image — l'absence est un cas normal, pas une erreur. */
    getBeanImage(presetId: string): ImageGrain | null {
      const row = q.getBeanImage.get(id, String(presetId));
      return row ? { mime: row.mime, bytes: row.bytes, at: row.at } : null;
    },
    /** Rend `true` si une image existait, pour que l'API puisse dire ce qu'elle a fait. */
    deleteBeanImage(presetId: string): boolean {
      return q.delBeanImage.run(id, String(presetId)).changes > 0;
    },
    countBeanImages: () => q.countBeanImages.get(id).n,
    /**
     * Les dates des images, indexées par configuration — en UNE requête.
     *
     * C'est ce qui permet à `/api/beanpresets` de dire « celle-ci a une image » sans que
     * `meta.beanPresets` ait à le recopier. Une donnée recopiée dans les deux endroits finirait
     * par les faire se contredire : la table dit ce qu'elle contient, elle est seule à le dire.
     */
    beanImageDates(): Record<string, number> {
      const d: Record<string, number> = {};
      for (const row of q.datesBeanImages.all(id)) d[row.id] = row.at;
      return d;
    },

    /** `null` si aucune clé n'a été découverte. La valeur retournée EST le secret : ne pas la logger. */
    getLanKey: () => getMeta<CleLanStockee>("lanKey"),
    setLanKey: (key: string, keyId: number | string) => setMeta("lanKey", { lanip_key: key, lanip_key_id: keyId, at: Date.now() }),
    /** Retourne `true` si une clé était bien mémorisée (pour que l'API dise la vérité). */
    clearLanKey() {
      const had = getMeta("lanKey") !== null;
      clearMeta("lanKey");
      return had;
    },

    /**
     * Vue en lecture équivalente à l'ancien objet `store` complet. Pratique pour les endpoints qui
     * parcourent tout (`/api/beverages`, `/api/profiles`), à **éviter** pour lire une seule valeur —
     * `getProp`, `getMeta`, `countStats` existent pour ça.
     */
    machineView: (): VueMachineStockee => ({
      props: allProps(),
      beanSystems: allBeanSystems(),
      stats: allStats(),
      checksums: getMeta<ChecksumsStockes>("checksums"),
      checksumsPrev: getMeta<ChecksumsStockes>("checksumsPrev"),
      checksumsAtImport: getMeta("checksumsAtImport"),
      dsn: getMeta<string>("dsn"),
      activeProfile: getMeta<number>("activeProfile"),
      importedAt: getMeta<number>("importedAt"),
    }),

    counts: (): ComptesMachine => ({
      props: q.countProps.get(id).n,
      stats: q.countStats.get(id).n,
      beanSystems: q.countBeans.get(id).n,
      recipes: q.countRecipes.get(id).n,
      beanImages: q.countBeanImages.get(id).n,
    }),

    /**
     * Efface **tout** ce qui appartient à cette machine, sans supprimer la machine elle-même :
     * propriétés lues, statistiques, profils de grains, recettes, images de configurations de
     * grains, et toutes les valeurs `meta` — donc aussi l'adresse mémorisée, le DSN, le modèle et
     * la clé LAN.
     *
     * C'est la remise à zéro de la **dernière** machine, qu'on ne peut pas retirer du registre sans
     * laisser l'application sans rien à piloter. Une seule transaction : une coupure au milieu ne
     * peut pas laisser la moitié d'une ancienne configuration, ce qui serait pire que les deux
     * états francs.
     *
     * Rend le décompte de ce qui a été effacé, pour que l'interface puisse le dire.
     */
    reset(): ComptesMachine {
      return tx(() => {
        const efface: ComptesMachine = {
          props: q.countProps.get(id).n,
          stats: q.countStats.get(id).n,
          beanSystems: q.countBeans.get(id).n,
          recipes: q.countRecipes.get(id).n,
          beanImages: q.countBeanImages.get(id).n,
        };
        q.wipeProps.run(id);
        q.wipeBeans.run(id);
        q.wipeStats.run(id);
        q.wipeRecipes.run(id);
        q.wipeBeanImages.run(id);
        q.wipeMeta.run(id);
        return efface;
      });
    },
  };
  return api;
}

// ---------------------------------------------------------------- migration des JSON
/**
 * Reprise des trois fichiers JSON de l'implémentation précédente. Ils ne sont **pas supprimés**
 * mais renommés en `.migrated` : si quelque chose s'est mal passé, l'état d'origine est encore là,
 * et un fichier renommé ne sera pas réimporté au prochain démarrage.
 *
 * Ces fichiers datent d'avant la notion de plusieurs machines : tout va donc dans `m1`.
 */
/**
 * Les anciens fichiers, tels que la version précédente de CE serveur les écrivait. Rien n'est
 * revalidé — exactement comme avant le typage : la migration reprend ce qu'elle trouve, et une
 * forme inattendue lève dans la transaction, qui s'annule.
 */
interface AncienCache {
  props?: Record<string, { at?: number; kind?: string | null; [champ: string]: unknown }>;
  beanSystems?: Record<string, { index: number; at?: number }>;
  stats?: Record<string, { value: number; at?: number }>;
  [cle: string]: unknown;
}
interface AnciennesRecettes { recipes?: unknown }
interface AncienneCle { lanip_key?: string; lanip_key_id?: number | string }

function migrateFromJson() {
  const M = DEFAULT_MACHINE;
  // `T` déclare la forme attendue du fichier (voir `AncienCache`) : c'est l'assignation d'un
  // `JSON.parse`, pas une vérification — la même confiance qu'avant, désormais écrite.
  const read = <T>(file: string): { data: T; path: string } | null => {
    const p = join(DIR, file);
    if (!existsSync(p)) return null;
    try { return { data: JSON.parse(readFileSync(p, "utf8")), path: p }; } catch (e) {
      bootMessages.push(`migration : ${file} illisible (${messageErreur(e)}) — ignoré, l'ancien fichier est conservé`);
      return null;
    }
  };
  const retire = (path: string) => { try { renameSync(path, `${path}.migrated`); } catch {} };
  const counts: string[] = [];

  const machine = read<AncienCache>("machine-beverages.json");
  if (machine) {
    const s = machine.data;
    tx(() => {
      for (const [name, p] of Object.entries(s.props ?? {})) {
        const { at = Date.now(), kind = null, ...rest } = p;
        q.putProp.run({ machine: M, name, at, kind, data: JSON.stringify(rest) });
      }
      for (const bs of Object.values(s.beanSystems ?? {})) {
        q.putBean.run({ machine: M, idx: bs.index, at: bs.at ?? Date.now(), data: JSON.stringify(bs) });
      }
      for (const [id, st] of Object.entries(s.stats ?? {})) {
        q.putStat.run({ machine: M, id: Number(id), value: st.value, at: st.at ?? Date.now() });
      }
      for (const key of ["checksums", "checksumsPrev", "checksumsAtImport", "dsn", "activeProfile", "importedAt"]) {
        if (s[key] !== undefined && s[key] !== null) {
          q.putMeta.run({ machine: M, key, value: JSON.stringify(s[key]), at: Date.now() });
        }
      }
    });
    counts.push(`${Object.keys(s.props ?? {}).length} propriétés`, `${Object.keys(s.stats ?? {}).length} statistiques`, `${Object.keys(s.beanSystems ?? {}).length} profils de grains`);
    retire(machine.path);
  }

  const recipes = read<AnciennesRecettes>("recipes.json");
  if (recipes) {
    const list: { id: unknown; updatedAt?: number }[] = Array.isArray(recipes.data.recipes) ? recipes.data.recipes : [];
    tx(() => {
      for (const r of list) {
        q.putRecipe.run({ machine: M, id: String(r.id), updatedAt: r.updatedAt ?? Date.now(), data: JSON.stringify(r) });
      }
    });
    counts.push(`${list.length} recettes`);
    retire(recipes.path);
  }

  const lan = read<AncienneCle>("lan-key.json");
  if (lan?.data?.lanip_key) {
    // Pas de trace de la clé dans les messages de démarrage : seul son key_id est public.
    forMachine(M).setMeta("lanKey", lan.data);
    counts.push(`clé LAN (key_id ${lan.data.lanip_key_id})`);
    retire(lan.path);
  }

  if (counts.length) {
    bootMessages.push(`migration JSON → SQLite : ${counts.join(", ")} ; anciens fichiers renommés en .migrated`);
  }
}

// ---------------------------------------------------------------- vue d'ensemble
/** Diagnostic exposé par `/api/system` : de quoi vérifier l'état du stockage sans ouvrir le fichier. */
export function storageInfo() {
  const pageCount = prepUne<{ page_count: number }>("PRAGMA page_count").get().page_count;
  const pageSize = prepUne<{ page_size: number }>("PRAGMA page_size").get().page_size;
  const machines = listMachines();
  // Les clés du total viennent de `counts()`, **jamais d'une liste écrite ici**. Elles l'étaient,
  // et c'est précisément ce qui a fait qu'un compteur ajouté à `counts()` n'apparaissait nulle
  // part dans `/api/system` — sans erreur, la clé manquait simplement. Une deuxième énumération
  // des tables est une divergence qui attend son tour.
  const total: Record<string, number> = {};
  const perMachine: Record<string, ComptesMachine> = {};
  for (const m of machines) {
    const c = forMachine(m.id).counts();
    perMachine[m.id] = c;
    for (const [k, v] of Object.entries(c)) total[k] = (total[k] ?? 0) + v;
  }
  return {
    engine: "sqlite",
    file: DBFILE,
    schemaVersion: version(),
    journalMode: prepUne<{ journal_mode: string }>("PRAGMA journal_mode").get().journal_mode,
    synchronous: prepUne<{ synchronous: number }>("PRAGMA synchronous").get().synchronous,
    sqliteVersion: prepUne<{ v: string }>("SELECT sqlite_version() AS v").get().v,
    sizeBytes: pageCount * pageSize,
    machines: machines.length,
    counts: total,
    perMachine,
  };
}

// ---------------------------------------------------------------- jetons MCP
import { randomBytes, createHash } from "node:crypto";

export const MCP_SCOPE_CATEGORIES: readonly string[] = ["statut", "journal", "boissons", "profils", "grains", "recettes", "reglages"];
/** `Partial` : indexée par une catégorie venue d'une requête, qui peut ne pas exister. */
export const MCP_SCOPE_NATURES_PAR_CATEGORIE: Readonly<Partial<Record<string, readonly string[]>>> = {
  statut: ["lecture"],
  journal: ["lecture", "action"],
  boissons: ["lecture", "action"],
  profils: ["lecture", "action"],
  grains: ["lecture", "action"],
  recettes: ["lecture", "action"],
  reglages: ["lecture", "action"],
};

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** `scopes` : tableau de "categorie:nature", ex. ["boissons:lecture"]. Rien par défaut. */
export function createMcpToken({ name, scopes = [] }: { name: unknown; scopes?: string[] }) {
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

/** Un jeton tel que l'API le rend : jamais son hash. */
export interface JetonMcpResume {
  id: number;
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const rowToTokenSummary = (row: LigneJeton): JetonMcpResume => ({
  id: row.id,
  name: row.name,
  scopes: JSON.parse(row.scopes),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
});

export function listMcpTokens(): JetonMcpResume[] {
  return q.listMcpTokens.all().map(rowToTokenSummary);
}

/** Renvoie la ligne complète (avec `revokedAt`) ou `null` — jamais le hash au-delà de cette fonction. */
export function findMcpTokenByHash(rawToken: string): JetonMcpResume | null {
  const row = q.getMcpTokenByHash.get(hashToken(rawToken));
  return row ? rowToTokenSummary(row) : null;
}

export function touchMcpTokenUse(id: number): void {
  q.touchMcpToken.run(Date.now(), id);
}

export function revokeMcpToken(id: number): boolean {
  const info = q.revokeMcpToken.run(Date.now(), id);
  return info.changes > 0;
}

export function hasScope(tokenRow: { scopes: readonly string[] }, categorie: string, nature: string): boolean {
  return tokenRow.scopes.includes(`${categorie}:${nature}`);
}
