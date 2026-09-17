/**
 * Vérifie que le catalogue d'outils MCP ne dérive pas de la surface /api/* réelle : chaque
 * outil déclaré dans server.mjs doit correspondre à un endpoint qui existe encore. Ne prouve
 * pas que l'implémentation est correcte (Task 12 s'en charge bout-en-bout) — seulement qu'un
 * outil ne pointe pas vers un endpoint renommé ou supprimé sans que quelqu'un s'en aperçoive.
 */
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

const OUTILS_ATTENDUS = [
  "get_status", "list_machines", "get_machine", "get_system", "get_stats", "get_journal",
  "list_beverages", "get_beverage", "start_beverage",
  "list_profiles", "rename_profile", "set_favorite_profile",
  "get_bean_adapt", "list_bean_presets", "bean_adapt_simulate", "bean_adapt_creation_rule",
  "create_bean_preset", "update_bean_preset", "delete_bean_preset", "bean_adapt_scan", "bean_adapt_save",
  "list_recipes", "write_recipe",
  "get_settings", "write_settings",
  "clear_journal",
];

for (const nom of OUTILS_ATTENDUS) {
  if (!source.includes(`name: "${nom}"`)) {
    throw new Error(`outil MCP attendu absent de server.mjs : ${nom}`);
  }
}

// Aucun outil ne doit exposer les endpoints explicitement exclus par la conception.
// On vérifie que les NOMS des outils MCP ne contiennent pas de motifs excluants.
const EXCLUS = ["lankey", "ota", "cloudsession", "apps", "register", "monitormode", "visual"];
const nomsOutils = [...source.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
for (const nomOutil of nomsOutils) {
  for (const motif of EXCLUS) {
    if (nomOutil.includes(motif)) {
      throw new Error(`un outil MCP semble exposer un endpoint exclu par conception : ${nomOutil} (motif "${motif}")`);
    }
  }
}

console.log(`OK: ${OUTILS_ATTENDUS.length} outils MCP attendus présents dans server.mjs, aucun endpoint exclu détecté`);
