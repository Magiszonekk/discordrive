// @ddv4/server-discord: what the e2ee and plain instances use to talk to Discord
// (docs/stage3-modes.md §3-§4). Node only.
export { DiscordSender, DiscordUnavailableError, NoChannelError, SERVER_BLOBS_MARKER, type SenderHook, type SenderOptions } from "./sender.js";
export { InstanceHooks, POOL, INSTANCE_KEY_FILE, MAX_ACCOUNT_CHANNELS, loadInstanceKey, instanceSubkey, type HookInfo } from "./instance-hooks.js";
