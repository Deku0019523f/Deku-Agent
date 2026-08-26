/**
 * Types minimaux du protocole MCP (Model Context Protocol) nécessaires à
 * Deku Agent : transport stdio, JSON-RPC 2.0 newline-delimited (validé
 * empiriquement contre @modelcontextprotocol/server-filesystem — pas de
 * framing Content-Length façon LSP, une ligne = un message).
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContentBlock {
  type: "text" | "image" | "audio" | "resource";
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Défaut true — permet de garder un serveur configuré mais désactivé. */
  enabled?: boolean;
}

export interface McpConfigFile {
  servers: Record<string, McpServerConfig>;
}
