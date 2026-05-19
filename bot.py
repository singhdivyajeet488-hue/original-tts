import discord
from discord.ext import commands
from discord import app_commands
import asyncio
import os
import tempfile
from gtts import gTTS

# ── Config ────────────────────────────────────────────────────────────────────
TOKEN  = os.environ["DISCORD_TOKEN"]
PREFIX = os.getenv("PREFIX", "!")
# ─────────────────────────────────────────────────────────────────────────────

intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix=PREFIX, intents=intents)

LANGUAGES = {
    "english":    "en",
    "hindi":      "hi",
    "french":     "fr",
    "spanish":    "es",
    "german":     "de",
    "japanese":   "ja",
    "korean":     "ko",
    "arabic":     "ar",
    "russian":    "ru",
    "italian":    "it",
    "portuguese": "pt",
    "chinese":    "zh",
}

# guild_id -> { "channel_id": int, "lang": str }
tts_channels: dict[int, dict] = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

async def generate_tts(text: str, lang: str = "en") -> str:
    loop = asyncio.get_event_loop()
    def _gen():
        tts = gTTS(text=text, lang=lang)
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3", dir="/tmp")
        tts.save(tmp.name)
        return tmp.name
    return await loop.run_in_executor(None, _gen)


async def get_voice(guild: discord.Guild, member: discord.Member = None) -> discord.VoiceClient | None:
    vc = guild.voice_client
    if member and member.voice:
        channel = member.voice.channel
        if vc and vc.channel != channel:
            await vc.move_to(channel)
        elif not vc:
            vc = await channel.connect()
    return guild.voice_client


def play_file(vc: discord.VoiceClient, filepath: str):
    # Queue if already playing
    if vc.is_playing():
        vc.stop()

    def after(err):
        try:
            os.remove(filepath)
        except Exception:
            pass

    vc.play(discord.FFmpegPCMAudio(filepath), after=after)


# ── Events ────────────────────────────────────────────────────────────────────

@bot.event
async def on_ready():
    print(f"✅  {bot.user} is online  |  Servers: {len(bot.guilds)}")
    await bot.change_presence(activity=discord.Activity(
        type=discord.ActivityType.listening,
        name="your messages 👂"
    ))
    try:
        synced = await bot.tree.sync()
        print(f"   Synced {len(synced)} slash command(s)")
    except Exception as e:
        print(f"   Slash sync error: {e}")


@bot.event
async def on_message(message: discord.Message):
    # Ignore bots and DMs
    if message.author.bot or not message.guild:
        await bot.process_commands(message)
        return

    cfg = tts_channels.get(message.guild.id)

    # If auto-TTS is active and message is in the TTS channel
    if cfg and message.channel.id == cfg["channel_id"]:
        # Skip command messages
        if message.content.startswith(PREFIX):
            await bot.process_commands(message)
            return

        text = message.content.strip()
        if not text:
            await bot.process_commands(message)
            return

        vc = message.guild.voice_client
        if not vc:
            # Try to join the author's voice channel
            if message.author.voice:
                vc = await message.author.voice.channel.connect()
            else:
                await message.add_reaction("❌")
                await bot.process_commands(message)
                return

        lang = cfg.get("lang", "en")
        filepath = await generate_tts(text, lang)
        play_file(vc, filepath)
        await message.add_reaction("🔊")

    await bot.process_commands(message)


# ── Prefix Commands ───────────────────────────────────────────────────────────

@bot.command(name="join", help="Join your voice channel.")
async def join(ctx: commands.Context):
    if not ctx.author.voice:
        return await ctx.send("❌ Join a voice channel first.")
    vc = await get_voice(ctx.guild, ctx.author)
    await ctx.send(f"🔊 Joined **{vc.channel.name}**")


@bot.command(name="leave", aliases=["dc"], help="Leave the voice channel and disable auto-TTS.")
async def leave(ctx: commands.Context):
    tts_channels.pop(ctx.guild.id, None)
    if ctx.voice_client:
        await ctx.voice_client.disconnect()
        await ctx.send("👋 Disconnected and auto-TTS disabled.")
    else:
        await ctx.send("❌ Not in a voice channel.")


