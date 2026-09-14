/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * RELEVER LES 8 CASES DU FLUX « BASIQUE » DE BEAN ADAPT — mélange × torréfaction
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'app officielle ne calcule rien : elle poste les réponses du questionnaire à De'Longhi et
 * applique ce qui revient. Pour l'AFFINAGE, cette règle a été relevée puis réimplémentée
 * (`computeBeanAdapt`, matrice de neuf cases au § 4 de `doc/bean-adapt.md`). Pour la CRÉATION, elle
 * ne l'avait jamais été : `composeGrainNeuf` a d'abord été une règle de notre main, annoncée comme
 * telle à l'écran. Ce script existe pour la remplacer par la vraie.
 *
 * L'espace d'entrée est **fini et minuscule** : 2 mélanges × 4 torréfactions = 8 réponses
 * possibles, et l'endpoint ne demande aucune authentification. Il est donc relevable en entier,
 * une fois, et c'est ce que fait ce script.
 *
 * ⚠️ **C'est le SEUL geste sortant de tout ce sujet, et il est explicite.** Rien dans le serveur
 * n'appelle `getBeanSystem.sr` : la table produite ici est figée dans le dépôt
 * (`src/lib/bean-creation.json`) et lue en mémoire. Relancer ce script est un acte volontaire, au
 * même titre que `import-bean-images.mjs` ou l'import d'une photo depuis le datum Ayla. Le
 * questionnaire d'ajout de grain, lui, ne touche jamais le réseau.
 *
 * ⚠️ **Ce script ne devine RIEN d'une absence de réponse.** Si une case échoue, elle est écrite
 * comme échouée et le script sort en erreur : une table à sept cases sur huit produirait un
 * réglage inventé pour la huitième, exactement le genre de valeur plausible et fausse que ce dépôt
 * traque. Mieux vaut pas de table qu'une table trouée.
 *
 * ## Le corps, lu dans le décompilé
 *
 * `L6.j.C(1, …)` et `L6.j.P()` construisent tous deux un `BeanChoice` (`it/delonghi/model/`) :
 *
 *   { "locale": "it_IT", "input": [ {"answer":{"id":M}, "question":{"id":1}},
 *                                   {"answer":{"id":T}, "question":{"id":2}} ] }
 *
 * `locale` est codé en dur à `it_IT` dans l'app, quelle que soit la langue : on envoie la même
 * chose, parce qu'on relève ce que l'app obtient et non ce que l'API pourrait rendre autrement.
 * La réponse est un JSON dont `json_settings` est **une chaîne contenant du JSON** — double
 * encodage, et les trois valeurs y sont des chaînes.
 *
 * ## Usage
 *
 *   node scripts/extract-bean-creation.mjs                  # relève les 8 cases
 *   node scripts/extract-bean-creation.mjs --brut <fichier> # rejoue un relevé, SANS RÉSEAU
 *   node scripts/extract-bean-creation.mjs --base <url>     # autre origine (miroir, test)
 *
 * `--brut` relit le journal des réponses écrit à côté de la table. C'est ce qui rend la table
 * reproductible sans rappeler De'Longhi, et ce qui permet de vérifier une modification du
 * décodage contre les octets d'origine.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, "..");

const arg = (nom, defaut = null) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};
const stop = (code, ...lignes) => {
  for (const l of lignes) console.error(l);
  process.exit(code);
};

const BASE = arg("base", "https://delonghibe.reply.it/api/");
const ENDPOINT = "getBeanSystem.sr";
const LOCALE = "it_IT";
const BRUT_LOCAL = arg("brut");
const SORTIE = join(RACINE, "src", "lib", "bean-creation.json");
const SORTIE_BRUT = join(RACINE, "src", "lib", "bean-creation.brut.json");

/** Les deux réponses de `prequestion_1`, identifiants du questionnaire De'Longhi. */
const MELANGES = [
  { id: 1, quoi: "100 % arabica" },
  { id: 2, quoi: "arabica + robusta" },
];
/** Les quatre réponses de `prequestion_2`, du plus clair au plus foncé. */
const TORREFACTIONS = [
  { id: 1, quoi: "claire" },
  { id: 2, quoi: "moyenne" },
  { id: 3, quoi: "foncée" },
  { id: 4, quoi: "très foncée" },
];

const cle = (melange, torrefaction) => `${melange}-${torrefaction}`;

/** Le corps exact que l'app envoie. */
const corps = (melange, torrefaction) => ({
  locale: LOCALE,
  input: [
    { answer: { id: melange }, question: { id: 1 } },
    { answer: { id: torrefaction }, question: { id: 2 } },
  ],
});

/**
 * Décode une réponse. **Rien n'est deviné** : l'absence de `settings`, une valeur non numérique ou
 * un `result.code` non nul lèvent, avec la réponse brute dans le message.
 *
 * C'est le point sensible du script. Le § 4.5 du doc relève que ce backend renvoie parfois une
 * réponse *malformée mais 200* — pas de clé `settings` dans `json_settings`. Un `?.` complaisant
 * aurait transformé ce cas en trois `undefined`, puis en trois `NaN`, puis en une table de
 * réglages qu'aucun service n'a jamais rendus.
 */
