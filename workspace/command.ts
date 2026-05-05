import { SlashCommandBuilder, ChannelType } from "npm:discord.js@14.14.1";
import type { WorkspaceManager } from "../core/workspace-manager.ts";
import { sanitizeChannelName } from "../discord/utils.ts";

export const workspaceCommands = [
  new SlashCommandBuilder()
    .setName('workspace')
    .setDescription('Manage workspace-channel mappings')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a workspace and create a channel for it')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Workspace name (used as channel name)')
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('path')
            .setDescription('Absolute path to the project working directory')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all registered workspaces'))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a workspace mapping')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Workspace name to remove')
            .setRequired(true))
        .addBooleanOption(opt =>
          opt.setName('delete_channel')
            .setDescription('Also delete the Discord channel')
            .setRequired(false))),
];

export interface WorkspaceHandlerDeps {
  workspaceManager: WorkspaceManager;
  // deno-lint-ignore no-explicit-any
  getGuild: () => any;
  // deno-lint-ignore no-explicit-any
  getCategory: () => any;
}

export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps) {
  const { workspaceManager, getGuild, getCategory } = deps;

  return {
    // deno-lint-ignore no-explicit-any
    async onWorkspace(ctx: any) {
      const subcommand = ctx.getSubcommand();

      if (subcommand === 'add') {
        await handleAdd(ctx);
      } else if (subcommand === 'list') {
        await handleList(ctx);
      } else if (subcommand === 'remove') {
        await handleRemove(ctx);
      }
    },
  };

  // deno-lint-ignore no-explicit-any
  async function handleAdd(ctx: any) {
    const name = ctx.getString('name', true);
    const workPath = ctx.getString('path', true);

    await ctx.deferReply();

    // Validate path exists
    try {
      const stat = await Deno.stat(workPath);
      if (!stat.isDirectory) {
        await ctx.editReply({ content: `Error: \`${workPath}\` is not a directory.` });
        return;
      }
    } catch {
      await ctx.editReply({ content: `Error: path \`${workPath}\` does not exist.` });
      return;
    }

    // Check if name already exists
    const existing = workspaceManager.findByName(name);
    if (existing) {
      await ctx.editReply({ content: `Workspace \`${name}\` already exists (channel: <#${existing.channelId}>).` });
      return;
    }

    // Create channel under the bot's category
    const guild = getGuild();
    const category = getCategory();
    if (!guild || !category) {
      await ctx.editReply({ content: `Error: bot is not fully initialized (no guild/category).` });
      return;
    }

    const channelName = sanitizeChannelName(name);
    try {
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `Workspace: ${name} | Path: ${workPath}`,
      });

      workspaceManager.add({ name, path: workPath, channelId: channel.id });
      await workspaceManager.saveToDisk();

      await ctx.editReply({
        embeds: [{
          color: 0x00ff00,
          title: 'Workspace Added',
          fields: [
            { name: 'Name', value: name, inline: true },
            { name: 'Path', value: `\`${workPath}\``, inline: true },
            { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          ],
        }],
      });
    } catch (error) {
      await ctx.editReply({ content: `Error creating channel: ${error}` });
    }
  }

  // deno-lint-ignore no-explicit-any
  async function handleList(ctx: any) {
    const workspaces = workspaceManager.list();

    if (workspaces.length === 0) {
      await ctx.reply({
        content: 'No workspaces registered. Use `/workspace add` to create one.',
        ephemeral: true,
      });
      return;
    }

    const fields = workspaces.map(w => ({
      name: w.name,
      value: `Path: \`${w.path}\`\nChannel: <#${w.channelId}>`,
      inline: false,
    }));

    await ctx.reply({
      embeds: [{
        color: 0x5865f2,
        title: 'Registered Workspaces',
        fields,
      }],
    });
  }

  // deno-lint-ignore no-explicit-any
  async function handleRemove(ctx: any) {
    const name = ctx.getString('name', true);
    const deleteChannel = ctx.getBoolean('delete_channel') ?? false;

    await ctx.deferReply();

    const removed = workspaceManager.remove(name);
    if (!removed) {
      await ctx.editReply({ content: `Workspace \`${name}\` not found.` });
      return;
    }

    await workspaceManager.saveToDisk();

    // Optionally delete the Discord channel
    if (deleteChannel) {
      const guild = getGuild();
      if (guild) {
        try {
          const channel = guild.channels.cache.get(removed.channelId);
          if (channel) await channel.delete(`Workspace "${name}" removed`);
        } catch { /* channel may already be deleted */ }
      }
    }

    await ctx.editReply({
      embeds: [{
        color: 0xff9900,
        title: 'Workspace Removed',
        fields: [
          { name: 'Name', value: removed.name, inline: true },
          { name: 'Path', value: `\`${removed.path}\``, inline: true },
          { name: 'Channel Deleted', value: deleteChannel ? 'Yes' : 'No', inline: true },
        ],
      }],
    });
  }
}
