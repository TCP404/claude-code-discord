/** @module claude/models — Claude model registry and dynamic refresh from SDK. */
import type { SDKModelInfo } from "./client.ts";
import { fetchModels, startModelRefresh } from "./model-fetcher.ts";

export interface ModelInfo {
  name: string;
  description: string;
  contextWindow: number;
  recommended: boolean;
  supportsThinking: boolean;
  tier: "flagship" | "balanced" | "fast" | "legacy";
  aliasFor?: string;
  thinkingMode?: boolean;
  deprecated?: boolean;
}

// Claude Code model options - Dynamic-friendly with aliases
// Aliases (opus, sonnet, haiku) auto-resolve to the latest version via Claude CLI
// Users can also specify full model names to pin a specific version
// This object is updated dynamically at runtime when ANTHROPIC_API_KEY is set
export let CLAUDE_MODELS: Record<string, ModelInfo> = {
  // === Aliases (always resolve to latest via CLI) ===
  "opus": {
    name: "Claude Opus (Latest)",
    description: "Most powerful model — auto-resolves to latest Opus via CLI alias",
    contextWindow: 200000,
    recommended: true,
    supportsThinking: true,
    tier: "flagship",
    aliasFor: "claude-opus-4-5-20251101",
  },
  "sonnet": {
    name: "Claude Sonnet (Latest)",
    description: "High-performance model — auto-resolves to latest Sonnet via CLI alias",
    contextWindow: 200000,
    recommended: true,
    supportsThinking: true,
    tier: "balanced",
    aliasFor: "claude-sonnet-4-5-20250929",
  },
  "haiku": {
    name: "Claude Haiku (Latest)",
    description: "Fast model for quick tasks — auto-resolves to latest Haiku via CLI alias",
    contextWindow: 200000,
    recommended: true,
    supportsThinking: false,
    tier: "fast",
    aliasFor: "claude-haiku-4-5-20251001",
  },

  // === Opus Family (Flagship) ===
  "claude-opus-4-5-20251101": {
    name: "Claude Opus 4.5",
    description:
      "Latest flagship model — superior agentic coding, long task sustenance, self-debugging",
    contextWindow: 200000,
    recommended: true,
    supportsThinking: true,
    tier: "flagship",
  },
  "claude-opus-4-1-20250805": {
    name: "Claude Opus 4.1",
    description: "Previous Opus — strong agentic coding and reasoning",
    contextWindow: 200000,
    recommended: false,
    supportsThinking: true,
    tier: "flagship",
  },
  "claude-opus-4-20250514": {
    name: "Claude Opus 4",
    description: "First Opus 4 release — powerful reasoning and coding",
    contextWindow: 200000,
    recommended: false,
    supportsThinking: true,
    tier: "flagship",
  },

  // === Sonnet Family (Balanced) ===
  "claude-sonnet-4-5-20250929": {
    name: "Claude Sonnet 4.5",
    description: "Latest Sonnet — excellent reasoning with balanced speed/cost",
    contextWindow: 200000,
    recommended: true,
    supportsThinking: true,
    tier: "balanced",
  },
  "claude-sonnet-4-20250514": {
    name: "Claude Sonnet 4",
    description: "Previous Sonnet — high-performance reasoning",
    contextWindow: 200000,
    recommended: false,
    supportsThinking: true,
    tier: "balanced",
  },

  // === Haiku Family (Fast) ===
  "claude-haiku-4-5-20251001": {
    name: "Claude Haiku 4.5",
    description: "Latest Haiku — fast and efficient for quick tasks",
    contextWindow: 200000,
    recommended: false,
    supportsThinking: false,
    tier: "fast",
  },

  // === Legacy Models ===
  "claude-3-5-sonnet-20241022": {
    name: "Claude 3.5 Sonnet",
    description: "Previous generation — still capable, lower cost",
    contextWindow: 200000,
    recommended: false,
    supportsThinking: false,
    tier: "legacy",
    deprecated: true,
  },
  "claude-3-5-haiku-20241022": {
    name: "Claude 3.5 Haiku",
    description: "Previous generation fast model",
    contextWindow: 200000,
    recommended: false,
    supportsThinking: false,
    tier: "fast",
    deprecated: true,
  },
  "claude-3-opus-20240229": {
    name: "Claude 3 Opus",
    description: 'Legacy Opus — deprecated, use "opus" alias instead',
    contextWindow: 200000,
    recommended: false,
    supportsThinking: false,
    tier: "legacy",
    deprecated: true,
  },
};

