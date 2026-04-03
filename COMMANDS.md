# Commands

Use these slash commands in Discord to control the session.

> [!NOTE]
> Many commands show a dropdown of suggestions as you type - just start typing and pick from the list. Character and group lists refresh every 60 seconds, so something added in SillyTavern may take up to a minute to appear. `/mood` and `/charimage` suggest the members of your active group, or just your current character in a solo chat. `/persona` and `/mypersona` suggest the personas you have set up - you can also type a name that isn't in the list to use it as a one-time persona. Chat history shows your most recent chats first and updates right away after any switch or new chat.
>
> Numbered shortcuts (`/switchchar_3`, `/switchgroup_2`, `/switchchat_1` etc.) don't appear in the slash command menu because everyone has a different number of characters. Just type them as a normal message - they work exactly the same way.

## Information & status

| Command | Description |
| --- | --- |
| **`/sthelp`** | *Show the list of all available commands* |
| **`/status`** | *Check if the bot is connected and see how image requests are going* |
| **`/history <n>`** | *Show the last few messages from the current chat (shows 5 by default)* |

## Characters & groups

| Command | Description |
| --- | --- |
| **`/listchars`** | *List all your characters with their shortcut numbers* |
| **`/switchchar <name>`** | *Switch to a different character by name* |
| **`/switchchar_#`** | *Switch to a character by its number from `/listchars`* |
| **`/listgroups`** | *List all your groups with their shortcut numbers* |
| **`/switchgroup <name>`** | *Switch to a different group by name* |
| **`/switchgroup_#`** | *Switch to a group by its number from `/listgroups`* |

## Chats

| Command | Description |
| --- | --- |
| **`/listchats`** | *Show your saved chats for the current character, newest first* |
| **`/switchchat <name>`** | *Load a saved chat by name* |
| **`/switchchat_#`** | *Load a saved chat by its number from `/listchats`* |
| **`/newchat`** | *Start a fresh new chat and get the character's opening message* |

## Persona

| Command | Description |
| --- | --- |
| **`/listpersonas`** | *See all your available personas* |
| **`/persona <name>`** | *Choose who you appear to be in the conversation. You can type a name that isn't in the list to use it as a temporary persona* |
| **`/mypersona <name>`** | *Save your persona so it gets set for you automatically every time you chat* |
| **`/mypersona clear`** | *Remove your saved persona setting* |

## Conversation

| Command | Description |
| --- | --- |
| **`/continue`** | *Ask the AI to keep writing from where it left off* |
| **`/impersonate`** | *Have the AI write your next message for you, as your character would say it. Add an optional prompt to guide it* |
| **`/note <text>`** | *Set SillyTavern's Author's Note to shape the story or the character's behavior. Leave out the text to read what's currently set* |

## Delete & Swipe

| Command | Description |
| --- | --- |
| **`/delete`** | *Delete the last message from the chat (both from SillyTavern and from Discord)* |
| **`/delete <1-5>`** | *Delete the last N messages, including any user messages before them so no AI response is left without context* |
| **`/swipe`** | *Delete the last AI response and generate a new one - useful when the output has formatting issues or just isn't quite right* |

> [!NOTE]
> `/delete` and `/swipe` mirror their changes to Discord automatically - the affected messages disappear from the channel. In solo chat only; `/swipe` is not supported in group chats.
>
> Deleting a Discord message manually (selecting "Delete Message" in Discord) will also delete the corresponding last message from SillyTavern, as long as it was the most recent AI response in that channel.

## Expressions & appearance

| Command | Description |
| --- | --- |
| **`/charimage <name>`** | *Post a character's picture in chat* |
| **`/mood <name>`** | *Show what mood or expression the character is currently displaying* |
| **`/reaction <mode>`** | *Change how the character's mood is shown (`off` = nothing, `status` = bot status bar only, `full` = status bar and expression images)* |

> [!TIP]
> Reactions can arrive a little after the chat text. That's normal.
>
> If you use `off` or `status` mode for reactions, run `/mood` any time you want to post the current expression image in chat.

## Language

| Command | Description |
| --- | --- |
| **`/setlang <language>`** | *Set your preferred language for bot responses. Use autocomplete to pick from the available languages* |
| **`/setlang clear`** | *Reset to the server's default language* |

> [!NOTE]
> If `/setlang` doesn't appear in the slash command menu yet, you can type it as a plain message (`/setlang Japanese`) and it will work immediately. Discord can take up to an hour to show newly registered commands - restarting your Discord client usually picks them up straight away.

## Image generation

| Command | Description |
| --- | --- |
| **`/image <prompt>`** | *Generate an AI image. Use a keyword or describe what you want to see* |
| **`/image cancel`** | *Cancel an image that is currently being generated - the result will be discarded even if it finishes* |

Instead of a custom prompt you can use one of these shorthand keywords:

| Keyword | Generates |
| --- | --- |
| **`you`** | *Full body portrait of the current character* |
| **`me`** | *Full body portrait of your player character* |
| **`face`** | *Close-up portrait of the current character* |
| **`scene`** | *An image based on the events of the entire chat* |
| **`last`** | *An image based on the last message sent by the character* |
| **`raw_last`** | *Uses the character's last message verbatim as the prompt* |
| **`background`** | *A backdrop image based on the current setting/location* |
| **`cancel`** | *Cancel the active image generation task - the result will be discarded even if it finishes* |

> [!NOTE]
> Image generation can take anywhere from a few seconds to several minutes depending on your hardware. The bot posts a 🎨 **Generating image…** placeholder straight away so you know it's working, then replaces it with the finished image when it's ready. The placeholder counts down so you can always see how much time is left.
>
> If it runs out of time, the placeholder disappears and you can try again. If the image happens to finish after the timeout, it will still be posted with a small note so it isn't lost.
>
> To keep things stable, the bot may briefly pause new image requests if too many are sent at once or if several fail in a row. Just wait a moment and try again.
