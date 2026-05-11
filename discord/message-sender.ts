/**
 * Discord message sending utilities — builds and sends Discord.js payloads
 * from our internal MessageContent type.
 *
 * @module discord/message-sender
 */

import type { MessageContent } from "./types.ts";
import type { DiscordSender } from "../claude/types.ts";

/**
 * Build a Discord.js payload from a MessageContent object and send it to a channel.
 */
export async function sendMessageContent(channel: any, content: MessageContent): Promise<void> {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } =
    await import("npm:discord.js@14.14.1");

  const payload: any = {};

  if (content.content) payload.content = content.content;

  if (content.embeds) {
    payload.embeds = content.embeds.map((e) => {
      const embed = new EmbedBuilder();
      if (e.color !== undefined) embed.setColor(e.color);
      if (e.title) embed.setTitle(e.title);
      if (e.description) embed.setDescription(e.description);
      if (e.fields) e.fields.forEach((f) => embed.addFields(f));
      if (e.footer) embed.setFooter(e.footer);
      if (e.timestamp) embed.setTimestamp();
      return embed;
    });
  }

  if (content.components) {
    payload.components = content.components.map((row) => {
      const actionRow = new ActionRowBuilder<any>();
      row.components.forEach((comp) => {
        const button = new ButtonBuilder().setLabel(comp.label);

        switch (comp.style) {
          case "primary":
            button.setStyle(ButtonStyle.Primary);
            break;
          case "secondary":
            button.setStyle(ButtonStyle.Secondary);
            break;
          case "success":
            button.setStyle(ButtonStyle.Success);
            break;
          case "danger":
            button.setStyle(ButtonStyle.Danger);
            break;
          case "link":
            button.setStyle(ButtonStyle.Link);
            break;
        }

        if (comp.style === "link" && comp.url) {
          button.setURL(comp.url);
        } else if (comp.customId) {
          button.setCustomId(comp.customId);
        }

        actionRow.addComponents(button);
      });
      return actionRow;
    });
  }

  if (content.files && content.files.length > 0) {
    payload.files = content.files.map((f) =>
      new AttachmentBuilder(f.path, { name: f.name || "attachment", description: f.description })
    );
  }

  await channel.send(payload);
}

/** Like sendMessageContent but returns the Message object for later editing/deleting. */
export async function sendMessageContentTracked(
  channel: any,
  content: MessageContent,
): Promise<any> {
  const { AttachmentBuilder } = await import("npm:discord.js@14.14.1");
  const payload: any = {};
  if (content.content) payload.content = content.content;
  if (content.files && content.files.length > 0) {
    payload.files = content.files.map((f) =>
      new AttachmentBuilder(f.path, { name: f.name || "attachment", description: f.description })
    );
  }
  return await channel.send(payload);
}

/**
 * Create Discord sender adapter from bot instance.
 * Falls back to bot's default channel if no per-channel routing is set.
 */
export function createDiscordSenderAdapter(
  bot: any,
  responseChannels: Map<string, any>,
): DiscordSender {
  return {
    async sendMessage(content) {
      let channel = bot.getChannel();
      if (responseChannels.size === 1) {
        channel = responseChannels.values().next().value || channel;
      }
      if (channel) {
        await sendMessageContent(channel, content);
      }
    },
  };
}

/**
 * Create Discord sender adapter that sends to a specific channel (e.g., a thread).
 */
export function createChannelSenderAdapter(channel: any): DiscordSender {
  return {
    async sendMessage(content) {
      await sendMessageContent(channel, content);
    },
    async sendTracked(content) {
      const msg = await sendMessageContentTracked(channel, content);
      return {
        async edit(newContent) {
          const payload: any = {};
          if (newContent.content) payload.content = newContent.content;
          await msg.edit(payload);
        },
        async delete() {
          await msg.delete();
        },
      };
    },
  };
}
