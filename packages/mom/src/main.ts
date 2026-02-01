#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import type { PlatformAdapter, PlatformEvent, PlatformHandler } from "./platform.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const MOM_PLATFORM = process.env.MOM_PLATFORM ?? "slack";
const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_DOMAIN = (process.env.FEISHU_DOMAIN ?? "feishu") as "feishu" | "lark";

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	model?: string;
	platform?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let model: string | undefined;
	let platform: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
		} else if (arg === "--model") {
			model = args[++i];
		} else if (arg.startsWith("--platform=")) {
			platform = arg.slice("--platform=".length);
		} else if (arg === "--platform") {
			platform = args[++i];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		model,
		platform,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode (Slack only)
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--platform=slack|feishu] [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	console.error("");
	console.error("Platforms:");
	console.error("  slack (default)  - Requires MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	console.error("  feishu           - Requires FEISHU_APP_ID, FEISHU_APP_SECRET");
	process.exit(1);
}

const { workingDir, sandbox, model } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	model: parsedArgs.model,
};

const platform = parsedArgs.platform ?? MOM_PLATFORM;

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string, botToken?: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, model),
			store: new ChannelStore({ workingDir, botToken }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create PlatformContext adapter
// ============================================================================

function createPlatformContext(
	event: PlatformEvent,
	platform: PlatformAdapter,
	state: ChannelState,
	isEvent?: boolean,
) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const user = platform.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: platform.getChannel(event.channel)?.name,
		store: state.store,
		channels: platform.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: platform.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

				if (messageTs) {
					await platform.updateMessage(event.channel, messageTs, displayText);
				} else {
					messageTs = await platform.postMessage(event.channel, displayText);
				}

				if (shouldLog && messageTs) {
					platform.logBotResponse(event.channel, text, messageTs);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
				if (messageTs) {
					await platform.updateMessage(event.channel, messageTs, displayText);
				} else {
					messageTs = await platform.postMessage(event.channel, displayText);
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				if (messageTs) {
					const ts = await platform.postInThread(event.channel, messageTs, text);
					threadMessageTs.push(ts);
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) {
						accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
						messageTs = await platform.postMessage(event.channel, accumulatedText + workingIndicator);
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await platform.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (messageTs) {
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await platform.updateMessage(event.channel, messageTs, displayText);
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages first (in reverse order)
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await platform.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// Ignore errors deleting thread messages
					}
				}
				threadMessageTs.length = 0;
				// Then delete main message
				if (messageTs) {
					await platform.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};
}

// ============================================================================
// Platform Handler (unified for all platforms)
// ============================================================================

function createPlatformHandler(botToken?: string): PlatformHandler {
	return {
		isRunning(channelId: string): boolean {
			const state = channelStates.get(channelId);
			return state?.running ?? false;
		},

		async handleStop(channelId: string, adapter: PlatformAdapter): Promise<void> {
			const state = channelStates.get(channelId);
			if (state?.running) {
				state.stopRequested = true;
				state.runner.abort();
				const ts = await adapter.postMessage(channelId, "_Stopping..._");
				state.stopMessageTs = ts;
			} else {
				await adapter.postMessage(channelId, "_Nothing running_");
			}
		},

		async handleEvent(event: PlatformEvent, adapter: PlatformAdapter, isEvent?: boolean): Promise<void> {
			const state = getState(event.channel, botToken);

			// Start run
			state.running = true;
			state.stopRequested = false;

			log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

			try {
				// Create context adapter
				const ctx = createPlatformContext(event, adapter, state, isEvent);

				// Run the agent
				await ctx.setTyping(true);
				await ctx.setWorking(true);
				const result = await state.runner.run(ctx as any, state.store);
				await ctx.setWorking(false);

				if (result.stopReason === "aborted" && state.stopRequested) {
					if (state.stopMessageTs) {
						await adapter.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
						state.stopMessageTs = undefined;
					} else {
						await adapter.postMessage(event.channel, "_Stopped_");
					}
				}
			} catch (err) {
				log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
			} finally {
				state.running = false;
			}
		},
	};
}

// ============================================================================
// Slack-specific handler (for backward compatibility)
// ============================================================================

const slackHandler: MomHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts;
		} else {
			await slack.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel, MOM_SLACK_BOT_TOKEN);

		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			const ctx = createPlatformContext(event, slack as unknown as PlatformAdapter, state, isEvent);

			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

let bot: PlatformAdapter;

if (platform === "feishu") {
	// Feishu platform
	if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
		console.error("Missing env: FEISHU_APP_ID, FEISHU_APP_SECRET");
		process.exit(1);
	}

	const { FeishuBot } = await import("./feishu.js");
	const sharedStore = new ChannelStore({ workingDir });

	bot = new FeishuBot(createPlatformHandler(), {
		feishuConfig: {
			appId: FEISHU_APP_ID,
			appSecret: FEISHU_APP_SECRET,
			domain: FEISHU_DOMAIN,
		},
		workingDir,
		store: sharedStore,
	});

	log.logInfo(`Platform: Feishu (${FEISHU_DOMAIN})`);
} else {
	// Slack platform (default)
	if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}

	const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN });

	bot = new SlackBotClass(slackHandler, {
		appToken: MOM_SLACK_APP_TOKEN,
		botToken: MOM_SLACK_BOT_TOKEN,
		workingDir,
		store: sharedStore,
	}) as unknown as PlatformAdapter;

	log.logInfo("Platform: Slack");
}

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", async () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	await bot.stop();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	await bot.stop();
	process.exit(0);
});

await bot.start();
