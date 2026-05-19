# 🔊 Discord TTS Bot — Railway Deploy

A Discord bot that **automatically speaks every chat message** in a voice channel using Google TTS — no `/tts` command needed. Just type and it speaks.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🗣️ Auto-speak | Every message in the linked channel is read aloud |
| 🤖 `/join` | Bot joins your current voice channel |
| 👋 `/leave` | Bot leaves the voice channel |
| 🔁 `/autojoin` | Auto-joins VC when you type (toggle) |
| 🧹 Smart cleanup | Skips URLs, mentions, commands, bot messages |
| 📛 Name prefix | Says "Username says: ..." for each message |
| 🚂 Railway ready | One-click deploy with Dockerfile included |

---

## 🚀 Step 1 — Create Your Discord Bot

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g. `TTS Bot`)
3. Go to **Bot** tab → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - ✅ `SERVER MEMBERS INTENT`
   - ✅ `MESSAGE CONTENT INTENT`
5. Copy your **Bot Token** (keep it secret!)
6. Go to **OAuth2 → General** and copy your **Client ID**

### Bot Invite Link

Replace `YOUR_CLIENT_ID` and open in browser:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3148800&scope=bot%20applications.commands
```

**Permissions included:** Read Messages, Send Messages, Connect, Speak, Use Voice Activity

---

## 🚂 Step 2 — Deploy to Railway

### Option A: Deploy from GitHub (Recommended)

1. Push this project to a GitHub repo
2. Go to [https://railway.app](https://railway.app) → **New Project**
3. Choose **Deploy from GitHub repo**
4. Select your repo
5. Railway auto-detects the Dockerfile ✅

### Option B: Deploy from Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## ⚙️ Step 3 — Set Environment Variables in Railway

In your Railway project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Your bot token from Discord Dev Portal |
| `CLIENT_ID` | Your application/client ID |

That's it — Railway will restart the bot automatically! 🎉

---

## 🏠 Local Development

```bash
# Clone / download the project
cd discord-tts-bot

# Install dependencies
npm install

# Create your .env file
cp .env.example .env
# Edit .env and fill in DISCORD_TOKEN and CLIENT_ID

# Run the bot
npm start

# Or with auto-restart on file changes
npm run dev
```

**Requirements:** Node.js 18+, FFmpeg installed locally
- macOS: `brew install ffmpeg`
- Ubuntu: `sudo apt install ffmpeg`
- Windows: Download from [ffmpeg.org](https://ffmpeg.org)

---

## 📖 How to Use

### First time in a server:

1. **Join a voice channel** in Discord
2. Type `/join` in any text channel → bot joins your VC
3. **Now just type anything** in that channel — the bot will speak it!
4. Type `/leave` when done

### Auto-join mode:

1. Type `/autojoin` in your TTS text channel
2. Whenever you join a voice channel and type in that channel, the bot **auto-joins** your VC
3. Type `/autojoin` again to disable

### What gets spoken:
- ✅ Normal messages
- ❌ Bot messages (ignored)
- ❌ Messages starting with `/` or `!`
- ❌ Empty messages
- URLs are replaced with the word "link"
- @mentions and emojis are removed

---

## 🗂️ File Structure

```
discord-tts-bot/
├── bot.js           # Main bot logic
├── package.json     # Dependencies
├── Dockerfile       # Railway/Docker build
├── railway.toml     # Railway config
├── .env.example     # Environment variable template
├── .gitignore
└── README.md
```

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't speak | Make sure it's in a voice channel via `/join` |
| "Missing permissions" | Re-invite bot with the OAuth link above |
| Commands not showing | Wait 1–2 min after first boot (global command sync) |
| Audio choppy | Railway hobby plan is fine; upgrade if needed |
| Bot keeps disconnecting | Check Railway logs; ensure TOKEN is correct |

---

## 📦 Dependencies

- [`discord.js`](https://discord.js.org/) — Discord API
- [`@discordjs/voice`](https://github.com/discordjs/voice) — Voice channel support  
- [`gtts`](https://www.npmjs.com/package/gtts) — Google Text-to-Speech
- [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) — Audio processing
- [`uuid`](https://www.npmjs.com/package/uuid) — Unique temp file names
