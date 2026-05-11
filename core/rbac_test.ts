import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkCommandPermission, getRestrictedCommands, isRestrictedCommand } from "./rbac.ts";
import type { InteractionContext } from "../discord/types.ts";

function mockContext(opts: {
  userId?: string;
  roleIds?: string[];
} = {}): InteractionContext {
  let replied = false;
  return {
    getUserId: () => opts.userId ?? "user-1",
    getMemberRoleIds: () => new Set(opts.roleIds ?? []),
    // deno-lint-ignore require-await
    reply: async () => {
      replied = true;
    },
    get _replied() {
      return replied;
    },
    // Unused methods for this test
    deferReply: async () => {},
    editReply: async () => {},
    followUp: async () => {},
    update: async () => {},
    getString: () => null,
    getInteger: () => null,
    getBoolean: () => null,
  } as unknown as InteractionContext & { _replied: boolean };
}

// --- isRestrictedCommand ---

Deno.test("isRestrictedCommand: shell commands are restricted", () => {
  assertEquals(isRestrictedCommand("shell"), true);
  assertEquals(isRestrictedCommand("shell-input"), true);
  assertEquals(isRestrictedCommand("shell-list"), true);
  assertEquals(isRestrictedCommand("shell-kill"), true);
});

Deno.test("isRestrictedCommand: git commands are restricted", () => {
  assertEquals(isRestrictedCommand("git"), true);
  assertEquals(isRestrictedCommand("worktree"), true);
});

Deno.test("isRestrictedCommand: system commands are restricted", () => {
  assertEquals(isRestrictedCommand("env-vars"), true);
  assertEquals(isRestrictedCommand("port-scan"), true);
  assertEquals(isRestrictedCommand("system-logs"), true);
});

Deno.test("isRestrictedCommand: admin commands are restricted", () => {
  assertEquals(isRestrictedCommand("shutdown"), true);
  assertEquals(isRestrictedCommand("restart"), true);
});

Deno.test("isRestrictedCommand: normal commands are not restricted", () => {
  assertEquals(isRestrictedCommand("claude"), false);
  assertEquals(isRestrictedCommand("help"), false);
  assertEquals(isRestrictedCommand("settings"), false);
  assertEquals(isRestrictedCommand("agent"), false);
});

Deno.test("isRestrictedCommand: empty string is not restricted", () => {
  assertEquals(isRestrictedCommand(""), false);
});

// --- getRestrictedCommands ---

Deno.test("getRestrictedCommands: returns all categories", () => {
  const cmds = getRestrictedCommands();
  assertEquals("shell" in cmds, true);
  assertEquals("git" in cmds, true);
  assertEquals("system" in cmds, true);
  assertEquals("admin" in cmds, true);
});

Deno.test("getRestrictedCommands: returns a copy (not the original)", () => {
  const cmds1 = getRestrictedCommands();
  cmds1.shell = [];
  const cmds2 = getRestrictedCommands();
  assertEquals(cmds2.shell.length > 0, true);
});

// --- hasPermission + checkCommandPermission ---
// Note: loadRBACConfig caches on first call. These tests rely on the
// environment state at the time the module is first loaded.
// We test the logic paths that don't depend on env (non-restricted commands).

Deno.test("checkCommandPermission: non-restricted command always returns true", async () => {
  const ctx = mockContext({ userId: "nobody", roleIds: [] });
  const result = await checkCommandPermission("claude", ctx);
  assertEquals(result, true);
});

Deno.test("checkCommandPermission: non-restricted command even with no user info", async () => {
  const ctx = mockContext({ userId: "", roleIds: [] });
  const result = await checkCommandPermission("help", ctx);
  assertEquals(result, true);
});

// --- RBAC enabled scenarios (integration-style with env manipulation) ---

Deno.test({
  name: "RBAC: full permission check flow with env vars",
  fn: async () => {
    // This test runs in a subprocess to avoid polluting the cached config
    const cmd = new Deno.Command("deno", {
      args: [
        "eval",
        `
        import { hasPermission, checkCommandPermission, loadRBACConfig } from "./core/rbac.ts";

        // Set env before loading config
        Deno.env.set("ADMIN_USER_IDS", "admin-1,admin-2");
        Deno.env.set("ADMIN_ROLE_IDS", "role-A");

        // Force fresh load (module hasn't been imported before in this subprocess)
        const config = loadRBACConfig();

        // Mock context helper
        function ctx(userId, roleIds = []) {
          return {
            getUserId: () => userId,
            getMemberRoleIds: () => new Set(roleIds),
            reply: async () => {},
            deferReply: async () => {},
            editReply: async () => {},
            followUp: async () => {},
            update: async () => {},
            getString: () => null,
            getInteger: () => null,
            getBoolean: () => null,
          };
        }

        // Admin user has access
        if (!hasPermission(ctx("admin-1"))) throw new Error("admin user should have access");

        // User with admin role has access
        if (!hasPermission(ctx("random", ["role-A"]))) throw new Error("admin role should have access");

        // Random user denied
        if (hasPermission(ctx("random", ["role-B"]))) throw new Error("random user should be denied");

        // checkCommandPermission for restricted command with admin user
        const r1 = await checkCommandPermission("shell", ctx("admin-1"));
        if (!r1) throw new Error("admin should pass restricted command check");

        // checkCommandPermission for restricted command with random user
        const r2 = await checkCommandPermission("shell", ctx("nobody", []));
        if (r2) throw new Error("random user should fail restricted command check");

        console.log("ALL_PASSED");
      `,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    assertEquals(
      stdout.includes("ALL_PASSED"),
      true,
      `RBAC subprocess failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  },
});

Deno.test({
  name: "RBAC: disabled when no env vars set",
  fn: async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "eval",
        `
        import { hasPermission, loadRBACConfig } from "./core/rbac.ts";

        // Ensure vars are unset
        Deno.env.delete("ADMIN_USER_IDS");
        Deno.env.delete("ADMIN_ROLE_IDS");

        const config = loadRBACConfig();
        if (config.enabled) throw new Error("should be disabled");

        // Anyone can access when disabled
        const ctx = {
          getUserId: () => "anyone",
          getMemberRoleIds: () => new Set(),
          reply: async () => {},
          deferReply: async () => {},
          editReply: async () => {},
          followUp: async () => {},
          update: async () => {},
          getString: () => null,
          getInteger: () => null,
          getBoolean: () => null,
        };
        if (!hasPermission(ctx)) throw new Error("should allow all when disabled");

        console.log("ALL_PASSED");
      `,
      ],
      stdout: "piped",
      stderr: "piped",
      env: { "PATH": Deno.env.get("PATH") ?? "" },
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    assertEquals(
      stdout.includes("ALL_PASSED"),
      true,
      `Subprocess failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  },
});
