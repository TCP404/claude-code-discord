/**
 * @module discord/queue-button-handler — Handles the "❌ Clear queue" button.
 *
 * customId format: `queue-clear:<sessionId>`
 *
 * On click:
 *   - clearByUser(interaction.user.id) on the session's pendingQueue
 *   - if nothing was cleared → ephemeral "No queued messages from you."
 *   - else → remove ⏳ reactions on cleared messages, refresh status line, ack interaction
 */

import type { ButtonInteraction, ThreadChannel } from "npm:discord.js@14.14.1";
import type { HotQuerySession } from "../claude/hot-query.ts";
import { markCancelled } from "./queue-reactions.ts";
import { getActiveSender } from "../claude/active-senders.ts";

export const QUEUE_CLEAR_PREFIX = "queue-clear:";

export interface QueueClearDeps {
  resolveSession: (sessionId: string) => HotQuerySession | undefined;
}

export function createQueueClearHandler(deps: QueueClearDeps) {
  return async (interaction: ButtonInteraction): Promise<void> => {
    const sessionId = interaction.customId.slice(QUEUE_CLEAR_PREFIX.length);
    const session = deps.resolveSession(sessionId);
    if (!session) {
      try {
        await interaction.reply({
          content: "Queue session no longer active.",
          ephemeral: true,
        });
      } catch { /* ignore */ }
      return;
    }

    const cleared = session.pendingQueue.clearByUser(interaction.user.id);
    if (cleared.length === 0) {
      try {
        await interaction.reply({
          content: "No queued messages from you.",
          ephemeral: true,
        });
      } catch { /* ignore */ }
      return;
    }

    // Ack the click first so Discord doesn't show "interaction failed"
    try {
      await interaction.deferUpdate();
    } catch { /* ignore */ }

    // Replace ⏳ with 🚫 on each cleared message — keeps the message in
    // place but signals it was cancelled.
    const channel = interaction.channel as ThreadChannel | null;
    if (channel) {
      for (const m of cleared) {
        await markCancelled(channel, m.messageId);
      }
    }

    // Refresh status line (may now hide the queue row + button entirely)
    const sender = getActiveSender(sessionId);
    if (sender) {
      // If queue is now empty, drop the queue context entirely
      if (session.pendingQueue.size() === 0) {
        sender.setQueueContext(null);
      } else {
        sender.setQueueContext({ count: session.pendingQueue.size(), sessionId });
      }
      await sender.refreshQueueStatus();
    }
  };
}
