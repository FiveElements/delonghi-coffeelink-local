import { readFileSync } from "node:fs";

/**
 * Bean Adapt — réimplémentation **locale** de la règle d'ajustement.
 *
 * Dans l'app officielle, le questionnaire part vers le backend De'Longhi
 * (`getBeanSystemAdv.sr`), qui renvoie les trois réglages à écrire dans la machine. La règle a été
 * dérivée empiriquement par balayage de cette API (voir `docs/bean-adapt.md` §4) et elle est
 * simple : on la rejoue ici, donc **aucun appel au cloud**.
 *
 *   grinder_out     = clamp(grinder_in + Δg(flowTime), 1, 7)
 *   temperature_out = temperature_in + Δt(crema)
 *   aroma_out       = clamp(aroma_in + Δa(taste, flowTime), 1, 5)
 *
 * Deux différences assumées avec le backend, en notre faveur :
 *   - il **échoue** sur `flowTime ∈ [10,19]` avec `taste = 2` (le cas « ne change rien »,
 *     pourtant nominal) ; ici ce cas renvoie simplement les valeurs inchangées ;
 *   - il ne borne **pas** la température vers le haut ; on plafonne à 5 par prudence, sans
 *     toucher au plancher (0), pour rester conforme à la matrice de référence.
 */

/** Bornes confirmées par le comportement du backend (0 et 8 en grinder le font échouer). */
export const GRINDER_MIN = 1;
export const GRINDER_MAX = 7;
export const AROMA_MIN = 1;
export const AROMA_MAX = 5;

/**
 * Bornes de température **non vérifiées**. Le backend n'en impose aucune : le doc relève
 * `temperature_in = 0` + « pas de crema » → `0`. On garde donc **0 comme plancher**, pour
 * reproduire exactement la matrice de référence (§4.4) plutôt que d'inventer une contrainte ; le
 * plafond à 5, lui, est une prudence de notre part. Valeur relevée sur la machine : 3. L'UI le dit.
 */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Δ mouture : l'écoulement est le symptôme, la mouture le correctif. */
function grinderDelta(flowTime) {
  if (flowTime < 10) return -1; // trop rapide → mouture trop grossière → affiner
  if (flowTime >= 20) return +1; // trop lent → mouture trop fine → élargir
  return 0; // fenêtre acceptable
}

/** Δ température, piloté par l'aspect de la crema. Toujours appliqué. */
function temperatureDelta(crema) {
  if (crema === 1) return +1; // crema claire
  if (crema === 3) return -1; // pas de crema
  return 0; // crema foncée
}

/**
 * Δ arôme, piloté par le goût — mais **seulement** dans la fenêtre d'écoulement acceptable.
 * Hors de cette fenêtre le backend ignore la réponse de goût : le problème est mécanique, pas
 * gustatif, et il faut d'abord corriger la mouture.
 */
function aromaDelta(taste, flowTime) {
  if (flowTime < 10 || flowTime >= 20) return 0;
  if (taste === 1) return +1;
  if (taste === 3) return -1;
  return 0;
}

/**
 * @param {{grinder:number,temperature:number,aroma:number}} current réglages actuels du profil
 * @param {{flowTime:number,crema:1|2|3,taste:1|2|3}} answers réponses au questionnaire
 */
