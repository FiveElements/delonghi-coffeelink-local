/**
 * Catalogue des boissons — **par modèle**.
 *
 * Deux choses à ne pas confondre, et c'est tout l'objet de ce fichier :
 *
 * 1. **La LISTE des boissons dépend du modèle.** Elle vient de `machine-catalogs.json`, extrait de
 *    `assets/MachinesModels.json` de l'APK. C'est l'app elle-même qui décide de cette liste à partir
 *    de cette table : la machine n'est JAMAIS interrogée sur « quelles boissons sais-tu faire ».
 *    Elle ne fournit que des valeurs.
 *
 * 2. **La NUMÉROTATION des propriétés Ayla ne dépend pas du modèle.** C'est un espace de noms
 *    De'Longhi figé, relevé dans `p258z7/z.java` :
 *
 *      `v(profileId, template)`  →  `i11 = (profileId − 1) × 21`, puis un offset FIXE par nom :
 *                                   rec_espresso + 39, rec_regular + 40 … rec_brew_over_ice + 59
 *      `t(profileId, template)`  →  `i10 = (profileId − 1) × 6`, puis bs_recipe_01 + 160 … 165
 *      bornes                    →  `d001_rec_espresso` … `d021_rec_brew_over_ice`, même ordre
 *
 *    ⚠️ Le `21` est une **constante de l'app**, pas le nombre de recettes du modèle. Une version
 *    précédente de ce fichier dérivait les offsets de l'INDEX dans le catalogue (`39 + i`) et
 *    documentait le 21 comme « le nombre de recettes standard de ce modèle ». Les deux affirmations
 *    étaient fausses. Elles donnaient le bon résultat sur ce modèle-ci par coïncidence — son
 *    catalogue est un préfixe de la liste globale — et auraient décalé toutes les lectures sur un
 *    modèle auquel manque une boisson du MILIEU de la liste.
 *
 * Conséquence heureuse : changer de modèle ne change que la liste. Aucune arithmétique à refaire,
 * donc aucun risque de lire silencieusement la mauvaise propriété.
 *
 * Fichier sous `src/lib/` volontairement : partagé tel quel entre `server.ts` (HTTP brut) et l'API qui
 * alimente l'UI, sans duplication de la table.
 */
import { readFileSync } from "node:fs";

/** Une recette de la table constructeur : `ingredients` = ids des paramètres que la boisson accepte. */
export interface RecetteModele { id: number; name: string; ingredients: number[] }

/**
 * Un modèle tel que `scripts/extract-catalogs.ts` l'écrit. Seuls les champs que le code lit sont
 * nommés ; les autres drapeaux de la table passent tels quels (`modelSheet`, `model`).
 */
export interface ModeleCatalogue {
  productCode: string;
  type: string;
  name: string;
  nProfiles: number;
  nStandardRecipes: number;
  nCustomRecipes: number;
  support: string;
  unsupportedIds: number[];
  recipes: RecetteModele[];
  [drapeau: string]: unknown;
}

interface FichierCatalogues { tableVersion: string | number; models: Partial<Record<string, ModeleCatalogue>> }

// Cast assumé : fichier GÉNÉRÉ par `extract-catalogs.ts`, jamais édité à la main — sa forme est
// celle que ce script écrit, et la revalider ici dupliquerait le script sans rien prouver de plus.
const CATALOGS = JSON.parse(readFileSync(new URL("./machine-catalogs.json", import.meta.url), "utf8")) as FichierCatalogues;

/**
 * Modèle retenu quand on ne sait pas encore lequel on pilote — celui de la machine sur laquelle ce
 * serveur a été développé et vérifié. Surchargeable par `MACHINE_MODEL_KEY`. Ce n'est pas une
 * supposition sur votre machine : c'est un point de départ, et l'écart est signalé dès que la
 * machine dit son vrai modèle (voir `applyIdentity` dans server.ts).
 */
export const DEFAULT_MODEL_KEY = "17055";

export const CATALOG_TABLE_VERSION = CATALOGS.tableVersion;
export const MODEL_KEYS = Object.keys(CATALOGS.models);

