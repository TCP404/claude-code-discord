/** @module claude/client — Low-level SDK wrapper: builds query options, streams responses. */
import {
  type AgentDefinition as SDKAgentDefinition,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type ModelInfo as SDKModelInfo,
  query as claudeQuery,
  type SdkBeta,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { clearTrackedMessages, setActiveQuery, trackMessageId } from "./query-manager.ts";
import type { AskUserCallback, AskUserQuestionInput } from "./user-question.ts";
import type { PermissionRequestCallback } from "./permission-request.ts";
import * as path from "https://deno.land/std@0.208.0/path/mod.ts";

// Load MCP server configs from .claude/mcp.json
async function loadMcpServers(
  workDir: string,
): Promise<Record<string, McpServerConfig> | undefined> {
  try {
    const mcpPath = path.join(workDir, ".claude", "mcp.json");
    const raw = await Deno.readTextFile(mcpPath);
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") return undefined;

    // Clean configs to match SDK's McpStdioServerConfig shape and resolve placeholders
    const result: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      const raw = cfg as any;
      // Resolve ${workspaceFolder:-.} placeholder in args
      const args = Array.isArray(raw.args)
        ? raw.args.map((a: string) => a.replace(/\$\{workspaceFolder:-\.?\}/g, workDir))
        : undefined;
      result[name] = {
        type: "stdio" as const,
        command: raw.command,
        ...(args && { args }),
        ...(raw.env && { env: raw.env }),
      };
    }
    console.log(
      `[MCP] Loaded ${Object.keys(result).length} MCP server(s): ${Object.keys(result).join(", ")}`,
    );
    return result;
  } catch {
    // File doesn't exist or is invalid — no MCP servers
    return undefined;
  }
}

export type { SDKAgentDefinition, SDKModelInfo };

// Extract permission denials from SDK result messages (deduplicated by tool name)
export function extractPermissionDenials(
  messages: SDKMessage[],
): Array<{ toolName: string; toolUseId: string; toolInput: Record<string, unknown> }> {
  const denials: Array<
    { toolName: string; toolUseId: string; toolInput: Record<string, unknown> }
  > = [];
  const seenTools = new Set<string>();
  for (const msg of messages) {
    if (
      msg.type === "result" && "permission_denials" in msg && Array.isArray(msg.permission_denials)
    ) {
      for (const d of msg.permission_denials) {
        // Skip duplicate tool names — SDK may report the same tool multiple times
        // when Claude retries a denied tool
        if (seenTools.has(d.tool_name)) continue;
        seenTools.add(d.tool_name);
        denials.push({
          toolName: d.tool_name,
          toolUseId: d.tool_use_id,
          toolInput: d.tool_input,
        });
      }
    }
  }
  return denials;
}

