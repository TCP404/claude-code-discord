/**
 * Offline Message Catch-up — fetches user messages sent while bot was offline,
 * posts an inbox-style prompt with Process / Ignore buttons in the original
 * channel, and routes the user's choice to the existing thread / workspace
 * message handlers.
 *
 * @module discord/offline-catchup
 */

export interface CatchupMessage {
  id: string;
  content: string;
  createdAt: Date;
}

const CATCHUP_PREFIX = "offline-catchup";

export type CatchupAction = "process" | "ignore";

export interface DecodedCatchupId {
  action: CatchupAction;
  channelId: string;
  oldestId: string;
  newestId: string;
}

export function encodeCatchupCustomId(
  action: CatchupAction,
  channelId: string,
  oldestId: string,
  newestId: string,
): string {
  return CATCHUP_PREFIX + ":" + action + ":" + channelId + ":" + oldestId + ":" + newestId;
}

export function decodeCatchupCustomId(customId: string): DecodedCatchupId | null {
  if (!customId.startsWith(CATCHUP_PREFIX + ":")) return null;
  const parts = customId.split(":");
  if (parts.length !== 5) return null;
  const [, action, channelId, oldestId, newestId] = parts;
  if (action !== "process" && action !== "ignore") return null;
  return { action, channelId, oldestId, newestId };
}

export function isCatchupCustomId(customId: string): boolean {
  return customId.startsWith(CATCHUP_PREFIX + ":");
}

export function formatMergedPrompt(messages: CatchupMessage[]): string {
  const header =
    `[这是你离线期间用户在该 thread/频道累积发送的 ${messages.length} 条消息，按时间顺序排列。请综合判断如何处理：]`;
  const body = messages
    .map((m, i) => `${i + 1}. (${m.createdAt.toISOString()}) ${m.content}`)
    .join("\n");
  return `${header}\n\n${body}`;
}

export function pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const r = queue.shift();
    if (r) r();
  };
  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          next();
        }
      };
      if (active < n) run();
      else queue.push(run);
    });
  };
}
