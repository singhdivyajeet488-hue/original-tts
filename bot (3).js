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
  console.error('[UnhandledRejection]', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err?.message || err);
});

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
    player.on(AudioPlayerStatus.Idle,  () => {
      console.log(`[Player] Idle — processing next in queue`);
      processQueue(guildId);
    });
    player.on(AudioPlayerStatus.Playing, () => console.log(`[Player] Now playing`));
    player.on(AudioPlayerStatus.Buffering, () => console.log(`[Player] Buffering...`));
    player.on('error', (err) => {
      console.error('[Player ERROR]', err.message);
      processQueue(guildId);
    });
    guildState.set(guildId, state);
  }
  return guildState.get(guildId);
}

// ─── Audio queue ──────────────────────────────────────────────────────────────

function processQueue(guildId) {
  const s = getState(guildId);
  console.log(`[Queue] length=${s.queue.length} processing=${s.processing} hasConn=${!!s.connection}`);

  if (!s.connection) {
    console.log('[Queue] No connection — clearing queue');
    s.processing = false;
    s.queue = [];
    return;
  }
  if (s.queue.length === 0) {
    s.processing = false;
    return;
  }

  s.processing = true;
  const { resource, file } = s.queue.shift();
  console.log(`[Queue] Playing file: ${file}`);

  try {
    s.connection.subscribe(s.player);
    s.player.play(resource);
    setTimeout(() => fs.unlink(file, () => {}), 15000);
  } catch (err) {
    console.error('[Queue PLAY ERROR]', err.message);
    s.processing = false;
    processQueue(guildId);
  }
}

function enqueueTTS(text, guildId) {
  console.log(`[TTS] Generating MP3 for: "${text}"`);
  const tmpFile = path.join('/tmp', `tts_${uuidv4()}.mp3`);
  const tts = new gtts(text, 'en');

  tts.save(tmpFile, (err) => {
    if (err) {
      console.error('[TTS SAVE ERROR]', err.message);
      return;
    }

    // Check file was actually written
    try {
      const stat = fs.statSync(tmpFile);
      console.log(`[TTS] MP3 saved OK — size: ${stat.size} bytes at ${tmpFile}`);
    } catch (e) {
      console.error('[TTS] File stat failed:', e.message);
      return;
    }

    const s = getState(guildId);
    if (!s.connection) {
      console.log('[TTS] No connection when MP3 ready — discarding');
      fs.unlink(tmpFile, () => {});
      return;
    }

    console.log(`[TTS] Enqueueing resource, queue size will be ${s.queue.length + 1}`);
    const resource = createAudioResource(tmpFile);
    s.queue.push({ resource, file: tmpFile });
    if (!s.processing) processQueue(guildId);
  });
}

// ─── Voice join ───────────────────────────────────────────────────────────────

async function joinVC(voiceChannel, guildId, textChannelId) {
  console.log(`[Voice] Attempting to join "${voiceChannel.name}" (${voiceChannel.id})`);

  const existing = getVoiceConnection(guildId);
  if (existing) {
    console.log('[Voice] Destroying existing connection first');
    existing.destroy();
  }

  const conn = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf:       false,
  });

  console.log('[Voice] Waiting for Ready state...');
  await entersState(conn, VoiceConnectionStatus.Ready, 20000);
  console.log('[Voice] Connected and Ready!');

  const s = getState(guildId);
  s.connection    = conn;
  s.textChannelId = textChannelId;
  console.log(`[Voice] textChannelId set to ${textChannelId}`);

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('[Voice] Disconnected — trying to reconnect...');
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting,  5000),
      ]);
      console.log('[Voice] Reconnected OK');
    } catch {
      console.log('[Voice] Reconnect failed — destroying');
      conn.destroy();
      const st = getState(guildId);
      st.connection = null; st.queue = []; st.processing = false;
    }
  });

  conn.on('error', (e) => console.error('[Voice ERROR]', e.message));
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
    console.log('✅ Slash commands registered.');
  } catch (e) {
    console.error('[RegisterCmds ERROR]', e.message);
  }
}

client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log(`   CLIENT_ID  = ${process.env.CLIENT_ID}`);
  console.log(`   TOKEN set  = ${!!process.env.DISCORD_TOKEN}`);
  await registerCommands();
});

