/**
 * Registre des applications branchées sur lan-server quand il joue le rôle de la machine.
 *
 * ⚠️ Ce module TOURNE. Ce n'est pas une des copies `.ts` shadowées.
 *
 * Voir `doc/spec-proxy-multi-app.md` : la machine ne retient **qu'un seul** interlocuteur local
 * (`local_reg` est une ressource au singulier, POST puis PUT, avec un `delete_session`). Deux
 * clients se chassent donc l'un l'autre sans erreur ni journal. Le multiplexeur lève ce verrou en
 * étant lui-même ce client unique, et en servant N applications derrière.
 *
 * **Ce fichier est pur** : aucune E/S, aucun `Date.now()` — l'instant est toujours un paramètre,
 * exactement comme dans `tasks.ts`, et pour la même raison : c'est ce qui rend `verif-apps.ts`
 * possible sans machine, sans téléphone et sans réseau.
 *
 * ## L'identité d'une application
 *
 * C'est son couple **adresse:port**, parce que c'est tout ce que `local_reg` nous donne — il ne
 * porte ni identifiant d'application, ni identifiant de téléphone. Deux conséquences à assumer
 * plutôt qu'à découvrir : deux applications derrière la même adresse ET le même port sont
 * indistinguables (mais elles ne peuvent pas écouter le même port), et un téléphone qui change
 * d'adresse revient comme une nouvelle application. Le second cas est la raison de `expirer()`.
 *
 * ## Les refus sont des données, pas des erreurs
 *
 * `refus` garde une trace bornée de ce qui a été REFUSÉ : mauvaise clé, DSN inconnu, session
 * absente. C'est la moitié « surveillance des usurpations » de la page : sans elle, quelqu'un qui
 * tente sa chance sur le réseau local ne laisse aucune trace visible, et un échec de configuration
 * légitime ressemble exactement à une tentative. Les deux méritent d'être vus.
 */

/** Combien de refus on garde. Assez pour voir une rafale, pas assez pour noyer la page. */
import type { SessionLan } from "./lansession.ts";

export const GARDE_REFUS = 20;

/** Sans contact pendant ce délai, une application est considérée partie. */
export const DELAI_APP_MUETTE = 90_000;

/**
 * Échecs consécutifs après lesquels une application est déclarée injoignable.
 *
 * Le silence et le refus ne sont pas la même information, et les confondre coûte cher. Une
 * application relancée abandonne son port d'écoute : nos requêtes sont alors **refusées**
 * immédiatement, ce qui est une preuve, pas une absence. Attendre `DELAI_APP_MUETTE` dans ce cas
 * revient à afficher « session établie » pendant une minute et demie sur un port fermé — constaté
 * en direct après un redémarrage de l'application officielle, avec deux entrées dont une morte.
 *
 * Trois échecs à la cadence de sonde valent une douzaine de secondes : assez pour absorber un
 * téléphone qui se met en veille une seconde, trop peu pour laisser vivre un fantôme.
 */
export const SEUIL_ECHECS = 3;

/** « annoncee » → « etablie » quand l'échange de clés aboutit ; « expiree » à la sortie du registre. */
export type EtatApp = "annoncee" | "etablie" | "expiree";

/**
 * Une application branchée. Les champs optionnels du bas ne sont pas posés ici : `server.ts` les
 * accroche (verrous, chaîne de poussées, machine pilotée) — les déclarer au même endroit évite
 * qu'une seconde définition de la même structure diverge de celle-ci.
 */
export interface AppBranchee {
  id: string;
  ip: string;
  port: number | string;
  uri: string;
  notify: 0 | 1;
  keyId: number | string | null;
  etat: EtatApp;
  /** La session LAN, rôle « device ». Opaque pour ce module : il ne fait que la ranger. */
  session: SessionLan | null;
  creeA: number;
  vueA: number;
  sessionA: number | null;
  annonces: number;
  datapoints: number;
  commandes: number;
  echecs: number;
  /** propriété → `cmd_id` de la lecture en attente (voir `annoncer`). */
  lectures: Map<string, number | string>;
  ua: string | null;
  dernierMotif: string | null;
  // --- accrochés par server.ts ---
  machineId?: string;
  echangeEnCours?: boolean;
  sondeEnCours?: boolean;
  dernierSondage?: string;
  relanceA?: number;
  chaine?: Promise<void>;
}

