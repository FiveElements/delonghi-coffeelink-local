# Bean Adapt — fonctionnement

> **Note.** Ce document est le fruit d'une analyse menée sur une machine réelle. Les valeurs
> propres à cet exemplaire ont été remplacées par des marqueurs : `IP_MACHINE`,
> `AC000W0XXXXXXXX` (numéro de série), `XX:XX:XX:XX:XX:XX` (adresse MAC), `VLAN_IOT`,
> `IFACE_IOT`, et « Grain A/B/… » pour les noms saisis sur la machine. Les références à
> `secrets.md` désignent un fichier volontairement absent du dépôt : il contenait la clé LAN et
> des données personnelles.

Analyse du 2026-08-19, à partir de l'APK `it.delonghi` 4.9.6 décompilé et d'appels réels aux
deux backends De'Longhi impliqués.

Bean Adapt est la fonction qui adapte les réglages de la machine à un café en grains donné.
Elle est liée au groupe **MillCore** — d'ailleurs `oem_model` de cette machine est `DL-millcore`
(voir `materiel-et-firmware.md`).

---

## 1. Le constat central : l'intelligence est côté serveur

**Il n'y a aucun algorithme d'adaptation dans l'application.** L'app collecte des réponses,
les envoie à un backend De'Longhi, et reçoit en retour les réglages à appliquer. Tout le calcul
est distant.

```
   ┌──────────┐   1. questions (JSON statique S3)   ┌──────────────┐
   │          │ <────────────────────────────────── │ S3 De'Longhi │
   │   App    │                                     └──────────────┘
   │  Android │   2. réponses + état courant        ┌──────────────┐
   │          │ ──────────────────────────────────> │ delonghibe   │
   │          │ <────────────────────────────────── │  .reply.it   │
   └────┬─────┘   3. réglages calculés + conseil    └──────────────┘
        │
        │ 4. trame ECAM 0x BB (base64 → propriété Ayla data_request)
        v
   ┌──────────┐
   │ Machine  │
   └──────────┘
```

Conséquence pour une réimplémentation : le calcul est reproductible localement (§ 4, la règle est
simple), mais il faut soit rejouer l'API, soit réimplémenter la règle.

---

## 2. Le modèle de données

### 2.1 Un profil Bean Adapt — `it/delonghi/model/BeanSystem.java`

| Champ | Type | Rôle |
|---|---|---|
| `id` | `int` | Identifiant du profil. **`id == 0` ⇒ `isDefault`** |
| `name` | `String` | Nom, 20 caractères utiles maximum |
| `image` | `String` | Illustration (`BS%sIMG`) |
| `isEnable` | `boolean` | Profil visible sur la machine |
| `isDeleted` | `boolean` | Marqueur de suppression |
| **`grinder`** | **`float`** | Finesse de mouture |
| **`temperature`** | **`int`** | Température d'infusion |
| **`aroma`** | **`int`** | Intensité / dose |
| `optimalId` | `int` | Défaut **200** |

Les trois valeurs pilotées par Bean Adapt sont donc `grinder`, `temperature` et `aroma`.

### 2.2 Propriétés Ayla associées

