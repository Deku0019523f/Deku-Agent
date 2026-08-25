import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types";
import { classifyCommand } from "./permissions";

export const runCommandTool: ToolDefinition = {
  name: "run_command",
  description:
    "Exécute une commande shell dans le workspace du projet. " +
    "Les commandes SAFE s'exécutent directement, CONFIRM et DANGEROUS " +
    "déclenchent une demande de validation à l'utilisateur.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Commande shell à exécuter" },
    },
    required: ["command"],
  },
};

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function runCommand(
  cwd: string,
  command: string,
  timeoutMs = 60_000
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export { classifyCommand };
