/**
 * Vérifie **le stockage SQLite** (`src/lib/store.ts`) là où il est le plus fragile : au premier
 * démarrage et aux changements de version — les deux seuls moments où il peut perdre des données.
 *
 * Le module ouvre sa base AU CHARGEMENT, à l'endroit que dit `DATA_DIR` : chaque scénario tourne
 * donc dans un processus enfant, sur un répertoire jetable. Rien ne touche `data/`.
 *
 *   - une `lan-key.json` sur base neuve levait « Cannot access 'bound' before initialization » ;
 *   - la reprise des JSON tournait APRÈS le marquage v4 : un plantage la perdait pour toujours ;
 *   - une date texte dans une colonne INTEGER STRICT faisait tout échouer, sans dire laquelle ;
 *   - `createMachine` réattribuait l'identifiant d'une machine supprimée.
 *
 * Aucune dépendance : `node scripts/verif-store.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let ko = 0;
const test = (nom: string, fn: () => void) => { try { fn(); console.log("  ok   ", nom); } catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e instanceof Error ? e.message : e); } };
const eq = (a: unknown, b: unknown, quoi: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`); };
const vrai = (c: unknown, quoi: string) => { if (!c) throw new Error(quoi); };

const STORE = new URL("../src/lib/store.ts", import.meta.url).href;
const dossiers: string[] = [];
const jetable = () => { const d = mkdtempSync(join(tmpdir(), "verif-store-")); dossiers.push(d); return d; };

/** Charge le store dans un processus neuf, exécute `corps` (qui voit `S`), rend ce qu'il imprime. */
function enfant(dir: string, corps: string): { ok: boolean; sortie: any; erreur: string } {
  const code = `const S = await import(${JSON.stringify(STORE)}); const r = await (async () => { ${corps} })(); console.log(JSON.stringify(r ?? null));`;
  const p = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env: { ...process.env, DATA_DIR: dir, DATABASE_FILE: "" }, encoding: "utf8" });
  const ligne = p.stdout.trim().split("\n").pop() ?? "";
  let sortie: unknown = null;
  try { sortie = JSON.parse(ligne); } catch { /* pas de JSON : l'erreur parle */ }
  return { ok: p.status === 0, sortie, erreur: p.stderr };
}

const ecrire = (dir: string, nom: string, v: unknown) => writeFileSync(join(dir, nom), JSON.stringify(v));

console.log("\n— reprise des anciens JSON au premier démarrage —");

test("une lan-key.json sur base neuve ne lève plus (ReferenceError « bound »)", () => {
  const d = jetable();
  ecrire(d, "lan-key.json", { lanip_key: "secret", lanip_key_id: 42 });
  const r = enfant(d, `return { cle: S.forMachine("m1").getMeta("lanKey")?.lanip_key_id, msgs: S.bootMessages };`);
  vrai(r.ok, `démarrage échoué : ${r.erreur.split("\n").find((l) => /Error/.test(l))}`);
  eq(r.sortie.cle, 42, "clé LAN reprise dans m1");
  vrai(!r.sortie.msgs.join(" ").includes("secret"), "la clé elle-même ne doit pas apparaître dans les messages");
  vrai(existsSync(join(d, "lan-key.json.migrated")) && !existsSync(join(d, "lan-key.json")), "fichier renommé en .migrated");
});

test("une date texte est CONVERTIE, une valeur inconvertible est REJETÉE en le disant", () => {
  const d = jetable();
  ecrire(d, "recipes.json", { recipes: [
    { id: "a", updatedAt: "2024-01-01" },
    { id: "b", updatedAt: "pas une date" },
    { id: "c", updatedAt: 1700000000000 },
  ] });
  const r = enfant(d, `return { rec: S.forMachine("m1").listRecipes().map((x) => [x.id, x.updatedAt]), msgs: S.bootMessages };`);
  vrai(r.ok, `démarrage échoué : ${r.erreur}`);
  eq(r.sortie.rec.map((x: [string, number]) => x[0]).sort(), ["a", "c"], "a converti, c intact, b rejeté");
  eq(r.sortie.rec.find((x: [string, number]) => x[0] === "a")[1], Date.parse("2024-01-01"), "date texte → millisecondes");
  const msgs = r.sortie.msgs.join(" | ");
  vrai(/1 date\(s\) texte converties/.test(msgs), `conversion non dite : ${msgs}`);
  vrai(/REJETÉE.*"b"/.test(msgs), `rejet non nommé : ${msgs}`);
});

