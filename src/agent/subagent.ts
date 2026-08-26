import type { AgentConfig, Message } from "../types";
import { getProvider } from "../providers";
import { ALL_TOOLS, executeTool, type ConfirmFn } from "../tools";
import { SUBAGENT_TOOL_NAME, MAX_SUBAGENT_DEPTH } from "../tools/subagent";

/**
 * Le sous-agent voit tous les outils SAUF spawn_subagent — défense en
 * profondeur en plus du check MAX_SUBAGENT_DEPTH : même si la vérification
 * de profondeur venait à changer, un sous-agent ne peut structurellement
 * pas se déléguer lui-même via ses tool definitions.
 *
 * Calculé PARESSEUSEMENT (à l'appel, pas au chargement du module) car
 * agent/subagent.ts <-> tools/index.ts est un import circulaire : au
 * moment où ce module est évalué, ALL_TOOLS de tools/index.ts peut ne
 * pas encore être initialisé (TDZ sur le const). Appeler cette fonction
 * depuis l'intérieur de runSubAgentLoop (donc après le chargement complet
 * des modules) est sûr.
 */
function getSubagentTools() {
  return ALL_TOOLS.filter((t) => t.name !== SUBAGENT_TOOL_NAME);
}

const SUBAGENT_SYSTEM_PROMPT = (config: AgentConfig) => `Tu es un sous-agent Deku, délégué par un agent parent pour UNE sous-tâche précise et bornée.

Racine du projet: ${config.cwd}
Mode: ${config.mode === "plan" ? "PLAN (analyse uniquement, ne modifie rien)" : "ACT (peut modifier le projet)"}

Règles:
- Reste strictement dans le périmètre de l'objectif donné, ne dérive pas vers autre chose.
- Explore avant d'agir, ne devine jamais le contenu d'un fichier non lu.
- Quand la sous-tâche est terminée, réponds avec un résumé clair et dense, SANS appeler d'outil.
  Ce résumé est lu par l'agent parent (pas par un humain) : va droit au but, pas de politesse inutile.`;

export interface SubagentResult {
  summary: string;
  iterationsUsed: number;
  completed: boolean;
}

/**
 * Exécute un sous-agent de façon synchrone (bloque le tool_call parent
 * jusqu'à conclusion) et retourne un résumé texte. Pas de session/message
 * persistés en SQLite séparément : le sous-agent est un détail
 * d'implémentation d'un seul tool_call parent, sa trace vit dans le
 * tool_result de ce dernier (déjà persisté par la boucle parente).
 */
export async function runSubAgentLoop(
  objective: string,
  parentConfig: AgentConfig,
  confirm: ConfirmFn,
  requestedMaxIterations: number | undefined,
  hardCapMaxIterations: number,
  defaultMaxIterations: number
): Promise<SubagentResult> {
  const currentDepth = parentConfig.subagentDepth ?? 0;
  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    return {
      summary: `Délégation refusée: profondeur max de sous-agents (${MAX_SUBAGENT_DEPTH}) atteinte. Traite cette sous-tâche toi-même.`,
      iterationsUsed: 0,
      completed: false,
    };
  }

  const maxIterations = Math.max(
    1,
    Math.min(requestedMaxIterations ?? defaultMaxIterations, hardCapMaxIterations)
  );

  const config: AgentConfig = {
    ...parentConfig,
    maxIterations,
    subagentDepth: currentDepth + 1,
  };

  const provider = getProvider(config.provider);
  const messages: Message[] = [
    { role: "system", content: SUBAGENT_SYSTEM_PROMPT(config) },
    { role: "user", content: objective },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await provider.send({
      model: config.model,
      messages,
      tools: getSubagentTools(),
    });
    messages.push(response.message);

    if (response.finish_reason !== "tool_calls" || !response.message.tool_calls) {
      return {
        summary: response.message.content ?? "(sous-agent terminé sans résumé)",
        iterationsUsed: iteration + 1,
        completed: true,
      };
    }

    for (const call of response.message.tool_calls) {
      // Le sous-agent hérite du même `confirm` que le parent : les
      // commandes CONFIRM/DANGEROUS repassent par l'utilisateur, aucun
      // contournement de la politique de permissions via délégation.
      const result = await executeTool(call, config, confirm, {});
      messages.push({
        role: "tool",
        content: result.content,
        tool_call_id: result.tool_call_id,
        name: result.name,
      });
    }
  }

  return {
    summary: `(sous-agent interrompu: limite de ${maxIterations} itérations atteinte sans conclusion — dernier état non résumé)`,
    iterationsUsed: maxIterations,
    completed: false,
  };
}
