# v1.8.1 - Patch

## Fixed

- **Smart Memory recap unblocked** - If you have Smart Memory installed and its away recap was showing, incoming Discord messages would be silently dropped because the modal overlay prevents SillyTavern from processing anything. The bot now automatically dismisses the recap when a Discord message arrives, so it responds even while you are away from your computer. If Smart Memory is not installed nothing changes.
