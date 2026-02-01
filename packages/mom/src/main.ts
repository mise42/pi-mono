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
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let model: string | undefined;

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
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		model,
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
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	console.error("");
	console.error("Platforms (auto-detected from environment variables):");
	console.error("  Slack  - MOM_SLACK_APP_TOKEN + MOM_SLACK_BOT_TOKEN");
	console.error("  Feishu - FEISHU_APP_ID + FEISHU_APP_SECRET (+ optional FEISHU_DOMAIN)");
	console.error("");
	console.error("Both platforms can run simultaneously if all credentials are provided.");
	process.exit(1);
}

const { workingDir, sandbox, model } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	model: parsedArgs.model,
};

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
	adapter: PlatformAdapter; // Which platform this channel belongs to
}

const channelStates = new Map<string, ChannelState>();

// Track which adapter owns which channel (for events)
const channelAdapters = new Map<string, PlatformAdapter>();

function getState(channelId: string, adapter: PlatformAdapter, botToken?: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, model),
			store: new ChannelStore({ workingDir, botToken }),
			stopRequested: false,
			adapter,
		};
		channelStates.set(channelId, state);
		channelAdapters.set(channelId, adapter);
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
			// Skip thread messages for platforms that don't support folded threads
			// (e.g., Feishu replies appear inline, cluttering the chat)
			if (!platform.supportsThreads) {
				return;
			}
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
			const state = getState(event.channel, adapter, botToken);

			// Start run
			state.running = true;
			state.stopRequested = false;

			log.logInfo(`[${adapter.platformId}:${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

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
// Slack-specific handler (for backward compatibility with SlackBot)
// ============================================================================

function createSlackHandler(botToken: string): MomHandler {
	return {
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
			const state = getState(event.channel, slack as unknown as PlatformAdapter, botToken);

			state.running = true;
			state.stopRequested = false;

			log.logInfo(`[slack:${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

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
}

// ============================================================================
// Multi-platform event router for EventsWatcher
// ============================================================================

/**
 * Creates a proxy adapter that routes events to the correct platform
 * based on which adapter owns the channel.
 */
function createMultiPlatformRouter(adapters: PlatformAdapter[]): PlatformAdapter {
	// Use the first adapter as default (for interface compliance)
	const defaultAdapter = adapters[0];

	return {
		platformId: "slack", // Default, not actually used for routing
		supportsThreads: true,

		async start(): Promise<void> {
			// Already started individually
		},

		async stop(): Promise<void> {
			// Stopped individually
		},

		getUser(userId: string) {
			for (const adapter of adapters) {
				const user = adapter.getUser(userId);
				if (user) return user;
			}
			return undefined;
		},

		getChannel(channelId: string) {
			for (const adapter of adapters) {
				const channel = adapter.getChannel(channelId);
				if (channel) return channel;
			}
			return undefined;
		},

		getAllUsers() {
			const users = new Map<string, ReturnType<PlatformAdapter["getUser"]>>();
			for (const adapter of adapters) {
				for (const user of adapter.getAllUsers()) {
					users.set(user.id, user);
				}
			}
			return Array.from(users.values()).filter((u): u is NonNullable<typeof u> => u !== undefined);
		},

		getAllChannels() {
			const channels = new Map<string, ReturnType<PlatformAdapter["getChannel"]>>();
			for (const adapter of adapters) {
				for (const channel of adapter.getAllChannels()) {
					channels.set(channel.id, channel);
				}
			}
			return Array.from(channels.values()).filter((c): c is NonNullable<typeof c> => c !== undefined);
		},

		async postMessage(channel: string, text: string): Promise<string> {
			const adapter = channelAdapters.get(channel) ?? defaultAdapter;
			return adapter.postMessage(channel, text);
		},

		async updateMessage(channel: string, messageId: string, text: string): Promise<void> {
			const adapter = channelAdapters.get(channel) ?? defaultAdapter;
			return adapter.updateMessage(channel, messageId, text);
		},

		async deleteMessage(channel: string, messageId: string): Promise<void> {
			const adapter = channelAdapters.get(channel) ?? defaultAdapter;
			return adapter.deleteMessage(channel, messageId);
		},

		async postInThread(channel: string, threadId: string, text: string): Promise<string> {
			const adapter = channelAdapters.get(channel) ?? defaultAdapter;
			return adapter.postInThread(channel, threadId, text);
		},

		async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
			const adapter = channelAdapters.get(channel) ?? defaultAdapter;
			return adapter.uploadFile(channel, filePath, title);
		},

		logBotResponse(channelId: string, text: string, ts: string): void {
			const adapter = channelAdapters.get(channelId) ?? defaultAdapter;
			adapter.logBotResponse(channelId, text, ts);
		},

		logToFile(channel: string, entry: object): void {
			const adapter = channelAdapters.get(channel) ?? defaultAdapter;
			adapter.logToFile(channel, entry);
		},

		enqueueEvent(event: PlatformEvent): boolean {
			// Route to the adapter that owns this channel
			const adapter = channelAdapters.get(event.channel);
			if (adapter) {
				return adapter.enqueueEvent(event);
			}
			// If channel not seen before, try all adapters
			for (const a of adapters) {
				if (a.enqueueEvent(event)) {
					return true;
				}
			}
			return false;
		},
	};
}

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Detect available platforms
const hasSlack = MOM_SLACK_APP_TOKEN && MOM_SLACK_BOT_TOKEN;
const hasFeishu = FEISHU_APP_ID && FEISHU_APP_SECRET;

if (!hasSlack && !hasFeishu) {
	console.error("No platform credentials found.");
	console.error("");
	console.error("Set environment variables for at least one platform:");
	console.error("  Slack:  MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	console.error("  Feishu: FEISHU_APP_ID, FEISHU_APP_SECRET");
	process.exit(1);
}

const adapters: PlatformAdapter[] = [];
const shutdownHandlers: Array<() => Promise<void>> = [];

// Start Slack if credentials available
if (hasSlack) {
	const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN });
	const slackHandler = createSlackHandler(MOM_SLACK_BOT_TOKEN!);

	const slack = new SlackBotClass(slackHandler, {
		appToken: MOM_SLACK_APP_TOKEN!,
		botToken: MOM_SLACK_BOT_TOKEN!,
		workingDir,
		store: sharedStore,
	});

	adapters.push(slack as unknown as PlatformAdapter);
	shutdownHandlers.push(() => slack.stop());

	log.logInfo("Platform: Slack (enabled)");
}

// Start Feishu if credentials available
if (hasFeishu) {
	const { FeishuBot } = await import("./feishu.js");
	const sharedStore = new ChannelStore({ workingDir });

	const feishu = new FeishuBot(createPlatformHandler(), {
		feishuConfig: {
			appId: FEISHU_APP_ID!,
			appSecret: FEISHU_APP_SECRET!,
			domain: FEISHU_DOMAIN,
		},
		workingDir,
		store: sharedStore,
	});

	adapters.push(feishu);
	shutdownHandlers.push(() => feishu.stop());

	log.logInfo(`Platform: Feishu (enabled, domain: ${FEISHU_DOMAIN})`);
}

log.logInfo(`Total platforms: ${adapters.length}`);

// Create event router for multi-platform support
const eventRouter = adapters.length === 1 ? adapters[0] : createMultiPlatformRouter(adapters);

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, eventRouter);
eventsWatcher.start();

// Handle shutdown
const shutdown = async () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	for (const handler of shutdownHandlers) {
		await handler();
	}
	process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start all adapters
await Promise.all(adapters.map((a) => a.start()));
