/**
 * Le côté « appareil » du multiplexeur : ce que lan-server dit et fait vers une APPLICATION qui
 * le prend pour la machine.
 *
 * ⚠️ Ce module TOURNE. Ce n'est pas une des copies `.ts` shadowées.
 *
 * Il ne contient **que** le transport et l'analyse des charges utiles ; la décision de servir ou
 * de refuser appartient à `server.ts`, et l'état des applications à `appregistry.ts`. La
 * fonction pure de ce fichier — `analyserCommandes()` — est celle qui compte : c'est elle qui
 * traduit ce qu'une application demande en intentions que notre file peut exécuter, et c'est la
 * seule partie vérifiable sans téléphone (`scripts/verif-apps.ts`).
 *
 * ## Les deux formes qu'une application sert dans `commands.json`
 *
 * Relevées dans le SDK décompilé, pas devinées :
 *
 * ```
 * AylaLanCommand.getPayload()          {"cmds":[{"cmd":{cmd_id, method, resource, data, uri}}]}
 * CreateDatapointCommand.getPayload()  {"properties":[{"property":{name, value, dsn, base_type, id}}]}
 * ```
 *
 * La première est une **lecture** (`GET property.json?name=X`) ou la fin de session
 * (`DELETE local_reg.json`, data `delete_session`). La seconde est une **écriture** de datapoint,
 * et c'est celle qui porte les trames ECAM que l'application veut faire exécuter.
 *
 * Ce sont exactement les deux formes que notre propre `prochainePaquet()` sert à la machine — ce
 * qui est normal : dans les deux cas c'est le client qui parle à l'appareil. Le multiplexeur est
 * cette symétrie prise au mot.
 *
 * ## Pourquoi ce n'est pas un tuyau
 *
 * On ne peut pas relayer les octets tels quels. Chaque session a son **propre** flux AES-CBC
 * persistant (voir `lansession.ts`) : le chiffré destiné à l'application n'a de sens que dans le
 * flux de l'application. Tout ce qui traverse est donc déchiffré d'un côté et rechiffré de
 * l'autre, et c'est ce qui rend le multiplexage possible — N flux indépendants au lieu d'un.
 */
import http from "node:http";

/** Le port sur lequel une application cherche l'appareil : le SDK construit `http://<ip>/…`. */
export const PORT_ATTENDU_PAR_APP = 80;

/**
 * Requête JSON vers une application, en `node:http` avec `Content-Length` explicite.
 *
 * Le même choix que pour `local_reg` vers la machine, et pour une raison de plus ici : le serveur
 * HTTP embarqué du SDK Android (NanoHTTPD) est aussi économe que celui de l'ESP32. `fetch`/undici
 * ajoute un `transfer-encoding` et des en-têtes que rien n'oblige ces serveurs à accepter.
 */
/**
 * Les codes réseau qui PROUVENT qu'il n'y a plus personne à l'écoute. `ETIMEDOUT` n'en est pas.
 *
 * La distinction est la justification même de l'éviction rapide : un port fermé répond non, et
 * c'est un fait sur l'application ; un silence ne dit rien, le téléphone peut être verrouillé. Les
 * confondre — ce que faisait le code, faute de code d'erreur porté jusqu'à l'appelant — évinçait en
 * une douzaine de secondes une application qui s'était seulement tue. Mesuré sur la vraie
 * application : sortie du registre en 16 s, revenue 9 s plus tard sur le MÊME port d'écoute.
 */
export const REFUS_RESEAU: ReadonlySet<string> = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

/**
 * **Les statuts qui portent une charge chiffrée : `200` ET `206`.**
 *
 * ⚠️ Le `206` n'est pas une curiosité, c'est le cœur du protocole côté application, et le lire
 * dans le SDK décompilé est la seule façon de le savoir :
 *
 * ```java
 * private Status getResponseCode() {
 *     return this._pendingLanCommands.size() > 0 ? PARTIAL_CONTENT : OK;
 * }
 * ```
 *
 * Autrement dit **`206` veut dire « il me reste des commandes en file »** et `200` « c'était la
 * dernière ». Les deux réponses portent la MÊME charge chiffrée — le statut ne qualifie pas le
 * corps, il annonce la suite.
 *
 * Ne traiter que le `200` avait donc l'effet exactement inverse de l'intention : on jetait
 * précisément les réponses qui transportaient une commande. Et jeter est ici irréparable, deux
 * fois — le SDK retire la commande de sa file au moment où il la **chiffre**, sans réessai (voir
 * `handleLanCommandRequest`), et le message chiffré qu'on n'a pas déchiffré laisse notre flux
 * AES-CBC un message en arrière, donc tout ce qui suit est illisible.
 *
 * Mesuré en direct sur l'application officielle : `sonde commands.json — HTTP 206, 300 o — non
 * déchiffré`, puis un bloc illisible finissant par `…ta":{}}`, et un allumage que l'appareil n'a
 * jamais reçu alors que le téléphone journalisait `AylaDatapoint sent to SDK: 0d 07 84 0f 02 01`.
 */
