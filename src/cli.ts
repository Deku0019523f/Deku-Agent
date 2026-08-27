#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { resolve } from "node:path";
import { runAgentLoop, type AgentEvent } from "./agent/loop";
import { findResumableSession } from "./memory/sessions";
import { listProjectSnapshots, restoreSnapshot, formatSnapshotList } from "./tools/snapshots";
import {
  loadConfig,
  setApiKey,
  removeApiKey,
  setDefaultProviderModel,
  applyStoredKeysToEnv,
  resolveProviderAndModel,
  maskKey,
  PROVIDER_IDS,
  PROVIDER_ENV_VAR,
} from "./config/store";
import { fetchModels } from "./config/models";
import { promptSelect, promptMasked } from "./config/prompts";
import type { ProviderId } from "./providers";
import type { AgentConfig } from "./types";

// Clés stockées via `deku config` injectées dans l'environnement AVANT tout
// le reste — comportement identique à un export shell classique pour les
// providers (qui lisent process.env[...] sans savoir d'où vient la valeur).
applyStoredKeysToEnv();

const program = new Command();

const PROVIDER_LABEL: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  gemini: "Gemini (Google)",
  groq: "Groq",
  openai: "OpenAI",
};

program
  .name("deku")
  .description("Deku Agent — agent de développement autonome pour Termux")
  .argument("[objectif]", "Objectif à réaliser (sinon prompt interactif)")
  .option("--provider <provider>", "openrouter | gemini | groq | openai (défaut: dernier configuré via `deku config`)")
  .option("--model <model>", "Modèle à utiliser (défaut: dernier configuré via `deku config`)")
  .option("--cwd <path>", "Racine du projet", process.cwd())
  .option("--plan", "Mode plan : analyse et propose sans rien modifier", false)
  .option("--auto", "Enchaîne les actions SAFE sans confirmation", false)
  .option("--max-iterations <n>", "Limite d'itérations de la boucle", "25")
  .option("--resume", "Reprendre la dernière session interrompue sur ce projet", false)
  .option("--list-snapshots", "Liste les snapshots Git du projet et quitte (pas d'agent)", false)
  .option("--rollback <id>", "Restaure le working tree à l'état du snapshot <id> et quitte")
  .action(async (objectifArg, opts) => {
    const cwd = resolve(opts.cwd);

    if (opts.listSnapshots) {
      const snapshots = await listProjectSnapshots(cwd);
      console.log(formatSnapshotList(snapshots));
      return;
    }

    if (opts.rollback) {
      const id = parseInt(opts.rollback, 10);
      const rlConfirm = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rlConfirm.question(
        chalk.yellow(`⚠️  Restaurer le snapshot #${id} ? Modifications non commitées et fichiers créés depuis seront perdus. (o/N) `)
      );
      rlConfirm.close();
      if (answer.trim().toLowerCase() !== "o") {
        console.log(chalk.dim("Annulé."));
        return;
      }
      const result = await restoreSnapshot(cwd, id);
      if (result.ok) {
        console.log(chalk.green(`✓ Working tree restauré: "${result.label}" (snapshot #${id})`));
      } else {
        console.log(chalk.red(`✗ ${result.error}`));
        process.exitCode = 1;
      }
      return;
    }

    // Le projet démarre TOUJOURS, même sans clé API configurée — on ne
    // sort plus en erreur ici. Une session interactive s'ouvre, avec une
    // commande /config disponible pour configurer clé + modèle à la volée
    // (comme Cline), sans avoir à relancer le programme.
    console.log(chalk.bold("\n╭────────────────────────────────────────╮"));
    console.log(chalk.bold("│              DEKU AGENT                 │"));
    console.log(chalk.bold("╰────────────────────────────────────────╯"));
    console.log(`Project : ${chalk.dim(cwd)}`);
    console.log(chalk.dim("Tape /config pour ajouter une clé API / changer de modèle, /help pour l'aide.\n"));

    let rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let pendingInput: string | undefined = objectifArg;
    let resumeHandled = false;

    while (true) {
      let input: string;
      try {
        input = pendingInput ?? (await rl.question(chalk.cyan("Objectif (ou /config, /help) > ")));
      } catch {
        break; // stdin fermé (Ctrl+D, pipe épuisé...) : sortie propre
      }
      pendingInput = undefined;
      input = input.trim();
      if (!input) continue;

      if (input.startsWith("/")) {
        const [cmd] = input.slice(1).split(/\s+/);
        if (cmd === "config") {
          rl.close(); // une seule interface readline active à la fois (cf. assistant de config)
          await runConfigWizard();
          applyStoredKeysToEnv();
          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        } else if (cmd === "help") {
          console.log(
            chalk.bold("\nCommandes disponibles :\n") +
              "  /config          Ajouter/changer une clé API et le modèle par défaut\n" +
              "  /help            Cette aide\n" +
              "  /exit, /quit     Quitter\n" +
              "  (tout le reste)  Traité comme un objectif pour l'agent\n"
          );
        } else if (cmd === "exit" || cmd === "quit") {
          break;
        } else {
          console.log(chalk.yellow(`Commande inconnue: /${cmd}. Tape /help pour la liste.`));
        }
        continue;
      }

      const stored = loadConfig();
      const { provider, model } = resolveProviderAndModel(opts.provider, opts.model, stored);

      const missingKey = !process.env[PROVIDER_ENV_VAR[provider]];
      if (missingKey) {
        console.log(
          chalk.red(
            `✗ Aucune clé API pour "${provider}" (variable ${PROVIDER_ENV_VAR[provider]} absente).\n` +
              `  Tape "/config" pour en ajouter une, ou exporte-la manuellement.\n`
          )
        );
        continue;
      }

      const config: AgentConfig = {
        provider,
        model,
        mode: opts.plan ? "plan" : "act",
        auto: opts.auto,
        cwd,
        maxIterations: parseInt(opts.maxIterations, 10),
      };

      printRunInfo(config);

      let resumeSessionId: string | undefined;
      if (opts.resume && !resumeHandled) {
        resumeHandled = true;
        const resumable = await findResumableSession(config.cwd);
        if (resumable) {
          resumeSessionId = resumable.id;
          console.log(chalk.magenta(`↻ Reprise de la session ${resumable.id} (objectif original: "${resumable.objective}")\n`));
        } else {
          console.log(chalk.dim("Aucune session interrompue trouvée pour ce projet, nouvelle session.\n"));
        }
      }

      const confirm = async (question: string): Promise<boolean> => {
        const answer = await rl.question(chalk.yellow(`${question} (o/N) `));
        return answer.trim().toLowerCase() === "o";
      };

      try {
        await runAgentLoop(input, config, confirm, (event) => render(event), {
          resumeSessionId,
        });
      } catch (e: any) {
        console.error(chalk.red(`\n✗ Erreur fatale: ${e?.message ?? e}`));
      }

      // Objectif passé en argument CLI (usage scripté/ponctuel) : une seule
      // tâche puis sortie, comportement historique. Session interactive
      // (aucun argument au lancement) : on reboucle pour un nouvel objectif.
      if (objectifArg) break;
      console.log(); // ligne vide avant le prochain prompt
    }

    rl.close();
  });