| Propriété | Usage |
|---|---|
| `d022_beansystem_1` | Profil Bean System — **machines classiques** (celle-ci) |
| `d251_beansystem_1` | Profil Bean System — machines « Striker » |
| `d260_beansystem_sync_par` | Paramètres Bean System — classiques |
| `d260_beansystem_par` | Paramètres Bean System — Striker |
| `d%s_%s_bs_recipe_01` | Recette rattachée à un Bean System (gabarit résolu à l'exécution) |

Le choix entre les deux jeux se fait sur le même booléen `f27338F` que le reste du protocole
(`DeLonghiWifiConnectService.java:622`, `:1429-1431`).

### 2.3 L'illustration : un **datum Ayla**, jamais une trame ECAM

Le champ `image` de `BeanSystem` ne voyage **pas** dans le protocole ECAM. La trame `0xBA`
(§ 5.1bis) rend le nom, la mouture, la température et l'arôme ; l'illustration est allée chercher
ailleurs, puis recollée sur l'objet.

```java
// DeLonghiWifiConnectService.R(int i) — lecture d'un profil
byte[] trame = Base64.decode(<d25n_beansystem_n>, 2);       // NO_WRAP : c'est la trame
String cle   = String.format("BS%sIMG", trame[4]);          // ← l'index du grain, octet 4
… fetchAylaDatum(dsn, cle, …) → beanSystem.setImage(datum.getValue())
```

- La clé est **`BS<id>IMG`** — `BS1IMG`, `BS2IMG`… — et le datum est porté par **l'appareil**
  (`deviceWithDSN(dsn).fetchAylaDatum`), donc **dans le cloud Ayla**.
- Écriture (`L6.p.z()`) : **`deleteDatum` puis `createDatum`**, dans la branche succès *comme*
  dans la branche erreur ; `updateDatum` n'est jamais appelé.
- Si le datum échoue (`L1`), le profil est livré **sans image** et rien ne le signale.

⚠️ **Conséquence pour un serveur local : cette illustration nous est inaccessible sans le cloud.**
Elle n'est ni dans une trame, ni dans une propriété Ayla ordinaire — c'est une paire clé/valeur du
compte, lisible seulement avec un jeton d'accès (`dsns/<DSN>/data.json`).

#### Le format, mesuré — et pourquoi on ne le reproduit pas

Chaîne complète : `com.canhub.cropper` pour le recadrage, puis `p218v7.c.b(Bitmap)` pour tout le
reste.

```java
// BeanAdaptDetailFragment.M0() — le cadreur
options.fixAspectRatio = true;  options.aspectRatioX = 3;  options.aspectRatioY = 2;

// p218v7.c.b(Bitmap) — redimensionnement, compression, encodage
Bitmap.createScaledBitmap(bmp, bmp.getWidth() / 2,
                          Math.round((bmp.getWidth() / 2) * 0.6f), true)
      .compress(Bitmap.CompressFormat.JPEG, 35, baos);
Base64.encodeToString(baos.toByteArray(), 0);   // 0 = DEFAULT ⇒ retours à la ligne tous les 76 car.
```

Trois défauts, tous mesurés, tous délibérément **non** reproduits par `src/lib/image-grains.mjs` :

1. **Qualité 35/100** en JPEG.
2. **Aucune taille de sortie fixe** : la largeur est la moitié de la largeur recadrée. Une photo de
   12 Mpx recadrée en 3:2 (4000 × 2667) sort en **2000 × 1200**, soit ~150-300 kio de JPEG et
   ~200-400 kio une fois en base64. Le code lui-même surveille ce chiffre
   (`Log.e("BeanSummary", length / 1000 + "Kb")`).
3. **Le rapport n'est pas conservé** : le cadreur impose 3:2 (1,50) mais la hauteur est recalculée
   à `0,6 × largeur`, soit 5:3 (1,667). Toute image stockée est donc **écrasée verticalement de
   10 %**, systématiquement.

Le choix de `lan-server` est **WebP 300 × 340** — le format des vignettes de boissons extraites de
l'APK (`drawable-xhdpi`, rapport 15:17, ~20 kio) — rangé en BLOB dans `bean_images` (schéma v3),
et servi par `GET /api/beanpresets/image`. Rien ne part vers le cloud, et rien n'est écrit sur
l'appareil : la machine ne transporte aucune image.

Un simple `<input type="file" accept="image/*">` remplace `react-webcam` côté navigateur : le
sélecteur natif propose l'appareil photo **et** les fichiers sur téléphone, le dialogue de fichiers
ailleurs.

⚠️ **Ne pas y ajouter `capture="environment"`.** L'attribut ne veut pas dire « propose aussi
l'appareil photo » : présent, il demande d'ouvrir **directement** le périphérique de capture, ce qui
sur mobile **retire l'accès aux fichiers**. Il était là, il a été retiré. Sur ordinateur il est
ignoré, donc le défaut ne se voit pas à l'endroit où on l'écrit.

#### Sources dans le code décompilé

| Élément | Emplacement |
|---|---|
| Lecture du datum | `DeLonghiWifiConnectService.R(int)`, `K1()` / `L1()` |
| Écriture du datum | `L6.p.z()` puis sa coroutine `g` (`deleteDatum` → `createDatum`) |
| Enveloppe Ayla | `p007a6.o` : `G`=fetch, `J`=update, `K`=create, `p`=delete |
| Recadrage | `it.delonghi.striker.homerecipe.beanadapt.view.BeanAdaptDetailFragment` |
| Redimensionnement / base64 | `p218v7.c` (`a`=décode, `b`=encode, `c`=lit le résultat du cadreur) |
| Décodage à l'affichage | `BeanSystemCustomModel.getDecodedImage(Context)` |

Le paquet s'appelle `striker/`, mais le flux vaut aussi pour les machines **classiques** : la
lecture passe par `p258z7.z.s(i)` → `d250_beansystem_0`, `d251_beansystem_1`… c'est-à-dire la
famille de propriétés décrite en § 2.2.


---

## 3. Les deux backends

### 3.1 Le questionnaire (statique, public, sans authentification)

```
GET https://delonghibe.s3-eu-west-1.amazonaws.com/CoffeeLink/BS/questions/BeanSystemQuestions_app_millcore_1.0.json
→ 200, 2718 octets
```

Le nom du fichier encode le modèle (`millcore`) et une version (`1.0`).

Structure : `{"questions": [{id, id_question, id_title, answers: [{id, id_answer, img, type}]}]}`
(modèles `BeanQuestionResponse`, `QuestionResponse`, `AnswerResponse`). Les `id_*` sont des clés
de traduction, pas du texte.

**4 questions, réparties en deux groupes :**

| `id` | Clé | Groupe | Réponses (`id` → clé) |
|---|---|---|---|
| 1 | `prequestion_1_*` | basique | `1`, `2` |
| 2 | `prequestion_2_*` | basique | `1`…`4`, avec images `BS/img/basic/q2/Beans1-4.png` |
| **11** | `question_1_*` | **avancé** | `1` → `light.png`, `2` → `dark.png`, `3` → `no_crema.png` |
| **12** | `question_2_*` | **avancé** | `1`, `2`, `3` (sans image) |

> Attention à l'ordre : dans le JSON, les réponses de la question 11 sont listées dans l'ordre
> d'affichage (foncé d'abord) mais portent les `id` **2, 1, 3**. C'est l'`id` qui compte.