/** Libellés FR + classement, par id de boisson. `slug` = suffixe de la propriété Ayla. */
export type CategorieBoisson = "cafe" | "lait" | "autre" | "froid" | "perso";
export interface MetaBoisson { label: string; slug: string; category: CategorieBoisson }

const LABELS: Readonly<Partial<Record<number, MetaBoisson>>> = {
  1: { label: "Espresso", slug: "espresso", category: "cafe" },
  2: { label: "Café", slug: "regular", category: "cafe" },
  3: { label: "Café long", slug: "long_coffee", category: "cafe" },
  4: { label: "Espresso ×2", slug: "2x_espresso", category: "cafe" },
  5: { label: "Doppio+", slug: "doppio", category: "cafe" },
  6: { label: "Americano", slug: "americano", category: "cafe" },
  7: { label: "Cappuccino", slug: "cappuccino", category: "lait" },
  8: { label: "Latte macchiato", slug: "latte_macchiato", category: "lait" },
  9: { label: "Caffelatte", slug: "caffelatte", category: "lait" },
  10: { label: "Flat white", slug: "flat_white", category: "lait" },
  11: { label: "Espresso macchiato", slug: "espr_macchiato", category: "lait" },
  12: { label: "Lait chaud", slug: "hot_milk", category: "lait" },
  13: { label: "Cappuccino doppio+", slug: "capp_doppio", category: "lait" },
  15: { label: "Cappuccino inversé", slug: "capp_reverse", category: "lait" },
  16: { label: "Eau chaude", slug: "hot_water", category: "autre" },
  22: { label: "Thé", slug: "tea", category: "autre" },
  23: { label: "Verseuse", slug: "coffee_pot", category: "cafe" },
  24: { label: "Cortado", slug: "cortado", category: "lait" },
  25: { label: "Long black", slug: "long_black", category: "cafe" },
  26: { label: "Mug de voyage", slug: "mug_to_go", category: "froid" },
  27: { label: "Brew over ice", slug: "brew_over_ice", category: "froid" },
  // Boisson préparée avec la configuration de grains active (Bean System). Son nom d'usine
  // dans la table constructeur est « Espresso BS 1 » — BS pour Bean System. Ce n'est PAS le nom
  // du grain : celui-là est un attribut, voir `activeBeanSystem` côté serveur.
  200: { label: "Espresso Bean Adapt", slug: "bs_recipe_01", category: "perso" },
  230: { label: "Recette perso 1", slug: "cstm_recipe_01", category: "perso" },
  231: { label: "Recette perso 2", slug: "cstm_recipe_02", category: "perso" },
  232: { label: "Recette perso 3", slug: "cstm_recipe_03", category: "perso" },
  233: { label: "Recette perso 4", slug: "cstm_recipe_04", category: "perso" },
  234: { label: "Recette perso 5", slug: "cstm_recipe_05", category: "perso" },
  235: { label: "Recette perso 6", slug: "cstm_recipe_06", category: "perso" },
};

/**
 * L'identité d'une boisson par son id, **hors de tout catalogue de modèle**.
 *
 * `catalogFor(...).byId` ne connaît que les recettes du modèle en place, ce qui est juste pour
 * piloter. Mais un compteur par boisson (`d730_tot_id27_brew_over_ice`, voir `compteurs.ts`) peut
 * nommer une boisson que le catalogue courant n'a pas : c'est alors l'id du protocole qui parle,
 * pas la machine du banc. D'où cet accès direct — et pas une seconde copie de la table.
 */
export const beverageMeta = (id: number | string): MetaBoisson | null => LABELS[Number(id)] ?? null;

/**
 * **Le créneau de chaque boisson standard dans l'espace de noms De'Longhi.** Fixe, global, relevé
 * dans l'app — jamais dérivé du catalogue d'un modèle.
 *
 *   bornes           : `d{slot}_rec_{slug}`               (d001 … d021)
 *   recette du profil: `d{slot + 38 + (p−1) × 21}_{p}_rec_{slug}`   (d039 … d059 pour le profil 1)
 *
 * Vérifié sur le profil 1 dans le logcat de l'app parlant à cette machine :
 * d001_rec_espresso … d021_rec_brew_over_ice, d039_1_rec_espresso … d059_1_rec_brew_over_ice.
 */
