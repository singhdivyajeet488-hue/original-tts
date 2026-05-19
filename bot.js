const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const gtts  = require('gtts');
const fs    = require('fs');
const path  = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();

process.on('unhandledRejection', (err) => console.error('[Unhandled]', err?.message || err));
process.on('uncaughtException',  (err) => console.error('[Uncaught]',  err?.message || err));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── State ────────────────────────────────────────────────────────────────────

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
      ready:         false,   // tracks if voice is truly Ready
    };
    player.on(AudioPlayerStatus.Idle, () => {
      console.log('[Player] Idle');
      state.processing = false;
      processQueue(guildId);
    });
    player.on(AudioPlayerStatus.Playing,   () => console.log('[Player] ▶ PLAYING AUDIO'));
    player.on(AudioPlayerStatus.Buffering, () => console.log('[Player] Buffering...'));
    player.on('error', (err) => {
      console.error('[Player ERROR]', err.message);
      state.processing = false;
      processQueue(guildId);
    });
    guildState.set(guildId, state);
  }
  return guildState.get(guildId);
}

// ─── Queue / Playback ─────────────────────────────────────────────────────────

function processQueue(guildId) {
  const s = getState(guildId);
  console.log(`[Queue] len=${s.queue.length} ready=${s.ready} processing=${s.processing}`);

  if (s.processing)          { console.log('[Queue] Already processing'); return; }
  if (!s.connection)         { console.log('[Queue] No connection'); return; }
  if (!s.ready)              { console.log('[Queue] Voice not Ready yet — will retry'); return; }
  if (s.queue.length === 0)  { console.log('[Queue] Empty'); return; }

  s.processing = true;
  const { file } = s.queue.shift();

  try {
    const resource = createAudioResource(fs.createReadStream(file), {
      inputType: StreamType.Arbitrary,
    });
    s.connection.subscribe(s.player);
    s.player.play(resource);
    console.log(`[Queue] play() called for ${file}`);
    setTimeout(() => fs.unlink(file, () => {}), 30000);
  } catch (err) {
    console.error('[Queue ERROR]', err.message);
    s.processing = false;
    fs.unlink(file, () => {});
    processQueue(guildId);
  }
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

function enqueueTTS(text, guildId) {
  console.log(`[TTS] "${text}"`);
  const tmpFile = path.join('/tmp', `tts_${uuidv4()}.mp3`);

  new gtts(text, 'en').save(tmpFile, (err) => {
    if (err) { console.error('[gTTS ERROR]', err.message); return; }

    fs.stat(tmpFile, (statErr, stats) => {
      if (statErr || stats.size === 0) { console.error('[gTTS] Bad file'); return; }
      console.log(`[TTS] ${stats.size} bytes saved`);

      const s = getState(guildId);
      if (!s.connection) { console.log('[TTS] No conn, discard'); fs.unlink(tmpFile, () => {}); return; }

      s.queue.push({ file: tmpFile });
      console.log(`[TTS] Queued. Total: ${s.queue.length}`);
      processQueue(guildId);
    });
  });
}

// ─── Voice join ───────────────────────────────────────────────────────────────

async function joinVC(voiceChannel, guildId, textChannelId) {
  console.log(`[Voice] Joining "${voiceChannel.name}"`);

  const existing = getVoiceConnection(guildId);
  if (existing) existing.destroy();

  const s = getState(guildId);
  s.ready = false;

  const conn = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf:       false,
  });

  s.connection    = conn;
  s.textChannelId = textChannelId;

  // When Ready → flush any queued items
  conn.on(VoiceConnectionStatus.Ready, () => {
    console.log('[Voice] ✅ READY — flushing queue');
    s.ready = true;
    processQueue(guildId);  // play anything that queued up before Ready
  });

  conn.on(VoiceConnectionStatus.Connecting,  () => console.log('[Voice] Connecting...'));
  conn.on(VoiceConnectionStatus.Signalling,  () => console.log('[Voice] Signalling...'));

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('[Voice] Disconnected');
    s.ready = false;
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 3000),
        entersState(conn, VoiceConnectionStatus.Connecting, 3000),
      ]);
      console.log('[Voice] Reconnecting...');
    } catch {
      conn.destroy();
      s.connection = null; s.queue = []; s.processing = false; s.ready = false;
      console.log('[Voice] Destroyed after disconnect');
    }
  });

  conn.on('error', (e) => console.error('[Voice ERROR]', e.message));
  return conn;
}

// ─── Register commands ────────────────────────────────────────────────────────

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
    if (!vc) return interaction.reply({ content: '❌ Join a voice channel first!', flags: 64 });

    interaction.reply({ content: `✅ Joining **${vc.name}**...`, flags: 64 }).catch(() => {});
    await joinVC(vc, guildId, interaction.channelId);
    interaction.channel.send(
      `✅ **TTS active!** I'm in **${vc.name}** — type anything here and I'll speak it.`
    ).catch(() => {});
  }

  else if (commandName === 'leave') {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
      state.connection = null; state.queue = []; state.processing = false;
      state.autoJoin = false; state.ready = false;
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
    if (vc) await joinVC(vc, guildId, message.channelId);
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

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.member?.user.bot) return;
  const guildId = newState.guild.id;
  const state   = getState(guildId);
  if (state.autoJoin && newState.channelId && !oldState.channelId && !state.connection) {
    await joinVC(newState.channel, guildId, state.textChannelId);
  }
});

client.login(process.env.DISCORD_TOKEN);
