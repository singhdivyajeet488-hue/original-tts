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
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();

process.on('unhandledRejection', (err) => {
  console.error('[Unhandled]', err?.message || err);
});

// ─────────────────────────────────────────────────────────────────────────────
// Discord client
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-guild state
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Audio queue
// ─────────────────────────────────────────────────────────────────────────────

function processQueue(guildId) {
  const s = getState(guildId);
  if (!s.connection || s.queue.length === 0) {
    s.processing = false;
    return;
  }
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
  // Fire-and-forget — does not block callers
  const tmpFile = path.join('/tmp', `tts_${uuidv4()}.mp3`);
  const tts = new gtts(text, 'en');
  tts.save(tmpFile, (err) => {
    if (err) { console.error('[gTTS]', err.message); return; }
    const s = getState(guildId);
    if (!s.connection) { fs.unlink(tmpFile, () => {}); return; }
    const resource = createAudioResource(tmpFile);
    s.queue.push({ resource, file: tmpFile });
    if (!s.processing) processQueue(guildId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice helpers
// ─────────────────────────────────────────────────────────────────────────────

async function joinVC(voiceChannel, guildId, textChannelId) {
  const existing = getVoiceConnection(guildId);
  if (existing) existing.destroy();

  const conn = joinVoiceChannel({
    channelId:       voiceChannel.id,
    guildId,
    adapterCreator:  voiceChannel.guild.voiceAdapterCreator,
    selfDeaf:        false,
  });

  await entersState(conn, VoiceConnectionStatus.Ready, 20000);

  const s = getState(guildId);
  s.connection    = conn;
  s.textChannelId = textChannelId;

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting,  5000),
      ]);
    } catch {
      conn.destroy();
      const st = getState(guildId);
      st.connection = null; st.queue = []; st.processing = false;
    }
  });

  conn.on('error', (e) => console.error('[ConnErr]', e.message));
  console.log(`[Voice] joined "${voiceChannel.name}"`);
  return conn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash command registration
// ─────────────────────────────────────────────────────────────────────────────

async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and start speaking chat'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
    new SlashCommandBuilder().setName('autojoin').setDescription('Toggle auto-join when you type in this channel'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
    console.log('✅ Commands registered.');
  } catch (e) {
    console.error('[RegCmds]', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot ready
// ─────────────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ Online as ${client.user.tag}`);
  await registerCommands();
});

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands
// KEY FIX: interaction.reply() is called FIRST (synchronously before any await
// that could take >3 s), then async voice work happens after.
// ─────────────────────────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  const guildId = guild.id;
  const state   = getState(guildId);

  // ── /join ──────────────────────────────────────────────────────────────────
  if (commandName === 'join') {
    const vc = member.voice?.channel;
    if (!vc) {
      // Safe: no async work before this reply
      return interaction.reply({ content: '❌ You must be in a voice channel first.', flags: 64 });
    }

    // ✅ Reply to Discord IMMEDIATELY — this is what prevents "did not respond"
    // We use channel.send for the real result since editReply can also race
    interaction.reply({ content: '⏳ Joining your voice channel...', flags: 64 }).catch(() => {});

    // Now do the slow async work AFTER the reply is already sent
    try {
      await joinVC(vc, guildId, interaction.channelId);
      interaction.channel.send(
        `✅ **TTS is now active in this channel!**\nI joined **${vc.name}** — everything you type here will be spoken aloud.`
      ).catch(() => {});
    } catch (err) {
      console.error('[/join]', err.message);
      interaction.channel.send(`❌ Failed to join voice channel: ${err.message}`).catch(() => {});
    }
  }

  // ── /leave ─────────────────────────────────────────────────────────────────
  else if (commandName === 'leave') {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
      state.connection = null; state.queue = []; state.processing = false; state.autoJoin = false;
      interaction.reply('👋 Left the voice channel. TTS stopped.').catch(() => {});
    } else {
      interaction.reply({ content: "❌ I'm not in a voice channel.", flags: 64 }).catch(() => {});
    }
  }

  // ── /autojoin ──────────────────────────────────────────────────────────────
  else if (commandName === 'autojoin') {
    state.autoJoin      = !state.autoJoin;
    state.textChannelId = interaction.channelId;
    interaction.reply(
      state.autoJoin
        ? `🔁 **Auto-join ON** — I'll automatically join your VC when you type in this channel.`
        : `⏹️ **Auto-join OFF.**`
    ).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Message handler — speak everything
// ─────────────────────────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const guildId = message.guild.id;
  const state   = getState(guildId);

  // Auto-join when user types and bot isn't in VC yet
  if (state.autoJoin && message.channelId === state.textChannelId && !state.connection) {
    const vc = message.member?.voice?.channel;
    if (vc) {
      try { await joinVC(vc, guildId, message.channelId); }
      catch (err) { console.error('[AutoJoin]', err.message); return; }
    }
  }

  if (!state.connection) return;
  if (state.textChannelId && message.channelId !== state.textChannelId) return;

  const content = message.content.trim();
  if (!content || content.startsWith('/') || content.startsWith('!')) return;

  const text = content
    .replace(/<@!?\d+>/g,    '')
    .replace(/<#\d+>/g,      '')
    .replace(/<@&\d+>/g,     '')
    .replace(/<a?:\w+:\d+>/g,'')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\n+/g, '. ')
    .trim();

  if (!text) return;

  const name    = message.member?.displayName || message.author.username;
  const ttsText = `${name} says: ${text}`;
  console.log(`[TTS] ${ttsText}`);
  enqueueTTS(ttsText, guildId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-join when user joins a VC
// ─────────────────────────────────────────────────────────────────────────────

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.member?.user.bot) return;
  const guildId = newState.guild.id;
  const state   = getState(guildId);
  if (state.autoJoin && newState.channelId && !oldState.channelId && !state.connection) {
    try { await joinVC(newState.channel, guildId, state.textChannelId); }
    catch (err) { console.error('[AutoJoin VC]', err.message); }
  }
});

client.login(process.env.DISCORD_TOKEN);