const SLOT: Readonly<Partial<Record<string, number>>> = {
  espresso: 1,
  regular: 2,
  long_coffee: 3,
  "2x_espresso": 4,
  doppio: 5,
  americano: 6,
  cappuccino: 7,
  latte_macchiato: 8,
  caffelatte: 9,
  flat_white: 10,
  espr_macchiato: 11,
  hot_milk: 12,
  capp_doppio: 13,
  capp_reverse: 14,
  hot_water: 15,
  tea: 16,
  coffee_pot: 17,
  cortado: 18,
  long_black: 19,
  mug_to_go: 20,
  brew_over_ice: 21,
};
const PROFILE_OFFSET = 38; // d039 = créneau 1 du profil 1
const PROFILE_STRIDE = 21; // constante de l'app (i11 = (p − 1) × 21), PAS le nombre de recettes

/**
 * Bean System : bornes `d022_beansystem_1`, recette du profil
 * `d{160 + (p−1) × 6}_{p}_bs_recipe_01`.
 *
 * ⚠️ Le pas de 6 vient de `t()` dans l'app (`i10 = (i9 − 1) * 6`). Il manquait : la version
 * précédente rendait `d160_{p}_bs_recipe_01` pour TOUS les profils, donc un nom qui n'existe pas
 * pour p ≥ 2. La lecture répondait vide et était classée « absente sur ce modèle » — la recette
 * Bean Adapt des profils 2 à 5 était donc illisible, sans que rien ne le dise.
 */
const BS_BOUNDS = "d022_beansystem_1";
const BS_PROFILE_BASE = 160;
const BS_PROFILE_STRIDE = 6;

/**
 * Recettes personnalisées : bornes `d028_rec_custom_1` … `d033_rec_custom_6`, valeurs
 * `d200_1_cstm_recipe_01` … `d205_1_cstm_recipe_06`.
 *
 * ⚠️ **Elles SONT par profil, pas de 6 — et l'inverse a longtemps été écrit ici.**
 *
 * L'ancienne note disait « le profil est toujours 1 », en s'appuyant sur un fait exact : l'app
 * n'écrit que six littéraux, `C1("d200_1_cstm_recipe_01")` … `C1("d205_1_cstm_recipe_06")`, et
 * ne possède aucun constructeur à profil variable. L'inférence tirée de ce fait était fausse :
 * ce que l'application ne sait pas demander, la machine sait néanmoins le publier.
 *
 * Constaté le 2026-08-22 à 19:41, dans le journal des applications, après une écriture de
 * recette (`0x83`) — la cafetière a poussé d'elle-même les CINQ profils :
 *
 * ```
 * d202_1_cstm_recipe_03   trame d0 17 a6 f0 01 e8 …
 * d208_2_cstm_recipe_03   trame d0 17 a6 f0 02 e8 …
 * d214_3_cstm_recipe_03   trame d0 17 a6 f0 03 e8 …
 * d220_4_cstm_recipe_03   trame d0 17 a6 f0 04 e8 …
 * d226_5_cstm_recipe_03   trame d0 17 a6 f0 05 e8 …
 * ```
 *
 * Deux confirmations indépendantes dans chaque ligne : le numéro suit `200 + (p−1)×6 + (slot−1)`
 * pour les cinq, et **l'octet de profil de la trame** (`f0 0P`) concorde avec le chiffre du nom.
 * `0xE8` = 232 = « Recette perso 3 » dans la table ci-dessus. Le pas de 6 est celui du Bean
 * System (`t()`, base 160), et `200 + 5×6 = 230` tombe pile là où commencent les identifiants de
 * boisson des recettes perso : aucune collision.
 *
 * ⚠️ Ce n'était pas qu'une étiquette manquante au journal : en imposant le profil 1, on lisait
 * `d202_1_…` pour les profils 2 à 5, donc on **affichait la recette du profil 1 en la présentant
 * comme la leur**. Exactement le défaut du Bean System sans pas, corrigé plus haut — à ceci près
 * que celui-là répondait vide et se voyait, alors que celui-ci répondait une valeur plausible.
 */
