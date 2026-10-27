/**
 * Fait dialoguer les DEUX rôles d'une session LAN, sans machine et sans réseau.
 *
 * C'est la vérification qui rend le multiplexeur crédible. Se faire passer pour l'appareil auprès
 * d'une application (voir `doc/spec-proxy-multi-app.md`) repose entièrement sur une affirmation :
 * les clés « app » et « dev » sont la même dérivation avec les opérandes échangés, donc un client
 * et un appareil construits sur le MÊME échange de clés doivent se comprendre.
 *
 * Cette affirmation ne se teste pas contre la vraie machine — elle ne dira jamais « tu t'es trompé
 * de sens », elle cessera simplement de répondre. Un mauvais sens ne lève aucune erreur : le
 * déchiffrement produit des octets plausibles et illisibles. Ici, les deux rôles sont dans le même
 * processus, donc le mensonge est impossible.
 *
 * Aucune dépendance : `node scripts/verif-lansession.mjs`.
 */
import crypto from "node:crypto";
import { makeLanSession, derive, token } from "../src/lib/lansession.mjs";

let ko = 0;
const test = (nom, fn) => {
  try {
    fn();
    console.log("  ok   ", nom);
  } catch (e) {
    ko++;
    console.log("  ÉCHEC", nom, "→", e.message);
  }
};
const eq = (a, b, quoi) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`);
};

/**
 * Un échange de clés fabriqué de toutes pièces. `lanKey` est prise comme les octets ASCII d'une
 * chaîne base64 — c'est la règle du protocole, et la fabriquer autrement ici donnerait un test qui
 * passe sur un code faux.
 */
const echange = () => ({
  lanKey: Buffer.from("dGVzdC1sYW4ta2V5LXBvdXItbGEtdmVyaWZpY2F0aW9u", "utf8"),
  random1: token(16),
  random2: token(16),
  time1: "1755855000",
  time2: "1755855001",
});

/** Les deux extrémités d'une même session, chacune dans son rôle. */
const paire = (kx) => ({
  appareil: makeLanSession({ ...kx, role: "device" }),
  client: makeLanSession({ ...kx, role: "client" }),
});

console.log("\n— les deux rôles se comprennent —");

test("appareil → client", () => {
  const { appareil, client } = paire(echange());
  const clair = client.decapsulate(JSON.parse(appareil.encapsulate('{"bonjour":1}')));
  eq(JSON.parse(clair).data, { bonjour: 1 }, "charge utile");
});

test("client → appareil", () => {
  const { appareil, client } = paire(echange());
  const clair = appareil.decapsulate(JSON.parse(client.encapsulate('{"commande":"on"}')));
  eq(JSON.parse(clair).data, { commande: "on" }, "charge utile");
});

test("les deux sens coexistent sans se perturber", () => {
  // Chaque sens a son propre flux : les entrelacer ne doit rien désynchroniser. C'est exactement
  // ce que fait un proxy réel, qui pousse un datapoint pendant qu'il lit une commande.
  const { appareil, client } = paire(echange());
  for (let i = 0; i < 5; i++) {
    const versClient = client.decapsulate(JSON.parse(appareil.encapsulate(`{"etat":${i}}`)));
    eq(JSON.parse(versClient).data, { etat: i }, `appareil → client #${i}`);
    const versAppareil = appareil.decapsulate(JSON.parse(client.encapsulate(`{"ordre":${i}}`)));
    eq(JSON.parse(versAppareil).data, { ordre: i }, `client → appareil #${i}`);
  }
});

test("le flux est PERSISTANT : le n-ième message dépend des précédents", () => {
  // Deux sessions identiques, l'une ayant déjà émis : le même clair doit donner un chiffré
  // DIFFÉRENT. Si ce test échoue, c'est que le chiffreur a été réinitialisé quelque part — et un
  // proxy qui rejouerait un flux depuis le début désynchroniserait tout.
  const kx = echange();
  const a = makeLanSession({ ...kx, role: "device" });
  const b = makeLanSession({ ...kx, role: "device" });
  a.encapsulate('{"x":1}');
  const suivant = a.encapsulate('{"x":1}');
  const premier = b.encapsulate('{"x":1}');
  if (suivant === premier) throw new Error("le chiffré ne dépend pas de l'historique");
});

test("le numéro de séquence s'incrémente", () => {
  const { appareil, client } = paire(echange());
  for (let i = 0; i < 3; i++) {
    const clair = client.decapsulate(JSON.parse(appareil.encapsulate("{}")));
    eq(JSON.parse(clair).seq_no, i, `seq_no #${i}`);
  }
});

