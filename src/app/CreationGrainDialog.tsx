"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { mfetch } from "./machine";
import Icone from "./icons";
import { ImageTorrefaction } from "./VignetteGrains";
import ChoixVisuel from "./ChoixVisuel";
import ReglagesGrains, { type Bound, type Brouillon } from "./ReglagesGrains";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AJOUTER UN GRAIN — LES DEUX QUESTIONS, PUIS LA CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'autre moitié du parcours Bean Adapt. `AffinageDialog` corrige un grain déjà réglé, à partir de
 * ce qu'on observe dans la tasse ; celui-ci en règle un pour la PREMIÈRE fois, quand il n'y a
 * encore aucune tasse à observer. Ce sont les deux flux de l'application officielle, et ils ne
 * posent pas les mêmes questions :
 *
 *   affinage   crema, goût, écoulement mesuré   → `getBeanSystemAdv.sr`
 *   création   mélange, torréfaction            → `getBeanSystem.sr`
 *
 * ## Le parcours est celui de l'appareil
 *
 * `NewCreationBeanAdaptFragment` porte un `ViewPager2` dont les deux premières pages sont, dans cet
 * ordre, `J6/C0742g` (le mélange, `prequestion_1`) et `J6/q0` (la torréfaction, `prequestion_2`).
 * C'est le bouton « suivant » de la page d'après qui déclenche le calcul — `L6.j.C(1, …)`. Les
 * trois étapes ci-dessous sont donc les siennes, la dernière fondue avec son écran de saisie :
 *
 *   0  le mélange       — deux réponses, sans visuel : le questionnaire De'Longhi n'en fournit pas
 *   1  la torréfaction  — quatre réponses, avec les visuels `Beans1-4` de l'app
 *   2  la configuration — ce que la règle propose, et le formulaire pour en faire ce qu'on veut
 *
 * ## Ce dialogue REMPLACE la carte qui se dépliait
 *
 * « + Nouvelle configuration » ouvrait le formulaire **en place**, dans la grille, sur trois
 * curseurs posés au milieu de leur plage. Un milieu de plage est un aveu : il dit « je n'ai aucune
 * idée de ton café ». Deux questions le remplacent, et la page ne garde AUCUNE copie du
 * formulaire — c'est la loi que `/beans` a déjà payée une fois avec son « Réglage manuel », et que
 * l'en-tête de `ReglagesGrains` énonce : un formulaire, plusieurs hôtes, jamais deux copies.
 *
 * ⚠️ **L'origine des trois valeurs est LUE dans la réponse, jamais écrite ici.** Cet écran a
 * d'abord affiché un avertissement : la règle de création était alors de cette maison, faute
 * d'avoir relevé les 8 combinaisons de `getBeanSystem.sr`. Elles l'ont été depuis, la règle est
 * celle de De'Longhi, et la phrase a changé **toute seule** — parce que le rendu teste
 * `proposition.source` au lieu de porter le libellé en dur. Les deux branches restent : se tromper
 * d'origine sur un chiffre, dans un sens comme dans l'autre, est l'erreur que ce dépôt tient pour
 * la pire, parce qu'elle est invisible.
 *
 * ⚠️ **La proposition est calculée UNE fois, au passage de la dernière question.** Ensuite les
 * trois curseurs sont libres, et le tableau continue d'afficher ce que la règle avait proposé, avec
 * un « reprendre » si l'on s'en est écarté — le même geste que « Reprendre la mesure » à l'étape 0
 * de l'affinage. Recalculer à chaque frappe écraserait les corrections manuelles ; masquer la
 * proposition dès qu'on la modifie empêcherait d'y revenir.
 *
 * ⚠️ **Le contenu de l'étape est annoncé, pas seulement affiché.** Changer de page ne déplace rien
 * dans le DOM du point de vue d'un lecteur d'écran si le conteneur reste le même : le corps porte
 * donc `aria-live="polite"`, et le focus est posé sur le titre de l'étape à chaque changement. Sans
 * ça, « Suivant » ne produit aucune parole.
 *
 * ⚠️ **Rien ne part vers la machine.** Le bouton final écrit dans la bibliothèque locale, comme le
 * faisait la carte. L'écriture dans un emplacement reste la puce « #n » du dos de la carte créée,
 * derrière sa propre confirmation.
 */

