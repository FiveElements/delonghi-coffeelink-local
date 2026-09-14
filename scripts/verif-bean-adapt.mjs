// Vérification des DEUX règles de `src/lib/bean-adapt.mjs` — celle qui affine un grain existant,
// et celle qui en compose un neuf.
//
// Ce script comble un trou : `computeBeanAdapt` n'avait aucune vérification, alors que c'est
// exactement le genre de module que CLAUDE.md désigne comme dangereux — pur, arithmétique, et dont
// une erreur ne lève rien. Un signe inversé sur un Δ rend un réglage plausible et faux, et il
// atterrit dans une machine à café.
//
// Les deux règles n'ont PAS le même statut, et le script le dit à sa façon :
//
//   `computeBeanAdapt`   est rejouée contre la **matrice de référence** de `docs/bean-adapt.md`
//                        §4.4 — neuf cases relevées sur le vrai backend De'Longhi. C'est une
//                        vérification au sens fort : la valeur attendue vient de l'appareil.
//
//   `composeGrainNeuf`   est rejouée contre les **8 cases** de `getBeanSystem.sr`, relevées le
//                        2026-09-02 par `scripts/extract-bean-creation.mjs`. Même statut, donc :
//                        la valeur attendue vient du service.
//
// ⚠️ **La matrice du grain neuf est retranscrite ICI, à la main, et ce n'est pas une redondance.**
// `composeGrainNeuf` lit `src/lib/bean-creation.json` : comparer sa sortie à ce même fichier ne
// vérifierait qu'un accès de tableau. La table écrite plus bas est une seconde copie, saisie
// depuis le journal du relevé, et c'est elle qui fait échouer le script si le JSON généré est
// édité à la main — ce que son en-tête interdit et qu'aucun outil n'empêche.
//
// ⚠️ **Cette section a d'abord vérifié une règle FAUSSE, et l'a vérifiée en vert.** Avant le
// relevé, `composeGrainNeuf` était une proposition de cette maison et les tests d'ici en
// affirmaient les intentions : mouture strictement croissante avec la torréfaction, robusta plus
// grossier, plus chaud d'un cran de moins… Toutes passaient ; le service dit l'inverse sur les
// deux axes. C'est la limite exacte d'une vérification sans oracle, et la raison pour laquelle un
// relevé de 8 requêtes valait plus que huit tests de cohérence.
import { readFile } from "node:fs/promises";
import {
  computeBeanAdapt,
  composeGrainNeuf,
  GRINDER_MIN, GRINDER_MAX,
  AROMA_MIN, AROMA_MAX,
  TEMPERATURE_MIN, TEMPERATURE_MAX,
  MELANGE_ARABICA, MELANGE_ARABICA_ROBUSTA,
  TORREFACTION_MIN, TORREFACTION_MAX,
} from "../src/lib/bean-adapt.mjs";

