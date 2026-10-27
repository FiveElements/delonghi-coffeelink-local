/**
 * Vérification par PROPRIÉTÉS (fast-check) : là où les autres `verif-*` rejouent des trames
 * choisies, celle-ci en fabrique des dizaines de milliers au hasard.
 *
 * Ce qui est prouvé :
 *
 * 1. **Les décodeurs de trames ne cassent jamais sur des octets quelconques.** Ce qu'ils lisent
 *    arrive du réseau — POST de la machine, d'une application, d'un journal rejoué. Un décodeur
 *    a le droit de REFUSER une trame (une `Error` à message, ex. « trame trop courte ») ; il n'a
 *    pas le droit de lever une `TypeError` / `RangeError` tombée d'un index hors bornes, qui
 *    trahirait une lecture qu'aucune garde ne protège.
 * 2. **La session LAN est un aller-retour exact**, dans les deux sens et entrelacée, pour toute
 *    suite de charges JSON — pas seulement les cinq de `verif-lansession.mjs`.
 * 3. **`token(n)`** rend exactement `n` caractères de l'alphabet alphanumérique.
 *
 * ⚠️ **Ce fichier est en `.js`, pas en `.mjs` comme ses voisins, et c'est délibéré.** OpenSSF
 * Scorecard (critère Fuzzing) reconnaît le test par propriétés en JavaScript à un import de
 * `fast-check` dans un `*.js` / `*.jsx` — jamais dans un `.mjs`. Sans `"type": "module"` dans
 * package.json, un `.js` est du CommonJS : d'où `require` pour fast-check et `import()` pour les
 * modules du dépôt.
 *
 * Rejouer un échec : `FC_SEED=<graine> node scripts/verif-proprietes.js` (la graine est affichée).
 */
const fc = require("fast-check");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const lib = (m) => import(pathToFileURL(path.join(__dirname, "..", "src", "lib", m)).href);
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : Date.now() ^ (Math.random() * 2 ** 31);
const RUNS = Number(process.env.FC_RUNS || 5000);

let ko = 0;
const test = (nom, propriete) => {
  try {
    fc.assert(propriete, { seed, numRuns: RUNS });
    console.log("  ok   ", nom);
  } catch (e) {
    ko++;
    console.log("  ÉCHEC", nom, "→", e.message.split("\n").slice(0, 6).join("\n         "));
  }
};

/** Une trame telle qu'elle arrive : du base64 d'octets quelconques, ou n'importe quelle chaîne. */
const trame = fc.oneof(
  fc.uint8Array({ maxLength: 300 }).map((u) => Buffer.from(u).toString("base64")),
  fc.string({ maxLength: 400 }),
);

/** Refuser est permis ; casser sur un index ne l'est pas. */
const neCassePas = (f) => (v) => {
  try {
    f(v);
  } catch (e) {
    if (e instanceof TypeError || e instanceof RangeError) throw e;
  }
};

(async () => {
  const E = await lib("ecam-args.mjs");
  const M = await lib("monitor.mjs");
  const P = await lib("profiles.mjs");
  const S = await lib("lansession.mjs");

  console.log(`\n— graine ${seed}, ${RUNS} cas par propriété —`);
  console.log("\n— les décodeurs de trames ne cassent jamais —");
  const decodeurs = {
    describeFrame: E.describeFrame,
    opTrame: E.opTrame,
    natureTrame: E.natureTrame,
    profilVise: E.profilVise,
    cleFusion: E.cleFusion,
    opReponse: E.opReponse,
    decodeMonitor: M.decodeMonitor,
    decodeNames: P.decodeNames,
    decodePriorities: P.decodePriorities,
    decodeChecksums: P.decodeChecksums,
    decodeBeanSystem: P.decodeBeanSystem,
    decodeBeanSync: P.decodeBeanSync,
  };
  for (const [nom, f] of Object.entries(decodeurs)) test(nom, fc.property(trame, neCassePas(f)));
  // Celle-ci prend des OCTETS, pas du base64 : c'est ainsi que server.mjs l'appelle.
  test("constanteConnue", fc.property(fc.uint8Array({ maxLength: 64 }), neCassePas(E.constanteConnue)));

  console.log("\n— la session LAN est un aller-retour exact —");
  const echange = fc.record({
    lanKey: fc.uint8Array({ minLength: 1, maxLength: 64 }).map((u) => Buffer.from(Buffer.from(u).toString("base64"), "utf8")),
    random1: fc.constant(null).map(() => S.token(16)),
    random2: fc.constant(null).map(() => S.token(16)),
    time1: fc.nat().map(String),
    time2: fc.nat().map(String),
  });
  const message = fc.record({ versClient: fc.boolean(), data: fc.jsonValue() });
  test(
    "toute suite de charges, dans les deux sens, entrelacée",
    fc.property(echange, fc.array(message, { maxLength: 20 }), (kx, suite) => {
      const appareil = S.makeLanSession({ ...kx, role: "device" });
      const client = S.makeLanSession({ ...kx, role: "client" });
      for (const { versClient, data } of suite) {
        const [de, vers] = versClient ? [appareil, client] : [client, appareil];
        const json = JSON.stringify(data);
        const recu = JSON.parse(vers.decapsulate(JSON.parse(de.encapsulate(json)))).data;
        if (JSON.stringify(recu) !== json) throw new Error(`${json} ≠ ${JSON.stringify(recu)}`);
      }
    }),
  );

  console.log("\n— token(n) —");
  test(
    "n caractères, tous alphanumériques",
    fc.property(fc.nat({ max: 256 }), (n) => {
      const t = S.token(n);
      if (t.length !== n || !/^[A-Za-z0-9]*$/.test(t)) throw new Error(JSON.stringify(t));
    }),
  );

  console.log(ko ? `\n${ko} échec(s) — rejouer avec FC_SEED=${seed}` : "\nTout passe.");
  process.exit(ko ? 1 : 0);
})();
