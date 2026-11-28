/**
 * Vérifie **l'identification du modèle** (`identify()`, `src/lib/machine-models.ts`) : les cinq
 * chiffres du numéro de série `d270_serialnumber` qui indexent la table du fabricant.
 *
 * Une découpe décalée d'un caractère ne lève rien : elle rend une clé de cinq chiffres plausible,
 * absente de la table ou — pire — présente, et le serveur annonce alors un autre modèle avec un
 * autre catalogue. Le cas de référence est celui de CLAUDE.md : `0132217055` → `17055` →
 * ECAM 610.75.MB. Le numéro ci-dessous est FABRIQUÉ autour de cette clé (aucun appareil réel).
 *
 * Aucune dépendance : `node scripts/verif-machine-models.ts`.
 */
import { identify, findModel, SERIAL_PROP } from "../src/lib/machine-models.ts";
import { crcCcitt } from "../src/lib/trame-bornes.ts";

let ko = 0;
const test = (nom: string, fn: () => void) => { try { fn(); console.log("  ok   ", nom); } catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e instanceof Error ? e.message : e); } };
const eq = (a: unknown, b: unknown, quoi: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`); };
const vrai = (c: unknown, quoi: string) => { if (!c) throw new Error(quoi); };

/** La trame `0xA1 0x0F` du paramètre 205, telle que la machine pousse `d270_serialnumber`. */
function trameSerie(serie: string): string {
  const b = [0xd0, 0, 0xa1, 0x0f, 0x00, 0xcd, ...Buffer.from(serie, "ascii"), 0x00, 0, 0];
  b[1] = b.length - 1;
  const crc = crcCcitt(b);
  b[b.length - 2] = crc >> 8; b[b.length - 1] = crc & 0xff;
  return Buffer.from(b).toString("base64");
}

console.log("\n— le cas de référence —");

test("0132217055 : caractères 1 à 5 du numéro → 17055 → ECAM 610.75.MB", () => {
  const r = identify(trameSerie("217055DU00000000123"));
  vrai(r.ok, `identification refusée : ${r.ok ? "" : r.reason}`);
  if (!r.ok) return;
  eq(r.serial, "217055DU00000000123", "numéro relu en ASCII à partir de l'octet 6");
  eq(r.modelKey, "17055", "clé de modèle");
  eq(r.model?.productCode, "0132217055", "product_code");
  eq(r.model?.type, "ECAM 610.75.MB", "modèle");
  eq(r.machineName, "D1705523", "nom façon app : D + clé + caractères 17 et 18");
  eq(SERIAL_PROP, "d270_serialnumber", "propriété lue");
});

test("une clé de cinq chiffres absente de la table : identifiée, modèle null — jamais deviné", () => {
  const r = identify(trameSerie("299999DU0000000000"));
  vrai(r.ok, "la découpe est valide");
  if (!r.ok) return;
  eq(r.modelKey, "99999", "clé lue");
  eq(r.model, null, "aucun modèle inventé");
  eq(findModel("99999"), null, "findModel aussi");
});

console.log("\n— les cas invalides rendent une raison ET la trame —");

test("valeur vide ou absente", () => {
  for (const v of ["", undefined, null]) {
    const r = identify(v);
    vrai(!r.ok && /trop courte/.test(r.reason), `${JSON.stringify(v)} : ${JSON.stringify(r)}`);
  }
});

test("trame trop courte pour porter un numéro", () => {
  const r = identify(Buffer.from([0xd0, 0x05, 0xa1, 0x0f, 0x00, 0xcd]).toString("base64"));
  vrai(!r.ok && /trop courte/.test(r.reason), JSON.stringify(r));
  vrai(!r.ok && r.hex === "d0 05 a1 0f 00 cd", "la trame est jointe, en hexadécimal");
});

test("numéro trop court", () => {
  const r = identify(trameSerie("2170"));
  vrai(!r.ok && /illisible/.test(r.reason), JSON.stringify(r));
});

test("caractères 1 à 5 qui ne sont pas des chiffres", () => {
  const r = identify(trameSerie("2ABCDEDU0000000000"));
  vrai(!r.ok && /pas 5 chiffres/.test(r.reason) && r.serial === "2ABCDEDU0000000000", JSON.stringify(r));
});

test("le numéro s'arrête au premier octet non imprimable (le remplissage, pas le CRC lu en texte)", () => {
  const r = identify(trameSerie("217055DU0000000012"));
  vrai(r.ok && !r.serial.includes(String.fromCharCode(0)), "aucun octet de remplissage dans le numéro");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
