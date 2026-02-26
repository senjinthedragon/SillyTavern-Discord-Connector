# SillyTavern Discord Connector

Bridge your SillyTavern character to Discord for real-time roleplay. Messages sent in a Discord channel are routed through SillyTavern's AI pipeline and responded to as your active character, with full streaming support.

## ☕ Support the Developer

I am a solo developer building this bridge to make mobile RP better for the community. I maintain this project in my free time, and as I'm currently navigating some financial challenges, any support is deeply appreciated.

If this tool adds value to your roleplay experience, please consider:
* **[Buying me a coffee on Ko-fi](https://ko-fi.com/senjinthedragon)** (One-time tips, no platform fees)
* **Starring this repository** to help others find it.

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (latest recommended)
- [Node.js](https://nodejs.org/) v18 or higher
- A Discord bot token with the **Message Content** privileged intent enabled (see step 2)
- A Discord server with a channel where you want to send messages. You can set this up yourself, for free, with Discord. It's at the bottom of your server list, **Add a Server** (the little icon with a + sign)

## Quick Start

*Note for Mobile/Android Users: You only need to perform these steps on the computer running your SillyTavern server. Once the bridge is running, you can chat from your phone using the standard Discord app.*

### 1. Install the extension

- In SillyTavern → **Extensions** menu (The stack of cubes) → **Install extension**
- Paste: `https://github.com/senjinthedragon/SillyTavern-Discord-Connector`
- Click **Install for all users** or **Install just for me**.

The **Discord Connector Settings** should now appear in your extensions list.

### 2. Create your Discord bot

- Go to https://discord.com/developers/applications
- Click **New Application**, give it a name (`SillyTavern Bridge` for example), check the box and click **Create**
- Go to the **Bot** tab:
  - Customize your bot. You can give it an **Icon**, **Banner** and **Username**
  - **Reset**/**Copy** your Token and store it somewhere safe. (The long line of random letters and numbers)
  - Under **Privileged Gateway Intents**, enable **Message Content Intent**
- Go to the **OAuth2** tab:
  - Under **OAuth2 URL generator**:
    - **Scopes**: `bot`
    - **Bot Permissions**: `Send Messages`, `Read Message History`, `Manage Messages`[^1]
    - Leave **Integration Type** set to **Guild Install**
    - Copy the **Generated URL** and open it with a browser to invite your bot to your Discord server

[^1]: `Manage Messages` is used to delete the streaming message and repost it cleanly.

### 3. Configure the SillyTavern Bridge Server

These folders and files can be found in your SillyTavern extensions folder which you can commonly find in the following locations:
- **Windows**: [Your SillyTavern Folder]\data\default-user\extensions\SillyTavern-Discord-Connector\server
- **Linux/Mac**: ~/.local/share/sillytavern/default-user/extensions/SillyTavern-Discord-Connector/server
- **Docker**: /home/node/app/data/default-user/extensions/SillyTavern-Discord-Connector/server

**Windows**:\
Copy or rename `config.example.js` to `config.js`

**Linux/Mac**:
```shell
cp config.example.js config.js
```

**Both**:\
Edit `config.js`:
```javascript
discordToken: 'YOUR_BOT_TOKEN_HERE', // The one you copied to a safe place in part 2
wssPort: 2333, // must match the bridge URL in the extension settings
allowedUserIds: [], // (optional) add your Discord user IDs here to make the bot private
allowedChannelIds: [], // (optional) add your Discord channel IDs here to make the bot only respond to users in specific channels
debug: false, // set this to true to enable verbose debug logging
timezone: "Europe/Amsterdam", // (optional) set this to your timezone
```

> [!TIP]
> To get a Discord user ID: enable Developer Mode in Discord settings, then right-click a user and select **Copy User ID**.\
> To get a Discord channel ID: enable Developer Mode in Discord settings, then right-click a channel and select **Copy Channel ID**.\
> To enable **Developer Mode**: Discord settings → ...Advanced → Developer Mode
> You can find a list of all supported timezones [here](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

> [!CAUTION]
> SECURITY WARNING: If you leave `allowedUserIds` empty, the bot is public.\
> ANYONE who finds your bot on Discord can trigger generations on your SillyTavern server. It is highly recommended to add your User ID.

### 4. Start the bridge server

**Windows**:\
Right click inside the explorer window at the server directory, the same one from the previous step, and select **Open Command Prompt Here** or **Open Terminal**.

**Linux/Mac**:\
Open your terminal and cd into the server directory listed in the previous step

**Both**:\
Type and press enter to run the following commands:
```shell
npm install
node server.js
```

This will run the Bridge Server required to make Discord and SillyTavern talk to each other. You need to run the server every time and **keep this window open** for it to work.\
You can simplify this if you have the knowledge by creating a batch or shell script to do this or set it up to run automatically on system start or when you start SillyTavern.

**Example batch script for Windows**\
Create a `start-bridge.bat` file in the server folder (make sure it doesn't end with .txt) and write the following into this file by opening it in a text editor. You can then create a shortcut to the .bat file and place it on your desktop or next to your SillyTavern starter.
```batchfile
@echo off
echo Checking dependencies...
call npm install
echo Starting bridge server...
node server.js
pause
```

### 5. Connect the extension

- In SillyTavern, open the **Discord Connector** panel in the Extensions tab
- The bridge URL should match your `wssPort` (default: `ws://127.0.0.1:2333`)
- Click **Connect** - or enable **Auto-connect** to connect on every page load
- Select a character in SillyTavern and start chatting in Discord

## Commands

Use these slash commands in Discord to control the session:

| Command | Description |
|---|---|
| `/sthelp` | Show available commands |
| `/newchat` | Start a fresh chat with the current character |
| `/listchars` | List all available characters |
| `/switchchar <name>` | Switch to a character by name |
| `/switchchar_#` | Switch to a character by number from `/listchars` |
| `/listgroups` | List all available groups |
| `/switchgroup <name>` | Switch to a group by name |
| `/switchgroup_#` | Switch to a group by number from `/listgroups` |
| `/listchats` | List saved chats for the current character |
| `/switchchat <name>` | Load a saved chat by name |
| `/switchchat_#` | Load a saved chat by number from `/listchats` |

## How It Works

The extension runs inside SillyTavern's browser environment and connects to a local Node.js WebSocket server. When a Discord message arrives, the server forwards it to SillyTavern, which generates a response using your active character and AI settings. The reply is sent back through the bridge and posted to Discord. Streaming is supported - the Discord message updates in real time as the AI generates.

## Troubleshooting

**Bot doesn't respond:** Check that the bridge server is running, the extension shows "Connected" in green, and a character is selected in SillyTavern.

**Message Content Intent error:** This intent must be explicitly enabled in the Discord Developer Portal under your bot's settings - it is not on by default.

**Port conflict:** If port 2333 is in use, change `wssPort` in `config.js` and update the bridge URL in the extension settings to match.

## License

MIT - see [LICENSE](LICENSE) file for full text