// Le titre disait « ne lève AUCUNE erreur » : c'était vrai tant que `decapsulate` ne vérifiait pas la
// signature. Depuis, se tromper de sens est REFUSÉ — mais le piège demeure : un refus de signature
// ne dit pas qu'on s'est trompé de rôle.
console.log("\n— le sens compte —");

test("deux appareils ne se comprennent pas", () => {
  // Le piège que ce fichier existe pour attraper : si le proxy prenait le rôle « client » au lieu
  // de « device », rien ne planterait — on obtiendrait ceci.
  const kx = echange();
  const a = makeLanSession({ ...kx, role: "device" });
  const b = makeLanSession({ ...kx, role: "device" });
  let lisible = false;
  try {
    JSON.parse(b.decapsulate(JSON.parse(a.encapsulate('{"x":1}'))));
    lisible = true;
  } catch { /* attendu : ce n'est pas du JSON */ }
  if (lisible) throw new Error("deux sessions du même rôle se sont comprises — les clés ne sont pas orientées");
});

test("un rôle inconnu est refusé au lieu d'être deviné", () => {
  let leve = false;
  try { makeLanSession({ ...echange(), role: "proxy" }); } catch { leve = true; }
  if (!leve) throw new Error("un rôle inconnu a été accepté");
});

console.log("\n— la clé LAN reste du TEXTE —");

test("décoder la clé base64 donnerait d'autres clés", () => {
  // Règle payée cher en production : `lanip_key` est utilisée comme les octets ASCII de la chaîne
  // base64, elle n'est PAS décodée. L'assertion ne vérifie pas la valeur — elle verrouille le fait
  // que les deux traitements diffèrent, pour qu'une « simplification » ne passe pas inaperçue.
  const texte = Buffer.from("dGVzdC1sYW4ta2V5LXBvdXItbGEtdmVyaWZpY2F0aW9u", "utf8");
  const decodee = Buffer.from(texte.toString("utf8"), "base64");
  const graine = Buffer.from("graine");
  if (derive(texte, graine).equals(derive(decodee, graine))) {
    throw new Error("décoder la clé ne change rien — la dérivation est suspecte");
  }
});

test("la dérivation est bien un DOUBLE HMAC", () => {
  const K = Buffer.from("cle");
  const s = Buffer.from("graine");
  const un = crypto.createHmac("sha256", K).update(s).digest();
  const attendu = crypto.createHmac("sha256", K).update(Buffer.concat([un, s])).digest();
  if (!derive(K, s).equals(attendu)) throw new Error("la dérivation n'est pas le double HMAC attendu");
});

/** Exige un refus de signature et rend le clair non authentifié qu'il transporte. */
const refus = (fn, quoi) => {
  try {
    fn();
  } catch (e) {
    if (!/signature/.test(e.message) || typeof e.clair !== "string") throw new Error(`${quoi} : refus inattendu — ${e.message}`, { cause: e });
    return e.clair;
  }
  throw new Error(`${quoi} : accepté sans signature valide`);
};

console.log("\n— la signature est vérifiée, comme dans le SDK —");

test("une signature altérée est refusée, et le flux reste aligné", () => {
  // Le déchiffrement a lieu AVANT le contrôle : un message refusé est quand même consommé, sans
  // quoi le suivant serait lu avec un chaînage faux et refusé à son tour.
  const { appareil, client } = paire(echange());
  const faux = JSON.parse(appareil.encapsulate('{"commande":"on"}'));
  const sign = Buffer.from(faux.sign, "base64");
  sign[0] ^= 1;
  faux.sign = sign.toString("base64");
  eq(refus(() => client.decapsulate(faux), "signature altérée"), '{"seq_no":0,"data":{"commande":"on"}}', "clair conservé");
  eq(JSON.parse(client.decapsulate(JSON.parse(appareil.encapsulate('{"ok":1}')))).data, { ok: 1 }, "message suivant");
});

test("une signature absente est refusée", () => {
  const { appareil, client } = paire(echange());
  const { enc } = JSON.parse(appareil.encapsulate("{}"));
  refus(() => client.decapsulate({ enc }), "sans sign");
});

test("une charge modifiée sous sa signature d'origine est refusée", () => {
  // Le cas qui motive le contrôle : le CBC ne protège pas l'intégrité — retourner un bit du
  // chiffré change le clair sans que rien ne casse. Seule la signature le voit.
  const { appareil, client } = paire(echange());
  const msg = JSON.parse(appareil.encapsulate('{"profil":1,"remplissage":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'));
  const enc = Buffer.from(msg.enc, "base64");
  enc[20] ^= 0x01;
  refus(() => client.decapsulate({ enc: enc.toString("base64"), sign: msg.sign }), "charge modifiée");
});

