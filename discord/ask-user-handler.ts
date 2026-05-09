/**
 * AskUserQuestion handler — sends interactive question embeds to Discord
 * and collects user answers via button clicks.
 *
 * @module discord/ask-user-handler
 */

import { parseAskUserButtonId, parseAskUserConfirmId, type AskUserQuestionInput } from "../claude/user-question.ts";

/**
 * Create the AskUserQuestion handler that uses the Discord channel.
 *
 * When Claude calls the AskUserQuestion tool:
 * 1. Builds embeds with option buttons for each question
 * 2. Sends them to the bot's channel (or session thread if available)
 * 3. Waits for button clicks
 * 4. Returns answers to the SDK so Claude can continue
 */
// deno-lint-ignore no-explicit-any
export function createAskUserDiscordHandler(bot: any, getTargetChannel?: () => any): (input: AskUserQuestionInput) => Promise<Record<string, string>> {
  return async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    const channel = getTargetChannel?.() ?? bot.getChannel();
    if (!channel) {
      throw new Error('Discord channel not available');
    }

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = await import("npm:discord.js@14.14.1");
    const answers: Record<string, string> = {};

    for (let qi = 0; qi < input.questions.length; qi++) {
      const q = input.questions[qi];

      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle(`❓ Claude needs your input — ${q.header}`)
        .setDescription(q.question)
        .setFooter({ text: q.multiSelect ? 'Select option(s), then click ✅ Confirm — Claude is waiting' : 'Click an option to answer — Claude is waiting' })
        .setTimestamp();

      for (let oi = 0; oi < q.options.length; oi++) {
        embed.addFields({ name: `${oi + 1}. ${q.options[oi].label}`, value: q.options[oi].description, inline: true });
      }

      const row = new ActionRowBuilder();
      for (let oi = 0; oi < q.options.length; oi++) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`ask-user:${qi}:${oi}`)
            .setLabel(q.options[oi].label)
            .setStyle(ButtonStyle.Primary)
        );
      }

      if (q.multiSelect) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`ask-user-confirm:${qi}`)
            .setLabel('✅ Confirm')
            .setStyle(ButtonStyle.Success)
        );
      }

      const questionMsg = await channel.send({ embeds: [embed], components: [row] });

      if (q.multiSelect) {
        const selected: string[] = [];
        const collector = questionMsg.createMessageComponentCollector({
          componentType: ComponentType.Button,
        });

        await new Promise<void>((resolve, reject) => {
          // deno-lint-ignore no-explicit-any
          collector.on('collect', async (i: any) => {
            const parsed = parseAskUserButtonId(i.customId);
            if (parsed && parsed.questionIndex === qi) {
              const label = q.options[parsed.optionIndex].label;
              if (!selected.includes(label)) {
                selected.push(label);
              }
              await i.update({
                embeds: [embed.setFooter({ text: `Selected: ${selected.join(', ')} — click ✅ Confirm when done` })],
                components: [row],
              });
            } else if (parseAskUserConfirmId(i.customId)?.questionIndex === qi) {
              answers[q.question] = selected.join(', ');
              collector.stop('confirmed');
              await i.update({
                embeds: [embed.setColor(0x00ff00).setFooter({ text: `✅ Answered: ${selected.join(', ')}` })],
                components: [],
              });
              resolve();
            }
          });

          collector.on('end', (_: unknown, reason: string) => {
            if (reason !== 'confirmed') {
              reject(new Error(`Question "${q.header}" was cancelled`));
            }
          });
        });
      } else {
        // deno-lint-ignore no-explicit-any
        const interaction: any = await questionMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
        });

        const parsed = parseAskUserButtonId(interaction.customId);
        if (parsed && parsed.questionIndex === qi) {
          const label = q.options[parsed.optionIndex].label;
          answers[q.question] = label;

          await interaction.update({
            embeds: [embed.setColor(0x00ff00).setFooter({ text: `✅ Answered: ${label}` })],
            components: [],
          });
        } else {
          throw new Error(`Unexpected button ID: ${interaction.customId}`);
        }
      }
    }

    console.log('[AskUserQuestion] Collected answers:', JSON.stringify(answers));
    return answers;
  };
}
