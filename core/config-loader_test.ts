import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  parseArgs,
  loadEnvConfig,
  validateEnvConfig,
  loadConfig,
  ConfigurationError,
} from "./config-loader.ts";

// --- parseArgs ---

Deno.test("parseArgs: named --category argument", () => {
  const result = parseArgs(["--category", "my-project"]);
  assertEquals(result.category, "my-project");
});

Deno.test("parseArgs: named --user-id argument", () => {
  const result = parseArgs(["--user-id", "12345"]);
  assertEquals(result.userId, "12345");
});

Deno.test("parseArgs: equals-sign format", () => {
  const result = parseArgs(["--category=proj", "--user-id=999"]);
  assertEquals(result.category, "proj");
  assertEquals(result.userId, "999");
});

Deno.test("parseArgs: positional arguments (legacy)", () => {
  const result = parseArgs(["my-category", "user-123"]);
  assertEquals(result.category, "my-category");
  assertEquals(result.userId, "user-123");
});

Deno.test("parseArgs: empty args returns empty result", () => {
  const result = parseArgs([]);
  assertEquals(result.category, undefined);
  assertEquals(result.userId, undefined);
});

Deno.test("parseArgs: named args take precedence over positional order", () => {
  const result = parseArgs(["--category", "named-cat", "positional-ignored"]);
  assertEquals(result.category, "named-cat");
});

Deno.test("parseArgs: --category without value is skipped", () => {
  const result = parseArgs(["--category"]);
  assertEquals(result.category, undefined);
});

Deno.test("parseArgs: --user-id without value is skipped", () => {
  const result = parseArgs(["--user-id"]);
  assertEquals(result.userId, undefined);
});

Deno.test("parseArgs: unknown flags are ignored", () => {
  const result = parseArgs(["--verbose", "--category", "proj"]);
  assertEquals(result.category, "proj");
});

// --- loadEnvConfig ---

Deno.test("loadEnvConfig: reads all env vars", () => {
  const env: Record<string, string> = {
    DISCORD_TOKEN: "tok-123",
    APPLICATION_ID: "app-456",
    CATEGORY_NAME: "cat",
    DEFAULT_MENTION_USER_ID: "uid",
  };
  const result = loadEnvConfig((key) => env[key]);
  assertEquals(result.discordToken, "tok-123");
  assertEquals(result.applicationId, "app-456");
  assertEquals(result.categoryName, "cat");
  assertEquals(result.mentionUserId, "uid");
});

Deno.test("loadEnvConfig: missing vars return undefined", () => {
  const result = loadEnvConfig(() => undefined);
  assertEquals(result.discordToken, undefined);
  assertEquals(result.applicationId, undefined);
  assertEquals(result.categoryName, undefined);
  assertEquals(result.mentionUserId, undefined);
});

// --- validateEnvConfig ---

Deno.test("validateEnvConfig: passes with all required fields", () => {
  validateEnvConfig({
    discordToken: "tok",
    applicationId: "app",
    categoryName: undefined,
    mentionUserId: undefined,
  });
});

Deno.test("validateEnvConfig: throws ConfigurationError when token missing", () => {
  const err = assertThrows(
    () => validateEnvConfig({
      discordToken: undefined,
      applicationId: "app",
      categoryName: undefined,
      mentionUserId: undefined,
    }),
    ConfigurationError,
  );
  assertEquals(err.missingKeys, ["DISCORD_TOKEN"]);
});

Deno.test("validateEnvConfig: throws ConfigurationError when app id missing", () => {
  const err = assertThrows(
    () => validateEnvConfig({
      discordToken: "tok",
      applicationId: undefined,
      categoryName: undefined,
      mentionUserId: undefined,
    }),
    ConfigurationError,
  );
  assertEquals(err.missingKeys, ["APPLICATION_ID"]);
});

Deno.test("validateEnvConfig: reports all missing keys together", () => {
  const err = assertThrows(
    () => validateEnvConfig({
      discordToken: undefined,
      applicationId: undefined,
      categoryName: undefined,
      mentionUserId: undefined,
    }),
    ConfigurationError,
  );
  assertEquals(err.missingKeys.length, 2);
  assertEquals(err.missingKeys.includes("DISCORD_TOKEN"), true);
  assertEquals(err.missingKeys.includes("APPLICATION_ID"), true);
});

// --- loadConfig (integration) ---

Deno.test("loadConfig: combines env and CLI args", () => {
  const config = loadConfig({
    getEnv: (key) => ({
      DISCORD_TOKEN: "tok",
      APPLICATION_ID: "app",
      CATEGORY_NAME: "env-cat",
    })[key],
    getCwd: () => "/work",
    args: [],
  });
  assertEquals(config.discordToken, "tok");
  assertEquals(config.applicationId, "app");
  assertEquals(config.workDir, "/work");
  assertEquals(config.categoryName, "env-cat");
});

Deno.test("loadConfig: CLI args override env for category", () => {
  const config = loadConfig({
    getEnv: (key) => ({
      DISCORD_TOKEN: "tok",
      APPLICATION_ID: "app",
      CATEGORY_NAME: "from-env",
    })[key],
    getCwd: () => "/work",
    args: ["--category", "from-cli"],
  });
  assertEquals(config.categoryName, "from-cli");
});

Deno.test("loadConfig: CLI args override env for userId", () => {
  const config = loadConfig({
    getEnv: (key) => ({
      DISCORD_TOKEN: "tok",
      APPLICATION_ID: "app",
      DEFAULT_MENTION_USER_ID: "env-user",
    })[key],
    getCwd: () => "/work",
    args: ["--user-id", "cli-user"],
  });
  assertEquals(config.userId, "cli-user");
});

Deno.test("loadConfig: throws when required env vars missing", () => {
  assertThrows(
    () => loadConfig({
      getEnv: () => undefined,
      getCwd: () => "/work",
      args: [],
    }),
    ConfigurationError,
  );
});