export const STATUTS_AVEC_CHARGE: ReadonlySet<number> = new Set([200, 206]);

/** Pur, donc prouvable sans réseau : cette réponse transporte-t-elle quelque chose à déchiffrer ? */
export const porteUneCharge = (status: unknown, corps: unknown): boolean =>
  STATUTS_AVEC_CHARGE.has(Number(status)) && String(corps ?? "").trim().length > 0;

/**
 * `206` : l'application dit qu'il lui en reste. Y retourner tout de suite plutôt qu'au prochain
 * tour de sonde — un lot de dix commandes mettrait vingt secondes à arriver alors que
 * l'utilisateur vient d'appuyer sur un bouton.
 */
export const encoreDesCommandes = (status: unknown): boolean => Number(status) === 206;

/** Pur, donc prouvable sans réseau : cette erreur est-elle un refus, ou seulement un silence ? */
export const estRefus = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null | undefined)?.code; // une erreur réseau Node, ou n'importe quoi d'autre
  return typeof code === "string" && REFUS_RESEAU.has(code);
};

export interface RequeteJson {
  ip: string;
  port: number | string;
  path: string;
  method?: string;
  body?: string | null;
  timeout?: number;
}
/** `status` peut manquer : `IncomingMessage.statusCode` est optionnel côté Node. */
export interface ReponseJson { status: number | undefined; corps: string }