console.log("\n— ce que coûte un message SAUTÉ, exactement —");

// Les helpers existants suffisent : l'application chiffre dans le rôle « appareil » (c'est nous
// qu'elle prend pour la cafetière), et nous la lisons dans le rôle « client ».
const deuxBouts = () => { const p = paire(echange()); return [p.appareil, p.client]; };

test("sauter un message n'en abîme QU'UN, puis le flux se recale seul", () => {
  // ⚠️ Ce test dit le contraire de ce que ce projet a cru pendant des jours : un flux AES-CBC
  // persistant décalé d'un message **se rattrape**. Le chaînage du bloc n d'un message vient du
  // chiffré n-1 du MÊME message ; seul le tout premier bloc dépend de ce qui précédait. Donc un
  // message sauté salit les 16 premiers octets du prochain message consommé, et rien d'autre.
  //
  // La conséquence pratique est ce qui rendait le diagnostic faux : **un seul « bloc illisible »
  // au journal ne veut pas dire « un incident isolé », il veut dire « exactement un message a
  // disparu juste avant ».
  //
  // Depuis que `decapsulate` vérifie la signature, le message abîmé est REFUSÉ — et c'est
  // `e.clair` qui garde le charabia : la preuve ne disparaît pas avec le refus.
  const [app, srv] = deuxBouts();
  const msgs = [];
  for (let i = 1; i <= 5; i++) msgs.push(app.encapsulate(JSON.stringify({ n: i })));
  const lu = (i) => srv.decapsulate(JSON.parse(msgs[i]));

  eq(lu(0), '{"seq_no":0,"data":{"n":1}}', "le premier message");
  // On saute le deuxième — ce que faisait `rep.status !== 200` sur une réponse 206.
  const abime = refus(() => lu(2), "le message qui suit un saut");
  if (abime === '{"seq_no":2,"data":{"n":3}}') throw new Error("le saut n'a rien abîmé : le flux n'est pas persistant");
  if (!abime.endsWith('"n":3}}')) throw new Error(`la QUEUE devrait rester lisible, obtenu ${JSON.stringify(abime)}`);
  eq(lu(3), '{"seq_no":3,"data":{"n":4}}', "le message suivant est PARFAIT : le flux s'est recalé");
  eq(lu(4), '{"seq_no":4,"data":{"n":5}}', "et le suivant aussi");
});

test("le charabia s'arrête au premier bloc, pas un octet de plus", () => {
  // La signature qu'on lit au journal — des octets illisibles finissant proprement par `…a":{}}`
  // — n'est pas une curiosité : c'est la mesure exacte du dégât. Un seul bloc AES, 16 octets.
  //
  // La référence n'est pas une chaîne écrite à la main : c'est le MÊME message lu par un second
  // client resté aligné. Comparer à un JSON supposé testerait la forme de l'enveloppe, pas le
  // chaînage — et se casserait au premier champ ajouté par `encapsulate`.
  const kx = echange();
  const app = makeLanSession({ ...kx, role: "device" });
  const aligne = makeLanSession({ ...kx, role: "client" });
  const decale = makeLanSession({ ...kx, role: "client" });

  const charge = JSON.stringify({ remplissage: "x".repeat(200) });
  const m = [app.encapsulate(charge), app.encapsulate(charge), app.encapsulate(charge)];

  const sain = [0, 1, 2].map((i) => aligne.decapsulate(JSON.parse(m[i])))[2];
  decale.decapsulate(JSON.parse(m[0]));                                    // le 1 est lu
  const abime = refus(() => decale.decapsulate(JSON.parse(m[2])), "le 3e"); // le 2 est sauté

  // Comparaison sur les CHAÎNES et non sur des octets : le charabia n'étant pas de l'UTF-8, il
  // ressort en caractères de remplacement et la longueur en octets n'a plus de sens. Ce qui compte
  // est ailleurs, et c'est exactement ce que montre le journal.
  if (abime === sain) throw new Error("rien n'est abîmé : le flux n'est donc pas persistant");
  if (!abime.endsWith(sain.slice(16))) {
    throw new Error(`au-delà des 16 premiers octets tout doit être intact, obtenu …${JSON.stringify(abime.slice(-24))}`);
  }
  if (abime.slice(-24) !== sain.slice(-24)) throw new Error("la queue du message doit être lisible mot pour mot");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
