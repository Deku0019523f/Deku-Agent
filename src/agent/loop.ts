import type { AgentConfig, Message, ProviderResponse } from "../types";
import { getProvider } from "../providers";
import { executeTool, getRuntimeTools, type ConfirmFn } from "../tools";
import { scanProject, formatProjectContext } from "../context/scanner";
import { getProjectMemory, formatProjectMemory } from "../memory/project";
import { mcpRegistry } from "../mcp/registry";
import { pluginRegistry } from "../plugins/registry";
import {
  createSession,
  endSession,
  saveMessage,
  getSessionMessages,
} from "../memory/sessions";

export interface AgentEvent {
  type:
    | "thinking"
    | "plan"
    | "assistant_text"
    | "tool_call"
    | "tool_result"
    | "warning"
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
- Un plan a été validé avant de démarrer (voir message précédent) : suis-le, mais adapte-toi si le terrain diffère de ce qui était prévu.
- Si une action échoue de façon répétée, ne la relance pas telle quelle : diagnostique la cause ou change d'approche.
- Quand la tâche est terminée, réponds avec un résumé clair sans appeler d'outil.
- Reste concis. Une action à la fois.`;

const PLANNING_PROMPT = (objective: string) => `Objectif: ${objective}

Avant d'agir, produis un PLAN explicite (pas d'appel d'outil ici, texte seul) :
- Liste numérotée de 3 à 8 étapes concrètes, dans l'ordre.
- Chaque étape en une ligne, verbe d'action en premier (ex: "1. Lire src/x.ts pour comprendre Y").
- Signale les étapes risquées ou irréversibles si il y en a.
- Pas de préambule, pas de conclusion — juste le plan numéroté.`;

export interface RunAgentLoopOptions {
  resumeSessionId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_PROVIDER_RETRIES = 3;

/**
 * Enveloppe provider.send() avec retry + backoff exponentiel pour les
 * erreurs transitoires (réseau, timeout, 429/5xx côté provider). Les
 * providers lèvent une Error générique en cas d'échec réseau/HTTP — on
 * ne distingue pas finement les codes ici, on retente simplement, ce qui
 * couvre le cas Termux le plus fréquent : coupure réseau mobile passagère.
 */
async function sendWithRetry(
  provider: ReturnType<typeof getProvider>,
  opts: Parameters<ReturnType<typeof getProvider>["send"]>[0],
  emit: EmitFn
): Promise<ProviderResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
    try {
      return await provider.send(opts);
    } catch (e) {
      lastError = e;
      if (attempt < MAX_PROVIDER_RETRIES) {
        const delayMs = 1000 * 2 ** (attempt - 1);
        emit({
          type: "thinking",
          payload: {
            phase: "retry",
            attempt,
            maxAttempts: MAX_PROVIDER_RETRIES,
            delayMs,
            error: e instanceof Error ? e.message : String(e),
          },
        });
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function toolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

/**
 * Phase de planning explicite (V0.6) : un appel LLM dédié, sans outils,
 * qui produit un plan texte avant que la boucle ACTION ne démarre. Le
 * plan est injecté dans l'historique comme message assistant, donc le
 * modèle s'y réfère naturellement aux tours suivants (et --resume le
 * retrouve tel quel, aucun schéma supplémentaire nécessaire).
 */
async function generatePlan(
  provider: ReturnType<typeof getProvider>,
  config: AgentConfig,
  objective: string,
  systemMessage: Message,
  emit: EmitFn
): Promise<Message> {
  emit({ type: "thinking", payload: { phase: "planning" } });

  const response = await sendWithRetry(
    provider,
    {
      model: config.model,
      messages: [systemMessage, { role: "user", content: PLANNING_PROMPT(objective) }],
      // Pas de `tools` ici : on veut du texte, pas un appel d'outil.
    },
    emit
  );

  const planText = response.message.content ?? "(plan vide)";
  emit({ type: "plan", payload: planText });

  return { role: "assistant", content: planText };
}

/**
 * La boucle agentique. S'arrête quand :
 * - le LLM répond sans tool_calls (tâche considérée terminée), ou
 * - maxIterations est atteint (garde-fou anti-boucle infinie), ou
 * - la même action échoue 3 fois de suite à l'identique (garde-fou V0.6
 *   anti-boucle-d'échec : on arrête plutôt que de gaspiller le budget
 *   d'itérations sur une action qui ne passera jamais).
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

  // Connexion MCP + chargement plugins (V1.0), une fois pour tout le run
  // (agent principal + sous-agents délégués qui réutilisent le même
  // registre singleton). Un serveur/plugin cassé est journalisé en
  // "warning" et simplement absent des outils — jamais fatal au démarrage.
  emit({ type: "thinking", payload: { phase: "extensions" } });
  const [mcpWarnings, pluginWarnings] = await Promise.all([
    mcpRegistry.connectAll(config.cwd),
    pluginRegistry.loadAll(config.cwd),
  ]);
  for (const warning of [...mcpWarnings, ...pluginWarnings]) {
    emit({ type: "warning", payload: warning });
  }

  try {
    await runAgentLoopInner(objective, config, confirm, emit, provider, projectContext, projectMemory, options);
  } finally {
    await mcpRegistry.disconnectAll();
    pluginRegistry.reset();
  }
}

async function runAgentLoopInner(
  objective: string,
  config: AgentConfig,
  confirm: ConfirmFn,
  emit: EmitFn,
  provider: ReturnType<typeof getProvider>,
  projectContext: Awaited<ReturnType<typeof scanProject>>,
  projectMemory: Awaited<ReturnType<typeof getProjectMemory>>,
  options: RunAgentLoopOptions
): Promise<void> {
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

    // Planning explicite (V0.6), skippé au resume : le plan d'origine
    // est déjà dans l'historique rechargé depuis SQLite.
    const planMessage = await generatePlan(provider, config, objective, systemMessage, emit);
    messages.push(planMessage);
    await saveMessage(sessionId, planMessage);

    if (!config.auto) {
      const proceed = await confirm("Lancer ce plan ?");
      if (!proceed) {
        await endSession(sessionId, "interrupted");
        emit({ type: "error", payload: "Plan refusé par l'utilisateur, session arrêtée." });
        return;
      }
    }
  }

  // Suivi anti-boucle-d'échec : signature du dernier tool_call en échec
  // et son nombre de répétitions consécutives.
  let lastFailedSignature: string | null = null;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;

  try {
    for (let iteration = 0; iteration < config.maxIterations; iteration++) {
      emit({ type: "thinking", payload: { iteration } });

      const response = await sendWithRetry(
        provider,
        { model: config.model, messages, tools: getRuntimeTools() },
        emit
      );

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

      let stuck = false;

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

        const signature = toolCallSignature(call.name, call.arguments);
        if (result.is_error && signature === lastFailedSignature) {
          consecutiveFailures += 1;
        } else if (result.is_error) {
          lastFailedSignature = signature;
          consecutiveFailures = 1;
        } else {
          lastFailedSignature = null;
          consecutiveFailures = 0;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stuck = true;
          break;
        }
      }

      if (stuck) {
        emit({
          type: "thinking",
          payload: { phase: "stuck", tool: lastFailedSignature, attempts: consecutiveFailures },
        });
        await endSession(sessionId, "error");
        emit({
          type: "error",
          payload: `Action "${lastFailedSignature}" a échoué ${consecutiveFailures} fois de suite à l'identique. Arrêt pour éviter de gaspiller les itérations — reprends avec --resume après avoir ajusté l'objectif ou le contexte.`,
        });
        return;
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
