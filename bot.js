const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  StreamType,
} = require('@discordjs/voice');
const gtts  = require('gtts');
const fs    = require('fs');
const path  = require('path');
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
    player.on(AudioPlayerStatus.Idle, () => {
      console.log('[Player] Idle → next');
      processQueue(guildId);
    });
    player.on(AudioPlayerStatus.Playing,   () => console.log('[Player] ▶ Playing'));
    player.on(AudioPlayerStatus.Buffering, () => console.log('[Player] ⏳ Buffering'));
    player.on('error', (err) => {
      console.error('[Player ERROR]', err.message, err.resource?.metadata);
      processQueue(guildId);
    });
    guildState.set(guildId, state);
  }
  return guildState.get(guildId);
}

// ─── Queue ────────────────────────────────────────────────────────────────────

function processQueue(guildId) {
  const s = getState(guildId);
  console.log(`[Queue] len=${s.queue.length} processing=${s.processing} conn=${!!s.connection}`);
  if (!s.connection || s.queue.length === 0) {
    s.processing = false;
    return;
  }
  s.processing = true;
  const { file } = s.queue.shift();

  try {
    // Create a fresh readable stream from the saved mp3 file
    const stream   = fs.createReadStream(file);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: false,
    });

    resource.playStream.on('error', (err) => {
      console.error('[Stream ERROR]', err.message);
    });

    s.connection.subscribe(s.player);
    s.player.play(resource);
    console.log(`[Queue] Playing: ${file}`);

    // Clean up after playback
    setTimeout(() => fs.unlink(file, () => {}), 30000);
  } catch (err) {
    console.error('[Queue PLAY]', err.message);
    s.processing = false;
    fs.unlink(file, () => {});
    processQueue(guildId);
  }
}

// ─── TTS → save mp3 → enqueue ─────────────────────────────────────────────────

function enqueueTTS(text, guildId) {
  console.log(`[TTS] Generating: "${text}"`);
  const tmpFile = path.join('/tmp', `tts_${uuidv4()}.mp3`);

  new gtts(text, 'en').save(tmpFile, (err) => {
    if (err) {
      console.error('[gTTS ERROR]', err.message);
      return;
    }

    // Verify file exists and has content
    fs.stat(tmpFile, (statErr, stats) => {
      if (statErr || stats.size === 0) {
        console.error('[gTTS] File missing or empty:', statErr?.message);
        return;
      }
      console.log(`[TTS] Saved ${stats.size} bytes → ${tmpFile}`);

      const s = getState(guildId);
      if (!s.connection) {
        console.log('[TTS] No connection, discarding');
        fs.unlink(tmpFile, () => {});
        return;
      }

      s.queue.push({ file: tmpFile });
      console.log(`[TTS] Queued. Queue size: ${s.queue.length}`);
      if (!s.processing) processQueue(guildId);
    });
  });
}

// ─── Voice join ───────────────────────────────────────────────────────────────

function joinVC(voiceChannel, guildId, textChannelId) {
  console.log(`[Voice] Joining "${voiceChannel.name}" (${voiceChannel.id})`);

  const existing = getVoiceConnection(guildId);
  if (existing) {
    console.log('[Voice] Destroying old connection');
    existing.destroy();
  }

  const conn = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf:       false,
  });

  const s = getState(guildId);
  s.connection    = conn;
  s.textChannelId = textChannelId;
  console.log(`[Voice] Connection set. textChannelId=${textChannelId}`);

  conn.on(VoiceConnectionStatus.Ready,       () => console.log('[Voice] ✅ Ready'));
  conn.on(VoiceConnectionStatus.Connecting,  () => console.log('[Voice] Connecting...'));
  conn.on(VoiceConnectionStatus.Signalling,  () => console.log('[Voice] Signalling...'));
  conn.on(VoiceConnectionStatus.Disconnected, () => {
    console.log('[Voice] Disconnected — destroying');
    conn.destroy();
    const st = getState(guildId);
    st.connection = null; st.queue = []; st.processing = false;
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
    interaction.reply({ content: `✅ Joining **${vc.name}**...`, flags: 64 }).catch(() => {});
    joinVC(vc, guildId, interaction.channelId);
    interaction.channel.send(
      `✅ **TTS active in <#${interaction.channelId}>!** Type anything and I'll speak it.`
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

  if (!state.connection) {
    console.log('[Msg] No connection — skip');
    return;
  }
  if (state.textChannelId && message.channelId !== state.textChannelId) {
    console.log(`[Msg] Wrong channel — skip`);
    return;
  }

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