const CUSTOM_BOUNDS_BASE = 28; // d028 = perso 1
const CUSTOM_PROFILE_BASE = 200; // d200 = perso 1, profil 1
const CUSTOM_PROFILE_STRIDE = 6; // six emplacements perso par profil, comme le Bean System
const CUSTOM_SLOT: Readonly<Partial<Record<string, number>>> = { cstm_recipe_01: 1, cstm_recipe_02: 2, cstm_recipe_03: 3, cstm_recipe_04: 4, cstm_recipe_05: 5, cstm_recipe_06: 6 };

const d = (n: number) => `d${String(n).padStart(3, "0")}`;

/** Propriété portant les bornes min/défaut/max d'une boisson (trame `0xB0`). */
function boundsProp(slug: string): string | null {
  const slot = SLOT[slug], perso = CUSTOM_SLOT[slug];
  if (slot !== undefined) return `${d(slot)}_rec_${slug}`;
  if (slug === "bs_recipe_01") return BS_BOUNDS;
  if (perso !== undefined) return `${d(CUSTOM_BOUNDS_BASE + perso - 1)}_rec_custom_${perso}`;
  return null;
}

/** Propriété portant la recette enregistrée d'un profil (trame `0xA6`). */
function profilePropForSlug(slug: string, profileId: number | string = 1): string | null {
  const p = Number(profileId) || 1;
  const slot = SLOT[slug], perso = CUSTOM_SLOT[slug];
  if (slot !== undefined) {
    return `${d(slot + PROFILE_OFFSET + (p - 1) * PROFILE_STRIDE)}_${p}_rec_${slug}`;
  }
  if (slug === "bs_recipe_01") {
    return `${d(BS_PROFILE_BASE + (p - 1) * BS_PROFILE_STRIDE)}_${p}_bs_recipe_01`;
  }
  if (perso !== undefined) {
    // Pas de 6 par profil — mesuré sur la machine, voir le commentaire de CUSTOM_PROFILE_BASE.
    return `${d(CUSTOM_PROFILE_BASE + (p - 1) * CUSTOM_PROFILE_STRIDE + perso - 1)}_${p}_${slug}`;
  }
  return null;
}

/**
 * L'emplacement perso 1-6 d'une boisson, d'après son slug, ou `null` si ce n'en est pas une.
 *
 * ⚠️ **À ne pas confondre avec le champ `customSlot` de `/api/beverages`**, qui vaut `null` tant que
 * l'emplacement n'a pas été NOMMÉ sur la machine — il vient de la trame des noms, pas du catalogue.
 * Les deux disent des choses différentes et les deux sont utiles : celui-ci répond « cet
 * identifiant est-il un emplacement perso de ce modèle », l'autre « la machine y a-t-elle écrit un
 * nom ». Le transfert d'une recette a besoin du PREMIER, puisqu'on transfère volontiers dans un
 * emplacement encore vierge.
 */
export const customSlotOf = (slug: string): number | null => CUSTOM_SLOT[slug] ?? null;

export const CATEGORIES: Readonly<Record<CategorieBoisson, string>> = {
  cafe: "Cafés",
  lait: "Boissons lactées",
  autre: "Eau chaude & thé",
  froid: "Froid / to-go",
  perso: "Personnalisées",
};

/** Une boisson du catalogue d'un modèle, telle que `/api/beverages` la sert. */
export interface Boisson extends MetaBoisson {
  id: number;
  /** nom d'usine de la table (anglais) */
  factoryName: string;
  ingredients: number[];
  milk: boolean;
  bounds: string | null;
  unaddressable: boolean;
}

export interface Catalogue {
  key: string;
  fallback: boolean;
  requestedKey: string | null;
  model: ModeleCatalogue & { key: string };
  support: string;
  beverages: Boisson[];
  byId: (id: number | string) => Boisson | undefined;
  boundsProp: (slug: string) => string | null;
  profileProp: (bev: { slug: string }, profileId?: number | string) => string | null;
  unaddressable: number[];
}

const cache = new Map<string, Catalogue>();

/**
 * Catalogue d'un modèle, par sa clé de 5 chiffres (les 5 derniers du `product_code`).
 *
 * Une clé inconnue — ou un modèle dont la table ne donne aucune recette — retombe sur le modèle par
 * défaut, en le **disant** dans le champ `fallback` : mieux vaut une liste explicitement empruntée
 * qu'une page vide, et l'interface doit pouvoir l'annoncer.
 */
