import type { AgentConfig, Message } from "../types";
import { getProvider } from "../providers";
import { ALL_TOOLS, executeTool, type ConfirmFn } from "../tools";
import { scanProject, formatProjectContext } from "../context/scanner";
import { getProjectMemory, formatProjectMemory } from "../memory/project";
import {
  createSession,
  endSession,
  saveMessage,
  getSessionMessages,
} from "../memory/sessions";

export interface AgentEvent {
  type:
    | "thinking"
    | "assistant_text"
    | "tool_call"
    | "tool_result"
    | "done"
    | "error";
  payload: unknown;
}

export type EmitFn = (event: AgentEvent) => void;

const SYSTEM_PROMPT = (
  config: AgentConfig,
  projectContextText: string,
  projectMemoryText: string | null
) => `Tu es Deku Agent, un agent de développement autonome opérant dans Termux sur Android.

Racine du projet: ${config.cwd}
Mode: ${config.mode === "plan" ? "PLAN (analyse uniquement, ne modifie rien)" : "ACT (peut modifier le projet)"}

## Contexte du projet (détecté automatiquement)
${projectContextText}
${projectMemoryText ? `\n## Mémoire du projet (sessions précédentes)\n${projectMemoryText}\n` : ""}
Règles:
- Utilise le contexte projet ci-dessus au lieu de relister les fichiers inutilement.
- Explore avant d'agir : lis les fichiers pertinents avant de proposer des modifications.
- Ne devine jamais le contenu d'un fichier que tu n'as pas lu.
- Après chaque action, vérifie le résultat avant de continuer.
- Quand la tâche est terminée, réponds avec un résumé clair sans appeler d'outil.
- Reste concis. Une action à la fois.`;

export interface RunAgentLoopOptions {
  resumeSessionId?: string;
}

/**
 * La boucle agentique. S'arrête quand :
 * - le LLM répond sans tool_calls (tâche considérée terminée), ou
 * - maxIterations est atteint (garde-fou anti-boucle infinie).
 * Chaque message est persisté en SQLite au fil de l'eau (V0.4) : une
 * session interrompue (crash, fermeture Termux) peut être reprise.
 */
export async function runAgentLoop(
  objective: string,
  config: AgentConfig,
  confirm: ConfirmFn,
  emit: EmitFn,
  options: RunAgentLoopOptions = {}
): Promise<void> {
  const provider = getProvider(config.provider);

  emit({ type: "thinking", payload: { phase: "scan" } });
  const [projectContext, projectMemory] = await Promise.all([
    scanProject(config.cwd),
    getProjectMemory(config.cwd),
  ]);

  let messages: Message[];
  let sessionId: string;

  if (options.resumeSessionId) {
    sessionId = options.resumeSessionId;
    messages = await getSessionMessages(sessionId);
  } else {
    sessionId = await createSession(config.cwd, objective);
    const systemMessage: Message = {
      role: "system",
      content: SYSTEM_PROMPT(
        config,
        formatProjectContext(projectContext),
        formatProjectMemory(projectMemory)
      ),
    };
    const userMessage: Message = { role: "user", content: objective };
    messages = [systemMessage, userMessage];
    await saveMessage(sessionId, systemMessage);
    await saveMessage(sessionId, userMessage);
  }

  try {
    for (let iteration = 0; iteration < config.maxIterations; iteration++) {
      emit({ type: "thinking", payload: { iteration } });

      const response = await provider.send({
        model: config.model,
        messages,
        tools: ALL_TOOLS,
      });

      messages.push(response.message);
      await saveMessage(sessionId, response.message);

      if (response.message.content) {
        emit({ type: "assistant_text", payload: response.message.content });
      }

      if (response.finish_reason !== "tool_calls" || !response.message.tool_calls) {
        emit({ type: "done", payload: { iterations: iteration + 1 } });
        await endSession(sessionId, "completed");
        return;
      }

      for (const call of response.message.tool_calls) {
        emit({ type: "tool_call", payload: call });

        const result = await executeTool(call, config, confirm, { sessionId });
        emit({ type: "tool_result", payload: result });

        const toolMessage: Message = {
          role: "tool",
          content: result.content,
          tool_call_id: result.tool_call_id,
          name: result.name,
        };
        messages.push(toolMessage);
        await saveMessage(sessionId, toolMessage);
      }
    }

    await endSession(sessionId, "interrupted");
    emit({
      type: "error",
      payload: `Limite de ${config.maxIterations} itérations atteinte sans conclusion.`,
    });
  } catch (e) {
    await endSession(sessionId, "error");
    throw e;
  }
}