let ko = 0;
const test = (nom, fn) => { try { fn(); console.log("  ok   ", nom); } catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e.message); } };
const eq = (a, b, quoi) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`); };
const vrai = (c, quoi) => { if (!c) throw new Error(`${quoi}: faux`); };
const leve = (fn, motif, quoi) => {
  try { fn(); } catch (e) { if (!String(e.message).includes(motif)) throw new Error(`${quoi}: « ${e.message} » ne contient pas « ${motif} »`, { cause: e }); return; }
  throw new Error(`${quoi}: aucune erreur levée`);
};

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   1 · AFFINAGE — la matrice relevée sur le backend (docs/bean-adapt.md §4.4)
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

console.log("\n— affinage : la matrice de référence, base g4 t1 a3 ft10 —");

const BASE = { grinder: 4, temperature: 1, aroma: 3 };
/* Les neuf cases du §4.4. La case (Q11=2, Q12=2) est celle où le backend renvoie une réponse
   malformée ; notre règle, elle, aboutit — d'où la valeur inchangée et la note qui l'explique. */
const MATRICE = [
  [1, 1, { grinder: 4, temperature: 2, aroma: 4 }],
  [1, 2, { grinder: 4, temperature: 2, aroma: 3 }],
  [1, 3, { grinder: 4, temperature: 2, aroma: 2 }],
  [2, 1, { grinder: 4, temperature: 1, aroma: 4 }],
  [2, 2, { grinder: 4, temperature: 1, aroma: 3 }], // « erreur » côté backend
  [2, 3, { grinder: 4, temperature: 1, aroma: 2 }],
  [3, 1, { grinder: 4, temperature: 0, aroma: 4 }],
  [3, 2, { grinder: 4, temperature: 0, aroma: 3 }],
  [3, 3, { grinder: 4, temperature: 0, aroma: 2 }],
];

for (const [crema, taste, attendu] of MATRICE) {
  test(`crema ${crema} · goût ${taste} → g${attendu.grinder} t${attendu.temperature} a${attendu.aroma}`, () => {
    const r = computeBeanAdapt(BASE, { flowTime: 10, crema, taste });
    eq({ grinder: r.grinder, temperature: r.temperature, aroma: r.aroma }, attendu, "réglages");
  });
}

test("la case où le backend échoue est signalée, pas silencieuse", () => {
  const r = computeBeanAdapt(BASE, { flowTime: 10, crema: 2, taste: 2 });
  vrai(r.notes.includes("backendWouldFail"), "note backendWouldFail");
  eq(r.changed, false, "rien ne change");
});

console.log("\n— affinage : l'écoulement commande, et il commande le goût aussi —");

test("écoulement trop rapide (< 10 s) : mouture affinée d'un cran", () => {
  const r = computeBeanAdapt(BASE, { flowTime: 9, crema: 2, taste: 2 });
  eq(r.grinder, 3, "mouture");
  eq(r.deltas.grinder, -1, "Δ mouture");
});

test("écoulement trop lent (≥ 20 s) : mouture élargie d'un cran", () => {
  const r = computeBeanAdapt(BASE, { flowTime: 20, crema: 2, taste: 2 });
  eq(r.grinder, 5, "mouture");
  eq(r.deltas.grinder, +1, "Δ mouture");
});

test("hors fenêtre, le goût est IGNORÉ — et dit ignoré", () => {
  // Le piège : sans cette règle, un « trop léger » hors fenêtre monterait l'arôme alors que le
  // problème est mécanique. Le backend l'ignore ; le taire ferait passer notre résultat pour faux.
  for (const ft of [9, 20]) {
    const r = computeBeanAdapt(BASE, { flowTime: ft, crema: 2, taste: 1 });
    eq(r.deltas.aroma, 0, `Δ arôme à ft=${ft}`);
    vrai(r.notes.includes("tasteIgnored"), `note tasteIgnored à ft=${ft}`);
  }
});

test("dans la fenêtre, le goût compte", () => {
  eq(computeBeanAdapt(BASE, { flowTime: 15, crema: 2, taste: 1 }).aroma, 4, "arôme trop léger");
  eq(computeBeanAdapt(BASE, { flowTime: 15, crema: 2, taste: 3 }).aroma, 2, "arôme trop fort");
});

console.log("\n— affinage : les bornes tronquent, et le disent —");

test("mouture à sa borne haute", () => {
  const r = computeBeanAdapt({ ...BASE, grinder: GRINDER_MAX }, { flowTime: 25, crema: 2, taste: 2 });
  eq(r.grinder, GRINDER_MAX, "mouture");
  vrai(r.notes.includes("grinderClamped"), "note grinderClamped");
});

test("arôme à sa borne haute", () => {
  const r = computeBeanAdapt({ ...BASE, aroma: AROMA_MAX }, { flowTime: 15, crema: 2, taste: 1 });
  eq(r.aroma, AROMA_MAX, "arôme");
  vrai(r.notes.includes("aromaClamped"), "note aromaClamped");
});

test("température à son plancher — le cas relevé sur le backend", () => {
  // §4.5 : `temperature_in = 0` avec Q11 = 3 renvoie 0. Le plancher est donc bien 0, et non 1.
  const r = computeBeanAdapt({ ...BASE, temperature: TEMPERATURE_MIN }, { flowTime: 15, crema: 3, taste: 2 });
  eq(r.temperature, TEMPERATURE_MIN, "température");
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   2 · COMPOSITION D'UN GRAIN NEUF — mélange × torréfaction
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

console.log("\n— grain neuf : les 8 combinaisons —");

const COMBINAISONS = [];
for (const melange of [MELANGE_ARABICA, MELANGE_ARABICA_ROBUSTA]) {
  for (let torrefaction = TORREFACTION_MIN; torrefaction <= TORREFACTION_MAX; torrefaction++) {
    COMBINAISONS.push({ melange, torrefaction });
  }
}

test("il y en a bien huit, et pas une de plus", () => {
  eq(COMBINAISONS.length, 8, "nombre de combinaisons");
});

test("chacune reste dans les bornes du Bean System", () => {
  for (const c of COMBINAISONS) {
    const r = composeGrainNeuf(c);
    const ou = `mélange ${c.melange} · torréfaction ${c.torrefaction}`;
    vrai(r.grinder >= GRINDER_MIN && r.grinder <= GRINDER_MAX, `${ou}: mouture ${r.grinder} hors [${GRINDER_MIN},${GRINDER_MAX}]`);
    vrai(r.aroma >= AROMA_MIN && r.aroma <= AROMA_MAX, `${ou}: arôme ${r.aroma} hors [${AROMA_MIN},${AROMA_MAX}]`);
    vrai(r.temperature >= TEMPERATURE_MIN && r.temperature <= TEMPERATURE_MAX, `${ou}: température ${r.temperature} hors [${TEMPERATURE_MIN},${TEMPERATURE_MAX}]`);
    vrai(Number.isInteger(r.grinder) && Number.isInteger(r.temperature) && Number.isInteger(r.aroma), `${ou}: valeurs non entières`);
  }
});

/* Les 8 cases telles que le service les a rendues, retranscrites depuis
   `src/lib/bean-creation.brut.json`. Clé « mélange-torréfaction ».

   La factorisation saute aux yeux — mouture par le mélange, température et arôme par la
   torréfaction, et quatre niveaux pour deux paliers — mais elle n'est PAS écrite comme une
   formule, ni ici ni dans le module : huit points ne se résument pas sans en réinventer sept. */
const RELEVE = {
  "1-1": { grinder: 4, temperature: 2, aroma: 4 },
  "1-2": { grinder: 4, temperature: 2, aroma: 4 },
  "1-3": { grinder: 4, temperature: 1, aroma: 3 },
  "1-4": { grinder: 4, temperature: 1, aroma: 3 },
  "2-1": { grinder: 3, temperature: 2, aroma: 4 },
  "2-2": { grinder: 3, temperature: 2, aroma: 4 },
  "2-3": { grinder: 3, temperature: 1, aroma: 3 },
  "2-4": { grinder: 3, temperature: 1, aroma: 3 },
};

test("chaque case rend exactement ce que le service a rendu", () => {
  for (const c of COMBINAISONS) {
    const attendu = RELEVE[`${c.melange}-${c.torrefaction}`];
    const r = composeGrainNeuf(c);
    const ou = `mélange ${c.melange} · torréfaction ${c.torrefaction}`;
    eq({ grinder: r.grinder, temperature: r.temperature, aroma: r.aroma }, attendu, ou);
  }
});

test("la sortie nomme De'Longhi et date le relevé", () => {
  // Le pire scénario de cet écran est de se tromper d'origine, dans un sens ou dans l'autre :
  // présenter une règle maison comme le calcul du fabricant, ou continuer à s'excuser d'une règle
  // maison alors qu'on sert la vraie. Le dialogue teste ce champ, il ne l'écrit pas en dur.
  for (const c of COMBINAISONS) {
    eq(composeGrainNeuf(c).source, "delonghi", "source");
    vrai(/^\d{4}-\d{2}-\d{2}$/.test(composeGrainNeuf(c).releve), `date de relevé « ${composeGrainNeuf(c).releve} » illisible`);
  }
});

console.log("\n— grain neuf : les deux réponses comptent, chacune sur son axe —");

test("la mouture ne dépend QUE du mélange, et le robusta se moud plus fin", () => {
  // La règle devinée avant le relevé faisait exactement l'inverse : mouture croissante avec la
  // torréfaction, robusta plus grossier. Les deux axes étaient échangés.
  for (const melange of [MELANGE_ARABICA, MELANGE_ARABICA_ROBUSTA]) {
    const moutures = [];
    for (let t = TORREFACTION_MIN; t <= TORREFACTION_MAX; t++) moutures.push(composeGrainNeuf({ melange, torrefaction: t }).grinder);
    for (const m of moutures) eq(m, moutures[0], `mélange ${melange}: la torréfaction bouge la mouture (${moutures.join(",")})`);
  }
  const arabica = composeGrainNeuf({ melange: MELANGE_ARABICA, torrefaction: 1 }).grinder;
  const robusta = composeGrainNeuf({ melange: MELANGE_ARABICA_ROBUSTA, torrefaction: 1 }).grinder;
  vrai(robusta < arabica, `mouture robusta ${robusta} ≥ arabica ${arabica} : le robusta doit être plus fin`);
});

test("température et arôme ne dépendent QUE de la torréfaction", () => {
  for (let t = TORREFACTION_MIN; t <= TORREFACTION_MAX; t++) {
    const a = composeGrainNeuf({ melange: MELANGE_ARABICA, torrefaction: t });
    const b = composeGrainNeuf({ melange: MELANGE_ARABICA_ROBUSTA, torrefaction: t });
    eq(b.temperature, a.temperature, `torréfaction ${t}: le mélange bouge la température`);
    eq(b.aroma, a.aroma, `torréfaction ${t}: le mélange bouge l'arôme`);
  }
});

