import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  McpToolDefinition,
  McpToolCallResult,
  McpServerConfig,
} from "./types";

const INIT_TIMEOUT_MS = 10_000;
const LIST_TOOLS_TIMEOUT_MS = 10_000;
const CALL_TOOL_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = "2024-11-05";

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Une connexion à un serveur MCP local (stdio). Un process enfant par
 * serveur, JSON-RPC 2.0 newline-delimited dans les deux sens. Le wire
 * format a été vérifié empiriquement (pas de spec ambiguë ici) contre
 * @modelcontextprotocol/server-filesystem avant d'écrire ce client.
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private serverName: string;
  private config: McpServerConfig;
  private initialized = false;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  /** Spawn + handshake initialize/initialized. Rejette si le serveur ne répond pas à temps. */
  async connect(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.config.env ? { ...process.env, ...this.config.env } : process.env,
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.on("error", (err) => this.rejectAllPending(err));
    this.child.on("exit", () => {
      this.rejectAllPending(new Error(`Serveur MCP "${this.serverName}" terminé de façon inattendue.`));
    });
    // stderr des serveurs MCP est généralement du logging, pas fatal — ignoré volontairement.

    const initResponse = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "deku-agent", version: "1.0.0" },
      },
      INIT_TIMEOUT_MS
    );

    if (initResponse.error) {
      throw new Error(`Handshake MCP échoué pour "${this.serverName}": ${initResponse.error.message}`);
    }

    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.assertInitialized();
    const response = await this.request("tools/list", {}, LIST_TOOLS_TIMEOUT_MS);
    if (response.error) {
      throw new Error(`tools/list échoué pour "${this.serverName}": ${response.error.message}`);
    }
    const result = response.result as { tools?: McpToolDefinition[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    this.assertInitialized();
    const response = await this.request("tools/call", { name, arguments: args }, CALL_TOOL_TIMEOUT_MS);
    if (response.error) {
      // Erreur protocole JSON-RPC (méthode/outil inconnu, params invalides...)
      // — distincte d'un résultat outil avec isError:true.
      return { content: [{ type: "text", text: `Erreur protocole MCP: ${response.error.message}` }], isError: true };
    }
    return response.result as McpToolCallResult;
  }

  close(): void {
    this.rejectAllPending(new Error(`Connexion MCP "${this.serverName}" fermée.`));
    this.child?.kill();
    this.child = null;
  }

  private assertInitialized() {
    if (!this.initialized || !this.child) {
      throw new Error(`Client MCP "${this.serverName}" non connecté (connect() requis avant tout appel).`);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<JsonRpcResponse> {
    if (!this.child) return Promise.reject(new Error(`Client MCP "${this.serverName}" non démarré.`));
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout MCP (${timeoutMs}ms) sur "${method}" pour "${this.serverName}".`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.child!.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child) return;
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(JSON.stringify(note) + "\n");
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf-8");
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Ligne non-JSON (rare, mais un serveur mal poli peut écrire sur stdout) — ignorée.
      }

      // On ne gère que les réponses corrélées par id ; les notifications
      // serveur->client (ex: notifications/tools/list_changed) sont
      // volontairement ignorées dans cette V1.0 (pas de rafraîchissement
      // dynamique de la liste d'outils en cours de run).
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