/** Un refus noté, replié sur ses répétitions consécutives. */
export interface Refus { at: number; from: string; motif: string; detail: string | null; repetitions: number }

export interface Registre { seq: number; apps: Map<string, AppBranchee>; refus: Refus[] }

/** Ce que `local_reg` transporte — `notify` est lu comme un booléen, quelle que soit sa forme. */
export interface Annonce { ip: string; port: number | string; uri?: string | null; notify?: unknown; keyId?: number | string | null }

export function nouveauRegistre(): Registre {
  return { seq: 0, apps: new Map(), refus: [] };
}

/** La clé d'identité : tout ce que `local_reg` nous donne pour distinguer deux applications. */
export const cleApp = (ip: string, port: number | string): string => `${ip}:${port}`;

/**
 * Une application s'annonce (`POST`) ou se rafraîchit (`PUT`).
 *
 * Renvoie `{ app, nouvelle }`. `nouvelle` vaut `true` quand c'est une première annonce : c'est ce
 * qui doit déclencher un échange de clés, et **seulement** à ce moment — un `PUT` ne doit pas en
 * relancer un, sinon chaque rafraîchissement casserait le flux AES en cours.
 */
export function annoncer(reg: Registre, { ip, port, uri, notify, keyId }: Annonce, maintenant: number): { app: AppBranchee; nouvelle: boolean } {
  const cle = cleApp(ip, port);
  const existante = reg.apps.get(cle);
  if (existante) {
    existante.uri = uri ?? existante.uri;
    existante.notify = notify ? 1 : 0;
    existante.vueA = maintenant;
    existante.annonces++;
    return { app: existante, nouvelle: false };
  }
  const app: AppBranchee = {
    id: `a${++reg.seq}`,
    ip,
    port,
    uri: uri ?? "/local_lan",
    notify: notify ? 1 : 0,
    keyId: keyId ?? null,
    /** « annoncee » → « etablie » quand l'échange de clés aboutit. */
    etat: "annoncee",
    session: null,
    creeA: maintenant,
    vueA: maintenant,
    sessionA: null,
    annonces: 1,
    /** Compteurs de trafic : ce que la page montre pour distinguer « branchée » de « active ». */
    datapoints: 0,
    commandes: 0,
    /** Échecs de contact CONSÉCUTIFS. Remis à zéro par le moindre succès (voir `toucher`). */
    echecs: 0,
    /**
     * **Les lectures que cette application attend, par propriété → `cmd_id`.**
     *
     * Une commande `GET property.json?name=X` n'est PAS dénouée par une réponse HTTP : elle
     * l'est par un POST de datapoint que nous initions, et le SDK ne le rattache à la commande
     * que par le paramètre d'URL `cmd_id` (`AylaLanModule.getCommand()` lit
     * `session.getParms().get("cmd_id")`). Sans lui la commande reste en attente et meurt sur
     * `defaultNetworkTimeoutMs` — 5 secondes, mesurées.
     *
     * On retient donc l'identifiant jusqu'à ce qu'on ait la valeur : soit tout de suite depuis
     * le cache, soit quand la machine pousse la propriété. Une seule entrée par propriété — un
     * réessai remplace le `cmd_id` précédent, qui a déjà expiré côté application.
     */
    lectures: new Map(),
    /**
     * `User-Agent` du client, quand il en met un. **Hors protocole et non fiable** : `local_reg`
     * ne transporte aucune identité (voir `handleAppReg`), et n'importe qui peut écrire ce qu'il
     * veut dans cet en-tête. Il documente la NATURE du client — application officielle, script,
     * notre faux-app — il n'authentifie personne et ne sépare pas deux instances identiques.
     */
    ua: null,
    dernierMotif: null,
  };
  reg.apps.set(cle, app);
  return { app, nouvelle: true };
}

/** L'échange de clés a abouti : la session est utilisable dans les deux sens. */
export function etablir(reg: Registre, app: AppBranchee, session: SessionLan, maintenant: number): AppBranchee {
  app.session = session;
  app.etat = "etablie";
  app.sessionA = maintenant;
  app.vueA = maintenant;
  app.dernierMotif = null;
  return app;
}

/** Une application s'en va (`DELETE`), ou on la retire. Renvoie `true` si elle était connue. */
export function oublier(reg: Registre, app: AppBranchee): boolean {
  return reg.apps.delete(cleApp(app.ip, app.port));
}