test("les quatre torréfactions s'effondrent en deux paliers", () => {
  // Le questionnaire offre quatre réponses pour deux résultats : {claire, moyenne} d'un côté,
  // {foncée, très foncée} de l'autre. C'est le service qui le dit, pas nous — et c'est vérifié
  // parce qu'un jour où il rendrait quatre paliers, l'écran devrait le suivre.
  for (const melange of [MELANGE_ARABICA, MELANGE_ARABICA_ROBUSTA]) {
    const v = (t) => { const r = composeGrainNeuf({ melange, torrefaction: t }); return { temperature: r.temperature, aroma: r.aroma }; };
    eq(v(2), v(1), `mélange ${melange}: claire et moyenne diffèrent`);
    eq(v(4), v(3), `mélange ${melange}: foncée et très foncée diffèrent`);
    vrai(JSON.stringify(v(3)) !== JSON.stringify(v(1)), `mélange ${melange}: les deux paliers rendent la même chose`);
    vrai(v(3).temperature < v(1).temperature, `mélange ${melange}: le palier foncé n'est pas plus froid`);
    vrai(v(3).aroma < v(1).aroma, `mélange ${melange}: le palier foncé n'a pas moins d'arôme`);
  }
});

test("chacune des deux réponses change le résultat", () => {
  // La vraie garantie contre un questionnaire décoratif, et la seule des assertions d'origine que
  // le relevé n'a pas démentie : chaque question doit peser sur le triplet rendu.
  const t = (x) => JSON.stringify(x);
  for (let r = TORREFACTION_MIN; r <= TORREFACTION_MAX; r++) {
    const a = composeGrainNeuf({ melange: MELANGE_ARABICA, torrefaction: r });
    const b = composeGrainNeuf({ melange: MELANGE_ARABICA_ROBUSTA, torrefaction: r });
    vrai(t(a) !== t(b), `torréfaction ${r}: les deux mélanges rendent le même réglage`);
  }
  for (const melange of [MELANGE_ARABICA, MELANGE_ARABICA_ROBUSTA]) {
    const clair = composeGrainNeuf({ melange, torrefaction: 1 });
    const fonce = composeGrainNeuf({ melange, torrefaction: 4 });
    vrai(t(clair) !== t(fonce), `mélange ${melange}: clair et très foncé rendent le même réglage`);
  }
});