// Resolve model alias to full model ID
// If the input is an alias, returns the resolved ID; otherwise returns the input unchanged
export function resolveModelId(modelInput: string): string {
  const model = CLAUDE_MODELS[modelInput];
  if (model?.aliasFor) {
    return model.aliasFor;
  }
  return modelInput;
}

// Check if a model string is valid (known or custom)
// Always returns true for custom model strings — let the CLI validate them
export function isValidModel(modelInput: string): boolean {
  // Known models are always valid
  if (modelInput in CLAUDE_MODELS) return true;
  // Accept any string that looks like a Claude model ID
  if (modelInput.startsWith("claude-")) return true;
  // Accept known alias patterns
  if (["opus", "sonnet", "haiku"].includes(modelInput.toLowerCase())) return true;
  // Accept any custom string — the CLI will validate
  return true;
}

/**
 * Initialize dynamic model fetching.
 * Call once at startup. If ANTHROPIC_API_KEY is set, fetches models
 * from the Anthropic API and refreshes every hour.
 * Falls back to the hardcoded defaults above if unavailable.
 */
export function initModels(): void {
  startModelRefresh((newModels) => {
    CLAUDE_MODELS = newModels;
    console.log(
      `[Models] Dynamically updated to ${
        Object.keys(CLAUDE_MODELS).length
      } models from Anthropic API`,
    );
  });
}

/**
 * Force an immediate model refresh (useful for /claude-models command).
 * Returns the current models record.
 */
export async function refreshModels(): Promise<Record<string, ModelInfo>> {
  const fetched = await fetchModels();
  if (fetched) {
    CLAUDE_MODELS = fetched;
  }
  return CLAUDE_MODELS;
}

/**
 * Update models from SDK's supportedModels() response.
 * Merges SDK model info with our richer ModelInfo structure.
 * Call after first successful query to get definitive model list.
 */
export function updateModelsFromSDK(sdkModels: SDKModelInfo[]): void {
  if (!sdkModels || sdkModels.length === 0) return;

  let updated = 0;
  for (const sdkModel of sdkModels) {
    const id = sdkModel.value;
    if (!id) continue;

    // Update existing entry with SDK display name/description
    if (CLAUDE_MODELS[id]) {
      CLAUDE_MODELS[id].name = sdkModel.displayName || CLAUDE_MODELS[id].name;
      if (sdkModel.description) {
        CLAUDE_MODELS[id].description = sdkModel.description;
      }
      updated++;
    } else {
      // Add new model discovered via SDK
      const tier = id.includes("opus")
        ? "flagship" as const
        : id.includes("haiku")
        ? "fast" as const
        : id.includes("sonnet")
        ? "balanced" as const
        : "balanced" as const;

      CLAUDE_MODELS[id] = {
        name: sdkModel.displayName || id,
        description: sdkModel.description || `${sdkModel.displayName || id} (discovered via SDK)`,
        contextWindow: 200_000,
        recommended: false,
        supportsThinking: id.includes("opus") ||
          (id.includes("sonnet") && !id.startsWith("claude-3-5-")),
        tier,
        deprecated: id.startsWith("claude-3-") && !id.startsWith("claude-3-5-"),
      };
      updated++;
    }
  }

  if (updated > 0) {
    console.log(`[Models] Merged ${updated} models from SDK supportedModels()`);
  }
}
