import { getConfig, type GatewayConfig } from "./config";

export const DEFAULT_AI_PROVIDER = "claude-cli";

export function getProviderDisplayName(config: GatewayConfig = getConfig()): string {
  const name = config.providerDisplayName?.trim();
  return name || "AI";
}

export function getConfiguredProviderName(config: GatewayConfig = getConfig()): string {
  const provider = config.aiProvider?.trim();
  return provider || DEFAULT_AI_PROVIDER;
}

export interface ProviderProcessConfig {
  orphanedProcessPattern?: string;
  clearSessionProcessPattern?: string;
}

export function getProviderProcessConfig(
  providerName: string,
  options: { mcpConfigPath: string }
): ProviderProcessConfig {
  if (providerName === "claude-cli") {
    return {
      orphanedProcessPattern: `claude.*--mcp-config.*${options.mcpConfigPath}`,
      clearSessionProcessPattern: "claude.*--print.*--dangerously-skip-permissions",
    };
  }

  if (providerName === "codex-cli") {
    return {
      orphanedProcessPattern: "codex.*exec.*--json.*--dangerously-bypass",
      clearSessionProcessPattern: "codex.*exec.*--json.*--dangerously-bypass",
    };
  }

  return {};
}