/* Lu au niveau du module : `test()` est synchrone, et une fonction `async` qui lèverait dedans
   verrait son échec avalé par une promesse que personne n'attend — vert, sans rien vérifier. */
const JSON_GENERE = JSON.parse(await readFile(new URL("../src/lib/bean-creation.json", import.meta.url), "utf8"));

test("le JSON généré dit la même chose que la retranscription", () => {
  // Les 8 clés attendues y sont toutes, et pas une de plus. C'est ce test qui donne sa valeur à la
  // seconde copie : une édition à la main du fichier généré échouerait ici, alors qu'elle
  // passerait partout ailleurs — le module la lirait sans se plaindre.
  eq(Object.keys(JSON_GENERE.table).sort(), Object.keys(RELEVE).sort(), "clés du relevé");
  eq(JSON_GENERE.table, RELEVE, "le JSON généré et la retranscription de ce script");
  eq(JSON_GENERE.releve, composeGrainNeuf({ melange: 1, torrefaction: 1 }).releve, "date de relevé reportée");
});

console.log("\n— grain neuf : chaque valeur est expliquée —");

test("chaque combinaison porte des notes, et toutes préfixées « neuf »", () => {
  // Le préfixe n'est pas cosmétique : l'interface rend les notes par `t("note_" + n)`, et les clés
  // d'affinage vivent dans le même espace. Une note « grinderFiner » rendue ici parlerait
  // d'écoulement dans un dialogue qui n'en mesure aucun.
  for (const c of COMBINAISONS) {
    const r = composeGrainNeuf(c);
    const ou = `mélange ${c.melange} · torréfaction ${c.torrefaction}`;
    vrai(r.notes.length >= 3, `${ou}: ${r.notes.length} note(s), il en faut une par réglage`);
    for (const n of r.notes) vrai(n.startsWith("neuf"), `${ou}: la note « ${n} » n'est pas préfixée`);
  }
});

