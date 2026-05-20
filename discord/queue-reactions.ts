/**
 * @module discord/queue-reactions — Add/remove ⏳ ▶️ reactions on Discord messages.
 *
 * Failures are logged and swallowed: reactions are best-effort UX; a missing one
 * must never crash the queue logic. Discord.js may throw "Unknown Message" when
 * the user has deleted the message — that's fine.
 */

import type { ThreadChannel } from "npm:discord.js@14.14.1";

export const QUEUED_EMOJI = "⏳";
export const PROCESSING_EMOJI = "▶️";

async function fetchMessage(channel: ThreadChannel, messageId: string) {
  try {
    return await channel.messages.fetch(messageId);
  } catch (err) {
    console.warn(
      `[queue-reactions] fetch failed for ${messageId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function safeReact(channel: ThreadChannel, messageId: string, emoji: string) {
  const msg = await fetchMessage(channel, messageId);
  if (!msg) return;
  try {
    await msg.react(emoji);
  } catch (err) {
    console.warn(
      `[queue-reactions] react ${emoji} failed for ${messageId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function safeRemoveOwn(channel: ThreadChannel, messageId: string, emoji: string) {
  const msg = await fetchMessage(channel, messageId);
  if (!msg) return;
  const botId = msg.client.user?.id;
  if (!botId) return;
  const reaction = msg.reactions.cache.find((r) => r.emoji.name === emoji);
  if (!reaction) return;
  try {
    await reaction.users.remove(botId);
  } catch (err) {
    console.warn(
      `[queue-reactions] remove ${emoji} failed for ${messageId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Add ⏳ to a queued message. */
export function markQueued(channel: ThreadChannel, messageId: string): Promise<void> {
  return safeReact(channel, messageId, QUEUED_EMOJI);
}

/** Replace ⏳ with ▶️ when processing begins. */
export async function markProcessing(
  channel: ThreadChannel,
  messageId: string,
): Promise<void> {
  await safeRemoveOwn(channel, messageId, QUEUED_EMOJI);
  await safeReact(channel, messageId, PROCESSING_EMOJI);
}

/** Remove every reaction this bot may have added. */
export async function unmarkAll(
  channel: ThreadChannel,
  messageId: string,
): Promise<void> {
  await safeRemoveOwn(channel, messageId, QUEUED_EMOJI);
  await safeRemoveOwn(channel, messageId, PROCESSING_EMOJI);
}
