const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
require("dotenv").config();

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN or GUILD_ID in .env");
  process.exit(1);
}

const CHANNEL_LAYOUT = [
  {
    category: "INFORMATION",
    channels: [
      { name: "welcome", type: 0 },
      { name: "rules", type: 0 },
      { name: "announcements", type: 0 },
    ],
  },
  {
    category: "DEPARTMENTS",
    channels: [
      { name: "usm", type: 0 },
      { name: "sasp", type: 0 },
      { name: "bcso", type: 0 },
      { name: "lspd", type: 0 },
    ],
  },
  {
    category: "REPORTS",
    channels: [
      { name: "officer-reports", type: 0 },
      { name: "anonymous-reports", type: 0 },
    ],
  },
  {
    category: "RIDE-ALONGS",
    channels: [
      { name: "ride-alongs", type: 0 },
    ],
  },
  {
    category: "LOGS",
    channels: [
      { name: "report-logs", type: 0 },
      { name: "ride-along-logs", type: 0 },
      { name: "bot-logs", type: 0 },
    ],
  },
];

const commands = [
  {
    name: "delete",
    description: "Reset the server by deleting every channel.",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    dm_permission: false,
    options: [
      {
        type: 1,
        name: "channels",
        description: "Delete every channel in this server.",
      },
    ],
  },
  {
    name: "create",
    description: "Create the WCRP channel structure.",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    dm_permission: false,
    options: [
      {
        type: 1,
        name: "channels",
        description: "Create the default WCRP channel structure.",
      },
    ],
  },
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands,
  });
  console.log("Registered exactly 2 guild commands.");
}

async function handleDeleteChannels(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "Administrator permission is required.", ephemeral: true });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("confirm_delete_channels").setLabel("Confirm").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("cancel_delete_channels").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: "This will permanently delete every channel in this server. Confirm to continue.",
    components: [row],
    ephemeral: true,
  });
}

async function handleCreateChannels(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "Administrator permission is required.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const created = [];
  for (const group of CHANNEL_LAYOUT) {
    let category = guild.channels.cache.find(
      (c) => c.type === 4 && c.name.toLowerCase() === group.category.toLowerCase()
    );

    if (!category) {
      category = await guild.channels.create({
        name: group.category,
        type: 4,
      });
      created.push(`#${category.name}`);
      await sleep(400);
    }

    for (const ch of group.channels) {
      const exists = guild.channels.cache.find(
        (c) =>
          c.parentId === category.id &&
          c.type === ch.type &&
          c.name.toLowerCase() === ch.name.toLowerCase()
      );
      if (!exists) {
        await guild.channels.create({
          name: ch.name,
          type: ch.type,
          parent: category.id,
        });
        created.push(`#${ch.name}`);
        await sleep(400);
      }
    }
  }

  await interaction.editReply(
    created.length
      ? `Created ${created.length} channels/categories.`
      : "The WCRP channel structure already exists."
  );
}

async function deleteAllChannels(guild) {
  const channels = [...guild.channels.cache.values()];
  let deleted = 0;

  for (const channel of channels) {
    try {
      await channel.delete("WCRP server reset requested");
      deleted += 1;
      await sleep(500);
    } catch (error) {
      console.error(`Failed to delete ${channel.name} (${channel.id}):`, error?.message || error);
    }
  }

  return deleted;
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  try {
    await registerCommands();
  } catch (error) {
    console.error("Command registration failed:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "delete" && interaction.options.getSubcommand() === "channels") {
        return handleDeleteChannels(interaction);
      }

      if (interaction.commandName === "create" && interaction.options.getSubcommand() === "channels") {
        return handleCreateChannels(interaction);
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "cancel_delete_channels") {
        return interaction.update({
          content: "Channel deletion cancelled.",
          components: [],
        });
      }

      if (interaction.customId === "confirm_delete_channels") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return interaction.update({
            content: "Administrator permission is required.",
            components: [],
          });
        }

        await interaction.update({
          content: "Deleting channels now...",
          components: [],
        });

        const deleted = await deleteAllChannels(interaction.guild);
        console.log(`Deleted ${deleted} channels in ${interaction.guild.name}.`);
      }
    }
  } catch (error) {
    console.error("Interaction error:", error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "The command failed. Check the bot logs.",
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: "The command failed. Check the bot logs.",
          ephemeral: true,
        });
      }
    } catch {}
  }
});

client.login(TOKEN);