/** Build the canUseTool callback used by both cold and hot query paths. */
export function buildCanUseTool(
  modelOptions?: ClaudeModelOptions,
): (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<
  { behavior: "allow"; updatedInput: Record<string, unknown> } | {
    behavior: "deny";
    message: string;
  }
> {
  const readOnlyTools = new Set([
    "Read",
    "Glob",
    "Grep",
    "Skill",
    "ToolSearch",
    "WebFetch",
    "WebSearch",
    "LSP",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TaskStop",
    "TaskOutput",
    "Agent",
    "EnterPlanMode",
    "ExitPlanMode",
    "Bash",
    "Write",
    "Edit",
    "NotebookEdit",
  ]);

  return async (toolName: string, input: Record<string, unknown>) => {
    if (readOnlyTools.has(toolName)) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (toolName === "AskUserQuestion" && modelOptions?.onAskUser) {
      try {
        const askInput = input as unknown as AskUserQuestionInput;
        const answers = await modelOptions.onAskUser(askInput);
        return {
          behavior: "allow" as const,
          updatedInput: { questions: askInput.questions, answers },
        };
      } catch (err) {
        console.error("[AskUserQuestion] Failed to collect answers:", err);
        return { behavior: "deny" as const, message: "User did not respond in time" };
      }
    }
    if (toolName.startsWith("mcp__")) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (modelOptions?.onPermissionRequest) {
      try {
        const allowed = await modelOptions.onPermissionRequest(toolName, input);
        if (allowed) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        return { behavior: "deny" as const, message: `User denied tool: ${toolName}` };
      } catch (err) {
        console.error(`[PermissionRequest] Error for ${toolName}:`, err);
        return {
          behavior: "deny" as const,
          message: `Permission request failed for: ${toolName}`,
        };
      }
    }
    return { behavior: "deny" as const, message: `Tool ${toolName} not pre-approved` };
  };
}

/** Build the `options` block for claudeQuery({ prompt, options }). */
export async function buildQueryOptions(
  workDir: string,
  modelOptions: ClaudeModelOptions | undefined,
  resumeSessionId: string | undefined,
  controller: AbortController,
): Promise<{
  cwd: string;
  abortController: AbortController;
  permissionMode: SDKPermissionMode;
  options: any;
}> {
  const mcpServers = await loadMcpServers(workDir);
  const permMode: SDKPermissionMode = modelOptions?.permissionMode ||
    (Deno.env.get("DEFAULT_PERMISSION_MODE") as SDKPermissionMode | undefined) ||
    "acceptEdits";

  const envVars: Record<string, string> = {
    ...Object.fromEntries(Object.entries(Deno.env.toObject())),
    CLAUDE_CODE_ENABLE_TASKS: "1",
    ...(modelOptions?.enableAgentTeams && { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }),
  };
  if (modelOptions?.extraEnv) Object.assign(envVars, modelOptions.extraEnv);

  const systemPromptConfig = modelOptions?.appendSystemPrompt
    ? {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: modelOptions.appendSystemPrompt,
    }
    : { type: "preset" as const, preset: "claude_code" as const };

  const options = {
    cwd: workDir,
    permissionMode: permMode,
    systemPrompt: systemPromptConfig,
    settingSources: ["project" as const, "local" as const, "user" as const],
    ...(modelOptions?.thinking && { thinking: modelOptions.thinking }),
    ...(modelOptions?.effort && { effort: modelOptions.effort }),
    ...(modelOptions?.maxBudgetUsd && { maxBudgetUsd: modelOptions.maxBudgetUsd }),
    ...(permMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
    ...(resumeSessionId && { resume: resumeSessionId }),
    ...(modelOptions?.model && { model: modelOptions.model }),
    ...(modelOptions?.maxTurns && { maxTurns: modelOptions.maxTurns }),
    ...(modelOptions?.fallbackModel && { fallbackModel: modelOptions.fallbackModel }),
    ...(modelOptions?.agents && { agents: modelOptions.agents }),
    ...(modelOptions?.agent && { agent: modelOptions.agent }),
    ...(modelOptions?.betas && modelOptions.betas.length > 0 && { betas: modelOptions.betas }),
    ...(modelOptions?.enableFileCheckpointing && { enableFileCheckpointing: true }),
    ...(modelOptions?.sandbox && { sandbox: modelOptions.sandbox }),
    ...(modelOptions?.additionalDirectories &&
      modelOptions.additionalDirectories.length > 0 &&
      { additionalDirectories: modelOptions.additionalDirectories }),
    ...(modelOptions?.forkSession && { forkSession: true }),
    ...(modelOptions?.hooks && Object.keys(modelOptions.hooks).length > 0 &&
      { hooks: modelOptions.hooks }),
    ...(modelOptions?.outputFormat && { outputFormat: modelOptions.outputFormat }),
    ...(mcpServers && { mcpServers }),
    canUseTool: buildCanUseTool(modelOptions),
    env: envVars,
  };

  return { cwd: workDir, abortController: controller, permissionMode: permMode, options };
}

// Clean session ID (remove unwanted characters)
export function cleanSessionId(sessionId: string): string {
  return sessionId
    .trim() // Remove leading/trailing whitespace
    .replace(/^`+|`+$/g, "") // Remove leading/trailing backticks
    .replace(/^```\n?|\n?```$/g, "") // Remove code block markers
    .replace(/[\r\n]/g, "") // Remove line breaks
    .trim(); // Remove whitespace again
}

// Valid SDK permission modes (maps to CLI --permission-mode)
// New SDK (claude-agent-sdk) supports 6 modes:
//   default, acceptEdits, bypassPermissions, plan, delegate, dontAsk
export type SDKPermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

// Thinking configuration — native SDK option (replaces MAX_THINKING_TOKENS env var hack)
export type ThinkingConfig =
  | { type: "adaptive" } // Claude decides (Opus 4.6+, default)
  | { type: "enabled"; budgetTokens: number } // Fixed budget (older models)
  | { type: "disabled" }; // No thinking

// Effort level — controls reasoning depth
export type EffortLevel = "low" | "medium" | "high" | "max";

// Full query options for Claude Agent SDK
export interface ClaudeModelOptions {
  model?: string;
  /** SDK permissionMode: controls what Claude can do */
  permissionMode?: SDKPermissionMode;
  /** Native thinking configuration — replaces old MAX_THINKING_TOKENS env var */
  thinking?: ThinkingConfig;
  /** Effort level — controls reasoning depth (low/medium/high/max) */
  effort?: EffortLevel;
  /** Maximum budget in USD — query stops if exceeded */
  maxBudgetUsd?: number;
  /** Append to Claude Code's default system prompt */
  appendSystemPrompt?: string;
  /** Max turns for the conversation */
  maxTurns?: number;
  /** Fallback model on rate limit */
  fallbackModel?: string;
  /** Extra environment variables for the Claude subprocess (proxy, etc.) */
  extraEnv?: Record<string, string>;
  /** Native SDK agent name for the main thread (must be defined in agents) */
  agent?: string;
  /** Custom subagent definitions — Record<name, AgentDefinition> */
  agents?: Record<string, SDKAgentDefinition>;
  /** Enable beta features (e.g. 1M context window) */
  betas?: SdkBeta[];
  /** Enable file checkpointing for undo/rewind */
  enableFileCheckpointing?: boolean;
  /** Sandbox settings for safer command execution — full SDK SandboxSettings */
  sandbox?: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    allowUnsandboxedCommands?: boolean;
    network?: {
      allowedDomains?: string[];
      allowManagedDomainsOnly?: boolean;
      allowUnixSockets?: string[];
      allowAllUnixSockets?: boolean;
      allowLocalBinding?: boolean;
      httpProxyPort?: number;
      socksProxyPort?: number;
    };
    filesystem?: {
      allowWrite?: string[];
      denyWrite?: string[];
      denyRead?: string[];
    };
    ignoreViolations?: Record<string, string[]>;
    excludedCommands?: string[];
  };
  /** Enable experimental Agent Teams (multi-agent collaboration) */
  enableAgentTeams?: boolean;
  /** Additional directories Claude can access beyond cwd (absolute paths) */
  additionalDirectories?: string[];
  /** Fork a resumed session into a new session instead of continuing the original */
  forkSession?: boolean;
  /** SDK hooks — deep integration callbacks for tool use, notifications, etc. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Structured output format (JSON schema) */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** Callback for AskUserQuestion tool — Claude asks the user mid-session.
   *  If provided, the AskUserQuestion tool is enabled and routed through this callback. */
  onAskUser?: AskUserCallback;
  /** Callback for interactive permission requests — replaces auto-deny.
   *  When Claude wants to use a tool that isn't pre-approved, this callback
   *  presents Allow/Deny buttons in Discord and waits for a response. */
  onPermissionRequest?: PermissionRequestCallback;
}

// Wrapper for Claude Code SDK query function
export async function sendToClaudeCode(
  workDir: string,
  prompt: string,
  controller: AbortController,
  sessionId?: string,
  onChunk?: (text: string) => void,
  onStreamJson?: (json: any) => void,
  modelOptions?: ClaudeModelOptions,
  onTyping?: () => void,
): Promise<{
  response: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  modelUsed?: string;
  /** Tools denied by permission mode (dontAsk, plan, etc.) */
  permissionDenials?: Array<
    { toolName: string; toolUseId: string; toolInput: Record<string, unknown> }
  >;
}> {
  const messages: SDKMessage[] = [];
  let fullResponse = "";
  let resultSessionId: string | undefined;
  let modelUsed = modelOptions?.model || "Default";

  // Clean up session ID
  const cleanedSessionId = sessionId ? cleanSessionId(sessionId) : undefined;

  // Wrap with comprehensive error handling
  const executeWithErrorHandling = async (overrideModel?: string) => {
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    try {
      // Determine which model to use
      const modelToUse = overrideModel || modelOptions?.model;

      const built = await buildQueryOptions(
        workDir,
        modelToUse ? { ...modelOptions, model: modelToUse } : modelOptions,
        cleanedSessionId,
        controller,
      );
      const queryOptions = {
        prompt,
        abortController: built.abortController,
        options: built.options,
      };
      const permMode = built.permissionMode;

      const thinkingLabel = modelOptions?.thinking
        ? `, thinking=${modelOptions.thinking.type}${
          modelOptions.thinking.type === "enabled" ? `(${modelOptions.thinking.budgetTokens})` : ""
        }`
        : "";
      const effortLabel = modelOptions?.effort ? `, effort=${modelOptions.effort}` : "";
      console.log(
        `Claude Agent SDK: Running with ${
          modelToUse || "default"
        } model, permission=${permMode}${thinkingLabel}${effortLabel}...`,
      );
      if (cleanedSessionId) {
        console.log(`Session resuming with ID: ${cleanedSessionId}`);
      }

      const iterator = claudeQuery(queryOptions);
      // Store query reference for mid-session controls (interrupt, rewind, info)
      setActiveQuery(iterator);
      clearTrackedMessages();

      const currentMessages: SDKMessage[] = [];
      let currentResponse = "";
      let currentSessionId: string | undefined;
      let turnCount = 0;

      if (onTyping) {
        try {
          onTyping();
        } catch { /* non-critical */ }
        typingInterval = setInterval(() => {
          try {
            onTyping();
          } catch { /* non-critical */ }
        }, 8000);
      }

      for await (const message of iterator) {
        // Check AbortSignal to stop iteration
        if (controller.signal.aborted) {
          console.log(`Claude Code: Abort signal detected, stopping iteration`);
          break;
        }

        currentMessages.push(message);

        // For JSON streams, call dedicated callback
        if (onStreamJson) {
          onStreamJson(message);
        }

        // For text messages, send chunks
        // Skip for JSON stream output as it's handled by onStreamJson
        if (message.type === "assistant" && message.message.content && !onStreamJson) {
          const textContent = message.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");

          if (textContent && onChunk) {
            onChunk(textContent);
          }
          currentResponse = textContent;
        }

        // Track user message IDs for rewind (if checkpointing enabled)
        if (message.type === "user" && "message" in message && "id" in message.message) {
          turnCount++;
          trackMessageId(
            message.message.id as string,
            turnCount,
            `Turn ${turnCount}`,
          );
        }

        // Save session information
        if ("session_id" in message && message.session_id) {
          currentSessionId = message.session_id;
        }
      }

      // Clear active query when done
      setActiveQuery(null);
      clearInterval(typingInterval);

      return {
        messages: currentMessages,
        response: currentResponse,
        sessionId: currentSessionId,
        aborted: controller.signal.aborted,
        modelUsed: modelToUse || "Default",
      };
    } catch (error: any) {
      // Clear active query on error
      setActiveQuery(null);
      clearInterval(typingInterval);
      // Properly handle process exit code 143 (SIGTERM) and AbortError
      if (
        error.name === "AbortError" ||
        controller.signal.aborted ||
        (error.message && error.message.includes("exited with code 143"))
      ) {
        console.log(`Claude Code: Process terminated by abort signal`);
        return {
          messages: [],
          response: "",
          sessionId: undefined,
          aborted: true,
          modelUsed: "Default",
        };
      }
      throw error;
    }
  };

  // First try with specified model (or default)
  try {
    const result = await executeWithErrorHandling();

    if (result.aborted) {
      return { response: "Request was cancelled", modelUsed: result.modelUsed };
    }

    messages.push(...result.messages);
    fullResponse = result.response;
    resultSessionId = result.sessionId;
    modelUsed = result.modelUsed;

    // Get information from the last message
    const lastMessage = messages[messages.length - 1];

    // Extract permission denials from result messages
    const permissionDenials = extractPermissionDenials(messages);

    return {
      response: fullResponse || "No response received",
      sessionId: resultSessionId,
      cost: "total_cost_usd" in lastMessage ? lastMessage.total_cost_usd : undefined,
      duration: "duration_ms" in lastMessage ? lastMessage.duration_ms : undefined,
      modelUsed,
      ...(permissionDenials.length > 0 && { permissionDenials }),
    };
  } catch (error: any) {
    // For exit code 1 errors (rate limit), retry with Haiku (cheaper/faster fallback)
    if (
      error.message &&
      (error.message.includes("exit code 1") || error.message.includes("exited with code 1"))
    ) {
      console.log("Rate limit detected, retrying with Haiku (fast fallback)...");

      try {
        const retryResult = await executeWithErrorHandling("haiku");

        if (retryResult.aborted) {
          return { response: "Request was cancelled", modelUsed: retryResult.modelUsed };
        }

        // Get information from the last message
        const lastRetryMessage = retryResult.messages[retryResult.messages.length - 1];
        const retryDenials = extractPermissionDenials(retryResult.messages);

        return {
          response: retryResult.response || "No response received",
          sessionId: retryResult.sessionId,
          cost: "total_cost_usd" in lastRetryMessage ? lastRetryMessage.total_cost_usd : undefined,
          duration: "duration_ms" in lastRetryMessage ? lastRetryMessage.duration_ms : undefined,
          modelUsed: retryResult.modelUsed,
          ...(retryDenials.length > 0 && { permissionDenials: retryDenials }),
        };
      } catch (retryError: any) {
        // If Haiku fallback also fails
        if (
          retryError.name === "AbortError" ||
          controller.signal.aborted ||
          (retryError.message && retryError.message.includes("exited with code 143"))
        ) {
          return { response: "Request was cancelled", modelUsed: "Claude Haiku (fallback)" };
        }

        retryError.message +=
          "\n\n⚠️ Both default model and Haiku fallback encountered errors. Please wait a moment and try again.";
        throw retryError;
      }
    }

    throw error;
  }
}