// ============================================================
// deku config — gestion des clés API et du provider/modèle par défaut
// ============================================================

const configCmd = program
  .command("config")
  .description("Ajoute une clé API et choisis le provider/modèle par défaut (assistant interactif si appelé seul)");

configCmd
  .command("show")
  .description("Affiche la config actuelle (clés masquées)")
  .action(() => {
    const stored = loadConfig();
    console.log(chalk.bold("\nProvider par défaut:"), stored.defaultProvider ?? chalk.dim("(aucun, openrouter par défaut)"));
    console.log(chalk.bold("Modèles mémorisés:"));
    for (const p of PROVIDER_IDS) {
      const model = stored.models?.[p];
      if (model) console.log(`  ${PROVIDER_LABEL[p]}: ${model}`);
    }
    console.log(chalk.bold("\nClés API:"));
    for (const p of PROVIDER_IDS) {
      const stored_key = stored.apiKeys?.[p];
      const envKey = process.env[PROVIDER_ENV_VAR[p]];
      if (stored_key) {
        console.log(`  ${PROVIDER_LABEL[p]}: ${chalk.green(maskKey(stored_key))} (sauvegardée)`);
      } else if (envKey) {
        console.log(`  ${PROVIDER_LABEL[p]}: ${chalk.green(maskKey(envKey))} (variable d'environnement)`);
      } else {
        console.log(`  ${PROVIDER_LABEL[p]}: ${chalk.dim("non configurée")}`);
      }
    }
    console.log();
  });

configCmd
  .command("set-key <provider> <key>")
  .description("Enregistre une clé API pour un provider, sans passer par l'assistant")
  .action((providerArg: string, key: string) => {
    const provider = validateProvider(providerArg);
    if (!provider) return;
    setApiKey(provider, key);
    console.log(chalk.green(`✓ Clé enregistrée pour ${PROVIDER_LABEL[provider]} (${maskKey(key)}).`));
  });

configCmd
  .command("remove-key <provider>")
  .description("Supprime la clé API sauvegardée pour un provider")
  .action((providerArg: string) => {
    const provider = validateProvider(providerArg);
    if (!provider) return;
    removeApiKey(provider);
    console.log(chalk.green(`✓ Clé supprimée pour ${PROVIDER_LABEL[provider]}.`));
  });

configCmd
  .command("set-model <provider> <model>")
  .description("Change le provider et le modèle par défaut, sans passer par l'assistant")
  .action((providerArg: string, model: string) => {
    const provider = validateProvider(providerArg);
    if (!provider) return;
    setDefaultProviderModel(provider, model);
    console.log(chalk.green(`✓ Par défaut: ${PROVIDER_LABEL[provider]} / ${model}`));
  });