La question 11 porte donc sur **l'aspect de la crema** (claire / foncée / absente) et la
question 12 sur le **goût**.

### 3.2 Le calcul des réglages

Deux endpoints sur `https://delonghibe.reply.it/api/` :

| Endpoint | Corps | Statut |
|---|---|---|
| `POST getBeanSystem.sr` | `BeanChoice { locale, input }` | le flux **basique** — appelé à chaque ajout de grain |
| `POST getBeanSystemAdv.sr` | `BeanAdvanceChoice { locale, grinder, temperature, aroma, flow_time, input }` | le flux **avancé** — affinage, et fin du parcours d'ajout |

> ⚠️ **CORRECTION (2026-09-02). Cette section affirmait que `getBeanSystem.sr` était du code
> mort « sans aucun appelant dans l'app ». C'est FAUX, et la façon dont l'erreur s'est produite
> vaut d'être retenue : ses deux appelants vivent dans des méthodes que **JADX abandonne**
> (`Method not decompiled`, 958 et 369 unités d'instructions dans `L6.j$b$a.invokeSuspend` et
> `L6.j$d$a.invokeSuspend`). Un `grep` sur `decompiled/sources/` ne trouve donc rien — et conclut
> à l'absence d'appelant. Leçon générale : **un `grep` négatif sur du décompilé ne prouve
> rien** tant qu'on n'a pas vérifié que la zone concernée a bien été décompilée. Relu au
> bytecode (`dexdump -d` sur `classes2.dex`, build-tools 36.1.0).

Corps envoyé, construit dans `L6/o.java:506-509` :

```json
{
  "locale": "it_IT",
  "grinder": 4,
  "temperature": 1,
  "aroma": 3,
  "flow_time": 10,
  "input": [
    {"answer": {"id": 2}, "question": {"id": 11}},
    {"answer": {"id": 1}, "question": {"id": 12}}
  ]
}
```

