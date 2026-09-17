"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useConfirm } from "../confirm";
import Icone from "../icons";
import { Input } from "@/ui/input";
import { Checkbox } from "@/ui/checkbox";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";

/**
 * Jetons d'API MCP : la page qui les crée, les liste et les révoque.
 *
 * **Global, comme `/machines` et `/api/apps`.** Un jeton n'appartient à aucune machine — il donne
 * à un client MCP l'accès qu'il porte sur TOUTES les machines de ce serveur — donc `fetch` brut et
 * jamais `mfetch` : il n'y a pas de `?machine=` à joindre ici (voir `/api/mcp-tokens` dans
 * `server.mjs`, servi avant toute résolution de machine).
 *
 * **Le jeton en clair ne traverse le réseau qu'une fois.** Le serveur ne range que son hachage
 * (`store.mjs`, `hashToken`) : la réponse de création est le seul moment où la valeur existe côté
 * client, d'où `freshToken` — un état qui ne survit ni à un rechargement ni à un aller-retour vers
 * la liste, et que rien ne repeuple après coup.
 */

interface TokenSummary {
  id: number;
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface Reponse {
  tokens: TokenSummary[];
  categories: string[];
  naturesParCategorie: Record<string, string[]>;
}

/** Un compte rendu d'action : son texte et ce qu'il annonce (voir `/machines`, même convention). */
interface Rapport {
  text: string;
  kind: "ok" | "err";
}

const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("fr-FR") : null);

/**
 * Les catégories et natures sont déjà des mots français lus tels quels dans le protocole
 * (« boissons », « lecture »…) : ce ne sont pas des identifiants opaques à faire passer par
 * `src/i18n/labels.ts`. Mais l'identifiant lui-même est ASCII (`MCP_SCOPE_CATEGORIES`,
 * `store.mjs`) — capitaliser « reglages » à la volée aurait donné « Reglages », sans l'accent
 * que le mot français porte. La table ne fait QUE ça : rhabiller l'accent qu'un identifiant de
 * catégorie ne peut pas porter, pas traduire un sens.
 */
const CATEGORIE_LABEL: Record<string, string> = {
  statut: "Statut",
  journal: "Journal",
  boissons: "Boissons",
  profils: "Profils",
  grains: "Grains",
  recettes: "Recettes",
  reglages: "Réglages",
};

const etiquette = (categorie: string, nature: string) =>
  `${CATEGORIE_LABEL[categorie] ?? categorie} · ${nature}`;

/**
 * Poser un texte dans le presse-papiers, sur un serveur en http simple.
 *
 * Copie de `copierTexte` (`src/app/statistiques/page.tsx`), qui explique pourquoi les deux chemins
 * sont nécessaires : `navigator.clipboard` n'existe que dans un contexte sûr (https, ou localhost),
 * or ce serveur se consulte à son adresse de réseau local. Rendue ici plutôt qu'importée pour ne pas
 * faire dépendre cette page d'un module qui n'exporte aujourd'hui que sa page par défaut.
 */
async function copierTexte(texte: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(texte);
      return true;
    } catch {
      /* refus de permission : on tente quand même le repli, qui n'en dépend pas */
    }
  }
  try {
    const champ = document.createElement("textarea");
    champ.value = texte;
    champ.setAttribute("readonly", "");
    champ.style.position = "fixed";
    champ.style.top = "0";
    champ.style.left = "-9999px";
    document.body.appendChild(champ);
    champ.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(champ);
    return ok;
  } catch {
    return false;
  }
}

