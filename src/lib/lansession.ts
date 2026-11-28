/**
 * Session chiffrée du mode LAN Ayla — **les deux rôles, une seule implémentation.**
 *
 * ⚠️ Ce module TOURNE. Ce n'est pas une des copies `.ts` shadowées : `server.ts` l'importe.
 *
 * ## Pourquoi ce fichier existe
 *
 * Jusqu'ici lan-server ne jouait qu'un rôle : le **client** auquel la machine se connecte. Le
 * multiplexeur (voir `doc/spec-proxy-multi-app.md`) demande l'autre moitié — se faire passer pour
 * l'appareil auprès des applications officielles. Or ce n'est pas un second protocole : c'est le
 * **même**, avec les opérandes échangés.
 *
 * L'échange de clés produit quatre valeurs — deux aléas et deux instants — et la dérivation en tire
 * deux jeux de clés indépendants, un par sens de circulation :
 *
 * ```
 * jeu « app »  ← seed  R1 ‖ R2 ‖ T1 ‖ T2 ‖ tag     chiffre  client  → appareil
 * jeu « dev »  ← seed  R2 ‖ R1 ‖ T2 ‖ T1 ‖ tag     chiffre  appareil → client
 * ```
 *
 * Les deux extrémités calculent **les mêmes quatre clés** ; ce qui les distingue est seulement
 * laquelle chacune utilise pour émettre. D'où le paramètre `role`, et d'où le fait qu'écrire ce
 * fichier une seconde fois pour le proxy aurait été la faute la plus prévisible du projet : deux
 * copies d'une dérivation cryptographique divergent au premier correctif.
 *
 * ## Ce qui n'est pas négociable, et qui a coûté cher
 *
 * - **`lanKey` est utilisée comme les octets ASCII de la chaîne base64.** On ne la décode PAS.
 * - **Le flux AES-256-CBC est persistant** : `cipher.update()` n'est jamais réinitialisé, chaque
 *   bloc dépend de tous les précédents. Une désynchronisation force un nouvel échange de clés.
 *   C'est aussi ce qui rend un proxy « passe-plat » impossible — deux sessions ne partagent aucun
 *   flux, il faut déchiffrer puis rechiffrer.
 * - **Le remplissage se fait à zéro, sur un octet de plus au minimum** (`len = ib.length + 1`
 *   arrondi au multiple de 16), et le déchiffrement retire les zéros de fin.
 * - **La signature porte sur le clair**, HMAC-SHA256 avec la clé de signature du sens d'émission.
 * - **Un `seq_no` déjà reçu dans la session est refusé** (voir `decapsulate`) : sans ce contrôle,
 *   deux messages capturés se rejouaient, signature valide comprise.
 *
 * Tout cela est un port validé en production contre la vraie machine ; ne pas « simplifier ».
 */
import crypto from "node:crypto";

const hmac = (k: crypto.BinaryLike, d: Buffer) => crypto.createHmac("sha256", k).update(d).digest();
/** Double HMAC : `HMAC(K, HMAC(K, seed) ‖ seed)`. C'est la dérivation d'`AylaEncryption`. */
export const derive = (K: crypto.BinaryLike, seed: Buffer): Buffer => hmac(K, Buffer.concat([hmac(K, seed), seed]));

const CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/**
 * Aléa alphanumérique, comme l'app : le protocole transporte ces valeurs en TEXTE, pas en octets.
 * `randomInt` et non `randomBytes() % 62` : 256 n'est pas un multiple de 62, le modulo favorisait
 * les huit premiers caractères (alerte CodeQL `js/biased-cryptographic-random`).
 */
export const token = (n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += CH[crypto.randomInt(CH.length)];
  return s;
};

/**
 * Construit une session à partir des quatre valeurs de l'échange de clés.
 *
 * `role` ne change pas les clés — il choisit laquelle sert à émettre. Un client chiffre en « app »
 * et déchiffre en « dev » ; un appareil fait l'inverse. Se tromper de sens ne lève aucune erreur :
 * on obtient du déchiffrement qui produit des octets plausibles et illisibles, et le symptôme est
 * une session qui « ne répond plus » — d'où `scripts/verif-lansession.ts`, qui fait dialoguer les
 * deux rôles et l'aurait vu.
 */