export function catalogFor(modelKey: unknown): Catalogue {
  const key = String(modelKey ?? "");
  const deja = cache.get(key);
  if (deja) return deja;

  const demande = CATALOGS.models[key] ?? null;
  const utilisable = demande && demande.recipes.length > 0;
  // Le modèle par défaut est dans la table générée par construction : c'est celui du banc.
  const model = utilisable ? demande : (CATALOGS.models[DEFAULT_MODEL_KEY] as ModeleCatalogue);
  const effectif = utilisable ? key : DEFAULT_MODEL_KEY;

  const beverages = model.recipes.map((r): Boisson => {
    const meta: MetaBoisson = LABELS[r.id] ?? { label: r.name, slug: `id_${r.id}`, category: "perso" };
    return {
      id: r.id,
      factoryName: r.name, // nom d'usine de la table (anglais)
      label: meta.label,
      slug: meta.slug,
      category: meta.category,
      ingredients: r.ingredients, // ids des paramètres que cette boisson accepte
      milk: r.ingredients.includes(9),
      bounds: boundsProp(meta.slug),
      // Vrai quand la boisson existe sur ce modèle mais qu'aucune propriété connue ne l'adresse
      // (familles « iced »/« mug » des Striker). Elle est listée, pas lisible.
      unaddressable: boundsProp(meta.slug) === null,
    };
  });

  const catalogue: Catalogue = {
    key: effectif,
    /** `true` si la clé demandée n'a pas pu être servie et qu'on a repris le modèle par défaut. */
    fallback: !utilisable,
    requestedKey: key || null,
    model: { ...model, key: effectif },
    support: model.support,
    beverages,
    byId: (id) => beverages.find((b) => b.id === Number(id)),
    boundsProp,
    profileProp: (bev, profileId = 1) => profilePropForSlug(bev.slug, profileId),
    /** Boissons listées par le modèle mais qu'aucune propriété connue n'adresse. */
    unaddressable: beverages.filter((b) => b.unaddressable).map((b) => b.id),
  };
  cache.set(key, catalogue);
  return catalogue;
}

/** Fiche courte d'un modèle, sans son catalogue : pour lister ce que le serveur sait piloter. */
export function modelSheet(key: string | number) {
  const m = CATALOGS.models[String(key)];
  if (!m) return null;
  const { recipes, ...rest } = m;
  return { key: String(key), nRecipes: recipes.length, ...rest };
}

// --- Paramètres de recette (enum p127m6/i) --------------------------------

/**
 * id → { name, label, unit, kind }
 *
 * `kind` sert uniquement à **grouper** l'affichage, pas à filtrer : rien ne doit être masqué.
 *   "user"     = ingrédient de la recette (quantités, arôme, température, 2 tasses, accessoire…)
 *   "advanced" = réglage qui touche le comportement machine plus que le goût (visibilité de la
 *                boisson à l'écran, programmabilité, index de longueur) — présenté à part, parce
 *                que le modifier change l'interface de la machine, pas la tasse
 *   "maint"    = maintenance (détartrage, rinçage, nettoyage)
 *
 * ⚠️ Cette classification est la NÔTRE, elle n'existe pas dans le protocole. Une première version
 * s'en servait pour n'afficher que "user", ce qui masquait des options réellement réglables
 * (« 2 tasses », « accessoire »). Ne pas refaire : filtrer sur `max > min`, grouper sur `kind`.
 */
/** Le regroupement d'affichage — NOTRE classification, voir ci-dessus. */
export type GenreParam = "user" | "advanced" | "maint";
export interface InfoParam { name: string; label: string; unit: string; kind: GenreParam }

