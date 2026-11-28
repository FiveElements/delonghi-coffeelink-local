/**
 * Ce que la réponse d'une commande dit de **l'annonce**, et pourquoi il faut le lire.
 *
 * **Les rôles sont inversés : la machine est le client HTTP.** Poser une commande dans la file ne la
 * lui envoie pas — il faut d'abord lui annoncer notre adresse (`local_reg`), après quoi c'est ELLE
 * qui vient chercher la trame. Si l'annonce n'arrive pas, la commande reste dans la file et la
 * machine n'en sait rien.
 *
 * Or `POST /api/command` répond `{ program, register: { ok: false, error } }` dans ce cas, et les
 * deux pages qui envoient des commandes ne lisaient que `error` — jamais `register`. Elles
 * affichaient donc « Commande envoyée : Allumer » pendant que le journal enregistrait quarante
 * échecs d'annonce d'affilée et que la cafetière restait éteinte. C'est le défaut relevé sur la
 * machine réelle : le geste marchait, le serveur avait bien construit la trame, et rien à l'écran
 * ne disait que l'appareil n'avait jamais été joint.
 *
 * Le message technique (« socket hang up ») **reste au journal** : ce qui remonte ici est une cause,
 * pas une chaîne de protocole.
 */
import type { Translator } from "./machineState";

/** La cause d'un échec d'annonce, ou `null` si l'annonce est passée (ou n'a rien à dire). */
export function echecAnnonce(r: unknown): string | null {
  const reg = (r as { register?: { ok?: boolean; error?: unknown } } | null)?.register;
  if (!reg || reg.ok !== false) return null;
  // Toute cause inconnue retombe sur « injoignable » : mieux vaut la phrase générique que le
  // silence, qui est précisément ce qu'on corrige.
  return typeof reg.error === "string" && reg.error ? reg.error : "unreachable";
}

/**
 * La clé de message correspondante, dans l'espace `common`.
 *
 * `machineIp` et `serverIp` sont normalement pré-empés par le garde 409 côté serveur — ils sont
 * traités quand même : un prérequis qui disparaît entre le garde et l'annonce ne doit pas produire
 * une phrase vide.
 */
export function cleAnnonce(cause: string): string {
  if (cause === "dns") return "regDns";
  if (cause === "machineIp") return "regNoAddress";
  if (cause === "serverIp") return "regServerIp";
  return "regUnreachable";
}


/**
 * **Le verdict d'une réponse d'action, au même endroit pour toutes les pages.**
 *
 * `echecAnnonce` n'était lu que sur `/` et `/pilotage` : `/beans`, `/profils`, `/reglages`,
 * `/recipes` et les dialogues de grain ne regardaient que `error` et annonçaient « envoyé » à une
 * cafetière qui n'avait rien entendu — le défaut que ce fichier existe pour corriger, reproduit
 * ailleurs. Une seule fonction, pour qu'une page de plus ne puisse pas l'oublier à son tour.
 *
 * Rend `null` quand la réponse ne dit aucun échec, sinon la phrase à afficher. Une réponse sans
 * `register` (une écriture locale, un calcul) se réduit à son `error`.
 */
export function echecAction(r: unknown, tc: Translator): string | null {
  const err = (r as { error?: unknown } | null)?.error;
  if (err) return tc("error", { message: String(err) });
  const annonce = echecAnnonce(r);
  return annonce ? tc(cleAnnonce(annonce)) : null;
}

/** Le compte rendu `{ text, kind }` que les pages affichent dans leur `.status`. */
export interface CompteRendu {
  text: string;
  kind: "ok" | "err";
}

/** `echecAction` mis en forme : l'échec s'il y en a un, sinon `ok`. */
export function compteRendu(r: unknown, ok: string, tc: Translator): CompteRendu {
  const echec = echecAction(r, tc);
  return echec ? { text: echec, kind: "err" } : { text: ok, kind: "ok" };
}

/**
 * Un `fetch` qui rejette n'a pas atteint le serveur ; un `fetch` qui répond 500 l'a atteint. La
 * distinction décide de la phrase : dans le premier cas il n'y a rien à corriger côté machine, et
 * rien d'autre à proposer que de réessayer.
 */
export function injoignable(e: unknown): boolean {
  return e instanceof TypeError;
}

/**
 * La raison d'une exception, en langue d'intention plutôt qu'en nom de classe JavaScript.
 *
 * Partagée parce qu'une vingtaine de gestionnaires faisaient `try { mfetch… } finally` sans
 * `catch` : une panne de liaison y devenait une promesse rejetée que personne n'écoutait, la page
 * restait muette — ou figée sur « Lecture en cours… » pour toujours.
 */
export function raisonEchec(e: unknown, tc: Translator): string {
  if (injoignable(e)) return tc("serverUnreachable");
  return tc("error", { message: e instanceof Error ? e.message : String(e) });
}

/** `raisonEchec` sous la forme d'un compte rendu d'échec, pour les `catch` des pages. */
export function echecReseau(e: unknown, tc: Translator): CompteRendu {
  return { text: raisonEchec(e, tc), kind: "err" };
}