Deux remarques sur ce corps :
- **`locale` est codé en dur à `"it_IT"`** dans l'app, quelle que soit la langue de l'utilisateur.
- `grinder` est converti en `int` (`(int) beanSystem.getGrinder()`), la partie décimale est perdue.
- `flow_time` vient de `U6.b.e()` — le temps d'écoulement mesuré lors d'une préparation de test.

Réponse :

```json
{"result":{"code":0,"message":"OK"},
 "json_settings":"{\"settings\":{\"grinder\":\"6\",\"temperature\":\"2\",\"aroma\":\"3\"}}"}
```

- `json_settings` est une **chaîne contenant du JSON** (double encodage).
- Les valeurs sont des **chaînes**, alors que les modèles déclarent `float grinder` / `int temperature`
  (`Setting.java`). Gson fait la coercition.
- Le modèle `Settings` prévoit aussi un objet `tips { title, body }` — absent des réponses
  observées.
- **L'endpoint ne demande aucune authentification.**

### 3.2bis Le flux basique, tel qu'il est réellement appelé

`L6.j.C(int i9, T7.l cb)` aiguille sur son argument entier (`|0050: if-ne v0, v4, 00ca`) :

| `i9` | Corps construit | Questions | Appelant |
|---|---|---|---|
| **1** | `BeanChoice` → `getBeanSystem.sr` | 1 (mélange) + 2 (torréfaction) | `NewCreationBeanAdaptFragment$c.l` — le « suivant » de l'étape mouture |
| **2** | `BeanAdvanceChoice` → `getBeanSystemAdv.sr` | 11 (crema) + 12 (goût) | `NewCreationBeanAdaptFragment.f0()` — la dernière étape |

Et `L6.j.P()` (coroutine `d.a`) construit le **même** `BeanChoice` que `C(1)` : c'est le « suivant »
de l'écran de nom, donc le chemin des machines **classiques**, dont le parcours ne fait que trois
pages (mélange, torréfaction, nom).

```json
POST getBeanSystem.sr
{ "locale": "it_IT",
  "input": [ {"answer": {"id": 1}, "question": {"id": 1}},
             {"answer": {"id": 3}, "question": {"id": 2}} ] }
```

`locale` est codé en dur à `"it_IT"` ici aussi.

**Ce que l'app fait des trois valeurs rendues, et ça dépend du chemin :**

| | `C(1)` (Striker) | `P()` (classique) |
|---|---|---|
| `temperature` | retenue **et écrite dans la machine** : `service.C.q0(61, temperature)` — paramètre 61, température café | affichée (`VIEW_BEAN_RESULT_TEMPERATURE`) |
| `aroma` | **épingle** le paramètre `TASTE` (`m6.i.e`, ordinal 2) de la boisson **200 « Espresso BS 1 »** : `setDefValue = setMinValue = setMaxValue = aroma`, puis `RecipeData.q0(aroma)` | affiché (`VIEW_BEAN_RESULT_AROMA`) |
| `grinder` | **jeté** — remplacé par la mouture choisie à la main à l'étape précédente (`J()`, défaut `5.0f`) | retenu (`VIEW_BEAN_RESULT_GRINDING`) |

⚠️ **Le flux avancé appelé en fin de CRÉATION envoie la question 11 codée en dur à
`answer.id = 2`** (crema foncée, donc Δtempérature = 0) : le parcours de création ne pose jamais
la question de la crema, et la réponse neutre est fournie à sa place.

⚠️ **Rien du mélange ni de la torréfaction n'est persisté.** `BeanSystem` porte
`{id, name, image, grinder, temperature, aroma, optimalId, isEnable, isDeleted}` — aucun champ pour
l'un ni pour l'autre. Les deux réponses ne survivent qu'à travers les trois nombres qu'elles ont
produits.

### 3.2ter Ce que `lan-server` en fait

