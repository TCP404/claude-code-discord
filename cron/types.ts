/** @module cron/types — Scheduled task type definitions. */

export interface TaskSchedule {
  type: "daily" | "interval" | "weekly";
  /** HH:mm format, used for daily/weekly */
  time?: string;
  /** Hours between runs, used for interval */
  intervalHours?: number;
  /** Weekdays (0=Sun, 1=Mon, ..., 6=Sat), used for weekly */
  weekdays?: number[];
}

export interface ScheduledTask {
  id: string;
  workspaceName: string;
  command: string;
  schedule: TaskSchedule;
  enabled: boolean;
  threadName?: string;
  createdAt: string;
}

export interface TaskRunLog {
  taskId: string;
  runAt: string;
  status: "success" | "failed";
  threadId?: string;
  error?: string;
}