export type RoleLan = "client" | "device";

export interface ParametresSession {
  /** octets ASCII de la chaîne base64 — **jamais décodée** */
  lanKey: crypto.BinaryLike;
  /** aléa émis par l'APPAREIL */
  random1: string;
  /** aléa émis par le CLIENT */
  random2: string;
  /** instant émis par l'appareil */
  time1: string | number;
  /** instant émis par le client */
  time2: string | number;
  /** le rôle que NOUS tenons dans cette session */
  role: RoleLan;
}

/** Le corps posté d'un message chiffré. `sign` peut manquer : c'est un refus, pas un plantage. */
export interface CorpsChiffre { enc: string; sign?: string | null }

/** Le refus de `decapsulate` : il porte le clair non authentifié, seule preuve de ce qui est arrivé. */
export type ErreurSignature = Error & { clair: string };

export interface SessionLan {
  role: RoleLan;
  random1: string;
  random2: string;
  encapsulate(dataJson: string): string;
  decapsulate(body: CorpsChiffre): string;
}

/** Numéros de séquence entrants mémorisés par session, au plus. Voir `vus` dans `makeLanSession`. */
const SEQ_MEMOIRE = 4096;

/** Le `seq_no` d'un clair `{seq_no, data}`, s'il y en a un entier ; `undefined` sinon. */
function lireSeqNo(texte: string): number | undefined {
  let v: unknown;
  try { v = JSON.parse(texte); } catch { return undefined; }
  if (typeof v !== "object" || v === null || !("seq_no" in v)) return undefined;
  return Number.isInteger(v.seq_no) ? Number(v.seq_no) : undefined;
}

