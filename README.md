# SillyTavern Discord Connector

Bridge your SillyTavern character to Discord for real-time roleplay. Messages sent in a Discord channel are routed through SillyTavern's AI pipeline and responded to as your active character, with full streaming support.

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (latest recommended)
- [Node.js](https://nodejs.org/) v18 or higher
- A Discord bot token with the **Message Content** privileged intent enabled

## Quick Start

### 1. Install the extension

- In SillyTavern → Extensions tab → Install from URL
- Paste: `https://github.com/senjinthedragon/SillyTavern-Discord-Connector`
- Enable the extension in the list

### 2. Create your Discord bot

- Go to https://discord.com/developers/applications
- Click **New Application** → **Bot** → **Add Bot**
- Under **Privileged Gateway Intents**, enable **Message Content Intent** (required)
- Copy the bot token for the next step
- Invite the bot to your server using the OAuth2 URL generator:
  - Scopes: `bot`
  - Permissions: `Send Messages`, `Read Message History`, `Manage Messages`

### 3. Configure the server
```bash
cd server
cp config.example.js config.js
```

Edit `config.js`:
```javascript
discordToken: 'YOUR_BOT_TOKEN_HERE',
wssPort: 2333, // must match the bridge URL in the extension settings
allowedUserIds: [], // add your Discord user ID here to make the bot private
```

To get your Discord user ID: enable Developer Mode in Discord settings, then right-click your username and select **Copy ID**.

### 4. Start the bridge server
```bash
cd server
npm install
node server.js
```

### 5. Connect the extension

- In SillyTavern, open the **Discord Connector** panel in the Extensions tab
- The bridge URL should match your `wssPort` (default: `ws://127.0.0.1:2333`)
- Click **Connect** — or enable **Auto-connect** to connect on every page load
- Select a character in SillyTavern and start chatting in Discord

## Commands

Use these slash commands in Discord to control the session:

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/new` | Start a fresh chat with the current character |
| `/listchars` | List all available characters |
| `/switchchar <name>` | Switch to a character by name |
| `/switchchar_#` | Switch to a character by number from `/listchars` |
| `/listchats` | List saved chats for the current character |
| `/switchchat <name>` | Load a saved chat by name |
| `/switchchat_#` | Load a saved chat by number from `/listchats` |

## How It Works

The extension runs inside SillyTavern's browser environment and connects to a local Node.js WebSocket server. When a Discord message arrives, the server forwards it to SillyTavern, which generates a response using your active character and AI settings. The reply is sent back through the bridge and posted to Discord. Streaming is supported — the Discord message updates in real time as the AI generates.

## Troubleshooting

**Bot doesn't respond:** Check that the bridge server is running, the extension shows "Connected" in green, and a character is selected in SillyTavern.

**Message Content Intent error:** This intent must be explicitly enabled in the Discord Developer Portal under your bot's settings — it is not on by default.

**Port conflict:** If port 2333 is in use, change `wssPort` in `config.js` and update the bridge URL in the extension settings to match.

## License

MIT - see [LICENSE](LICENSE) file for full text