test("les notes suivent les réponses — pas la même explication pour deux grains opposés", () => {
  const clair = composeGrainNeuf({ melange: MELANGE_ARABICA, torrefaction: 1 }).notes;
  const fonce = composeGrainNeuf({ melange: MELANGE_ARABICA_ROBUSTA, torrefaction: 4 }).notes;
  vrai(JSON.stringify(clair) !== JSON.stringify(fonce), "notes identiques pour deux grains opposés");
});

console.log("\n— grain neuf : une réponse absente est refusée, pas devinée —");

test("un mélange hors des deux options est refusé", () => {
  // Refuser plutôt que retomber sur l'arabica : une réponse fantaisiste vient d'un bug d'appel, et
  // la retomber en silence ferait afficher un réglage pour une question que personne n'a posée.
  for (const melange of [0, 3, -1, 1.5, null, undefined, "1"]) {
    leve(() => composeGrainNeuf({ melange, torrefaction: 2 }), "mélange", `mélange ${JSON.stringify(melange)}`);
  }
});

test("une torréfaction hors de 1–4 est refusée", () => {
  for (const torrefaction of [0, 5, -1, 2.5, null, undefined, "2"]) {
    leve(() => composeGrainNeuf({ melange: MELANGE_ARABICA, torrefaction }), "torréfaction", `torréfaction ${JSON.stringify(torrefaction)}`);
  }
});

test("un appel sans rien du tout est refusé", () => {
  leve(() => composeGrainNeuf({}), "mélange", "objet vide");
  leve(() => composeGrainNeuf(), "mélange", "aucun argument");
});

console.log("\n— les notes des DEUX règles ont un texte, et c'est vérifié ici —");

/**
 * ⚠️ **`verif-messages.mjs` ne peut pas attraper ça, et c'est le motif même de ce bloc.** Les deux
 * dialogues rendent leurs notes par `t("note_" + n)` : une clé calculée, donc invisible au script
 * qui ne lit que les clés littérales écrites sur place. Une note dont personne n'a écrit le texte
 * s'affiche alors sous sa forme technique — « neufMoutureRobusta » en plein milieu d'une explication
 * — et rien, nulle part, ne l'avait signalé. Le seul endroit qui connaît la liste exhaustive des
 * notes est celui qui les produit : ici.
 */
const MESSAGES = JSON.parse(await readFile(new URL("../messages/fr.json", import.meta.url), "utf8")).beanAdapt;

test("chaque note de l'affinage a son texte dans messages/fr.json", () => {
  const vues = new Set();
  for (const flowTime of [5, 10, 15, 25]) {
    for (const crema of [1, 2, 3]) {
      for (const taste of [1, 2, 3]) {
        for (const base of [BASE, { grinder: GRINDER_MAX, temperature: TEMPERATURE_MAX, aroma: AROMA_MAX }, { grinder: GRINDER_MIN, temperature: TEMPERATURE_MIN, aroma: AROMA_MIN }]) {
          for (const n of computeBeanAdapt(base, { flowTime, crema, taste }).notes) vues.add(n);
        }
      }
    }
  }
  vrai(vues.size > 0, "aucune note produite — le balayage ne couvre rien");
  for (const n of vues) vrai(`note_${n}` in MESSAGES, `note_${n} manque dans messages/fr.json`);
});

test("chaque note du grain neuf a son texte dans messages/fr.json", () => {
  const vues = new Set();
  for (const c of COMBINAISONS) for (const n of composeGrainNeuf(c).notes) vues.add(n);
  vrai(vues.size > 0, "aucune note produite — le balayage ne couvre rien");
  for (const n of vues) vrai(`note_${n}` in MESSAGES, `note_${n} manque dans messages/fr.json`);
});

console.log("\n— grain neuf : les identifiants sont ceux du questionnaire De'Longhi —");

test("mélange 1 = 100 % arabica, 2 = arabica + robusta", () => {
  // `prequestion_1` dans `public/grains/questions.json`, et `it/delonghi/a.java:2082/2136` :
  // l'app envoie `answer.id` 1 pour « 100_arabica » et 2 pour « arabica_robusta ». Inverser les
  // deux ne lèverait rien et produirait le réglage de l'autre café.
  eq(MELANGE_ARABICA, 1, "identifiant arabica");
  eq(MELANGE_ARABICA_ROBUSTA, 2, "identifiant arabica + robusta");
});

test("torréfaction 1–4, du plus clair au plus foncé", () => {
  eq([TORREFACTION_MIN, TORREFACTION_MAX], [1, 4], "bornes de torréfaction");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