export function makeLanSession({ lanKey, random1, random2, time1, time2, role }: ParametresSession): SessionLan {
  if (role !== "client" && role !== "device") throw new Error(`rôle inconnu : ${role}`);
  const R1 = Buffer.from(random1, "utf8");
  const R2 = Buffer.from(random2, "utf8");
  const T1 = Buffer.from(String(time1), "utf8");
  const T2 = Buffer.from(String(time2), "utf8");
  const tag = (t: number) => Buffer.from([t]);
  const graineApp = (t: number) => Buffer.concat([R1, R2, T1, T2, tag(t)]);
  const graineDev = (t: number) => Buffer.concat([R2, R1, T2, T1, tag(t)]);

  const app = {
    sign: derive(lanKey, graineApp(0x30)),
    crypto: derive(lanKey, graineApp(0x31)),
    iv: derive(lanKey, graineApp(0x32)).subarray(0, 16),
  };
  const dev = {
    sign: derive(lanKey, graineDev(0x30)),
    crypto: derive(lanKey, graineDev(0x31)),
    iv: derive(lanKey, graineDev(0x32)).subarray(0, 16),
  };

  // Le sens d'émission dépend du rôle ; le sens de réception est l'autre. C'est tout ce que `role`
  // décide, et c'est pour cela qu'un seul fichier suffit aux deux moitiés du multiplexeur.
  const sortant = role === "client" ? app : dev;
  const entrant = role === "client" ? dev : app;

  const e = crypto.createCipheriv("aes-256-cbc", sortant.crypto, sortant.iv);
  e.setAutoPadding(false);
  const d = crypto.createDecipheriv("aes-256-cbc", entrant.crypto, entrant.iv);
  d.setAutoPadding(false);

  let seq = 0;
  /**
   * Les `seq_no` déjà acceptés dans CETTE session, sens entrant (une session ne déchiffre qu'un
   * sens). Morte avec la session, donc remise à zéro à chaque échange de clés — comme le compteur
   * des deux bouts.
   *
   * ⚠️ **Un ensemble, pas « strictement supérieur au dernier ».** Rien dans ce dépôt ne PROUVE que
   * la machine (ADA) numérote strictement en croissant, ni ce qu'elle fait au rebouclage : les
   * captures de `scripts/captures/` sont des trames ECAM décodées, sans enveloppe, et la seule
   * numérotation observable ici est la NÔTRE (`seq++` depuis 0). Exiger la croissance stricte
   * sur une hypothèse risquait de refuser des datapoints réels en silence ; refuser un numéro
   * déjà VU ne suppose rien — un rejeu exact est toujours faux. Borné à `SEQ_MEMOIRE` entrées
   * (les plus anciennes sortent) : un compteur qui reboucle retrouve ses numéros, une session
   * longue ne fait pas grossir la mémoire.
   */
  const vus = new Set<number>();
  return {
    role,
    random1,
    random2,
    /** Chiffre un JSON déjà sérialisé et renvoie le corps `{enc, sign}` à poster. */
    encapsulate(dataJson) {
      const inner = `{"seq_no":${seq++},"data":${dataJson}}`;
      const ib = Buffer.from(inner, "utf8");
      const sign = crypto.createHmac("sha256", sortant.sign).update(ib).digest("base64");
      let len = ib.length + 1;
      const r = len % 16;
      if (r) len += 16 - r;
      const pad = Buffer.alloc(len);
      ib.copy(pad, 0);
      return JSON.stringify({ enc: e.update(pad).toString("base64"), sign });
    },
    /**
     * Déchiffre un corps `{enc, sign}` et rend le JSON intérieur, remplissage retiré — **après
     * avoir vérifié `sign`**, comme le fait le SDK (`AylaLanMessage` : HMAC de la clé de signature
     * entrante sur le clair sans remplissage, « Message signature does not match » sinon). Ce
     * port l'avait omis : n'importe quel corps déchiffrable passait pour authentique.
     *
     * ⚠️ Le déchiffrement a lieu AVANT le contrôle, et c'est voulu : le flux CBC est persistant,
     * donc ne pas consommer un message refusé décalerait tous les suivants. Le refus porte le
     * clair non authentifié dans `e.clair` — c'est la seule preuve de ce qui est arrivé (un
     * message sauté se lit à l'œil : charabia sur 16 octets, queue intacte), et le journal la
     * conserve.
     */
    decapsulate(body) {
      const brut = Buffer.from(String(body.enc ?? ""), "base64");
      // Refusé AVANT `d.update` : sans remplissage automatique, le déchiffreur garde un bloc
      // incomplet en réserve et le colle devant le message suivant — tout le flux serait décalé
      // pour de bon, là où un message sauté n'abîme que 16 octets. Rien n'est consommé ici.
      if (brut.length === 0 || brut.length % 16 !== 0) throw new Error(`charge chiffrée de ${brut.length} octets : pas un multiple de 16, refusée sans toucher au flux`);
      const p = d.update(brut);
      let end = p.length;
      while (end > 0 && p[end - 1] === 0) end--;
      const clair = p.subarray(0, end);
      const attendue = crypto.createHmac("sha256", entrant.sign).update(clair).digest();
      const recue = Buffer.from(String(body.sign ?? ""), "base64");
      if (recue.length !== attendue.length || !crypto.timingSafeEqual(recue, attendue)) {
        const e: ErreurSignature = Object.assign(new Error(body.sign ? "signature HMAC invalide" : "signature absente"), { clair: clair.toString("utf8") });
        throw e;
      }
      // Après la signature, jamais avant : un message refusé n'a pas à marquer son numéro comme vu.
      // Un clair sans `seq_no` entier passe — on ne l'a jamais vu manquer, et le refuser serait
      // l'hypothèse non prouvée ci-dessus sous une autre forme ; il ne se rejoue que si le pair
      // légitime en émet.
      const texte = clair.toString("utf8");
      const n = lireSeqNo(texte);
      if (n !== undefined) {
        if (vus.has(n)) {
          const e: ErreurSignature = Object.assign(new Error(`seq_no ${n} déjà reçu dans cette session : rejeu refusé`), { clair: texte });
          throw e;
        }
        vus.add(n);
        if (vus.size > SEQ_MEMOIRE) vus.delete(vus.values().next().value as number);
      }
      return texte;
    },
  };
}
