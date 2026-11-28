// Vérification de l'ordonnanceur, sans machine et sans horloge : l'instant est un paramètre.
import { RANG, DELAIS, nouvelleFile, tache, pasLecture, pasTrame, enfiler, aServir, reponse, tic, vue, annuler, courante } from "../src/lib/tasks.ts";
import type { FileTaches, Rang, ResultatEnfiler } from "../src/lib/tasks.ts";

let ko = 0;
const test = (nom: string, fn: () => void) => { try { fn(); console.log("  ok   ", nom); } catch (e) { ko++; console.log("  ÉCHEC", nom, "→", e instanceof Error ? e.message : e); } };
const eq = (a: unknown, b: unknown, quoi: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${quoi}: ${x} ≠ ${y}`); };

const lecture = (label: string, props: string[]) => tache({ label, rang: RANG.LECTURE, pas: props.map((p) => pasLecture(p)), cle: `r:${props.join(",")}` });
const commande = (label: string, rang: Rang = RANG.COMMANDE) => tache({ label, rang, pas: [pasTrame(label, "AAA=", { attente: "fenetre", ms: 20000 })] });
const stats = (label: string, n = 2) => tache({ label, rang: RANG.LECTURE_BASSE, pas: Array.from({ length: n }, (_, i) => pasTrame(`${label} ${i}`, "AAA=", { attente: "reponse" })), cle: `s:${label}` });

/* Trois aides qui rendent au typeur ce que le scénario garantit déjà — et qui, si le scénario se
   trompe, font échouer le test au lieu de lever un TypeError sur `null`. */
/** La tâche de tête, qui DOIT exister à ce point du scénario. */
const tete = (f: FileTaches) => {
  const t = courante(f);
  if (!t) throw new Error("file vide : aucune tâche en tête");
  return t;
};
/** Un `enfiler` qui DOIT avoir été accepté — un refus (« pleine ») est un échec. */
const accepte = <M>(r: ResultatEnfiler<M>) => {
  if (!r.ok) throw new Error(`enfilement refusé : ${r.raison}`);
  return r;
};
/** L'`eq` sur le type d'un évènement, écrit en assertion : après lui, ses champs propres sont lisibles. */
function deType<E extends { type: string }, T extends E["type"]>(e: E | undefined, type: T, quoi: string): asserts e is Extract<E, { type: T }> {
  eq(e?.type, type, quoi);
}

console.log("\n— priorités et insertion —");
test("une commande passe devant une lecture, un arrêt devant tout", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  enfiler(f, lecture("Balayage", ["c"]), 0);
  enfiler(f, commande("Allumer"), 0);
  enfiler(f, commande("Arrêt", RANG.URGENT), 0);
  eq(f.liste.map((t) => t.label), ["Arrêt", "Allumer", "Import", "Balayage"], "ordre");
});
test("un balayage de statistiques passe DERRIÈRE les autres lectures", () => {
  const f = nouvelleFile();
  enfiler(f, stats("Statistiques"), 0);
  enfiler(f, lecture("Profils", ["a"]), 0);
  enfiler(f, commande("Allumer"), 0);
  eq(f.liste.map((t) => t.label), ["Allumer", "Profils", "Statistiques"], "ordre");
});
test("une lecture ordinaire SUSPEND un balayage entamé, qui reprend ensuite", () => {
  const f = nouvelleFile();
  enfiler(f, stats("Statistiques", 2), 0);
  aServir(f, 0);                                  // sert la 1re requête
  reponse(f, { reponse: true }, 1000);            // elle répond
  eq(tete(f).faits, 1, "une requête faite");
  enfiler(f, lecture("Profils", ["a"]), 2000);
  eq(tete(f).label, "Profils", "la lecture prend la tête");
  eq(f.liste[1].faits, 1, "le balayage garde ce qu'il a fait");
  aServir(f, 2000);
  reponse(f, { prop: "a" }, 2500);
  tic(f, 2600);
  eq(tete(f).label, "Statistiques", "le balayage reprend");
  eq(tete(f).i, 1, "à la requête où il en était");
});
test("deux commandes restent en FIFO entre elles", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Allumer"), 0);
  enfiler(f, commande("Préparer"), 0);
  eq(f.liste.map((t) => t.label), ["Allumer", "Préparer"], "ordre");
});
test("une lecture suspendue REPREND après la commande qui l'a doublée", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  aServir(f, 0);                       // sert « a »
  reponse(f, { prop: "a" }, 1000);     // a lu
  enfiler(f, commande("Allumer"), 2000);
  eq(tete(f).label, "Allumer", "la commande prend la tête");
  eq(f.liste[1].faits, 1, "l'import garde son pas déjà fait");
  // La commande finit (fenêtre atteinte = succès), l'import redevient tête avec son reste.
  aServir(f, 2000);
  tic(f, 2000 + 20001);
  eq(tete(f).label, "Import", "l'import reprend");
  eq(tete(f).pas[tete(f).i].nom, "b", "au pas où il en était");
});

console.log("\n— fusion et plafond —");
test("deux demandes identiques en attente n'en font qu'une", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Allumer"), 0);           // occupe la tête
  const a = accepte(enfiler(f, lecture("Présence", ["m"]), 0));
  const b = accepte(enfiler(f, lecture("Présence", ["m"]), 0));
  eq(b.fusion, true, "fusion signalée");
  eq(b.tache.id, a.tache.id, "même tâche");
  eq(f.liste.length, 2, "rien d'ajouté");
});
test("la file plafonne au lieu de gonfler", () => {
  const f = nouvelleFile();
  for (let i = 0; i < 32; i++) enfiler(f, commande(`c${i}`), 0);
  eq(enfiler(f, commande("de trop"), 0), { ok: false, raison: "pleine" }, "refus");
});

test("un arrêt passe même quand la file est pleine", () => {
  const f = nouvelleFile();
  for (let i = 0; i < 32; i++) enfiler(f, commande(`c${i}`), 0);
  const r = accepte(enfiler(f, commande("Arrêt", RANG.URGENT), 0));
  eq(tete(f).label, "Arrêt", "en tête");
  eq(r.tache.label, "Arrêt", "acceptée");
});
test("une fusion relève la jumelle au rang le plus élevé, et la reclasse", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Allumer"), 0);
  enfiler(f, lecture("Profils", ["p"]), 0);
  const fond = accepte(enfiler(f, tache({ label: "Compteurs", rang: RANG.LECTURE_BASSE, pas: [pasLecture("x")], cle: "k" }), 0)).tache;
  const r = accepte(enfiler(f, tache({ label: "Compteurs", rang: RANG.COMMANDE, pas: [pasLecture("x")], cle: "k" }), 0));
  eq(r.fusion, true, "fusion");
  eq(fond.rang, RANG.COMMANDE, "rang relevé");
  eq(f.liste.map((t) => t.label), ["Allumer", "Compteurs", "Profils"], "reclassée, FIFO à rang égal");
});

console.log("\n— préemption à une frontière de pas seulement —");
test("une commande ne suspend PAS une lecture dont le pas est en vol", () => {
  const f = nouvelleFile();
  enfiler(f, stats("Statistiques", 2), 0);
  aServir(f, 0);                                  // 1re requête en vol
  enfiler(f, commande("Allumer"), 100);
  eq(tete(f).label, "Statistiques", "la lecture garde la tête tant que sa réponse est attendue");
  eq(aServir(f, 200).quoi, "soutien", "rien d'autre n'est servi");
  reponse(f, { reponse: true }, 1000);            // frontière de pas
  const s = aServir(f, 1100);
  eq(s.quoi === "pas" ? s.tache.label : s.quoi, "Allumer", "la commande prend la tête à la frontière");
  eq(f.liste[1].i, 1, "la lecture reprendra au pas suivant");
});
test("un pas de lecture de propriété en vol n'est pas suspendu non plus", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  aServir(f, 0);
  enfiler(f, commande("Allumer"), 100);
  eq(tete(f).label, "Import", "pas en vol");
  tic(f, 200);
  eq(tete(f).label, "Import", "un tic ne reclasse pas non plus");
});
test("un ARRÊT coupe une préparation dont la fenêtre court (rien n'est en vol)", () => {
  // Un pas « fenetre » servi n'attend aucune réponse : attendre sa fin ferait patienter l'arrêt
  // 75 s, le temps d'une préparation entière.
  const f = nouvelleFile();
  enfiler(f, tache({ label: "Préparer", rang: RANG.COMMANDE, pas: [pasTrame("Préparer", "AAA=", { attente: "fenetre", ms: 75000 })] }), 0);
  aServir(f, 0);
  enfiler(f, commande("Arrêt", RANG.URGENT), 1000);
  eq(tete(f).label, "Arrêt", "l'arrêt prend la tête tout de suite");
});
/**
 * Visites simulées, une par seconde, chacune précédée d'un tic — ce que fait server.ts. Rend la
 * liste des TRAMES servies (les « pas »), dans l'ordre : c'est elle qui dit si une trame agissante
 * repart, et une trame qui repart, c'est un deuxième café.
 */
const visites = (f: FileTaches, de: number, a: number) => {
  const servis: string[] = [];
  for (let t = de; t <= a; t += 1000) {
    f.dernierContact = t;
    tic(f, t);
    const s = aServir(f, t);
    if (s.quoi === "pas") servis.push(s.pas.nom);
  }
  return servis;
};
test("ARRÊT pendant la fenêtre d'une préparation : servi à la visite suivante, 0x83 jamais réémise", () => {
  const f = nouvelleFile();
  const prep = tache({ label: "Préparer", rang: RANG.COMMANDE, pas: [pasTrame("Préparer 0x83", "AAA=", { attente: "fenetre", ms: 75000, cmd: 0x83 })] });
  enfiler(f, prep, 0);
  eq(visites(f, 0, 5000), ["Préparer 0x83"], "la préparation part une fois");
  enfiler(f, tache({ label: "Arrêt", rang: RANG.URGENT, pas: [pasTrame("Arrêt", "AAA=", { attente: "fenetre", ms: 15000 })] }), 5500);
  // La trame de la préparation est livrée : préempter sa fenêtre accomplit le pas, il ne le suspend pas.
  eq(prep.pas[0].etat, "fait", "pas de la préparation accompli à la préemption");
  const s = aServir(f, 6000);
  eq(s.quoi === "pas" ? s.pas.nom : s.quoi, "Arrêt", "l'arrêt part à la visite suivante");
  const suite = visites(f, 7000, 120000);
  eq(suite, [], "rien ne repart ensuite — surtout pas la boisson");
  eq(prep.etat, "faite", "la préparation se conclut sans relancer");
  eq(f.liste.length, 0, "file vide : la fenêtre restante n'a pas bloqué la file");
});
test("une fenêtre préemptée ne réémet pas sa trame : la tâche reprend AU PAS SUIVANT", () => {
  // Le cas du transfert de recette : deux trames agissantes, chacune avec sa fenêtre.
  const f = nouvelleFile();
  const transfert = tache({ label: "Transfert", rang: RANG.COMMANDE, pas: [
    pasTrame("Réglages", "AAA=", { attente: "fenetre", ms: 20000 }),
    pasTrame("Nom", "AAA=", { attente: "fenetre", ms: 20000 }),
  ] });
  enfiler(f, transfert, 0);
  eq(visites(f, 0, 3000), ["Réglages"], "1re trame servie");
  enfiler(f, commande("Arrêt", RANG.URGENT), 3500);
  eq(visites(f, 4000, 80000), ["Arrêt", "Nom"], "l'arrêt, puis la 2e trame — jamais la 1re une seconde fois");
  eq(transfert.etat, "faite", "transfert conclu");
  eq(transfert.faits, 2, "deux pas accomplis");
});
test("rang strictement supérieur : une commande préempte la fenêtre d'une lecture, pas celle d'une commande", () => {
  const f = nouvelleFile();
  const fond = tache({ label: "Fond", rang: RANG.LECTURE, pas: [pasTrame("Fond", "AAA=", { attente: "fenetre", ms: 20000 })] });
  enfiler(f, fond, 0);
  aServir(f, 0);
  enfiler(f, commande("Allumer"), 100);
  eq(tete(f).label, "Allumer", "la commande prend la tête");
  eq(fond.pas[0].etat, "fait", "la fenêtre préemptée est accomplie");
  const g = nouvelleFile();
  const prep = commande("Préparer");
  enfiler(g, prep, 0);
  aServir(g, 0);
  enfiler(g, commande("Allumer"), 100);
  eq(tete(g).label, "Préparer", "même rang : pas de préemption");
  eq(prep.pas[0].etat, "servi", "la fenêtre court toujours");
});
test("un pas reponse servi n'est toujours pas préemptable, même par un ARRÊT", () => {
  const f = nouvelleFile();
  const lect = tache({ label: "Lecture", rang: RANG.COMMANDE, pas: [pasTrame("0xA2", "AAA=", { attente: "reponse", cmd: 0xa2 })] });
  enfiler(f, lect, 0);
  aServir(f, 0);
  enfiler(f, commande("Arrêt", RANG.URGENT), 100);
  eq(tete(f).label, "Lecture", "la lecture garde la tête");
  eq(aServir(f, 200).quoi, "soutien", "rien d'autre n'est servi");
  eq(lect.pas[0].etat, "servi", "toujours en vol");
  reponse(f, { reponse: true, cmd: 0xa2 }, 1000);
  const s = aServir(f, 1100);
  eq(s.quoi === "pas" ? s.tache.label : s.quoi, "Arrêt", "l'arrêt part dès la réponse");
});
test("la réponse tardive de A ne valide pas le pas de B (cmd fourni)", () => {
  const f = nouvelleFile();
  const a = tache({ label: "A", rang: RANG.LECTURE_BASSE, pas: [pasTrame("A", "AAA=", { attente: "reponse", cmd: 0xa2 })] });
  enfiler(f, a, 0);
  aServir(f, 0);                                  // A en vol
  const b = tache({ label: "B", rang: RANG.LECTURE, pas: [pasTrame("B", "AAA=", { attente: "reponse", cmd: 0xa3 })] });
  enfiler(f, b, 100);
  // A expire sans réponse (reprise en queue) : frontière de pas, B prend la tête et part.
  f.dernierContact = 100;
  tic(f, DELAIS.reponse + 1);
  aServir(f, DELAIS.reponse + 2);
  eq(tete(f).label, "B", "B en tête");
  eq(b.pas[0].etat, "servi", "B en vol");
  // La réponse de A arrive enfin : elle ne doit pas valider B.
  eq(reponse(f, { reponse: true, cmd: 0xa2 }, DELAIS.reponse + 500), null, "0xA2 n'apparie pas le pas 0xA3 (A n'est plus servi)");
  eq(b.faits, 0, "B intact");
  eq(reponse(f, { reponse: true, cmd: 0xa3 }, DELAIS.reponse + 600)?.label, "B", "sa propre réponse l'apparie");
});

console.log("\n— échéances, reprise, fin —");
test("un pas de lecture manqué repart UNE fois, puis compte comme perdu", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  f.dernierContact = 0;
  aServir(f, 0);                                  // sert « a »
  reponse(f, { prop: "a" }, 100);                 // contact établi
  aServir(f, 200);                                // sert « b »
  let ev = tic(f, 200 + DELAIS.prop + 1);         // « b » manque
  eq(ev.map((e) => e.type), ["repris"], "repris une fois");
  eq(tete(f).pas.length, 3, "le pas est remis en queue");
  aServir(f, 9000);                               // re-sert « b »
  ev = tic(f, 9000 + DELAIS.prop + 1);            // manque encore
  eq(ev.map((e) => e.type), ["perdu", "echouee"], "perdu, puis tâche échouée");
  eq(f.finies[0].nonLus, ["b"], "b est non lu");
});
test("une fenêtre atteinte est un SUCCÈS, pas une panne", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Allumer"), 0);
  f.dernierContact = 0;
  aServir(f, 0);
  const ev = tic(f, 20001);
  eq(ev.map((e) => e.type), ["faite"], "réussie");
  eq(f.finies[0].nonLus.length, 0, "rien de manquant");
});

console.log("\n— coupe-circuit —");
test("machine muette : la tête échoue et le reste est annulé, une seule fois", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b", "c"]), 0);
  enfiler(f, lecture("Autre", ["d"]), 0);
  enfiler(f, lecture("Encore", ["e"]), 0);
  aServir(f, 0);                                   // la machine ne viendra jamais
  const ev = tic(f, DELAIS.muet + 1);
  deType(ev[0], "muette", "verdict");
  eq(ev[0].restantes, 2, "les deux autres sont nommées");
  eq(f.liste.length, 0, "file vidée");
  eq(f.finies.map((t) => t.etat), ["annulee", "annulee", "echouee"], "états");
});
test("un contact repousse le coupe-circuit", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  aServir(f, 0);
  reponse(f, { prop: "a" }, DELAIS.muet - 1000);   // contact tardif mais réel
  eq(tic(f, DELAIS.muet + 1).length, 0, "pas de verdict");
});

test("une tache JAMAIS servie declenche quand meme le coupe-circuit", () => {
  // Le cas reel : la machine ne vient pas chercher la commande, donc `aServir` n'est jamais appele
  // et rien ne promeut la tache. Elle restait « en attente » pour toujours, sans verdict.
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  enfiler(f, lecture("Autre", ["c"]), 0);
  eq(tic(f, 1000).length, 0, "rien avant l'echeance");
  const ev = tic(f, DELAIS.muet + 2000);
  eq(ev[0].type, "muette", "verdict rendu sans qu'aucun pas ait ete servi");
  eq(f.liste.length, 0, "file videe");
});

console.log("\n— annulation —");
test("annuler garde une trace au lieu de faire disparaître", () => {
  const f = nouvelleFile();
  const a = accepte(enfiler(f, lecture("Import", ["a"]), 0)).tache;
  annuler(f, a.id, "demandée", 500);
  eq(f.liste.length, 0, "sortie de file");
  eq([f.finies[0].etat, f.finies[0].motif], ["annulee", "demandée"], "tracée");
});

console.log("\n— vue —");
test("la vue distingue en cours, en attente et terminées", () => {
  const f = nouvelleFile();
  enfiler(f, lecture("Import", ["a", "b"]), 0);
  enfiler(f, lecture("Autre", ["c"]), 0);
  aServir(f, 0);
  reponse(f, { prop: "a" }, 100);
  const v = vue(f);
  eq([v.encours?.label, v.encours?.faits, v.encours?.total, v.encours?.pasCourant], ["Import", 1, 2, "b"], "en cours");
  eq(v.attente.map((t) => t.label), ["Autre"], "en attente");
});

test("la clé de traduction du libellé traverse la vue", () => {
  const f = nouvelleFile();
  // Le serveur envoie un identifiant, le client traduit : si `vue()` laisse tomber `i18n`, le
  // panneau « Activité » retombe silencieusement sur le français du serveur et personne ne le voit.
  enfiler(f, tache({ label: "Boissons · profil 2", rang: RANG.LECTURE, pas: [pasLecture("a")], i18n: { k: "beverages", p: { profil: 2 } } }), 0);
  enfiler(f, tache({ label: "Allumer", rang: RANG.COMMANDE, pas: [pasLecture("b")] }), 0);
  const v = vue(f);
  const tout = [v.encours, ...v.attente].filter((t) => t !== null);
  eq(tout.find((t) => t.label.startsWith("Boissons"))?.i18n, { k: "beverages", p: { profil: 2 } }, "clé transmise");
  // Sans clé, le champ vaut null — c'est ce qui déclenche le repli sur le libellé du serveur.
  eq(tout.find((t) => t.label === "Allumer")?.i18n, null, "absence de clé explicite");
});

console.log("");
console.log("— repli des terminées —");
// Cas reel signale sur /pilotage : un coupe-circuit annule toute la file d'un coup, donc cinq
// « Presence » echouees ; la presence suivante reussit mais n'occupe qu'une des cinq lignes, et
// les quatre verdicts perimes restent affiches alors qu'ils decrivent un etat revolu.
const presence = () => tache({ label: "Présence", rang: RANG.LECTURE, pas: [pasLecture("p")], cle: "presence" });
test("une même demande ne laisse qu'UN verdict, le dernier", () => {
  const f = nouvelleFile();
  for (let i = 0; i < 4; i++) {
    enfiler(f, presence(), i * 100);
    annuler(f, null, "muette", i * 100 + 50);
  }
  eq(vue(f).finies.length, 1, "une seule ligne");
  eq(vue(f).finies[0].repetitions, 4, "le compte est gardé");
  // Puis elle reussit : c'est CE verdict qui doit rester.
  enfiler(f, presence(), 1000);
  aServir(f, 1000);
  reponse(f, { prop: "p" }, 1100);
  tic(f, 1100);
  eq(vue(f).finies.map((t) => [t.label, t.etat, t.repetitions]), [["Présence", "faite", 5]], "dernier verdict");
});
test("le repli ne masque pas une AUTRE demande", () => {
  const f = nouvelleFile();
  enfiler(f, presence(), 0);
  enfiler(f, tache({ label: "Sommes", rang: RANG.LECTURE, pas: [pasLecture("s")], cle: "checksums" }), 0);
  annuler(f, null, "muette", 50);
  eq(vue(f).finies.map((t) => t.label), ["Sommes", "Présence"], "deux lignes distinctes");
});
test("sans clé, aucun repli : deux cafés font deux lignes", () => {
  const f = nouvelleFile();
  enfiler(f, commande("Préparer Espresso"), 0);
  annuler(f, null, "annulée", 10);
  enfiler(f, commande("Préparer Espresso"), 20);
  annuler(f, null, "annulée", 30);
  eq(vue(f).finies.map((t) => [t.label, t.repetitions]), [["Préparer Espresso", 1], ["Préparer Espresso", 1]], "deux lignes");
});
test("le repli libère de la place : cinq demandes distinctes restent visibles", () => {
  const f = nouvelleFile();
  for (const c of ["presence", "checksums", "reglages", "initiale", "profils"]) {
    enfiler(f, tache({ label: c, rang: RANG.LECTURE, pas: [pasLecture("p")], cle: c }), 0);
  }
  annuler(f, null, "muette", 50);
  // Une nouvelle presence se replie sur l'ancienne au lieu de chasser la plus vieille des cinq.
  enfiler(f, presence(), 100);
  annuler(f, null, "muette", 150);
  eq(vue(f).finies.length, 5, "cinq lignes");
  eq(new Set(vue(f).finies.map((t) => t.label)).size, 5, "cinq demandes distinctes");
});

console.log("\n— la réponse à 0x75 arrive en poussée de monitor, pas en data_response —");

test("une poussée de monitor satisfait un pas 0x75", () => {
  // Le défaut mesuré sur la machine : le pas « Présence » ne pouvait être satisfait que par un
  // data_response, que la machine n'envoie pas pour cette commande — elle répond en poussant
  // d302_monitor. État reçu et affiché à l'écran, tâche déclarée « sans réponse » puis échouée.
  const f = nouvelleFile();
  const pres = tache({ label: "Présence", rang: RANG.LECTURE, genre: "lecture",
    pas: [pasTrame("Présence", "AAA=", { attente: "reponse", cmd: 0x75 })] });
  enfiler(f, pres, 1000);
  aServir(f, 1000);
  eq(reponse(f, { reponse: true, cmd: 0x75 }, 2000)?.label, "Présence", "le monitor apparie le pas 0x75");
  eq(pres.faits, 1, "pas fait");
});

test("un monitor SPONTANÉ ne valide pas un pas qui attend autre chose", () => {
  // Pendant une préparation la machine pousse un monitor toutes les 1 à 3 s. Apparier largement
  // déclarerait lus des compteurs jamais lus — le pire des résultats, silencieux et faux.
  const f = nouvelleFile();
  const st = tache({ label: "Statistiques", rang: RANG.LECTURE_BASSE, genre: "lecture",
    pas: [pasTrame("Paramètres 3001", "AAA=", { attente: "reponse", cmd: 0xa2 })] });
  enfiler(f, st, 1000);
  aServir(f, 1000);
  eq(reponse(f, { reponse: true, cmd: 0x75 }, 2000), null, "le monitor n'apparie pas le pas 0xA2");
  eq(st.faits, 0, "pas intact");
  // Sans cmd, comportement d'origine conservé : restreindre à l'aveugle ferait échouer des
  // lectures qui fonctionnent aujourd'hui.
  eq(reponse(f, { reponse: true }, 3000)?.label, "Statistiques", "un data_response non qualifié apparie encore");
});

console.log("\n— la réponse à 0xBA arrive en poussée de d(250+n)_beansystem_n —");

test("un pas 0xBA n'est PAS apparié par le nom de la propriété qui le satisfait", () => {
  // Le défaut, mesuré le 2026-08-26. Le pas d'un balayage de grains est un pas de TRAME, donc de
  // type « reponse » ; la machine, elle, répond en poussant une PROPRIÉTÉ. Le serveur appariait
  // sur ce nom de propriété — ce qui ne peut coller à aucun pas de trame. Résultat : les quatre
  // grains rangés en base, noms et réglages corrects, et la tâche échouée en « 6 sans réponse ».
  const f = nouvelleFile();
  const scan = tache({ label: "Balayage des grains", rang: RANG.LECTURE, genre: "lecture",
    pas: [pasTrame("Bean System 1", "AAA=", { attente: "reponse", cmd: 0xba })] });
  enfiler(f, scan, 1000);
  aServir(f, 1000);
  eq(reponse(f, { prop: "d251_beansystem_1" }, 2000), null, "le nom de propriété n'apparie rien");
  eq(scan.faits, 0, "pas intact");
  eq(reponse(f, { reponse: true, cmd: 0xba }, 2100)?.label, "Balayage des grains", "la commande 0xBA apparie");
  eq(scan.faits, 1, "pas fait");
});

test("une poussée 0xBA ne valide pas un pas qui attend une autre commande", () => {
  // La machine pousse aussi ces propriétés d'elle-même après une écriture 0xBB : apparier
  // largement validerait le pas d'une lecture qui attendait tout autre chose.
  const f = nouvelleFile();
  const st = tache({ label: "Statistiques", rang: RANG.LECTURE_BASSE, genre: "lecture",
    pas: [pasTrame("Paramètres 3001", "AAA=", { attente: "reponse", cmd: 0xa2 })] });
  enfiler(f, st, 1000);
  aServir(f, 1000);
  eq(reponse(f, { reponse: true, cmd: 0xba }, 2000), null, "0xBA n'apparie pas le pas 0xA2");
  eq(st.faits, 0, "pas intact");
});

test("un pas de trame construit sans `cmd` reste hors de portée d'un appariement étroit", () => {
  // L'autre moitié du même défaut, côté serveur : `scanBeans` bâtissait ses pas avec `pasTrame` en
  // laissant `cmd` à null, donc même l'appariement par commande n'avait rien à quoi se raccrocher.
  // La règle « nature + commande » ne vit qu'à un endroit, `pasPourTrame` ; voici pourquoi.
  const f = nouvelleFile();
  const scan = tache({ label: "Balayage sans cmd", rang: RANG.LECTURE, genre: "lecture",
    pas: [pasTrame("Bean System 1", "AAA=", { attente: "reponse" })] });
  enfiler(f, scan, 1000);
  aServir(f, 1000);
  eq(reponse(f, { reponse: true, cmd: 0xba }, 2000), null, "cmd null n'apparie aucune commande");
  eq(scan.faits, 0, "pas intact");
});

console.log(ko ? `\n${ko} ÉCHEC(S)\n` : "\nTout passe.\n");
process.exit(ko ? 1 : 0);