@bot.command(name="setup", help="Set this channel as the auto-TTS channel. Usage: !setup [language]")
async def setup(ctx: commands.Context, language: str = "english"):
    if not ctx.author.voice:
        return await ctx.send("❌ Join a voice channel first.")

    lang = LANGUAGES.get(language.lower(), "en")
    vc = await get_voice(ctx.guild, ctx.author)

    tts_channels[ctx.guild.id] = {
        "channel_id": ctx.channel.id,
        "lang": lang
    }

    await ctx.send(
        f"✅ Auto-TTS enabled!\n"
        f"🔊 Voice: **{vc.channel.name}**\n"
        f"💬 Text channel: **#{ctx.channel.name}**\n"
        f"🌐 Language: **{language}**\n\n"
        f"Just type anything here and I'll say it!"
    )


@bot.command(name="setlang", help="Change TTS language. Usage: !setlang hindi")
async def setlang(ctx: commands.Context, language: str = "english"):
    if ctx.guild.id not in tts_channels:
        return await ctx.send("❌ Run `!setup` first.")
    lang = LANGUAGES.get(language.lower())
    if not lang:
        return await ctx.send(f"❌ Unknown language. Use `!langs` to see options.")
    tts_channels[ctx.guild.id]["lang"] = lang
    await ctx.send(f"✅ Language set to **{language}**.")


@bot.command(name="stop", help="Stop current TTS playback.")
async def stop(ctx: commands.Context):
    if ctx.voice_client and ctx.voice_client.is_playing():
        ctx.voice_client.stop()
        await ctx.send("⏹️ Stopped.")
    else:
        await ctx.send("❌ Nothing is playing.")


@bot.command(name="langs", help="Show supported languages.")
async def langs(ctx: commands.Context):
    desc = "\n".join(f"`{k}` → `{v}`" for k, v in LANGUAGES.items())
    embed = discord.Embed(title="🌐 Supported Languages", description=desc, color=0x5865F2)
    await ctx.send(embed=embed)


@bot.command(name="ping", help="Check bot latency.")
async def ping(ctx: commands.Context):
    await ctx.send(f"🏓 Pong! `{round(bot.latency * 1000)}ms`")


# ── Slash Commands ────────────────────────────────────────────────────────────

@bot.tree.command(name="setup", description="Enable auto-TTS: bot reads everything typed in this channel.")
@app_commands.describe(language="Language to speak in (default: english)")
async def slash_setup(interaction: discord.Interaction, language: str = "english"):
    await interaction.response.defer()
    if not interaction.user.voice:
        return await interaction.followup.send("❌ Join a voice channel first.")

    lang = LANGUAGES.get(language.lower(), "en")
    vc = await get_voice(interaction.guild, interaction.user)

    tts_channels[interaction.guild.id] = {
        "channel_id": interaction.channel.id,
        "lang": lang
    }

    await interaction.followup.send(
        f"✅ Auto-TTS enabled!\n"
        f"🔊 Voice: **{vc.channel.name}**\n"
        f"💬 Text channel: **#{interaction.channel.name}**\n"
        f"🌐 Language: **{language}**\n\n"
        f"Just type anything here and I'll say it!"
    )


@bot.tree.command(name="leave", description="Disconnect and disable auto-TTS.")
async def slash_leave(interaction: discord.Interaction):
    tts_channels.pop(interaction.guild.id, None)
    vc = interaction.guild.voice_client
    if vc:
        await vc.disconnect()
        await interaction.response.send_message("👋 Disconnected and auto-TTS disabled.")
    else:
        await interaction.response.send_message("❌ Not in a voice channel.")


@bot.tree.command(name="stop", description="Stop current TTS playback.")
async def slash_stop(interaction: discord.Interaction):
    vc = interaction.guild.voice_client
    if vc and vc.is_playing():
        vc.stop()
        await interaction.response.send_message("⏹️ Stopped.")
    else:
        await interaction.response.send_message("❌ Nothing is playing.")


# ── Run ───────────────────────────────────────────────────────────────────────

bot.run(TOKEN)