configCmd.action(async () => {
  await runConfigWizard();
});

function validateProvider(input: string): ProviderId | null {
  if (PROVIDER_IDS.includes(input as ProviderId)) return input as ProviderId;
  console.log(chalk.red(`✗ Provider inconnu: "${input}". Valeurs possibles: ${PROVIDER_IDS.join(", ")}`));
  process.exitCode = 1;
  return null;
}

async function runConfigWizard(): Promise<void> {
  console.log(chalk.bold("\n⚙️  Configuration Deku Agent\n"));

  let rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const provider = (await promptSelect(
    rl,
    "Quel provider configurer ?",
    PROVIDER_IDS.map((p) => ({ label: PROVIDER_LABEL[p], value: p }))
  )) as ProviderId;
  rl.close();

  const stored = loadConfig();
  const existingKey = stored.apiKeys?.[provider];
  const keyPrompt = existingKey
    ? `Clé API ${PROVIDER_LABEL[provider]} (Entrée pour garder ${maskKey(existingKey)}) : `
    : `Clé API ${PROVIDER_LABEL[provider]} : `;

  const typedKey = await promptMasked(keyPrompt);
  const apiKey = typedKey || existingKey;

  if (!apiKey) {
    console.log(chalk.red("✗ Aucune clé fournie, configuration annulée."));
    return;
  }
  if (typedKey) setApiKey(provider, apiKey);

  console.log(chalk.dim("\nRécupération des modèles disponibles..."));
  const { models, dynamic } = await fetchModels(provider, apiKey);
  if (!dynamic) {
    console.log(chalk.yellow("(catalogue live indisponible — liste de repli, peut être incomplète)"));
  }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const options = [
    ...models.map((m) => ({ label: m.label ? `${m.id}  (${m.label})` : m.id, value: m.id })),
    { label: "Autre (saisir un id de modèle manuellement)", value: "__custom__" },
  ];
  let model = await promptSelect(rl, `Quel modèle ${PROVIDER_LABEL[provider]} utiliser par défaut ?`, options);
  if (model === "__custom__") {
    model = (await rl.question("Id du modèle : ")).trim();
  }
  rl.close();

  if (!model) {
    console.log(chalk.red("✗ Aucun modèle choisi, configuration annulée."));
    return;
  }

  setDefaultProviderModel(provider, model);
  console.log(
    chalk.green(
      `\n✓ Configuré: ${PROVIDER_LABEL[provider]} / ${model}\n` +
        `  Utilisé par défaut au prochain "deku ..." (remplaçable avec --provider/--model).\n`
    )
  );
}

function printRunInfo(config: AgentConfig) {
  console.log(`Provider: ${chalk.dim(config.provider)}  Model: ${chalk.dim(config.model)}`);
  console.log(`Mode    : ${config.mode === "plan" ? chalk.blue("PLAN") : chalk.green("ACT")}${config.auto ? chalk.magenta("  +AUTO") : ""}\n`);
}

function render(event: AgentEvent) {
  switch (event.type) {
    case "thinking": {
      const payload = event.payload as any;
      if (payload?.phase === "scan") {
        console.log(chalk.dim("● Analyse du projet..."));
      } else if (payload?.phase === "planning") {
        console.log(chalk.dim("● Élaboration du plan..."));
      } else if (payload?.phase === "retry") {
        console.log(
          chalk.yellow(
            `● Échec provider (tentative ${payload.attempt}/${payload.maxAttempts}): ${payload.error} — nouvel essai dans ${payload.delayMs}ms`
          )
        );
      } else if (payload?.phase === "stuck") {
        console.log(chalk.red(`● Blocage détecté sur ${payload.tool} (${payload.attempts} échecs identiques)`));
      } else if (payload?.phase === "extensions") {
        console.log(chalk.dim("● Connexion MCP / chargement plugins..."));
      } else {
        console.log(chalk.dim("● Réflexion..."));
      }
      break;
    }
    case "warning": {
      console.log(chalk.yellow(`⚠ ${event.payload}`));
      break;
    }
    case "plan": {
      console.log(chalk.bold.blue("\n📋 Plan:"));
      console.log(`${event.payload}\n`);
      break;
    }
    case "assistant_text":
      console.log(`\n${event.payload}\n`);
      break;
    case "tool_call": {
      const call = event.payload as any;
      console.log(chalk.cyan(`● ${call.name}(${JSON.stringify(call.arguments)})`));
      break;
    }
    case "tool_result": {
      const result = event.payload as any;
      const icon = result.is_error ? chalk.red("✗") : chalk.green("✓");
      const preview = String(result.content).slice(0, 200);
      console.log(`  ${icon} ${preview}${String(result.content).length > 200 ? "..." : ""}`);
      break;
    }
    case "done":
      console.log(chalk.bold.green("\n✓ Tâche terminée.\n"));
      break;
    case "error":
      console.log(chalk.bold.red(`\n✗ ${event.payload}\n`));
      break;
  }
}

program.parseAsync(process.argv);
