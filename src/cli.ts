#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { resolve } from "node:path";
import { runAgentLoop, type AgentEvent } from "./agent/loop";
import { findResumableSession } from "./memory/sessions";
import type { ProviderId } from "./providers";
import type { AgentConfig } from "./types";

const program = new Command();

program
  .name("deku")
  .description("Deku Agent — agent de développement autonome pour Termux")
  .argument("[objectif]", "Objectif à réaliser (sinon prompt interactif)")
  .option("--provider <provider>", "openrouter | gemini | groq | openai", "openrouter")
  .option("--model <model>", "Modèle à utiliser", "anthropic/claude-3.5-sonnet")
  .option("--cwd <path>", "Racine du projet", process.cwd())
  .option("--plan", "Mode plan : analyse et propose sans rien modifier", false)
  .option("--auto", "Enchaîne les actions SAFE sans confirmation", false)
  .option("--max-iterations <n>", "Limite d'itérations de la boucle", "25")
  .option("--resume", "Reprendre la dernière session interrompue sur ce projet", false)
  .action(async (objectifArg, opts) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const objectif =
      objectifArg ?? (await rl.question(chalk.cyan("Objectif > ")));

    const config: AgentConfig = {
      provider: opts.provider as ProviderId,
      model: opts.model,
      mode: opts.plan ? "plan" : "act",
      auto: opts.auto,
      cwd: resolve(opts.cwd),
      maxIterations: parseInt(opts.maxIterations, 10),
    };

    printBanner(config);

    let resumeSessionId: string | undefined;
    if (opts.resume) {
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
      await runAgentLoop(objectif, config, confirm, (event) => render(event), {
        resumeSessionId,
      });
    } catch (e: any) {
      console.error(chalk.red(`\n✗ Erreur fatale: ${e?.message ?? e}`));
      process.exitCode = 1;
    } finally {
      rl.close();
    }
  });

function printBanner(config: AgentConfig) {
  console.log(chalk.bold("\n╭────────────────────────────────────────╮"));
  console.log(chalk.bold("│              DEKU AGENT                 │"));
  console.log(chalk.bold("╰────────────────────────────────────────╯"));
  console.log(`Project : ${chalk.dim(config.cwd)}`);
  console.log(`Provider: ${chalk.dim(config.provider)}  Model: ${chalk.dim(config.model)}`);
  console.log(`Mode    : ${config.mode === "plan" ? chalk.blue("PLAN") : chalk.green("ACT")}${config.auto ? chalk.magenta("  +AUTO") : ""}\n`);
}

function render(event: AgentEvent) {
  switch (event.type) {
    case "thinking": {
      const payload = event.payload as any;
      if (payload?.phase === "scan") {
        console.log(chalk.dim("● Analyse du projet..."));
      } else {
        console.log(chalk.dim("● Réflexion..."));
      }
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
