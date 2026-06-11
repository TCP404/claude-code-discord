/** @module cron/persistence — Read/write scheduled tasks and run logs to disk. */

import * as path from "https://deno.land/std@0.208.0/path/mod.ts";
import type { ScheduledTask, TaskRunLog } from "./types.ts";

const DATA_DIR = ".bot-data";
const TASKS_FILE = "scheduled-tasks.json";
const LOGS_FILE = "scheduled-tasks-log.json";
const MAX_LOGS = 200;

export class ScheduledTaskStore {
  private tasksPath: string;
  private logsPath: string;
  private tasks: ScheduledTask[] = [];
  private logs: TaskRunLog[] = [];

  constructor(private baseDir: string) {
    const dataDir = path.join(baseDir, DATA_DIR);
    this.tasksPath = path.join(dataDir, TASKS_FILE);
    this.logsPath = path.join(dataDir, LOGS_FILE);
  }

  async load(): Promise<void> {
    try {
      const raw = await Deno.readTextFile(this.tasksPath);
      this.tasks = JSON.parse(raw);
    } catch {
      this.tasks = [];
    }
    try {
      const raw = await Deno.readTextFile(this.logsPath);
      this.logs = JSON.parse(raw);
    } catch {
      this.logs = [];
    }
  }

  async saveTasks(): Promise<void> {
    const dir = path.dirname(this.tasksPath);
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch { /* exists */ }
    await Deno.writeTextFile(this.tasksPath, JSON.stringify(this.tasks, null, 2) + "\n");
  }

  async saveLogs(): Promise<void> {
    const dir = path.dirname(this.logsPath);
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch { /* exists */ }
    await Deno.writeTextFile(this.logsPath, JSON.stringify(this.logs, null, 2) + "\n");
  }

  getAll(): ScheduledTask[] {
    return [...this.tasks];
  }

  getById(id: string): ScheduledTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  add(task: ScheduledTask): void {
    this.tasks.push(task);
  }

  update(id: string, patch: Partial<Omit<ScheduledTask, "id" | "createdAt">>): boolean {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.tasks[idx] = { ...this.tasks[idx], ...patch };
    return true;
  }

  remove(id: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.tasks.splice(idx, 1);
    return true;
  }

  addLog(log: TaskRunLog): void {
    this.logs.push(log);
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(-MAX_LOGS);
    }
  }

  getLogsForTask(taskId: string, limit = 20): TaskRunLog[] {
    return this.logs.filter((l) => l.taskId === taskId).slice(-limit);
  }

  getAllLogs(limit = 50): TaskRunLog[] {
    return this.logs.slice(-limit);
  }
}