// ─── Slash command handler ────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`[Cmd] /${interaction.commandName} by ${interaction.user.tag}`);

  const { commandName, guild, member } = interaction;
  const guildId = guild.id;
  const state   = getState(guildId);

  if (commandName === 'join') {
    const vc = member.voice?.channel;
    console.log(`[/join] user voice channel: ${vc ? vc.name : 'NONE'}`);

    if (!vc) {
      return interaction.reply({ content: '❌ You must be in a voice channel first.', flags: 64 });
    }

    // Reply to Discord FIRST before any async work
    interaction.reply({ content: '⏳ Joining...', flags: 64 }).catch(e => console.error('[Reply err]', e.message));

    try {
      await joinVC(vc, guildId, interaction.channelId);
      console.log(`[/join] Success! Sending confirmation to channel ${interaction.channelId}`);
      interaction.channel.send(
        `✅ **TTS active!** Joined **${vc.name}** — type anything in this channel and I'll speak it.`
      ).catch(e => console.error('[Send err]', e.message));
    } catch (err) {
      console.error('[/join ERROR]', err.message);
      interaction.channel.send(`❌ Failed to join: ${err.message}`).catch(() => {});
    }
  }

  else if (commandName === 'leave') {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
      state.connection = null; state.queue = []; state.processing = false; state.autoJoin = false;
      console.log('[/leave] Disconnected');
      interaction.reply('👋 Left. TTS stopped.').catch(() => {});
    } else {
      interaction.reply({ content: "❌ Not in a voice channel.", flags: 64 }).catch(() => {});
    }
  }

  else if (commandName === 'autojoin') {
    state.autoJoin      = !state.autoJoin;
    state.textChannelId = interaction.channelId;
    console.log(`[/autojoin] autoJoin=${state.autoJoin} channel=${interaction.channelId}`);
    interaction.reply(
      state.autoJoin
        ? `🔁 **Auto-join ON** — I'll join your VC when you type here.`
        : `⏹️ **Auto-join OFF.**`
    ).catch(() => {});
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const guildId = message.guild.id;
  const state   = getState(guildId);

  console.log(`[Msg] "${message.content}" | channel=${message.channelId} | linkedChannel=${state.textChannelId} | hasConn=${!!state.connection} | autoJoin=${state.autoJoin}`);

  // Auto-join
  if (state.autoJoin && message.channelId === state.textChannelId && !state.connection) {
    const vc = message.member?.voice?.channel;
    console.log(`[AutoJoin] user VC = ${vc ? vc.name : 'NONE'}`);
    if (vc) {
      try { await joinVC(vc, guildId, message.channelId); }
      catch (err) { console.error('[AutoJoin ERROR]', err.message); return; }
    }
  }

  if (!state.connection) {
    console.log('[Msg] Skipping — no voice connection');
    return;
  }

  if (state.textChannelId && message.channelId !== state.textChannelId) {
    console.log(`[Msg] Skipping — wrong channel (${message.channelId} != ${state.textChannelId})`);
    return;
  }

  const content = message.content.trim();
  if (!content || content.startsWith('/') || content.startsWith('!')) {
    console.log('[Msg] Skipping — empty or command');
    return;
  }

  const text = content
    .replace(/<@!?\d+>/g,     '')
    .replace(/<#\d+>/g,       '')
    .replace(/<@&\d+>/g,      '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\n+/g, '. ')
    .trim();

  if (!text) { console.log('[Msg] Skipping — empty after clean'); return; }

  const name    = message.member?.displayName || message.author.username;
  const ttsText = `${name} says: ${text}`;

  console.log(`[Msg] ✅ Will speak: "${ttsText}"`);
  enqueueTTS(ttsText, guildId);
});

// ─── Auto-join on VC join ─────────────────────────────────────────────────────

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.member?.user.bot) return;
  const guildId = newState.guild.id;
  const state   = getState(guildId);
  if (state.autoJoin && newState.channelId && !oldState.channelId && !state.connection) {
    console.log(`[VoiceState] AutoJoin triggered for ${newState.member.user.tag}`);
    try { await joinVC(newState.channel, guildId, state.textChannelId); }
    catch (err) { console.error('[VoiceState AutoJoin ERROR]', err.message); }
  }
});

client.login(process.env.DISCORD_TOKEN);
