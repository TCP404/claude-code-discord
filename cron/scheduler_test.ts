/** @module cron/scheduler_test — Unit tests for the scheduler tick logic. */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { ScheduledTask, TaskRunLog } from "./types.ts";
import { ScheduledTaskStore } from "./persistence.ts";
import { TaskScheduler } from "./scheduler.ts";

function makeStore(tasks: ScheduledTask[], logs: TaskRunLog[] = []): ScheduledTaskStore {
  const store = {
    getAll: () => tasks,
    getById: (id: string) => tasks.find((t) => t.id === id),
    getLogsForTask: (id: string, _limit?: number) => logs.filter((l) => l.taskId === id),
    addLog: (log: TaskRunLog) => logs.push(log),
    saveLogs: () => Promise.resolve(),
  } as unknown as ScheduledTaskStore;
  return store;
}

Deno.test("TaskScheduler: runNow triggers executor and logs success", async () => {
  const task: ScheduledTask = {
    id: "t1",
    workspaceName: "test-ws",
    command: "/cs-review 昨天数据",
    schedule: { type: "daily", time: "09:00" },
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const logs: TaskRunLog[] = [];
  const store = makeStore([task], logs);
  const executor = { execute: async () => "thread-123" };

  const scheduler = new TaskScheduler(store, executor);
  const result = await scheduler.runNow("t1");

  assertEquals(result.status, "success");
  assertEquals(result.threadId, "thread-123");
  assertEquals(result.taskId, "t1");
  assertEquals(logs.length, 1);
  assertEquals(logs[0].status, "success");
});

Deno.test("TaskScheduler: runNow logs failure when executor throws", async () => {
  const task: ScheduledTask = {
    id: "t2",
    workspaceName: "ws",
    command: "/test",
    schedule: { type: "daily", time: "10:00" },
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const logs: TaskRunLog[] = [];
  const store = makeStore([task], logs);
  const executor = {
    execute: async () => {
      throw new Error("workspace not found");
    },
  };

  const scheduler = new TaskScheduler(store, executor);
  const result = await scheduler.runNow("t2");

  assertEquals(result.status, "failed");
  assertEquals(result.error, "workspace not found");
  assertEquals(logs.length, 1);
});

Deno.test("TaskScheduler: runNow throws for unknown task", async () => {
  const store = makeStore([]);
  const executor = { execute: async () => "t" };
  const scheduler = new TaskScheduler(store, executor);

  let caught: Error | null = null;
  try {
    await scheduler.runNow("nonexistent");
  } catch (e) {
    caught = e as Error;
  }
  assertEquals(caught?.message, 'Task "nonexistent" not found');
});