export default function McpTokens() {
  const t = useTranslations("mcpTokens");
  const tc = useTranslations("common");
  const { demander, dialogue } = useConfirm();

  const [d, setD] = useState<Reponse | null>(null);
  const [msg, setMsg] = useState<Rapport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** Le jeton fraîchement créé, et lui seul : voir l'en-tête du fichier. */
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await fetch("/api/mcp-tokens").then((r) => r.json()));
    } catch (e) {
      setMsg({ text: tc("error", { message: String(e) }), kind: "err" });
    }
  }, [tc]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (cle: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(cle)) next.delete(cle);
      else next.add(cle);
      return next;
    });

  const create = async () => {
    const nom = name.trim();
    if (!nom) return;
    setBusy("creation");
    setMsg(null);
    try {
      const r = await fetch("/api/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nom, scopes: [...checked] }),
      }).then((x) => x.json());
      if (r.error) {
        setMsg({ text: tc("error", { message: r.error }), kind: "err" });
        return;
      }
      setFreshToken(r.token);
      setCopyMsg(null);
      setName("");
      setChecked(new Set());
      await load();
    } catch (e) {
      setMsg({ text: tc("error", { message: String(e) }), kind: "err" });
    } finally {
      setBusy(null);
    }
  };

  const copierJeton = async () => {
    if (!freshToken) return;
    const ok = await copierTexte(freshToken);
    setCopyMsg(ok ? t("copied") : t("copyFailed"));
  };

  const revoke = (tok: TokenSummary) =>
    demander({
      question: t("revokeConfirm", { name: tok.name }),
      warn: t("revokeWarn"),
      onConfirm: () =>
        void (async () => {
          setBusy(`revoke-${tok.id}`);
          setMsg(null);
          try {
            const r = await fetch(`/api/mcp-tokens/${tok.id}`, { method: "DELETE" }).then((x) => x.json());
            setMsg(
              r.revoked
                ? { text: t("revokedNote", { name: tok.name }), kind: "ok" }
                : { text: tc("error", { message: String(r.error ?? "?") }), kind: "err" },
            );
            await load();
          } catch (e) {
            setMsg({ text: tc("error", { message: String(e) }), kind: "err" });
          } finally {
            setBusy(null);
          }
        })(),
    });

  if (!d) return <p className="sub">{tc("loading")}</p>;

  return (
    <>
      <h1>{t("heading")}</h1>
      <p className="sub">{t("intro")}</p>

      {/* Permanent, comme sur `/machines` : un conteneur qui n'apparaît qu'avec son texte n'est
          jamais annoncé à un lecteur d'écran. Vide, `.status:empty` le masque. */}
      <p className={"status " + (msg?.kind === "err" ? "err" : "ok")} role="status">
        {msg?.text ?? ""}
      </p>

      {freshToken && (
        <Card>
          <h2 className="titreBloc">{t("createdHeading")}</h2>
          <p className="legende">{t("createdNote")}</p>
          <code className="mono block break-all rounded-touche bg-creux p-2">{freshToken}</code>
          <div className="row blocSuite">
            <Button type="button" variant="neutre" size="commande" className="iconBtn" onClick={copierJeton}>
              <Icone nom="copier" />
              <span className="lbl">{t("copy")}</span>
            </Button>
            <Button type="button" variant="neutre" size="commande" onClick={() => { setFreshToken(null); setCopyMsg(null); }}>
              {t("createdDismiss")}
            </Button>
          </div>
          <p className="status ok" role="status">{copyMsg ?? ""}</p>
        </Card>
      )}

      <Card>
        <h2>{t("createHeading")}</h2>
        <span className="champBloc">
          <label htmlFor="mcp-nom">{t("nameLabel")}</label>
          <Input
            id="mcp-nom"
            className="champ"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy) create();
            }}
          />
        </span>

        <h3 className="titreBloc" id="mcp-portees-t">{t("scopesHeading")}</h3>
        <p className="legende" id="mcp-portees-n">{t("scopesNote")}</p>
        <div className="blocSuite" role="group" aria-labelledby="mcp-portees-t" aria-describedby="mcp-portees-n">
          {d.categories.map((cat) => (
            <div key={cat} className="row">
              {(d.naturesParCategorie[cat] ?? []).map((nat) => {
                const cle = `${cat}:${nat}`;
                const idCase = `mcp-scope-${cle}`;
                return (
                  /* `aria-labelledby`, pas `htmlFor` : `Checkbox` est un `<button>` Radix, qu'un
                     `<label>` enveloppant ne nomme pas (voir `/machines`, la case « mémoriser »). */
                  <span key={cle} className="caseLibelle">
                    <Checkbox
                      id={idCase}
                      checked={checked.has(cle)}
                      aria-labelledby={`${idCase}-l`}
                      onCheckedChange={() => toggle(cle)}
                    />
                    <span id={`${idCase}-l`}>{etiquette(cat, nat)}</span>
                  </span>
                );
              })}
            </div>
          ))}
        </div>

        <div className="row blocSuite">
          <Button
            type="button"
            variant="neutre"
            size="commande"
            className="iconBtn"
            onClick={create}
            disabled={!name.trim() || !!busy}
            aria-busy={busy === "creation" || undefined}
          >
            <Icone nom="ajouter" />
            <span className="lbl">{t("create")}</span>
          </Button>
        </div>
      </Card>

      <Card>
        <h2>{t("listHeading")}</h2>
        {d.tokens.length === 0 ? (
          <p className="sub">{t("empty")}</p>
        ) : (
          <div className="tableWrap">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colScopes")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead>{t("colLastUsed")}</TableHead>
                  <TableHead>{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.tokens.map((tok) => (
                  <TableRow key={tok.id} className={tok.revokedAt ? "opacity-45" : undefined}>
                    <TableCell>
                      {tok.name}
                      {/* `plaque`, pas `arret` : le rouge est réservé à ce que la MACHINE rapporte
                          (voir `src/ui/badge.tsx`). Un jeton révoqué est un fait de ce serveur, pas
                          un état de l'appareil — la ligne grisée porte déjà la conséquence visuelle. */}
                      {tok.revokedAt && <Badge variant="plaque" className="ml-2">{t("revoked")}</Badge>}
                    </TableCell>
                    <TableCell>
                      {tok.scopes.length ? tok.scopes.map((s) => s.replace(":", " · ")).join(", ") : t("noScopes")}
                    </TableCell>
                    <TableCell className="num">{date(tok.createdAt)}</TableCell>
                    <TableCell className="num">{tok.lastUsedAt ? date(tok.lastUsedAt) : t("never")}</TableCell>
                    <TableCell>
                      {!tok.revokedAt && (
                        <Button
                          type="button"
                          variant="discret-arret"
                          size="coquille"
                          className="iconBtn"
                          onClick={() => revoke(tok)}
                          disabled={!!busy}
                          aria-busy={busy === `revoke-${tok.id}` || undefined}
                        >
                          <Icone nom="corbeille" taille={14} />
                          <span className="lbl">{t("revoke")}</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {dialogue}
    </>
  );
}