export function computeBeanAdapt(current, answers) {
  const flowTime = Number(answers.flowTime);
  const crema = Number(answers.crema);
  const taste = Number(answers.taste);
  const dg = grinderDelta(flowTime);
  const dt = temperatureDelta(crema);
  const da = aromaDelta(taste, flowTime);

  const grinder = clamp(Number(current.grinder) + dg, GRINDER_MIN, GRINDER_MAX);
  const temperature = clamp(Number(current.temperature) + dt, TEMPERATURE_MIN, TEMPERATURE_MAX);
  const aroma = clamp(Number(current.aroma) + da, AROMA_MIN, AROMA_MAX);

  const notes = [];
  if (dg !== 0) notes.push(flowTime < 10 ? "grinderFiner" : "grinderCoarser");
  if (da === 0 && taste !== 2) notes.push("tasteIgnored");
  if (grinder !== Number(current.grinder) + dg) notes.push("grinderClamped");
  if (aroma !== Number(current.aroma) + da) notes.push("aromaClamped");
  if (temperature !== Number(current.temperature) + dt) notes.push("temperatureClamped");
  if (flowTime >= 10 && flowTime < 20 && taste === 2) notes.push("backendWouldFail");

  return {
    grinder,
    temperature,
    aroma,
    deltas: { grinder: dg, temperature: dt, aroma: da },
    changed: grinder !== Number(current.grinder) || temperature !== Number(current.temperature) || aroma !== Number(current.aroma),
    notes,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * COMPOSER UN GRAIN NEUF — mélange × torréfaction, RELEVÉ et non calculé
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'affinage ci-dessus corrige un grain déjà réglé. Il manquait l'autre moitié : le premier
 * réglage, quand il n'y a encore rien à corriger. Dans l'app officielle c'est le flux « basique »
 * du parcours d'ajout — deux questions posées avant toute tasse :
 *
 *   question 1  `prequestion_1`  le mélange       → 1 = 100 % arabica, 2 = arabica + robusta
 *   question 2  `prequestion_2`  la torréfaction  → 1 (claire) … 4 (très foncée)
 *
 * puis `POST getBeanSystem.sr` avec ces deux réponses, qui renvoie `{grinder, temperature, aroma}`.
 * Les appelants sont `NewCreationBeanAdaptFragment$c.l` (`L6.j.C(1, …)`) et `L6.j.P()`.
 *
 * ## Une table, pas une formule — et surtout pas la nôtre
 *
 * Cette fonction a d'abord été une règle de cette maison, annoncée comme telle à l'écran, parce
 * qu'aucune des 8 cases n'avait été relevée. Elles l'ont été le **2026-09-02**
 * (`scripts/extract-bean-creation.mjs`, 8 requêtes, sans authentification) et la vraie règle est
 * l'inverse de celle qu'on avait devinée, **sur les deux axes** :
 *
 *                    | clair | moyen | foncé | très foncé     (mouture / température / arôme)
 *   100 % arabica    | 4/2/4 | 4/2/4 | 4/1/3 | 4/1/3
 *   arabica+robusta  | 3/2/4 | 3/2/4 | 3/1/3 | 3/1/3
 *
 *   - la **mouture ne dépend que du mélange** (et non de la torréfaction), et le robusta se moud
 *     **plus FIN** (3) que l'arabica (4) — on avait posé l'inverse, en élargissant avec le foncé ;
 *   - **température et arôme ne dépendent que de la torréfaction** (et non du mélange), et les
 *     quatre niveaux s'effondrent en **deux paliers** : {claire, moyenne} → 2/4, {foncée, très
 *     foncée} → 1/3. Le questionnaire offre donc quatre réponses pour deux résultats.
 *
 * ⚠️ **La table est LUE, pas interpolée ni factorisée.** Écrire `grinder = robusta ? 3 : 4` serait
 * exact aujourd'hui et faux le jour où De'Longhi changerait une case : une formule tirée de huit
 * points en réinventerait sept. Le relevé est figé dans `bean-creation.json`, la lecture est un
 * accès direct, et l'absence d'une case lève — exactement comme le script refuse d'écrire une
 * table trouée. Les motifs ci-dessus sont de la documentation, pas du code.
 *
 * ⚠️ **Aucun appel réseau ici.** Le questionnaire d'ajout de grain lit la table en mémoire ; le
 * seul geste sortant de tout ce sujet est le script de relevé, lancé à la main. C'est la même
 * discipline que `bean-images.json` : généré depuis le réseau, servi depuis le dépôt.
 *
 * ⚠️ **`source` nomme l'origine, et l'écran s'y adapte.** Il valait `"local"` tant que la règle
 * était de nous, ce qui déclenchait un avertissement dans le dialogue ; il vaut maintenant
 * `"delonghi"` avec la date du relevé, et cet avertissement disparaît **de lui-même** — c'est
 * pourquoi le dialogue teste la valeur au lieu d'écrire le libellé en dur.
 */

/** Les deux réponses de `prequestion_1`, avec les identifiants du questionnaire De'Longhi. */
export const MELANGE_ARABICA = 1;
export const MELANGE_ARABICA_ROBUSTA = 2;
/** Les quatre niveaux de `prequestion_2`, du plus clair au plus foncé. */
export const TORREFACTION_MIN = 1;
export const TORREFACTION_MAX = 4;

/**
 * Le relevé, tel qu'écrit par `scripts/extract-bean-creation.mjs`. `JSON.parse(readFileSync(…))`
 * et non une `import` d'attribut : c'est la forme déjà employée par `beverages.mjs` et
 * `machine-models.mjs` pour leurs tables générées, et elle ne dépend d'aucun réglage de bundler.
 */
const CREATION = JSON.parse(readFileSync(new URL("./bean-creation.json", import.meta.url), "utf8"));

/** La date du relevé, portée jusqu'à l'écran : un réglage venu d'ailleurs se date. */
export const CREATION_RELEVE = CREATION.releve;

/**
 * @param {{melange:1|2, torrefaction:1|2|3|4}} reponses les deux réponses du questionnaire
 * @returns {{grinder:number, temperature:number, aroma:number, source:"delonghi", releve:string, notes:string[]}}
 */
export function composeGrainNeuf(reponses) {
  const melange = reponses?.melange;
  const torrefaction = reponses?.torrefaction;

  /**
   * ⚠️ **On refuse au lieu de retomber sur une valeur par défaut.** Une réponse hors des options
   * ne vient pas d'un utilisateur — elle vient d'un appel mal formé. Retomber en silence sur
   * « arabica » ferait afficher un réglage complet pour une question que personne n'a posée, et
   * c'est précisément le genre d'erreur que ce dépôt tient pour la pire : plausible et fausse.
   */
  if (melange !== MELANGE_ARABICA && melange !== MELANGE_ARABICA_ROBUSTA) {
    throw new Error(`mélange ${JSON.stringify(melange)} inconnu : attendu ${MELANGE_ARABICA} (100 % arabica) ou ${MELANGE_ARABICA_ROBUSTA} (arabica + robusta)`);
  }
  if (!Number.isInteger(torrefaction) || torrefaction < TORREFACTION_MIN || torrefaction > TORREFACTION_MAX) {
    throw new Error(`torréfaction ${JSON.stringify(torrefaction)} invalide : attendu un entier de ${TORREFACTION_MIN} (claire) à ${TORREFACTION_MAX} (très foncée)`);
  }

  const cle = `${melange}-${torrefaction}`;
  const releve = CREATION.table?.[cle];
  /* Une case manquante est un fichier abîmé, pas une entrée invalide : on le dit autrement. */
  if (!releve) throw new Error(`bean-creation.json : case ${cle} absente du relevé (relancer scripts/extract-bean-creation.mjs)`);

  const grinder = clamp(releve.grinder, GRINDER_MIN, GRINDER_MAX);
  const temperature = clamp(releve.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX);
  const aroma = clamp(releve.aroma, AROMA_MIN, AROMA_MAX);

  /**
   * Une note par réglage, toujours — et **préfixées `neuf`**.
   *
   * L'affinage n'en émet que sur l'événement notable, parce qu'il compare à un état connu. Ici il
   * n'y a rien à comparer : la note dit **de quelle réponse vient le chiffre**, ce qui est la seule
   * chose que trois curseurs posés d'autorité ne racontent pas. Le préfixe, lui, sépare cet espace
   * de clés de celui de l'affinage : les deux dialogues rendent leurs notes par `t("note_" + n)`, et
   * une note « grinderFiner » servie ici parlerait d'un écoulement que personne n'a mesuré.
   *
   * ⚠️ **Les notes suivent la causalité relevée, pas celle qu'on avait supposée.** La première
   * version expliquait la mouture par la torréfaction et la température par le mélange : deux
   * phrases justes en caféologie et fausses sur cette machine. C'est le genre d'erreur qu'un
   * relevé corrige et qu'une explication plausible fait vivre longtemps.
   */
  const robusta = melange === MELANGE_ARABICA_ROBUSTA;
  const fonce = torrefaction >= 3;
  const notes = [
    robusta ? "neufMoutureRobusta" : "neufMoutureArabica",
    fonce ? "neufTempFoncee" : "neufTempClaire",
    fonce ? "neufAromeFoncee" : "neufAromeClaire",
  ];

  return { grinder, temperature, aroma, source: "delonghi", releve: CREATION.releve, notes };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE VERROU DE L'AFFINAGE — port de `L6/k.java`
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'app officielle n'ouvre « Affiner vos paramètres de grains » qu'après un nombre minimum
 * d'espressos tirés avec le grain courant, et ce n'est pas une politesse d'interface : le
 * questionnaire porte sur un écoulement que la machine mesure elle-même (paramètre 502). Une
 * mesure prise sur une ou deux tasses décrit la mise en route de la meule, pas le café.
 *
 * `L6/k.java`, littéralement :
 *
 * ```java
 * this.f4791e = Integer.valueOf(g() ? 3 : 5);   // g() : l'appModelId contient « striker »
 * …
 * if (compteur505 >= seuil) f4792f.l(TRUE); else f4792f.l(FALSE);
 * ```
 *
 * Le compteur est le mot 5 de `d260_beansystem_sync_par` (voir `decodeBeanSync`), et la machine le
 * remet à **0** à chaque écriture de profil : le verrou se réarme donc tout seul après un affinage,
 * sans que personne ait à le remettre à zéro.
 *
 * ⚠️ **La branche verrouillée n'a jamais été observée en vrai.** La capture du 2026-08-31 s'est
 * faite avec un compteur à 31, donc largement au-dessus du seuil. Le seuil et la comparaison
 * viennent du décompilé, pas d'une observation — d'où `affinagePermis` qui rend `null` quand le
 * compteur est absent : ne pas savoir n'est pas « refusé », et l'interface le dit ainsi.
 */
export const SEUIL_ESPRESSOS_CLASSIC = 5;
export const SEUIL_ESPRESSOS_STRIKER = 3;

/** Le seuil applicable à une génération de machine (`"striker"` ou `"classic"`). */
export function seuilAffinage(gen) {
  return gen === "striker" ? SEUIL_ESPRESSOS_STRIKER : SEUIL_ESPRESSOS_CLASSIC;
}

/**
 * L'affinage est-il permis ? `true`, `false`, ou **`null` quand on ne sait pas** — la machine
 * n'ayant pas encore poussé `d260`, ou l'ayant poussé trop court pour porter le mot 5.
 *
 * Rendre `false` dans ce cas grimerait une ignorance en refus, et l'utilisateur chercherait des
 * cafés à faire là où il n'y a qu'une propriété à lire.
 */
export function affinagePermis(espressos, gen) {
  if (!Number.isInteger(espressos)) return null;
  return espressos >= seuilAffinage(gen);
}

/**
 * Encode un nom de Bean System — port de `p258z7/z.f0()` : exactement 20 caractères, chacun sur
 * 2 octets **poids fort d'abord** (UTF-16 big-endian), zéros au-delà, tronqué à 20 caractères.
 */
export function encodeBeanName(name) {
  const out = Buffer.alloc(40);
  const chars = String(name ?? "").slice(0, 20);
  for (let i = 0; i < chars.length; i++) {
    const c = chars.charCodeAt(i);
    out[i * 2] = (c >> 8) & 0xff;
    out[i * 2 + 1] = c & 0xff;
  }
  return out;
}