export function httpJson({ ip, port, path, method = "POST", body = null, timeout = 5000 }: RequeteJson): Promise<ReponseJson> {
  return new Promise((resolve, reject) => {
    const buf = body == null ? null : Buffer.from(body, "utf8");
    const req = http.request(
      {
        host: ip,
        port,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(buf ? { "Content-Type": "application/json", "Content-Length": buf.length } : {}),
        },
        timeout,
      },
      (res) => {
        const morceaux: Buffer[] = [];
        res.on("data", (c: Buffer) => morceaux.push(c));
        res.on("end", () => resolve({ status: res.statusCode, corps: Buffer.concat(morceaux).toString("utf8") }));
      },
    );
    // Le code d'erreur est PORTÉ, pas seulement le message : un délai dépassé et un refus de
    // connexion n'ont pas la même valeur de preuve. Un port fermé répond non — c'est un fait sur
    // l'application. Un silence ne dit rien : le téléphone peut être verrouillé. Sans ce code,
    // l'appelant ne peut que les confondre, et l'éviction rapide conçue pour les refus frappait
    // aussi les silences (constaté : une application déclarée injoignable en 16 s, revenue sur le
    // MÊME port 9 s plus tard — elle n'était jamais partie).
    req.on("timeout", () => {
      req.destroy(Object.assign(new Error("délai dépassé"), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

/**
 * Ouvre une session vers une application, dans le rôle de l'appareil.
 *
 * C'est le miroir exact de ce que la machine nous fait : **c'est l'appareil qui initie**. Nous
 * postons `random_1` / `time_1` / `key_id`, l'application répond `random_2` / `time_2`.
 *
 * `time_1` part en **nombre**, et `time_2` est relu sur le corps BRUT par expression régulière —
 * les deux précautions viennent du côté machine, où un `time_2` en chaîne faisait échouer
 * l'échange et où `JSON.parse` perdait de la précision sur des entiers longs. Rien ne garantit
 * que l'implémentation d'en face soit plus tolérante que celle-ci.
 */
export async function echangeClesVersApp({ ip, port, uri, keyId, random1, time1, timeout = 5000 }: {
  ip: string;
  port: number | string;
  uri: string;
  keyId: number | string | null;
  random1: string;
  time1: number | string;
  timeout?: number;
}): Promise<{ random2: string; time2: string }> {
  const corps = JSON.stringify({
    key_exchange: { ver: 1, proto: 1, key_id: Number(keyId), random_1: random1, time_1: Number(time1) },
  });
  const rep = await httpJson({ ip, port, path: `${uri}/key_exchange.json`, method: "POST", body: corps, timeout });
  if (rep.status !== 200) throw new Error(`échange de clés refusé (HTTP ${rep.status})`);
  const brut = rep.corps.match(/"time_2"\s*:\s*"?(-?\d+)"?/);
  const j: unknown = JSON.parse(rep.corps);
  const random2 = champ(j, "random_2") ?? champ(champ(j, "key_exchange"), "random_2");
  // Le test de type remplace le seul test de vérité : un `random_2` non textuel ne peut de toute
  // façon pas entrer dans la dérivation (`Buffer.from(random, "utf8")`).
  if (typeof random2 !== "string" || !random2 || !brut) throw new Error("réponse d'échange de clés incomplète");
  return { random2, time2: brut[1] };
}

/** Un champ d'un JSON reçu, sans présumer de sa forme : `undefined` dès que ce n'est pas un objet. */
export function champ(o: unknown, cle: string): unknown {
  return o !== null && typeof o === "object" ? (o as Record<string, unknown>)[cle] : undefined;
}

/** Ce que `analyserCommandes` sait nommer. `inconnu` garde sa charge : elle doit se voir au journal. */
export type IntentionApp =
  | { type: "illisible"; brut: string }
  | { type: "finSession"; cmdId: unknown }
  | { type: "lecture"; cmdId: unknown; nom: string; uri: unknown }
  | { type: "inconnu"; charge: unknown }
  | { type: "ecriture"; nom: string; valeur: unknown; ackId: unknown; dsn: unknown }
  | { type: "vide" };

/**
 * Analyse une charge utile déchiffrée reçue d'une application, et rend des **intentions**.
 *
 * Fonction pure — c'est délibéré, et c'est ce qui rend `verif-apps.ts` possible. Elle ne décide
 * rien : elle nomme. Ce qui n'est pas reconnu ressort en `{type:"inconnu"}` **avec sa charge**,
 * plutôt que d'être ignoré : une application qui nous demande quelque chose que nous ne savons pas
 * faire doit apparaître dans le journal, pas disparaître.
 */
export function analyserCommandes(clair: string): IntentionApp[] {
  let j: unknown;
  try {
    j = JSON.parse(clair);
  } catch {
    return [{ type: "illisible", brut: clair.slice(0, 200) }];
  }
  // La charge chiffrée est enveloppée dans `{seq_no, data}` par `encapsulate`. Selon l'appelant on
  // reçoit l'enveloppe ou déjà son contenu ; accepter les deux évite un dépliage en double.
  const data = champ(j, "data");
  const d = j && typeof data === "object" && data !== null ? data : j;
  const out: IntentionApp[] = [];

  // `?? []` gardé tel quel : une valeur non nulle mais non itérable lève, comme avant.
  for (const e of (champ(d, "cmds") ?? []) as Iterable<unknown>) {
    const c = champ(e, "cmd") ?? e;
    if (!c) continue;
    if (champ(c, "method") === "DELETE" && String(champ(c, "resource")).startsWith("local_reg")) {
      out.push({ type: "finSession", cmdId: champ(c, "cmd_id") ?? champ(c, "cmdId") ?? 0 });
      continue;
    }
    const nom = String(champ(c, "resource") ?? "").match(/name=([^&]+)/);
    if (champ(c, "method") === "GET" && nom) {
      out.push({ type: "lecture", cmdId: champ(c, "cmd_id") ?? champ(c, "cmdId") ?? 0, nom: decodeURIComponent(nom[1]), uri: champ(c, "uri") ?? null });
      continue;
    }
    out.push({ type: "inconnu", charge: c });
  }

  for (const e of (champ(d, "properties") ?? []) as Iterable<unknown>) {
    const p = champ(e, "property") ?? e;
    const name = champ(p, "name");
    if (!p || typeof name !== "string") {
      out.push({ type: "inconnu", charge: e });
      continue;
    }
    out.push({
      type: "ecriture",
      nom: name,
      valeur: champ(p, "value"),
      // `id` n'est présent que si la propriété demande un accusé ; sa présence EST la demande.
      // Le renvoyer tel quel est ce que l'application attend pour dénouer son attente.
      ackId: champ(p, "id") ?? null,
      dsn: champ(p, "dsn") ?? null,
    });
  }

  if (!out.length) out.push({ type: "vide" });
  return out;
}

/**
 * **Le datapoint qu'un appareil pousse vers une application : un objet NU.**
 *
 * ⚠️ Même piège que l'accusé, et il était encore plus coûteux parce qu'il touchait *toutes* les
 * rediffusions. `AylaLanModule.handlePropertyUpdateRequest` lit la charge à plat :
 *
 * ```java
 * JSONObject jSONObject = new JSONObject(payload.data);
 * String string = jSONObject.getString("name");
 * Object obj    = jSONObject.get("value");
 * String dsn    = jSONObject.optString("dsn", null);
 * ```
 *
 * Enveloppé dans `{properties:[{property:…}]}`, `getString("name")` lève une `JSONException` :
 * la propriété n'est jamais appliquée, la commande en attente reçoit un `JsonError`, et
 * l'application répond **400 « Bad message JSON »**. Autrement dit, le cœur du multiplexeur —
 * une lecture réelle, N destinataires — poussait depuis toujours des messages que personne ne
 * pouvait lire. Le journal disait « état rediffusé » et c'était vrai ; ce qui manquait, c'est
 * que rien n'arrivait de l'autre côté.
 *
 * `metadata` et `dev_time_ms` sont facultatifs (`JSONException` attrapée, `optInt`) ; `dsn` ne
 * l'est pas tout à fait — quand il est là, le SDK s'en sert pour retrouver l'appareil visé.
 */
export function paquetDatapoint(dsn: unknown, name: string, value: unknown): string {
  return JSON.stringify({ name, value, dsn });
}

/**
 * **L'URL qui apparie une poussée à la commande de lecture qui l'attendait.**
 *
 * `AylaLanModule.getCommand()` ne regarde ni le corps ni le chemin : il lit le paramètre d'URL
 * `cmd_id`, et lui seul.
 *
 * ```java
 * String str = (String) jVar.c().get("cmd_id");        // c() == getParms(), la query string
 * AylaLanCommand queued = str != null ? getQueuedCommand(Integer.parseInt(str)) : null;
 * if (queued == null) { AylaLog.d(…, "No matching command found in the queue"); return null; }
 * ```
 *
 * Sans le paramètre, `command` vaut `null`, `setModuleResponse()` n'est jamais appelé, et la
 * commande expire au bout de `getRequestTimeout()` — `defaultNetworkTimeoutMs`, **5 secondes**
 * mesurées en direct : `E/LocalNetwork: Timed out waiting for command response:
 * LanCmd[1]=property.json?name=d302_monitor`.
 *
 * Une poussée spontanée n'en porte pas, et c'est correct : `getCommand()` rend `null`, la
 * propriété est appliquée quand même.
 */
export function cheminAvecCmd(chemin: string, cmdId: string | number | boolean | null | undefined): string {
  return cmdId === null || cmdId === undefined ? chemin : `${chemin}?cmd_id=${encodeURIComponent(cmdId)}`;
}

/**
 * **Le chemin d'un accusé — et c'est l'URI qui en fait un accusé, rien d'autre.**
 *
 * Les deux routes tombent sur le même gestionnaire, qui tranche sur la fin du chemin :
 *
 * ```java
 * return gVar.c().endsWith("ack.json")
 *      ? lanModule.handleDatapointAck(gVar, map, jVar)
 *      : lanModule.handlePropertyUpdateRequest(gVar, map, jVar);
 * ```
 *
 * Un accusé posté sur `/property/datapoint.json` est donc lu comme une **écriture de
 * propriété** : il ne dénoue rien, et l'application déclare la commande en échec au bout de son
 * `_ackTimeout`. Symptôme vécu : la machine s'allume pour de bon, et le téléphone affiche que la
 * connexion a échoué.
 */
export const CHEMIN_ACK = "/property/datapoint/ack.json";

/**
 * **L'accusé qu'une application attend quand sa propriété portait un `id`.** Trois détails, tous
 * relevés dans `AylaLanModule.handleDatapointAck`, et chacun suffit à faire échouer la commande
 * du point de vue de l'application alors que l'appareil, lui, a bien exécuté.
 *
 * 1. **La charge est l'objet NU**, pas un `{properties:[{property:…}]}`. Le SDK fait
 *    `fromJson(payload.data, CreateDatapointAck.class)` : enveloppé, Gson ne trouve ni `id` ni
 *    `ack_status`, l'identifiant sort `null`, aucune commande ne correspond, et l'application
 *    lève `PreconditionError("Received ack for this device without a matching command")`.
 * 2. **`ack_status` vaut `200`, pas `0`.** C'est un code HTTP réemployé comme statut applicatif :
 *    `if (ack.ack_status == Status.OK.getRequestStatus())` → succès, **sinon** `ServerError(…,
 *    "Datapoint NAK")`. Un `0` bien routé est donc lu comme un refus explicite.
 * 3. Le chemin doit finir par `ack.json` — voir `CHEMIN_ACK`.
 */
export function paquetAck(dsn: unknown, id: unknown, status = 200): string {
  return JSON.stringify({ dsn, id, ack_status: status, ack_message: 0 });
}