export const PARAMS: Readonly<Partial<Record<number, InfoParam>>> = {
  0: { name: "TEMP", label: "Température café", unit: "niveau", kind: "user" },
  1: { name: "COFFEE", label: "Café", unit: "ml", kind: "user" },
  2: { name: "TASTE", label: "Arôme", unit: "niveau", kind: "user" },
  3: { name: "GRANULOMETRY", label: "Mouture", unit: "niveau", kind: "user" },
  4: { name: "BLEND", label: "Mélange", unit: "", kind: "advanced" },
  5: { name: "INFUSION_SPEED", label: "Vitesse d'infusion", unit: "", kind: "user" },
  6: { name: "PREINFUSIONE", label: "Pré-infusion", unit: "", kind: "user" },
  7: { name: "CREMA", label: "Crema", unit: "", kind: "user" },
  8: { name: "DUExPER", label: "2 tasses", unit: "", kind: "user" },
  9: { name: "MILK", label: "Lait", unit: "ml", kind: "user" },
  10: { name: "MILK_TEMP", label: "Température lait", unit: "niveau", kind: "user" },
  11: { name: "MILK_FROTH", label: "Mousse de lait", unit: "niveau", kind: "user" },
  12: { name: "INVERSION", label: "Ordre lait/café", unit: "", kind: "user" },
  13: { name: "THE_TEMP", label: "Température thé", unit: "niveau", kind: "user" },
  14: { name: "THE_PROFILE", label: "Profil thé", unit: "", kind: "user" },
  15: { name: "HOT_WATER", label: "Eau chaude", unit: "ml", kind: "user" },
  16: { name: "MIX_VELOCITY", label: "Vitesse de mélange", unit: "", kind: "user" },
  17: { name: "MIX_DURATION", label: "Durée de mélange", unit: "", kind: "user" },
  18: { name: "DENSITY_MULTI_BEVERAGE", label: "Densité multi-boisson", unit: "", kind: "advanced" },
  19: { name: "TEMP_MULTI_BEVERAGE", label: "Température multi-boisson", unit: "", kind: "advanced" },
  20: { name: "DECALC_TYPE", label: "Type de détartrage", unit: "", kind: "maint" },
  21: { name: "TEMP_RISCIACQUO", label: "Température de rinçage", unit: "", kind: "maint" },
  22: { name: "WATER_RISCIACQUO", label: "Eau de rinçage", unit: "", kind: "maint" },
  23: { name: "CLEAN_TYPE", label: "Type de nettoyage", unit: "", kind: "maint" },
  24: { name: "PROGRAMABLE", label: "Programmable", unit: "", kind: "advanced" },
  25: { name: "VISIBLE", label: "Visible", unit: "", kind: "advanced" },
  26: { name: "VISIBLE_IN_PROGRAMMING", label: "Visible en programmation", unit: "", kind: "advanced" },
  // « longueur » est le nom de l'enum, pas ce que le parametre fait : bornes IDENTIQUES sur un
  // espresso et sur un cafe long, donc il ne decrit pas le volume verse. Voir doc/commandes-cafe.md.
  27: { name: "INDEX_LENGTH", label: "Index de calibre", unit: "", kind: "advanced" },
  28: { name: "ACCESSORIO", label: "Accessoire", unit: "", kind: "user" },
  30: { name: "PROG_TIME", label: "Programmation horaire", unit: "", kind: "advanced" },
  31: { name: "ICED", label: "Glacé", unit: "", kind: "user" },
  32: { name: "MUG_SIZE", label: "Taille du mug", unit: "", kind: "user" },
  33: { name: "MUG_ADJUST", label: "Ajustement mug", unit: "", kind: "advanced" },
  37: { name: "NUM_ICE_CUBES", label: "Glaçons", unit: "", kind: "user" },
  38: { name: "INTENSITY", label: "Intensité", unit: "niveau", kind: "user" },
  39: { name: "RINSE", label: "Rinçage", unit: "", kind: "maint" },
};

export const paramInfo = (id: number): InfoParam => PARAMS[id] ?? { name: String(id), label: `Paramètre ${id}`, unit: "", kind: "advanced" };

/**
 * Paramètres dont la valeur tient sur 2 octets.
 * L'app lit cette longueur dans une table téléchargée du backend (`getCommonData.sr`
 * → `z.Z(id)` : `length > 1`). Sur cette famille ce sont les quantités liquides ;
 * confirmé par le décodage exact de `d001_rec_espresso` (parcours tombant sur le CRC).
 */