/** Ce que rend `/api/beanadapt/creation` — la sortie de `composeGrainNeuf`. */
interface Proposition {
  grinder: number;
  temperature: number;
  aroma: number;
  /** `"delonghi"` : la table relevée sur le service. `"local"` : une règle de cette maison. */
  source: string;
  /** La date du relevé, quand `source` en désigne un. Affichée, jamais devinée. */
  releve?: string;
  notes: string[];
  error?: string;
}

const ETAPES = 3;

export default function CreationGrainDialog({
  ouvert,
  onFermer,
  bounds,
  busy = false,
  onCreer,
}: {
  ouvert: boolean;
  onFermer: () => void;
  /** Les plages du serveur, passées au formulaire. Absentes tant que rien n'est lu. */
  bounds?: { grinder: Bound; aroma: Bound; temperature: Bound };
  /** L'enregistrement est en cours côté page : le parcours entier se verrouille. */
  busy?: boolean;
  /**
   * Enregistre la configuration, et **rend le message d'erreur du serveur** — `null` si tout va
   * bien. C'est la page qui ferme le dialogue, une fois le serveur d'accord ; et c'est ce dialogue
   * qui montre le refus, parce que le `.status` de la page est derrière lui.
   */
  onCreer: (b: Brouillon) => Promise<string | null>;
}) {
  const t = useTranslations("beanAdapt");
  const tc = useTranslations("common");
  const [etape, setEtape] = useState(0);
  const [melange, setMelange] = useState(1);
  const [torrefaction, setTorrefaction] = useState(2);
  const [proposition, setProposition] = useState<Proposition | null>(null);
  const [brouillon, setBrouillon] = useState<Brouillon | null>(null);
  const [calcul, setCalcul] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const titreEtape = useRef<HTMLHeadingElement>(null);

  /**
   * **Chaque ouverture repart de zéro.**
   *
   * Garder l'état d'une session précédente ferait rouvrir le parcours sur la proposition d'un café
   * qu'on n'a plus dans les mains — et, pire, sur un brouillon à demi rempli qu'un « Créer » un peu
   * rapide enverrait tel quel. Les réponses reprennent leurs valeurs médianes : arabica et
   * torréfaction moyenne, qui ne sont pas des relevés mais des points de départ pour une question.
   */
  useEffect(() => {
    if (!ouvert) return;
    setEtape(0);
    setMelange(1);
    setTorrefaction(2);
    setProposition(null);
    setBrouillon(null);
    setErreur(null);
  }, [ouvert]);

  /* Le focus suit l'étape. `preventScroll` : le dialogue est déjà à sa place, et un défilement
     supplémentaire ferait sauter le contenu sous les yeux de qui n'utilise pas le clavier. */
  useEffect(() => {
    if (!ouvert) return;
    titreEtape.current?.focus({ preventScroll: true });
  }, [etape, ouvert]);

  /**
   * Joue la règle de composition côté serveur — aucune écriture, aucun appel au cloud.
   *
   * Le brouillon est amorcé ICI, et pas avant : ses trois réglages sont la proposition, et son
   * niveau de torréfaction est la réponse qu'on vient de donner. Un brouillon existant plus tôt
   * aurait porté des valeurs que personne n'a demandées.
   */
  const calculer = useCallback(async () => {
    setCalcul(true);
    setErreur(null);
    try {
      const r: Proposition = await mfetch("/api/beanadapt/creation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ melange, torrefaction }),
      }).then((x) => x.json());
      if (r.error) { setErreur(tc("error", { message: r.error })); return false; }
      setProposition(r);
      setBrouillon({
        name: "",
        grinder: r.grinder,
        temperature: r.temperature,
        aroma: r.aroma,
        roast: torrefaction,
        /* Absente et non `null` : c'est la convention de `Brouillon.image` de bout en bout. Une
           configuration neuve n'a pas de photo enregistrée à retirer. */
      });
      return true;
    } finally {
      setCalcul(false);
    }
  }, [melange, torrefaction, tc]);

  /**
   * Le dernier geste. Il ne ferme rien lui-même : un refus du serveur doit laisser les réponses et
   * le brouillon en place, sinon corriger un nom trop long demanderait de refaire le questionnaire.
   */
  const creer = async () => {
    if (!brouillon) return;
    setErreur(null);
    const err = await onCreer(brouillon);
    if (err) setErreur(tc("error", { message: err }));
  };

  const suivant = async () => {
    /* Le passage de la dernière question à la configuration DÉCLENCHE le calcul : un « Calculer »
       séparé ferait une étape de plus dont la seule fonction serait d'être cliquée. Si le calcul
       échoue, on reste sur place — avancer vers un formulaire vide serait annoncer une proposition
       qui n'existe pas. */
    if (etape === 1) {
      if (await calculer()) setEtape(2);
      return;
    }
    setEtape((n) => Math.min(ETAPES - 1, n + 1));
  };

  /** Les trois curseurs se sont-ils écartés de la proposition ? */
  const ecarte = !!proposition && !!brouillon && (
    brouillon.grinder !== proposition.grinder
    || brouillon.temperature !== proposition.temperature
    || brouillon.aroma !== proposition.aroma
  );

  const off = busy || calcul;

  return (
    <Dialog open={ouvert} onOpenChange={(o) => { if (!o) onFermer(); }}>
      {/**
        * ⚠️ **`sm:max-w-[34rem]` et pas seulement `max-w-[34rem]` : la primitive porte
        * `sm:max-w-lg`, et le variant gagne.** Mesuré — le dialogue sortait à 512 px alors que la
        * classe demandait 544, parce que `sm:max-w-lg` est déclaré APRÈS dans la feuille et
        * s'applique dès 640 px de fenêtre. Écrire une largeur qu'on n'obtient pas est le pire des
        * deux mondes : la classe est là, elle se lit, et la boîte fait autre chose.
        *
        * ⚠️ **La hauteur : le dialogue est plafonné, et c'est le CORPS qui défile.** À l'étape 3 le
        * contenu mesure ~1 180 px. Mettre `overflow-y-auto` sur le dialogue entier ferait défiler
        * son pied avec lui, donc « Créer » sortirait de l'écran — un bouton d'enregistrement qu'il
        * faut aller chercher. D'où `flex flex-col` + un corps en `flex-1 min-h-0 overflow-y-auto` :
        * l'en-tête et le pied gardent leur taille, le corps prend ce qui reste.
        *
        * ⚠️ **`calc(100dvh-2rem)` et non un pourcentage choisi à la main.** Un `max-h-[60dvh]` sur
        * le corps a d'abord été écrit : il tenait dans une fenêtre de 900 px et débordait de 8 px
        * dans celle de 600 px du banc — parce qu'un pourcentage du corps ignore la hauteur FIXE de
        * l'en-tête et du pied, qui ne rétrécit pas avec la fenêtre. Le plafond porte donc sur le
        * dialogue, où il n'a aucun nombre magique à deviner. Mesuré aux deux tailles.
        *
        * ⚠️ **`flex` remplace la grille de la primitive, et ce n'est pas cosmétique.** Une grille
        * dimensionne sa colonne unique sur le contenu le plus large : la largeur minimale du tableau
        * l'étirait à 568 px dans une boîte de 510, et tout débordait à droite, en silence.
        */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[34rem] flex-col sm:max-w-[34rem]">
        <DialogHeader>
          <DialogTitle>{t("presetNew")}</DialogTitle>
          <DialogDescription>{t("refineStep", { n: etape + 1, total: ETAPES })}</DialogDescription>
        </DialogHeader>

        {/* La barre est décorative : le compte est déjà dit en toutes lettres juste au-dessus, et
            l'annoncer deux fois ferait lire « étape 2 sur 3 » puis « 67 % » pour la même chose. */}
        <Progress value={((etape + 1) / ETAPES) * 100} aria-hidden="true" />

        {/* `min-h-0` est ce qui rend `flex-1` + `overflow-y-auto` effectif : sans lui la base d'un
            élément flex est son contenu, donc il pousse le dialogue au lieu de défiler. `min-w-0`
            pour la même raison sur l'autre axe — c'est le tableau qui défile dans son `.tableWrap`,
            pas le dialogue. */}
        <div className="blocSuite min-h-0 min-w-0 flex-1 overflow-y-auto" aria-live="polite">
          {/* ── 0 · LE MÉLANGE ─────────────────────────────────────────────────────────────── */}
          {etape === 0 && (
            <>
              <h3 tabIndex={-1} ref={titreEtape}>{t("blend")}</h3>
              {/* **Deux réponses, sans image.** Ce n'est pas une économie : `prequestion_1` du
                  questionnaire De'Longhi ne porte aucun `img`, contrairement aux quatre réponses de
                  la torréfaction. Inventer deux dessins de grains ici ferait passer une illustration
                  de notre main pour un visuel de l'appareil.
                  Écrits à la main, pas en boucle — `verif-messages.mjs` ne voit que les clés
                  littérales, et un `t(`blend${n}`)` lui échapperait. */}
              <ChoixVisuel nom="blend" etiquette={t("blend")} valeur={melange} onChange={setMelange} disabled={off} options={[
                { v: 1, libelle: t("blend1") },
                { v: 2, libelle: t("blend2") },
              ]} />
              <p className="legende">{t("blendHint")}</p>
            </>
          )}

          {/* ── 1 · LA TORRÉFACTION ────────────────────────────────────────────────────────── */}
          {etape === 1 && (
            <>
              <h3 tabIndex={-1} ref={titreEtape}>{t("roast")}</h3>
              {/* Les quatre visuels sont ceux de l'app (`prequestion_2`, `Beans1-4.png`), déjà
                  versionnés sous `public/grains/`. Ici la question est posée SANS « non précisée » :
                  le parcours de création n'aboutit à une proposition que si l'on a répondu, et la
                  réponse alimente le calcul. C'est au dos de la carte, plus tard, que le niveau
                  redevient effaçable. */}
              <ChoixVisuel nom="roast" etiquette={t("roast")} valeur={torrefaction} onChange={setTorrefaction} disabled={off} options={[
                { v: 1, libelle: t("roast1"), image: <ImageTorrefaction niveau={1} className="h-14 w-auto" /> },
                { v: 2, libelle: t("roast2"), image: <ImageTorrefaction niveau={2} className="h-14 w-auto" /> },
                { v: 3, libelle: t("roast3"), image: <ImageTorrefaction niveau={3} className="h-14 w-auto" /> },
                { v: 4, libelle: t("roast4"), image: <ImageTorrefaction niveau={4} className="h-14 w-auto" /> },
              ]} />
              <p className="legende">{t("roastHint")}</p>
            </>
          )}

          {/* ── 2 · LA CONFIGURATION ───────────────────────────────────────────────────────── */}
          {etape === 2 && proposition && brouillon && (
            <>
              <h3 tabIndex={-1} ref={titreEtape}>{t("neufStepConfig")}</h3>

              {/* **L'origine de la règle, avant les chiffres qu'elle propose.** Lue dans la réponse
                  du serveur et non écrite ici : une phrase codée en dur affirmerait encore
                  « proposition locale » depuis que la table réelle est relevée, ou l'inverse.

                  La date accompagne le relevé et n'est pas décorative : elle dit de quand datent
                  ces trois chiffres, et donc à partir de quand ils peuvent avoir vieilli. */}
              {proposition.source === "delonghi" && proposition.releve
                ? <p className="legende">{t("neufReleveRule", { date: proposition.releve })}</p>
                : <p className="warn">{t("neufLocalRule")}</p>}

              <div className="tableWrap">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("setting")}</TableHead>
                      <TableHead>{t("proposed")}</TableHead>
                      <TableHead>{t("neufKept")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>{t("grinder")}</TableCell>
                      <TableCell className="num">{proposition.grinder}</TableCell>
                      <TableCell className="num">{brouillon.grinder}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>{t("temperature")}</TableCell>
                      <TableCell className="num">{proposition.temperature}</TableCell>
                      <TableCell className="num">{brouillon.temperature}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>{t("aroma")}</TableCell>
                      <TableCell className="num">{proposition.aroma}</TableCell>
                      <TableCell className="num">{brouillon.aroma}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              {proposition.notes.map((n) => (
                <p className="legende" key={n}>{t.has(`note_${n}`) ? t(`note_${n}`) : n}</p>
              ))}

              {/* Le retour à la proposition, et seulement quand on s'en est écarté — même geste que
                  « Reprendre la mesure » à l'étape 0 de l'affinage : proposé quand il a un sens,
                  absent le reste du temps plutôt que présent et inerte. */}
              {ecarte && (
                <div className="row">
                  <Button type="button" variant="neutre" size="commande" className="iconBtn" disabled={off}
                    onClick={() => setBrouillon({ ...brouillon, grinder: proposition.grinder, temperature: proposition.temperature, aroma: proposition.aroma })}>
                    <Icone nom="lire" taille={14} />
                    <span className="lbl">{t("neufReuse")}</span>
                  </Button>
                </div>
              )}

              {/* Le formulaire, celui des deux autres hôtes. Le nom et la torréfaction se corrigent
                  ici : la torréfaction est déjà cochée sur la réponse de l'étape 1, et la changer ne
                  recalcule rien — le tableau garde la proposition faite aux réponses données, ce qui
                  reste vrai.

                  ⚠️ **`photo={false}`, et c'est mesuré, pas décidé au goût.** L'affiche du grain
                  rendait le dessin de torréfaction à 370 × 332 px — agrandis d'un fichier de
                  147 × 132 — soit ~660 px de haut, juste au-dessus du rail qui montre le même
                  dessin ; le dialogue atteignait 1 762 px. Et c'est le parcours de l'appareil :
                  son écran de création ne demande que le nom, la photo s'attachant depuis l'écran
                  de détail. Elle s'ajoute donc au dos de la carte, une fois celle-ci créée. */}
              <ReglagesGrains
                prefixe="creation"
                valeur={brouillon}
                bounds={bounds}
                disabled={off}
                photo={false}
                onChange={setBrouillon}
              />

              <p className="legende">{t("neufPhotoPlusTard")}</p>
              <p className="legende">{t("neufCreateHint")}</p>
            </>
          )}

          {erreur && <p className="status err" role="status">{erreur}</p>}
        </div>

        {/* `data-nav` nomme les commandes du parcours. Ce n'est pas une commodité de test :
            `DialogContent` rend sa croix de fermeture APRÈS ses enfants, donc « le dernier bouton
            du dialogue » désigne la croix, pas « Suivant ». Un repère positionnel se serait trompé
            de bouton en silence — et c'est exactement ce qui est arrivé à l'affinage. */}
        <DialogFooter>
          <Button type="button" data-nav="retour" variant="neutre" disabled={etape === 0 || off} onClick={() => setEtape((n) => Math.max(0, n - 1))}>
            {t("refineBack")}
          </Button>
          {etape < ETAPES - 1 ? (
            <Button type="button" data-nav="suivant" variant="marche" disabled={off} onClick={suivant}>
              {etape === 1 ? t("simulate") : t("refineNext")}
            </Button>
          ) : (
            <Button type="button" data-nav="creer" variant="marche" disabled={off || !brouillon} onClick={() => void creer()}>
              {t("presetCreate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
