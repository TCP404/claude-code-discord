#!/usr/bin/env -S deno run --allow-all

/**
 * Unit tests for WorkspaceManager
 */

import { WorkspaceManager } from "../core/workspace-manager.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ================================
// Test: resolve() fallback
// ================================
console.log("\n🧪 resolve() returns defaultWorkDir when no mapping exists");
{
  const wm = new WorkspaceManager("/default/path");
  assertEqual(wm.resolve("unknown-channel"), "/default/path", "unknown channel falls back to default");
}

// ================================
// Test: add() and resolve()
// ================================
console.log("\n🧪 add() creates mapping, resolve() returns it");
{
  const wm = new WorkspaceManager("/default/path");
  wm.add({ name: "crm", path: "/projects/crm", channelId: "chan-1" });

  assertEqual(wm.resolve("chan-1"), "/projects/crm", "mapped channel resolves correctly");
  assertEqual(wm.resolve("chan-2"), "/default/path", "unmapped channel still falls back");
}

// ================================
// Test: add() overwrites existing name
// ================================
console.log("\n🧪 add() with same name overwrites the entry");
{
  const wm = new WorkspaceManager("/default/path");
  wm.add({ name: "crm", path: "/old/crm", channelId: "chan-1" });
  wm.add({ name: "crm", path: "/new/crm", channelId: "chan-2" });

  const list = wm.list();
  assertEqual(list.length, 1, "only one entry after overwrite");
  assertEqual(list[0].path, "/new/crm", "path updated");
  assertEqual(list[0].channelId, "chan-2", "channelId updated");
}

// ================================
// Test: remove()
// ================================
console.log("\n🧪 remove() deletes entry and returns it");
{
  const wm = new WorkspaceManager("/default/path");
  wm.add({ name: "crm", path: "/projects/crm", channelId: "chan-1" });

  const removed = wm.remove("crm");
  assertEqual(removed?.name, "crm", "returns removed entry");
  assertEqual(wm.list().length, 0, "list is empty after removal");
  assertEqual(wm.resolve("chan-1"), "/default/path", "channel falls back after removal");
}

// ================================
// Test: remove() returns undefined for non-existent
// ================================
console.log("\n🧪 remove() returns undefined for non-existent name");
{
  const wm = new WorkspaceManager("/default/path");
  const removed = wm.remove("nope");
  assertEqual(removed, undefined, "returns undefined");
}

// ================================
// Test: findByChannel()
// ================================
console.log("\n🧪 findByChannel() looks up by channel ID");
{
  const wm = new WorkspaceManager("/default/path");
  wm.add({ name: "crm", path: "/projects/crm", channelId: "chan-1" });

  const found = wm.findByChannel("chan-1");
  assertEqual(found?.name, "crm", "finds entry by channel");
  assertEqual(wm.findByChannel("chan-2"), undefined, "undefined for unknown channel");
}

// ================================
// Test: findByName()
// ================================
console.log("\n🧪 findByName() looks up by name");
{
  const wm = new WorkspaceManager("/default/path");
  wm.add({ name: "crm", path: "/projects/crm", channelId: "chan-1" });

  assertEqual(wm.findByName("crm")?.channelId, "chan-1", "finds by name");
  assertEqual(wm.findByName("nope"), undefined, "undefined for unknown name");
}

// ================================
// Test: getManagedChannelIds()
// ================================
console.log("\n🧪 getManagedChannelIds() includes default + workspace channels");
{
  const wm = new WorkspaceManager("/default/path");
  wm.setDefaultChannelId("default-chan");
  wm.add({ name: "crm", path: "/projects/crm", channelId: "chan-1" });
  wm.add({ name: "api", path: "/projects/api", channelId: "chan-2" });

  const ids = wm.getManagedChannelIds();
  assert(ids.has("default-chan"), "includes default channel");
  assert(ids.has("chan-1"), "includes workspace channel 1");
  assert(ids.has("chan-2"), "includes workspace channel 2");
  assertEqual(ids.size, 3, "exactly 3 channels");
}

// ================================
// Test: getManagedChannelIds() without default
// ================================
console.log("\n🧪 getManagedChannelIds() works without default channel set");
{
  const wm = new WorkspaceManager("/default/path");
  wm.add({ name: "crm", path: "/projects/crm", channelId: "chan-1" });

  const ids = wm.getManagedChannelIds();
  assertEqual(ids.size, 1, "only workspace channel");
  assert(ids.has("chan-1"), "includes workspace channel");
}

// ================================
// Test: persistence (save + load)
// ================================
console.log("\n🧪 saveToDisk() + loadFromDisk() round-trips data");
{
  const tmpDir = await Deno.makeTempDir();

  const wm1 = new WorkspaceManager(tmpDir);
  wm1.add({ name: "crm", path: "/projects/crm", channelId: "chan-1" });
  wm1.add({ name: "api", path: "/projects/api", channelId: "chan-2" });
  await wm1.saveToDisk();

  const wm2 = new WorkspaceManager(tmpDir);
  await wm2.loadFromDisk();

  const list = wm2.list();
  assertEqual(list.length, 2, "loaded 2 entries");
  assertEqual(wm2.resolve("chan-1"), "/projects/crm", "crm mapping persisted");
  assertEqual(wm2.resolve("chan-2"), "/projects/api", "api mapping persisted");

  // Cleanup
  await Deno.remove(tmpDir, { recursive: true });
}

// ================================
// Test: loadFromDisk() when file doesn't exist
// ================================
console.log("\n🧪 loadFromDisk() gracefully handles missing file");
{
  const wm = new WorkspaceManager("/nonexistent/path");
  await wm.loadFromDisk();
  assertEqual(wm.list().length, 0, "empty list when file missing");
}

// ================================
// Summary
// ================================
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  Deno.exit(1);
}