// La table vit dans `ecam-args.ts`, qui est le référentiel du protocole ECAM. Elle a existé en
// TROIS exemplaires — ici, dans `server.ts` et dans le décodeur d'arguments — et trois copies
// d'une table de largeurs d'octets divergent au premier ajout sans lever la moindre erreur : on
// obtient des valeurs plausibles et fausses. Réexportée sous son ancien nom, les deux décodeurs
// ci-dessous s'en servant sous celui-là.
import { TWO as TWO_BYTE } from "./ecam-args.ts";
import { trameEntiere } from "./trame-bornes.ts";
export { TWO_BYTE };

/**
 * Décode une propriété de bornes (trame ECAM `0xB0`) — port de `p097j6.d.X()`.
 *
 *   0      0xD0
 *   1      len = taille totale − 1
 *   2      0xB0
 *   3      0xF0
 *   4      beverageId
 *   5..    quadruplets : id (1 o) puis min, défaut, max — 1 o chacun,
 *          ou 2 o big-endian si le paramètre est dans TWO_BYTE
 *   −2..   CRC16
 *
 * `exact: false` signale un désalignement (typiquement un paramètre 2 octets absent de
 * TWO_BYTE) : les valeurs sont alors à considérer comme douteuses.
 */
export interface BorneDecodee extends InfoParam { id: number; min: number; def: number; max: number }
export interface ValeurDecodee extends InfoParam { id: number; value: number }

export interface BornesRecette { beverageId: number; cmd: number; params: BorneDecodee[]; exact: boolean; hex: string }
export interface ValeursRecette { profileId: number; beverageId: number; cmd: number; params: ValeurDecodee[]; exact: boolean; hex: string }

export function decodeRecipeBounds(b64: string): BornesRecette {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 7) throw new Error("trame trop courte");
  // Tronquée ou corrompue : refusée, au lieu de bornes à 0 enregistrées comme lues.
  const len = trameEntiere(buf, "trame de bornes");
  const end = len - 2; // début du CRC
  const out: BornesRecette = { beverageId: buf[4], cmd: buf[2], params: [], exact: false, hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim() };
  let i = 5;
  while (i < end) {
    const id = buf[i];
    const w = TWO_BYTE.has(id) ? 2 : 1;
    if (i + 1 + 3 * w > end) break; // désalignement : on s'arrête proprement
    const read = (o: number) => (w === 2 ? (buf[o] << 8) | buf[o + 1] : buf[o]);
    const info = paramInfo(id);
    out.params.push({ id, name: info.name, label: info.label, unit: info.unit, kind: info.kind, min: read(i + 1), def: read(i + 1 + w), max: read(i + 1 + 2 * w) });
    i += 1 + 3 * w;
  }
  out.exact = i === end;
  return out;
}

/**
 * Décode une propriété « recette du profil » (trame ECAM `0xA6`) — port de `p097j6.d.u0()`.
 * Ici pas de bornes : offset 4 = profil, 5 = boisson, puis des paires (id, valeur).
 */
export function decodeRecipeValues(b64: string): ValeursRecette {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw new Error("trame trop courte");
  const len = trameEntiere(buf, "trame de recette");
  const end = len - 2;
  const out: ValeursRecette = { profileId: buf[4], beverageId: buf[5], cmd: buf[2], params: [], exact: false, hex: buf.subarray(0, len).toString("hex").replace(/(..)/g, "$1 ").trim() };
  let i = 6;
  while (i < end) {
    const id = buf[i];
    const w = TWO_BYTE.has(id) ? 2 : 1;
    if (i + 1 + w > end) break;
    const info = paramInfo(id);
    out.params.push({ id, name: info.name, label: info.label, unit: info.unit, kind: info.kind, value: w === 2 ? (buf[i + 1] << 8) | buf[i + 2] : buf[i + 1] });
    i += 1 + w;
  }
  out.exact = i === end;
  return out;
}

/** Aiguille le décodage selon la commande portée par la trame (0xB0 bornes / 0xA6 valeurs). */
export type ProprieteRecette = ({ kind: "values" } & ValeursRecette) | ({ kind: "bounds" } & BornesRecette);

export function decodeRecipeProperty(b64: string): ProprieteRecette {
  const cmd = Buffer.from(b64, "base64")[2];
  return cmd === 0xa6 ? { kind: "values", ...decodeRecipeValues(b64) } : { kind: "bounds", ...decodeRecipeBounds(b64) };
}