Les **8 combinaisons** (2 mélanges × 4 torréfactions) ont été relevées le **2026-09-02** par
`scripts/extract-bean-creation.mjs` — 8 requêtes, sans authentification, `locale: it_IT` comme
l'app. Le relevé est figé dans `src/lib/bean-creation.json` (les réponses brutes à côté, dans
`bean-creation.brut.json`, pour rejouer le décodage sans rappeler) et `composeGrainNeuf`
(`src/lib/bean-adapt.mjs`) **le lit** :

| mélange \ torréfaction | claire | moyenne | foncée | très foncée |
|---|---|---|---|---|
| **100 % arabica** | 4 / 2 / 4 | 4 / 2 / 4 | 4 / 1 / 3 | 4 / 1 / 3 |
| **arabica + robusta** | 3 / 2 / 4 | 3 / 2 / 4 | 3 / 1 / 3 | 3 / 1 / 3 |

(mouture / température / arôme)

Trois choses s'y lisent :

- la **mouture ne dépend que du mélange**, et le robusta se moud **plus fin** (3 contre 4) ;
- **température et arôme ne dépendent que de la torréfaction**, jamais du mélange ;
- les **quatre niveaux de torréfaction s'effondrent en deux paliers** : {claire, moyenne} → 2 / 4,
  {foncée, très foncée} → 1 / 3. Le questionnaire pose quatre réponses pour deux résultats.

⚠️ **Cette section a d'abord décrit une règle de notre main, et elle était fausse sur les deux
axes.** Avant le relevé, `composeGrainNeuf` calculait `mouture = 2 + torréfaction`,
`température = (robusta ? 2 : 3) − …`, `arôme = robusta ? 4 : 3` — étiqueté `source: "local"` avec
un avertissement à l'écran, et vérifié en vert par huit tests de cohérence qui affirmaient
l'intention (monotonie de la mouture avec la torréfaction, robusta plus grossier et plus froid).
Chaque axe était **inversé**. C'est la limite exacte d'une vérification sans oracle : elle prouve
qu'un code fait ce qu'il dit, jamais qu'il dit vrai. La règle était plausible — c'est même de la
caféologie correcte — et De'Longhi ne la suit pas.

`scripts/verif-bean-adapt.mjs` rejoue maintenant les 8 cases contre une **seconde transcription**
du relevé, écrite dans le script : comparer la sortie au JSON qu'elle lit ne vérifierait qu'un
accès de tableau, tandis que la copie fait échouer le script si le fichier généré est édité à la
main. La table est **lue et non factorisée** — `robusta ? 3 : 4` serait exact aujourd'hui et
réinventerait sept points sur huit le jour où une case changerait.

⚠️ **Le questionnaire d'ajout de grain ne touche pas le réseau.** Le relevé est un acte explicite,
au même titre que `import-bean-images.mjs`, et son résultat est servi depuis le dépôt. L'écran, lui,
lit `source` dans la réponse (`"delonghi"` + la date) et n'écrit aucun libellé d'origine en dur :
c'est ce qui a fait disparaître l'avertissement tout seul le jour du relevé.

---

## 4. L'algorithme, dérivé empiriquement

Établi par balayage systématique de l'API (base `grinder=4, temperature=1, aroma=3`) :

```
grinder_out     = clamp(grinder_in + Δg(flow_time), 1, 7)
temperature_out = temperature_in + Δt(Q11)
aroma_out       = aroma_in + Δa(Q12, flow_time)
```

### 4.1 `flow_time` pilote le grinder — et commande tout le reste

| `flow_time` | Δ grinder | Q12 pris en compte ? |
|---|---|---|
| **< 10** | **−1** | non — aroma inchangé |
| **10 – 19** | **0** | **oui** |
| **≥ 20** | **+1** | non — aroma inchangé |

C'est la logique d'un barista : l'écoulement est le symptôme mesurable, la mouture est le
correctif. Écoulement trop rapide (< 10 s) ⇒ mouture trop grossière ⇒ affiner (−1). Écoulement
trop lent (≥ 20 s) ⇒ mouture trop fine ⇒ élargir (+1). Ce n'est **que** dans la fenêtre
acceptable (10–19 s) que le backend s'autorise à écouter le goût de l'utilisateur pour ajuster
l'aroma.

Bornes du grinder : **1 à 7**. Les valeurs 0 et 8 en entrée font échouer le backend.