test("un plantage pendant la reprise annule TOUT, et le démarrage suivant la rejoue", () => {
  const d = jetable();
  ecrire(d, "lan-key.json", { lanip_key: "secret", lanip_key_id: 7 });
  ecrire(d, "recipes.json", { recipes: [null] });                 // forme inattendue : lève
  const r1 = enfant(d, `return S.bootMessages;`);
  vrai(!r1.ok, "le démarrage aurait dû échouer");
  vrai(/rien n'a été écrit/.test(r1.erreur), `message d'échec peu clair : ${r1.erreur.slice(0, 300)}`);
  vrai(existsSync(join(d, "lan-key.json")) && existsSync(join(d, "recipes.json")), "aucun fichier renommé");
  const v = new DatabaseSync(join(d, "lan-server.db"));
  eq((v.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0, "base restée vierge (v0)");
  v.close();
  // Le fichier corrigé, le démarrage suivant repart d'une base neuve et reprend tout.
  ecrire(d, "recipes.json", { recipes: [{ id: "r", updatedAt: 1 }] });
  const r2 = enfant(d, `return { cle: S.forMachine("m1").getMeta("lanKey")?.lanip_key_id, rec: S.forMachine("m1").listRecipes().length };`);
  vrai(r2.ok, `second démarrage échoué : ${r2.erreur}`);
  eq(r2.sortie, { cle: 7, rec: 1 }, "tout repris au second démarrage");
});

console.log("\n— rien ne se rejoue —");

test("ni la reprise JSON ni une migration de schéma ne tournent deux fois", () => {
  const d = jetable();
  ecrire(d, "recipes.json", { recipes: [{ id: "r", updatedAt: 1 }] });
  vrai(enfant(d, `return 1;`).ok, "premier démarrage");
  // Un fichier qui réapparaît sur une base existante n'écrase pas ce qu'elle contient.
  ecrire(d, "recipes.json", { recipes: [{ id: "intrus", updatedAt: 1 }] });
  const r = enfant(d, `return { rec: S.forMachine("m1").listRecipes().map((x) => x.id), msgs: S.bootMessages };`);
  eq(r.sortie, { rec: ["r"], msgs: [] }, "base existante : aucune reprise, aucun message");
  // v3 → v4 une fois, puis plus rien.
  const v = new DatabaseSync(join(d, "lan-server.db"));
  v.exec("DROP TABLE mcp_tokens; PRAGMA user_version = 3");
  v.close();
  const m1 = enfant(d, `return S.bootMessages;`).sortie;
  vrai(m1.length === 1 && /v3 → v4/.test(m1[0]), `migration v3 → v4 non annoncée : ${JSON.stringify(m1)}`);
  eq(enfant(d, `return S.bootMessages;`).sortie, [], "pas de seconde migration");
});

console.log("\n— identifiants de machine —");

test("createMachine ne réattribue jamais un identifiant supprimé, même après redémarrage", () => {
  const d = jetable();
  const r = enfant(d, `
    const a = S.createMachine().id, b = S.createMachine().id;
    S.deleteMachine(b);
    const c = S.createMachine().id;
    S.deleteMachine(c);
    return [a, b, c];`);
  vrai(r.ok, r.erreur);
  eq(r.sortie, ["m2", "m3", "m4"], "m3 supprimée n'est pas rendue");
  eq(enfant(d, `return S.createMachine().id;`).sortie, "m5", "m4 supprimée avant redémarrage n'est pas rendue non plus");
});

test("une base sans compteur (antérieure) repart du plus grand identifiant existant", () => {
  const d = jetable();
  enfant(d, `S.createMachine(); S.createMachine(); return 1;`);       // m1, m2, m3
  const v = new DatabaseSync(join(d, "lan-server.db"));
  v.exec("DELETE FROM settings WHERE key = 'machineSeq'");
  v.close();
  eq(enfant(d, `return S.createMachine().id;`).sortie, "m4", "suite du plus grand existant");
});

for (const d of dossiers) rmSync(d, { recursive: true, force: true });
console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
