/**
 * PermissionRequest handler — shows Allow/Deny buttons in Discord
 * when Claude wants to use an unapproved tool.
 *
 * @module discord/permission-handler
 */

import {
  buildPermissionEmbed,
  parsePermissionButtonId,
  type PermissionRequestCallback,
} from "../claude/permission-request.ts";

/**
 * Create the PermissionRequest handler that uses the Discord channel.
 *
 * When Claude wants to use a tool that isn't pre-approved:
 * 1. Builds an embed showing the tool name and input preview
 * 2. Adds Allow / Deny buttons
 * 3. Sends to the bot's channel
 * 4. Waits for a button click (no timeout — user decides)
 * 5. Returns true (allow) or false (deny)
 */
// deno-lint-ignore no-explicit-any
export function createPermissionRequestHandler(
  bot: any,
  getTargetChannel?: () => any,
): PermissionRequestCallback {
  let nonce = 0;

  return async (toolName: string, toolInput: Record<string, unknown>): Promise<boolean> => {
    const channel = getTargetChannel?.() ?? bot.getChannel();
    if (!channel) {
      console.warn("[PermissionRequest] No channel — auto-denying");
      return false;
    }

    const reqNonce = String(++nonce);
    const embedData = buildPermissionEmbed(toolName, toolInput);

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } =
      await import("npm:discord.js@14.14.1");

    const embed = new EmbedBuilder()
      .setColor(embedData.color)
      .setTitle(embedData.title)
      .setDescription(embedData.description)
      .setFooter({ text: embedData.footer.text })
      .setTimestamp();

    for (const field of embedData.fields) {
      embed.addFields({ name: field.name, value: field.value, inline: field.inline });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-req:${reqNonce}:allow`)
        .setLabel("✅ Allow")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm-req:${reqNonce}:deny`)
        .setLabel("❌ Deny")
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    // deno-lint-ignore no-explicit-any
    const interaction: any = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
    });

    const parsed = parsePermissionButtonId(interaction.customId);
    const allowed = parsed?.allowed ?? false;

    embed.setColor(allowed ? 0x00ff00 : 0xff4444)
      .setFooter({ text: allowed ? `✅ Allowed by user` : `❌ Denied by user` });

    await interaction.update({
      embeds: [embed],
      components: [],
    });

    console.log(
      `[PermissionRequest] Tool "${toolName}" — ${allowed ? "ALLOWED" : "DENIED"} by user`,
    );
    return allowed;
  };
}