### 4.2 Q11 (crema) pilote la température

| Q11 | Signification | Δ température |
|---|---|---|
| `1` | crema claire | **+1** |
| `2` | crema foncée | **0** |
| `3` | pas de crema | **−1** |

Effet indépendant de `flow_time` : toujours appliqué.

### 4.3 Q12 (goût) pilote l'aroma — uniquement si `flow_time` ∈ [10, 19]

| Q12 | Δ aroma (si 10 ≤ ft < 20) | Δ aroma sinon |
|---|---|---|
| `1` | **+1** | 0 |
| `2` | 0 | 0 |
| `3` | **−1** | 0 |

Bornes de l'aroma : **1 à 5**. Un `aroma_in = 5` avec Δ = +1 fait échouer le backend.

### 4.4 Matrice vérifiée

Base `grinder=4, temperature=1, aroma=3, flow_time=10` :

| | Q12=1 | Q12=2 | Q12=3 |
|---|---|---|---|
| **Q11=1** | g4 t2 a4 | g4 t2 a3 | g4 t2 a2 |
| **Q11=2** | g4 t1 a4 | *erreur* | g4 t1 a2 |
| **Q11=3** | g4 t0 a4 | g4 t0 a3 | g4 t0 a2 |

### 4.5 Un bug du backend

La combinaison **`flow_time` ∈ [10, 19] et `Q12 = 2`** (goût neutre) renvoie une réponse
malformée : pas de clé `settings` dans `json_settings`. Reproduit sur `ft = 10` et `ft = 15`,
avec plusieurs tentatives, à `Q11 = 2`. Or c'est le cas « tout va bien, ne change rien » — donc
un chemin nominal. Côté app, cela doit se traduire par une erreur ou un profil non enregistré.

À noter aussi que la température n'est **pas bornée** par le backend : `temperature_in = 0` avec
`Q11 = 3` renvoie `temperature = 0`, et rien n'empêche de descendre plus bas côté API. La
validation de plage doit se faire côté app ou machine.

---

## 5. Écriture vers la machine

`DeLonghiWifiConnectService.b0(BeanSystem)` (ligne 2829) appelle
`p097j6.d.a0(...)` = `getPacketForBeanSystemSaveOrDelete`, puis `Y1()` qui encapsule et envoie
(voir `analyse-connexion-wifi.md` § 4.3).

### 5.1 La trame — 52 octets

```
offset  taille  contenu
  0       1     0x0D                en-tête requête
  1       1     0x33 (51)           longueur = 52 − 1
  2       1     0xBB                commande « bean system save/delete »
  3       1     0xF0                flag
  4       1     id                  identifiant du profil
  5..44   40    name                20 caractères en UTF-16 big-endian, complété de zéros
 45       1     grinder
 46       1     temperature
 47       1     aroma
 48       1     0x00                réservé / inutilisé
 49       1     visible             1 = actif, 0 = supprimé
 50..51   2     CRC16               init 0x1D0F sur les 50 premiers octets
```

Encodage du nom (`p258z7/z.f0()`) : exactement 20 caractères parcourus, chacun écrit sur
2 octets **poids fort d'abord** (`c >> 8` puis `c & 0xFF`) ; au-delà de la longueur de la chaîne,
des zéros. Les caractères au-delà du 20ᵉ sont ignorés.

> **La suppression n'est pas une commande distincte** : c'est la même trame avec `visible = 0`.
> D'où le nom `SaveOrDelete`.

### 5.1bis Lecture d'un profil (`0xBA`) — 53 octets, et le grain ACTIF

**Relevé sur les 6 profils reels de la machine le 2026-08-20.** La reponse fait **53 octets**
(len = 52), soit **un octet de plus que la trame d'ecriture** :

```
offset  contenu
  4     index du profil
  5..44 nom, 40 octets UTF-16 big-endian
 45     mouture      46  temperature      47  arome
 48     reserve
 49     visible / non supprime      (G0 : isDeleted = octet49 != 1)
 50     ACTIF - le grain selectionne (G0 : isEnable = octet50 != 0)
 51..52 CRC16
```

