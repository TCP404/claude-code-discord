/** @module cron/scheduler — Tick-based scheduler that triggers tasks at the right time. */

import type { ScheduledTask, TaskRunLog } from "./types.ts";
import { ScheduledTaskStore } from "./persistence.ts";

export interface SchedulerExecutor {
  /** Create a new thread in the workspace channel and send the command. Returns threadId on success. */
  execute(task: ScheduledTask): Promise<string>;
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMinute = -1;

  constructor(
    private store: ScheduledTaskStore,
    private executor: SchedulerExecutor,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30_000);
    this.tick();
    console.log("[Scheduler] Started — checking every 30s");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[Scheduler] Stopped");
    }
  }

  private tick(): void {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // Avoid double-firing within the same minute
    if (currentMinute === this.lastTickMinute) return;
    this.lastTickMinute = currentMinute;

    const tasks = this.store.getAll().filter((t) => t.enabled);
    for (const task of tasks) {
      if (this.shouldRun(task, now)) {
        this.run(task);
      }
    }
  }

  private shouldRun(task: ScheduledTask, now: Date): boolean {
    const { schedule } = task;
    const currentHH = now.getHours().toString().padStart(2, "0");
    const currentMM = now.getMinutes().toString().padStart(2, "0");
    const currentTime = `${currentHH}:${currentMM}`;

    switch (schedule.type) {
      case "daily":
        return schedule.time === currentTime;

      case "weekly":
        if (!schedule.weekdays?.includes(now.getDay())) return false;
        return schedule.time === currentTime;

      case "interval": {
        if (!schedule.intervalHours) return false;
        const logs = this.store.getLogsForTask(task.id, 1);
        if (logs.length === 0) {
          // Never run before — run if at the scheduled start time, or immediately if no time set
          if (!schedule.time) return true;
          return schedule.time === currentTime;
        }
        const lastRun = new Date(logs[logs.length - 1].runAt);
        const elapsed = (now.getTime() - lastRun.getTime()) / 3_600_000;
        return elapsed >= schedule.intervalHours;
      }

      default:
        return false;
    }
  }

  private async run(task: ScheduledTask): Promise<void> {
    const log: TaskRunLog = {
      taskId: task.id,
      runAt: new Date().toISOString(),
      status: "success",
    };

    try {
      const threadId = await this.executor.execute(task);
      log.threadId = threadId;
      log.status = "success";
      console.log(`[Scheduler] Task "${task.command}" triggered → thread ${threadId}`);
    } catch (err) {
      log.status = "failed";
      log.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Task "${task.command}" failed:`, log.error);
    }

    this.store.addLog(log);
    await this.store.saveLogs().catch(() => {});
  }

  /** Manual trigger — bypasses schedule check */
  async runNow(taskId: string): Promise<TaskRunLog> {
    const task = this.store.getById(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const log: TaskRunLog = {
      taskId: task.id,
      runAt: new Date().toISOString(),
      status: "success",
    };

    try {
      const threadId = await this.executor.execute(task);
      log.threadId = threadId;
      log.status = "success";
    } catch (err) {
      log.status = "failed";
      log.error = err instanceof Error ? err.message : String(err);
    }

    this.store.addLog(log);
    await this.store.saveLogs().catch(() => {});
    return log;
  }
}
