const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const gtts = require('gtts');
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();

process.on('unhandledRejection', (err) => console.error('[Unhandled]', err?.message || err));
process.on('uncaughtException',  (err) => console.error('[Uncaught]',  err?.message || err));

// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const guildState = new Map();

function getState(guildId) {
  if (!guildState.has(guildId)) {
    const player = createAudioPlayer();
    const state  = {
      connection:    null,
      player,
      queue:         [],
      autoJoin:      false,
      textChannelId: null,
      processing:    false,
    };
    player.on(AudioPlayerStatus.Idle,  () => processQueue(guildId));
    player.on('error', (err) => { console.error('[Player]', err.message); processQueue(guildId); });
    guildState.set(guildId, state);
  }
  return guildState.get(guildId);
}

// ─── Queue ────────────────────────────────────────────────────────────────────

function processQueue(guildId) {
  const s = getState(guildId);
  if (!s.connection || s.queue.length === 0) { s.processing = false; return; }
  s.processing = true;
  const { resource, file } = s.queue.shift();
  try {
    s.connection.subscribe(s.player);
    s.player.play(resource);
    setTimeout(() => fs.unlink(file, () => {}), 15000);
  } catch (err) {
    console.error('[Queue]', err.message);
    s.processing = false;
    processQueue(guildId);
  }
}

function enqueueTTS(text, guildId) {
  console.log(`[TTS] "${text}"`);
  const tmpFile = path.join('/tmp', `tts_${uuidv4()}.mp3`);
  new gtts(text, 'en').save(tmpFile, (err) => {
    if (err) { console.error('[gTTS]', err.message); return; }
    const s = getState(guildId);
    if (!s.connection) { fs.unlink(tmpFile, () => {}); return; }
    s.queue.push({ resource: createAudioResource(tmpFile), file: tmpFile });
    if (!s.processing) processQueue(guildId);
  });
}

// ─── Voice join — NO entersState, no timeout, just join and set immediately ───

function joinVC(voiceChannel, guildId, textChannelId) {
  console.log(`[Voice] Joining "${voiceChannel.name}"`);

  const existing = getVoiceConnection(guildId);
  if (existing) existing.destroy();

  const conn = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf:       false,
  });

  // Set state immediately — don't wait for Ready
  const s = getState(guildId);
  s.connection    = conn;
  s.textChannelId = textChannelId;

  conn.on(VoiceConnectionStatus.Ready, () => {
    console.log(`[Voice] Ready in "${voiceChannel.name}"`);
  });

  conn.on(VoiceConnectionStatus.Disconnected, () => {
    console.log('[Voice] Disconnected');
    conn.destroy();
    const st = getState(guildId);
    st.connection = null; st.queue = []; st.processing = false;
  });

  conn.on('error', (e) => console.error('[Voice err]', e.message));

  return conn;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and speak chat'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
    new SlashCommandBuilder().setName('autojoin').setDescription('Toggle auto-join when you type here'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
    console.log('✅ Commands registered.');
  } catch (e) {
    console.error('[RegCmds]', e.message);
  }
}

client.once('ready', async () => {
  console.log(`✅ Online: ${client.user.tag}`);
  await registerCommands();
});

// ─── Slash commands ───────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  const guildId = guild.id;
  const state   = getState(guildId);

  if (commandName === 'join') {
    const vc = member.voice?.channel;
    if (!vc) {
      return interaction.reply({ content: '❌ Join a voice channel first!', flags: 64 });
    }

    // Reply to Discord INSTANTLY — synchronous, no await before this
    interaction.reply({ content: `✅ Joining **${vc.name}**...`, flags: 64 }).catch(() => {});

    // Join voice — synchronous function, no await needed
    joinVC(vc, guildId, interaction.channelId);

    // Confirm in channel
    interaction.channel.send(
      `✅ **TTS active!** I'm in **${vc.name}** — type anything here and I'll speak it.`
    ).catch(() => {});
  }

  else if (commandName === 'leave') {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
      state.connection = null; state.queue = []; state.processing = false; state.autoJoin = false;
      interaction.reply('👋 Left. TTS stopped.').catch(() => {});
    } else {
      interaction.reply({ content: "❌ Not in a voice channel.", flags: 64 }).catch(() => {});
    }
  }

  else if (commandName === 'autojoin') {
    state.autoJoin      = !state.autoJoin;
    state.textChannelId = interaction.channelId;
    interaction.reply(
      state.autoJoin
        ? `🔁 **Auto-join ON** — I'll join your VC when you type here.`
        : `⏹️ **Auto-join OFF.**`
    ).catch(() => {});
  }
});

// ─── Messages → TTS ───────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const guildId = message.guild.id;
  const state   = getState(guildId);

  // Auto-join
  if (state.autoJoin && message.channelId === state.textChannelId && !state.connection) {
    const vc = message.member?.voice?.channel;
    if (vc) joinVC(vc, guildId, message.channelId);
  }

  if (!state.connection) return;
  if (state.textChannelId && message.channelId !== state.textChannelId) return;

  const content = message.content.trim();
  if (!content || content.startsWith('/') || content.startsWith('!')) return;

  const text = content
    .replace(/<@!?\d+>/g,     '')
    .replace(/<#\d+>/g,       '')
    .replace(/<@&\d+>/g,      '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\n+/g, '. ')
    .trim();

  if (!text) return;

  const name = message.member?.displayName || message.author.username;
  enqueueTTS(`${name} says: ${text}`, guildId);
});

// ─── Auto-join on VC join ─────────────────────────────────────────────────────

client.on('voiceStateUpdate', (oldState, newState) => {
  if (newState.member?.user.bot) return;
  const guildId = newState.guild.id;
  const state   = getState(guildId);
  if (state.autoJoin && newState.channelId && !oldState.channelId && !state.connection) {
    joinVC(newState.channel, guildId, state.textChannelId);
  }
});

client.login(process.env.DISCORD_TOKEN);
