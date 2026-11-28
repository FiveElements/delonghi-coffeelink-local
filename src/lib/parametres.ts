/**
 * **Les réponses `0xA2` (paramètres et compteurs) et `0x95` (réglages machine).**
 *
 * Sorties de `server.ts`, qui reste leur seul appelant, pour une seule raison : être prouvées
 * sans machine (`scripts/verif-args.ts`, § réponses `0xA2` / `0x95`). Elles lisaient `buf[i]`
 * sans savoir si l'octet existait ni si la trame était intacte — les deux dernières à le faire
 * après `monitor.ts`, `profiles.ts` et `beverages.ts`. Même remède qu'eux : `trameEntiere`
 * d'abord, et une trame tronquée ou au CRC faux LÈVE. L'appelant journalise le rejet ; rien
 * n'arrive dans `putStats` ni dans `meta.reglages`.
 *
 * Le CRC a été vérifié sur la seule réponse `0xA2` réelle conservée dans l'historique du dépôt
 * (`d0 0b a2 0f 0b b8 00 00 23 91 2e c0`, id 3000 = 9105) : la machine le pose, avec la même
 * formule que nos requêtes. Aucune réponse `0x95` réelle n'est conservée ; le CRC est une propriété
 * de la trame ECAM, pas de la commande, et toutes celles qu'on a pu relire le portent.
 */
import { trameEntiere } from "./trame-bornes.ts";

/**
 * Décode la réponse `0xA2` — port de `p097j6.d.L()` case `-94`.
 *
 * ```
 * 0        0xD0
 * 1        len = taille totale − 1
 * 2        0xA2
 * 3        0x0F
 * 4..      n entrées de 6 octets : id sur 16 bits big-endian, puis valeur sur 32 bits
 * 2 dern.  CRC16
 * ```
 *
 * `n = (len − 5) / 6`. Une seule réponse peut donc porter plusieurs paramètres — c'est ce que
 * `qty` demande. Les valeurs sont lues en big-endian comme tout le reste du protocole (`z.g0()`).
 */
export function decodeParameters(b64: string) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 12) throw new Error(`trame trop courte (${buf.length} octets)`);
  if (buf[2] !== 0xa2) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const count = Math.floor((buf[1] - 5) / 6);
  if (count < 1) throw new Error(`aucune entrée (len ${buf[1]})`);
  // Tronquée ou corrompue : refusée, au lieu de compteurs partiels rangés comme lus. La borne est
  // celle de la trame ANNONCÉE (`len - 2`, début du CRC), plus `buf.length` : un datapoint traîne
  // 4 octets d'horodatage que l'ancienne borne prenait pour une partie de la trame.
  const len = trameEntiere(buf, "réponse 0xA2");
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 6;
    if (o + 6 > len - 2) break;
    entries.push({ id: (buf[o] << 8) | buf[o + 1], value: buf.readUInt32BE(o + 2) });
  }
  return { count, entries, hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim() };
}

/**
 * **Réponse `0x95` — les réglages machine.** Port de `p097j6/d.q0()`
 * (`getParametersFromByte`), et le format n'est PAS celui de `0xA2` :
 *
 *   octet 1     len
 *   octets 4-5  adresse du PREMIER réglage (16 bits)
 *   octets 6…   n × 4 octets de valeur, adresses consécutives ; n = (len − 7) / 4
 *
 * L'identifiant n'est donc pas répété devant chaque valeur, contrairement à `0xA2` : il faut
 * l'incrémenter soi-même. Confondre les deux formats décalerait chaque valeur d'un cran, ce qui
 * donnerait des réglages plausibles et faux — l'espèce d'erreur qui ne se voit qu'à l'usage.
 */
export function decodeSettings(b64: string) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw new Error(`trame trop courte (${buf.length} octets)`);
  if (buf[2] !== 0x95) throw new Error(`commande inattendue 0x${buf[2].toString(16)}`);
  const count = Math.floor((buf[1] - 7) / 4);
  if (count < 1) throw new Error(`aucune entrée (len ${buf[1]})`);
  const len = trameEntiere(buf, "réponse 0x95");
  const premier = (buf[4] << 8) | buf[5];
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 4;
    if (o + 4 > len - 2) break;
    entries.push({ addr: premier + i, value: buf.readUInt32BE(o) });
  }
  return { count, entries, hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim() };
}