function decoder(texte) {
  let enveloppe;
  try {
    enveloppe = JSON.parse(texte);
  } catch (e) {
    throw new Error(`réponse illisible (${e.message}) : ${texte.slice(0, 200)}`, { cause: e });
  }
  const code = enveloppe?.result?.code;
  if (code != null && Number(code) !== 0) {
    throw new Error(`result.code = ${code} (${enveloppe?.result?.message ?? "sans message"})`);
  }
  if (typeof enveloppe?.json_settings !== "string") {
    throw new Error(`pas de json_settings : ${texte.slice(0, 200)}`);
  }
  let dedans;
  try {
    dedans = JSON.parse(enveloppe.json_settings);
  } catch (e) {
    throw new Error(`json_settings illisible (${e.message}) : ${enveloppe.json_settings.slice(0, 200)}`, { cause: e });
  }
  const s = dedans?.settings;
  if (!s) throw new Error(`json_settings sans clé « settings » : ${enveloppe.json_settings.slice(0, 200)}`);

  /* Les valeurs arrivent en CHAÎNES alors que les modèles Java déclarent des nombres — Gson fait la
     coercition côté app. Ici on la fait explicitement, et on refuse ce qui n'est pas un nombre. */
  const out = {};
  for (const champ of ["grinder", "temperature", "aroma"]) {
    const v = Number(s[champ]);
    if (!Number.isFinite(v)) throw new Error(`${champ} = ${JSON.stringify(s[champ])}, pas un nombre`);
    out[champ] = v;
  }
  /* `tips` est prévu par le modèle `Settings` et n'a jamais été observé. On le relève s'il vient,
     plutôt que de le découvrir un jour dans une réponse qu'on aura jetée. */
  return { ...out, tips: dedans.tips ?? null };
}

async function interroger(melange, torrefaction) {
  const url = BASE + ENDPOINT;
  const body = JSON.stringify(corps(melange, torrefaction));
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
  } catch (e) {
    throw new Error(`injoignable : ${e.message}`, { cause: e });
  }
  const texte = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} : ${texte.slice(0, 200)}`);
  return texte;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   LE BALAYAGE
   ───────────────────────────────────────────────────────────────────────────────────────────── */

const brut = {};
const table = {};
const echecs = [];

/**
 * La date du relevé. En rejeu elle vient du journal, **jamais de l'horloge** : un rejeu ne relève
 * rien, il redécode des octets déjà obtenus, et les redater ferait vieillir la table d'un jour à
 * chaque passage — la CI rejoue justement ce fichier et compare le résultat au fichier commité,
 * donc `new Date()` ici l'aurait fait échouer dès le lendemain du relevé, sans qu'aucune valeur
 * n'ait changé.
 */
let RELEVE_LE = new Date().toISOString().slice(0, 10);

if (BRUT_LOCAL) {
  const rejoue = JSON.parse(readFileSync(BRUT_LOCAL, "utf8"));
  Object.assign(brut, rejoue.reponses ?? rejoue);
  if (typeof rejoue.releve === "string") RELEVE_LE = rejoue.releve.slice(0, 10);
  console.log(`rejeu hors réseau : ${BRUT_LOCAL} (relevé du ${RELEVE_LE})`);
} else {
  console.log(`${BASE}${ENDPOINT} — 8 cases, une requête chacune`);
}

for (const m of MELANGES) {
  for (const t of TORREFACTIONS) {
    const k = cle(m.id, t.id);
    const ou = `${m.quoi} · torréfaction ${t.quoi}`;
    try {
      if (!BRUT_LOCAL) {
        brut[k] = await interroger(m.id, t.id);
        /* Une pause entre deux requêtes. Huit appels n'inquiètent personne, mais un balayage se
           mène en invité : rien ici n'est pressé. */
        await new Promise((r) => setTimeout(r, 400));
      }
      if (brut[k] == null) throw new Error("absente du relevé rejoué");
      const v = decoder(brut[k]);
      table[k] = { grinder: v.grinder, temperature: v.temperature, aroma: v.aroma };
      console.log(`  ok    ${ou} → mouture ${v.grinder}, température ${v.temperature}, arôme ${v.aroma}`);
      if (v.tips) console.log(`        tips : ${JSON.stringify(v.tips)}`);
    } catch (e) {
      echecs.push({ cle: k, ou, pourquoi: e.message });
      console.log(`  ÉCHEC ${ou} → ${e.message}`);
    }
  }
}

/* Le journal des réponses est écrit MÊME en cas d'échec : c'est lui qui permet de comprendre ce que
   le service a répondu, et de rejouer sans rappeler. */
if (!BRUT_LOCAL) {
  writeFileSync(SORTIE_BRUT, JSON.stringify({
    _: "Réponses BRUTES relevées par scripts/extract-bean-creation.mjs — ne pas éditer à la main.",
    releve: new Date().toISOString(),
    source: BASE + ENDPOINT,
    locale: LOCALE,
    reponses: brut,
  }, null, 1) + "\n");
}

if (echecs.length) {
  stop(1,
    "",
    `${echecs.length} case(s) sur 8 n'ont pas été relevées — AUCUNE table n'est écrite.`,
    "Une table trouée ferait inventer un réglage pour la case manquante : c'est exactement",
    "l'erreur que ce relevé existe pour éviter.",
    ...(BRUT_LOCAL ? [] : [`Les réponses obtenues sont dans ${SORTIE_BRUT}.`]),
  );
}

writeFileSync(SORTIE, JSON.stringify({
  _: "Généré par scripts/extract-bean-creation.mjs — ne pas éditer à la main.",
  releve: RELEVE_LE,
  source: BASE + ENDPOINT,
  locale: LOCALE,
  // clé « <mélange>-<torréfaction> » : 1 = 100 % arabica, 2 = arabica + robusta ;
  // torréfaction de 1 (claire) à 4 (très foncée). Les identifiants sont ceux du questionnaire.
  table,
}, null, 1) + "\n");

console.log(`\n8 cases relevées, écrites dans src/lib/bean-creation.json`);
console.log(`réponses brutes : src/lib/bean-creation.brut.json`);