/**
 * Retire les applications muettes depuis trop longtemps, et renvoie celles qui sont parties.
 *
 * Sans cela on rechiffrerait indéfiniment vers un téléphone éteint : une session app qui ne sert
 * plus consomme un flux AES, une entrée de diffusion et une ligne de page — et surtout, elle ferait
 * croire à quelqu'un qui regarde la page que trois téléphones sont branchés quand il n'y en a plus.
 */
export function expirer(reg: Registre, maintenant: number, delai = DELAI_APP_MUETTE): AppBranchee[] {
  const partis: AppBranchee[] = [];
  for (const [cle, app] of reg.apps) {
    if (maintenant - app.vueA < delai) continue;
    reg.apps.delete(cle);
    app.etat = "expiree";
    partis.push(app);
  }
  return partis;
}

/**
 * Toute activité d'une application repousse son expiration — et efface ses échecs.
 *
 * Le compteur d'échecs est CONSÉCUTIF : un seul contact réussi annule ce qui précède. Un
 * téléphone qui se met en veille une seconde entre deux sondes n'est pas un téléphone parti.
 */
export function toucher(app: AppBranchee, maintenant: number): void {
  app.vueA = maintenant;
  app.echecs = 0;
}

/**
 * Une tentative de contact vers l'application a échoué. Renvoie `true` quand elle a assez
 * échoué de suite pour être déclarée injoignable — à l'appelant de la retirer et de le dire.
 *
 * Le port d'écoute d'une application est éphémère : elle en prend un nouveau à chaque
 * lancement. L'ancienne entrée, elle, reste `etablie` jusqu'à `DELAI_APP_MUETTE`, alors même
 * que son port est fermé et le refuse immédiatement. Compter les refus transforme cette preuve
 * en retrait, au lieu d'attendre une minute et demie un silence déjà expliqué.
 */
export function echouer(app: AppBranchee, seuil = SEUIL_ECHECS): boolean {
  app.echecs = (app.echecs ?? 0) + 1;
  return app.echecs >= seuil;
}

/**
 * Note un refus. `motif` est un identifiant de protocole, pas une phrase : l'interface le traduit,
 * comme partout ailleurs ici.
 *
 * Motifs prévus : `cleInconnue` (le `key_id` ne correspond à aucune machine), `dsnInconnu`,
 * `sansSession` (une requête chiffrée avant tout échange de clés), `desactive` (le proxy est
 * éteint), `echecEchange` (l'échange de clés n'a pas abouti).
 */
export function refuser(
  reg: Registre,
  { from, motif, detail = null }: { from: string; motif: string; detail?: string | null },
  maintenant: number,
): Refus {
  const entree: Refus = { at: maintenant, from, motif, detail, repetitions: 1 };
  // Repli des refus identiques consécutifs, même règle que le journal : une rafale de tentatives
  // remplit la liste et chasse tout le reste, alors que « ×12 » dit la même chose et mieux.
  const tete = reg.refus[0];
  if (tete && tete.from === from && tete.motif === motif && tete.detail === detail) {
    tete.at = maintenant;
    tete.repetitions = (tete.repetitions ?? 1) + 1;
    return tete;
  }
  reg.refus.unshift(entree);
  reg.refus.length = Math.min(reg.refus.length, GARDE_REFUS);
  return entree;
}

/**
 * Ce que l'API expose et que la page rend. **Aucune session n'en sort** : elle porte des clés
 * dérivées, elle n'a rien à faire dans une réponse HTTP.
 */
export function vue(reg: Registre, maintenant: number) {
  const apps = [...reg.apps.values()].map((a) => ({
    id: a.id,
    machineId: a.machineId ?? null,
    ip: a.ip,
    port: a.port,
    etat: a.etat,
    keyId: a.keyId,
    ua: a.ua ?? null,
    notify: a.notify,
    creeA: a.creeA,
    vueA: a.vueA,
    sessionA: a.sessionA,
    ageSec: Math.round((maintenant - a.vueA) / 1000),
    annonces: a.annonces,
    datapoints: a.datapoints,
    commandes: a.commandes,
    dernierMotif: a.dernierMotif,
  }));
  return {
    apps,
    etablies: apps.filter((a) => a.etat === "etablie").length,
    refus: reg.refus.map((r) => ({ ...r })),
  };
}
