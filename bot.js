const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
} = require('@discordjs/voice');
const gtts = require('gtts');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// State management
const guildState = new Map(); // guildId -> { connection, player, queue, autoJoin, textChannelId }

function getState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, {
      connection: null,
      player: createAudioPlayer(),
      queue: [],
      autoJoin: false,
      textChannelId: null,
      processing: false,
    });

    const state = guildState.get(guildId);

    state.player.on(AudioPlayerStatus.Idle, () => {
      processQueue(guildId);
    });

    state.player.on('error', (err) => {
      console.error(`[Player Error] Guild ${guildId}:`, err.message);
      processQueue(guildId);
    });
  }
  return guildState.get(guildId);
}

async function speakText(text, guildId) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join('/tmp', `tts_${uuidv4()}.mp3`);
    const tts = new gtts(text, 'en');
    tts.save(tmpFile, async (err) => {
      if (err) return reject(err);

      const state = getState(guildId);
      if (!state.connection) {
        fs.unlink(tmpFile, () => {});
        return resolve();
      }

      const resource = createAudioResource(tmpFile);
      state.queue.push({ resource, file: tmpFile });

      if (!state.processing) {
        processQueue(guildId);
      }
      resolve();
    });
  });
}

function processQueue(guildId) {
  const state = getState(guildId);
  if (state.queue.length === 0) {
    state.processing = false;
    return;
  }

  state.processing = true;
  const { resource, file } = state.queue.shift();

  if (!state.connection) {
    state.processing = false;
    state.queue = [];
    return;
  }

  try {
    state.connection.subscribe(state.player);
    state.player.play(resource);

    // Clean up file after a delay
    setTimeout(() => {
      fs.unlink(file, () => {});
    }, 10000);
  } catch (err) {
    console.error('[Queue Error]', err.message);
    state.processing = false;
  }
}

async function joinChannel(voiceChannel, guildId, textChannelId) {
  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

    const state = getState(guildId);
    state.connection = connection;
    state.textChannelId = textChannelId;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        connection.destroy();
        state.connection = null;
        state.queue = [];
        state.processing = false;
      }
    });

    return connection;
  } catch (err) {
    console.error('[Join Error]', err.message);
    throw err;
  }
}

// Register slash commands
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Bot joins your current voice channel'),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Bot leaves the voice channel'),
    new SlashCommandBuilder()
      .setName('autojoin')
      .setDescription('Toggle auto-join when someone types in this channel'),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered globally.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  const guildId = guild.id;
  const state = getState(guildId);

  if (commandName === 'join') {
    const voiceChannel = member.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '❌ You need to be in a voice channel first!', ephemeral: true });
    }

    try {
      await joinChannel(voiceChannel, guildId, interaction.channelId);
      await interaction.reply(`✅ Joined **${voiceChannel.name}**! I'll speak everything typed in this channel.`);
    } catch {
      await interaction.reply({ content: '❌ Failed to join the voice channel.', ephemeral: true });
    }
  }

  else if (commandName === 'leave') {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
      state.connection = null;
      state.queue = [];
      state.processing = false;
      state.autoJoin = false;
      await interaction.reply('👋 Left the voice channel.');
    } else {
      await interaction.reply({ content: "❌ I'm not in a voice channel.", ephemeral: true });
    }
  }

  else if (commandName === 'autojoin') {
    state.autoJoin = !state.autoJoin;
    state.textChannelId = interaction.channelId;
    const status = state.autoJoin ? '✅ **Auto-join enabled**' : '❌ **Auto-join disabled**';
    await interaction.reply(`${status} — I'll ${state.autoJoin ? 'automatically join your voice channel' : 'no longer auto-join'} when you type here.`);
  }
});

// Handle messages — speak ALL messages (no command needed)
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const guildId = message.guild.id;
  const state = getState(guildId);

  // Auto-join logic: if autojoin is on and someone types in the linked channel
  if (state.autoJoin && message.channelId === state.textChannelId && !state.connection) {
    const voiceChannel = message.member?.voice?.channel;
    if (voiceChannel) {
      try {
        await joinChannel(voiceChannel, guildId, message.channelId);
        console.log(`[AutoJoin] Joined ${voiceChannel.name} in ${message.guild.name}`);
      } catch {
        return;
      }
    }
  }

  // Only speak if bot is in a voice channel in this guild
  if (!state.connection) return;

  // Only speak messages from the linked text channel
  if (state.textChannelId && message.channelId !== state.textChannelId) return;

  // Skip messages that start with ! or / (commands)
  const content = message.content.trim();
  if (!content || content.startsWith('/') || content.startsWith('!')) return;

  // Clean up message for TTS
  let text = content
    .replace(/<@!?\d+>/g, '') // remove mentions
    .replace(/<#\d+>/g, '')   // remove channel mentions
    .replace(/<:\w+:\d+>/g, '') // remove custom emojis
    .replace(/https?:\/\/\S+/g, 'link') // replace URLs with "link"
    .replace(/\n+/g, '. ')
    .trim();

  if (!text) return;

  // Prepend username
  const displayName = message.member?.displayName || message.author.username;
  const ttsText = `${displayName} says: ${text}`;

  try {
    await speakText(ttsText, guildId);
  } catch (err) {
    console.error('[TTS Error]', err.message);
  }
});

// Handle voice state updates (member joins VC while autojoin is on)
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.member?.user.bot) return;

  const guildId = newState.guild.id;
  const state = getState(guildId);

  // If autojoin and user joins a VC and bot isn't in one
  if (state.autoJoin && newState.channelId && !oldState.channelId && !state.connection) {
    try {
      await joinChannel(newState.channel, guildId, state.textChannelId);
      console.log(`[AutoJoin] Joined ${newState.channel.name} on VC join`);
    } catch {
      // Silently fail
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
