import type { ToolDefinition } from "../types";

export const spawnSubagentTool: ToolDefinition = {
  name: "spawn_subagent",
  description:
    "Délègue une sous-tâche autonome et bornée à un sous-agent qui partage les mêmes outils " +
    "(sauf spawn_subagent lui-même — pas de récursion). Utile pour une sous-investigation " +
    "self-contained (ex: 'analyse tous les fichiers de src/legacy/ et résume les patterns à risque') " +
    "sans polluer le fil de raisonnement principal avec le détail de son exploration. " +
    "Le sous-agent retourne un résumé texte final, pas d'accès à son historique complet.",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "Objectif précis, autonome et vérifiable pour le sous-agent (pas une simple sous-étape floue)",
      },
      max_iterations: {
        type: "number",
        description: "Limite d'itérations du sous-agent (défaut 8, plafond 15)",
      },
    },
    required: ["objective"],
  },
};

export const SUBAGENT_TOOL_NAME = spawnSubagentTool.name;
export const DEFAULT_SUBAGENT_MAX_ITERATIONS = 8;
export const HARD_CAP_SUBAGENT_MAX_ITERATIONS = 15;
export const MAX_SUBAGENT_DEPTH = 1;