**L'octet 50 designe le grain actif.** Sur les 6 profils lus il ne vaut 1 que pour un seul, et
c'est celui que l'ecran de la machine annonce. C'est aussi l'explication de l'ecart de taille avec
`0xBB` (52 octets, ou les octets 50-51 portent le CRC) : **l'ecriture ne peut pas designer le grain
actif**, c'est le role de `0xB9`.

Liste relevee sur cette machine :

| Index | Nom | Mouture | Temp. | Arome | |
|---:|---|---:|---:|---:|---|
| 0 | Bean Adapt (ON/OFF) | 4 | 1 | 0 | interrupteur, pas un cafe |
| 1 | Grain A | 3 | 3 | 4 | |
| 2 | Grain B | 4 | 3 | 4 | |
| 3 | Grain C | 3 | 3 | 4 | |
| 4 | **Grain D** | 4 | 2 | 5 | **actif** (octet 50 = 1) |
| 5 | Grain E | 4 | 1 | 3 | |

> **Piege de lecture.** La propriete Ayla `d(250+n)_beansystem_n` **n'a de valeur qu'apres** l'envoi
> de la commande `0xBA` correspondante. Interroger la propriete seule ne renvoie rien - ce qui fait
> croire a tort que le profil n'existe pas. Il faut une commande par grain ; c'est pourquoi le
> serveur expose un balayage (`POST /api/beanadapt/scan`) qui les enchaine.

### 5.2 Deux particularités « Striker »

Ces deux points ne s'appliquent **pas** à cette machine (génération classique), mais sont dans
le code :

- `getPacketForBeanSystemSaveOrDelete` fait `grinder *= 2.0f` si Striker. La mouture y est donc
  encodée par demi-crans (échelle 0,5).
- `b0()` remplace `grinder == 7.0f` par `6.5f` si Striker — un plafonnement à 6,5 sur cette
  génération.

### 5.3 Commandes voisines

| Fonction | Trame |
|---|---|
| `getPacketForSelectBean(id)` | `0D 06 B9 F0 <id> <crc16>` — active un profil Bean System |
| `getPacketForSendProfile(id)` | `0D 06 A9 F0 <id> <crc16>` |

### 5.4 Relecture des paramètres

`readBeanSystemPar` lit la propriété Ayla (`d260_beansystem_sync_par` en classique), décode le
base64, puis appelle `p097j6.d.q0()` — un parseur de paramètres génériques :

```
nb_params  = (octet[1] − 7) / 4
id_premier = uint16(octet[4], octet[5])
param i    = 4 octets à l'offset 6 + i×4,  id = id_premier + i
```

---

## 6. Ce qui reste à vérifier

- **Sémantique réelle de `grinder`, `temperature`, `aroma`** côté machine : les plages
  (1–7 / ?, 1–5) sont déduites du comportement du backend, pas d'une lecture machine. Lire
  `d022_beansystem_1` sur la machine et comparer à ce qu'affiche l'app lèverait le doute.
- ~~**Les 8 combinaisons du flux basique**~~ — **relevées le 2026-09-02**, table au § 3.2ter.
  Reste ouvert : **pourquoi quatre torréfactions pour deux paliers**. Le service ne distingue pas
  {claire, moyenne} ni {foncée, très foncée} sur les trois réglages qu'il rend ; soit la question
  sert ailleurs (un conseil, une statistique), soit deux de ses réponses sont mortes.
- **Le champ `tips`** : prévu par le modèle, jamais renvoyé dans les réponses observées.
  Peut-être dépendant de la `locale` ou d'un cas non atteint.
- **`optimalId` (défaut 200)** : rôle non déterminé. **Piste** — 200 est l'identifiant de la
  boisson « Espresso BS 1 », et c'est exactement celle dont le flux de création charge la recette
  pour y épingler l'arôme (§ 3.2bis). Le champ désignerait donc la boisson de référence du profil.
  Non vérifié : aucune écriture de `optimalId` n'a été observée.
- **La réponse neutre imposée à la question 11** : le flux avancé appelé en fin de création
  envoie `answer.id = 2` en dur (crema foncée, Δtempérature = 0). Est-ce un choix ou un oubli ?
  Rien ne le dit.
