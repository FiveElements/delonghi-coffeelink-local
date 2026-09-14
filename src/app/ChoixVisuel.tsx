"use client";
import { cn } from "@/ui/cn";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE RÉPONSE PARMI PLUSIEURS, MONTRÉE EN ENTIER
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le contrôle des questionnaires Bean Adapt : deux à quatre réponses posées côte à côte, avec ou
 * sans visuel. Une liste déroulante n'en montrerait qu'une à la fois, or comparer *est* la question
 * — on choisit une crema en regardant les trois, un mélange en lisant les deux.
 *
 * **Il est né dans `AffinageDialog` et il en est sorti le jour où il a eu un second hôte** — le
 * questionnaire de création (`CreationGrainDialog`). C'est la règle que cette page a déjà payée
 * deux fois : deux copies d'un même contrôle font atterrir une correction d'accessibilité sur l'un
 * et pas sur l'autre. Il n'y a donc qu'une implémentation, et `verif-surfaces.mjs` la vérifie une
 * fois pour les deux dialogues.
 *
 * ⚠️ **C'est un `radiogroup` écrit à la main, et il doit l'être en entier.** Des `<button>` posés
 * côte à côte n'annoncent ni le groupe, ni le nombre d'options, ni celle qui est choisie — ils se
 * lisent « bouton, bouton, bouton ». Le rôle, `aria-checked` et le nom du groupe sont donc portés
 * explicitement, et la navigation aux flèches est écrite : dans un groupe de boutons radio, seul
 * l'élément coché est dans l'ordre de tabulation (`tabIndex` roving), et les flèches déplacent le
 * choix. C'est ce que `<input type="radio">` donnait gratuitement, et ce qu'il faut redemander dès
 * qu'on veut une image dans l'étiquette.
 *
 * ⚠️ **L'étiquette du groupe arrive DÉJÀ TRADUITE, en argument.** Elle se déduisait du nom
 * technique (`nom === "crema" ? t("crema") : t("taste")`), ce qui marchait tant qu'il n'y avait que
 * deux questions et donnait « Goût » à la troisième, en silence. Un composant partagé ne devine pas
 * le vocabulaire de ses hôtes.
 */
export interface OptionChoix {
  /** La valeur envoyée au serveur — l'`answer.id` du questionnaire De'Longhi. */
  v: number;
  libelle: string;
  image?: React.ReactNode;
}

export default function ChoixVisuel({
  nom,
  etiquette,
  valeur,
  onChange,
  options,
  disabled = false,
}: {
  /** Préfixe de `data-choix`, et rien d'autre : il ne sert pas à choisir un libellé. */
  nom: string;
  /** Le nom accessible du groupe, déjà traduit par l'hôte. */
  etiquette: string;
  valeur: number;
  onChange: (v: number) => void;
  options: OptionChoix[];
  disabled?: boolean;
}) {
  const clavier = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const i = options.findIndex((o) => o.v === valeur);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); onChange(options[(i + 1) % options.length].v); }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); onChange(options[(i - 1 + options.length) % options.length].v); }
  };
  return (
    <div className="row" role="radiogroup" aria-label={etiquette} onKeyDown={clavier}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={valeur === o.v}
          tabIndex={valeur === o.v ? 0 : -1}
          data-choix={`${nom}-${o.v}`}
          disabled={disabled}
          /* ⚠️ **La matière est portée ici, en utilitaires, et ce n'est pas un raccourci.** Une
             classe dans `surfaces.css` perdrait deux fois en silence : `button:not([data-slot])`
             y est (0,1,1) et battrait `.choixVisuel` (0,1,0) sur le rembourrage, et la règle
             `button { font: inherit; line-height: 1.2 }` de la couche `facade` bat n'importe
             quelle spécificité de `surfaces` sur la taille du texte. `utilities` gagne sur les
             deux — c'est la loi énoncée dans CLAUDE.md, et elle a déjà coûté trois blocs. */
          className={cn(
            "flex flex-1 flex-col items-center gap-2 rounded-[var(--radius)] border p-3 text-center text-sm leading-tight",
            "cursor-pointer transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:cursor-not-allowed disabled:opacity-60",
            /* **Ambre, et pas vert.** La loi des trois couleurs de ce produit : l'ambre dit
               « choisi », le vert dit « ça démarre sur l'appareil ». Cocher une réponse à un
               questionnaire ne démarre rien — c'est la même teinte que la variante `choisi`. */
            valeur === o.v
              ? "border-ambre bg-ambre-verre text-ambre"
              : "border-border bg-card text-encre-douce hover:border-encre/40",
          )}
          onClick={() => onChange(o.v)}
        >
          {o.image}
          <span>{o.libelle}</span>
        </button>
      ))}
    </div>
  );
}
