/**
 * Feishu/Lark platform adapter for pi-mom.
 *
 * This module provides Feishu integration using the official Lark SDK.
 * It implements the PlatformAdapter interface for seamless multi-platform support.
 *
 * References:
 * - Lark SDK: https://github.com/larksuite/node-sdk
 * - clawdbot-feishu: https://github.com/m1heng/clawdbot-feishu
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import type {
	LocalAttachment,
	PlatformAdapter,
	PlatformChannel,
	PlatformEvent,
	PlatformHandler,
	PlatformUser,
} from "./platform.js";
import type { ChannelStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface FeishuConfig {
	appId: string;
	appSecret: string;
	/** "feishu" for China, "lark" for international */
	domain?: "feishu" | "lark";
	/** Encryption key for webhook mode */
	encryptKey?: string;
	/** Verification token for webhook mode */
	verificationToken?: string;
}

interface FeishuMessageEvent {
	sender: {
		sender_id: {
			open_id?: string;
			user_id?: string;
			union_id?: string;
		};
		sender_type?: string;
		tenant_key?: string;
	};
	message: {
		message_id: string;
		root_id?: string;
		parent_id?: string;
		chat_id: string;
		chat_type: "p2p" | "group";
		message_type: string;
		content: string;
		mentions?: Array<{
			key: string;
			id: {
				open_id?: string;
				user_id?: string;
				union_id?: string;
			};
			name: string;
			tenant_key?: string;
		}>;
	};
}

// ============================================================================
// Message Parsing (adapted from clawdbot-feishu/src/bot.ts)
// ============================================================================

function parseMessageContent(content: string, messageType: string): string {
	try {
		const parsed = JSON.parse(content);
		if (messageType === "text") {
			return parsed.text || "";
		}
		if (messageType === "post") {
			return parsePostContent(content);
		}
		return content;
	} catch {
		return content;
	}
}

function parsePostContent(content: string): string {
	try {
		const parsed = JSON.parse(content);
		const title = parsed.title || "";
		const contentBlocks = parsed.content || [];
		let textContent = title ? `${title}\n\n` : "";

		for (const paragraph of contentBlocks) {
			if (Array.isArray(paragraph)) {
				for (const element of paragraph) {
					if (element.tag === "text") {
						textContent += element.text || "";
					} else if (element.tag === "a") {
						textContent += element.text || element.href || "";
					} else if (element.tag === "at") {
						textContent += `@${element.user_name || element.user_id || ""}`;
					}
				}
				textContent += "\n";
			}
		}

		return textContent.trim() || "[富文本消息]";
	} catch {
		return "[富文本消息]";
	}
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
	const mentions = event.message.mentions ?? [];
	if (mentions.length === 0) return false;
	if (!botOpenId) return mentions.length > 0;
	return mentions.some((m) => m.id.open_id === botOpenId);
}

function stripBotMention(text: string, mentions?: FeishuMessageEvent["message"]["mentions"]): string {
	if (!mentions || mentions.length === 0) return text;
	let result = text;
	for (const mention of mentions) {
		result = result.replace(new RegExp(`@${mention.name}\\s*`, "g"), "").trim();
		result = result.replace(new RegExp(mention.key, "g"), "").trim();
	}
	return result;
}

// ============================================================================
// Sender Name Resolution (adapted from clawdbot-feishu/src/bot.ts)
// ============================================================================

const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

async function resolveFeishuSenderName(client: Lark.Client, senderOpenId: string): Promise<string | undefined> {
	if (!senderOpenId) return undefined;

	const cached = senderNameCache.get(senderOpenId);
	const now = Date.now();
	if (cached && cached.expireAt > now) return cached.name;

	try {
		const res = await client.contact.user.get({
			path: { user_id: senderOpenId },
			params: { user_id_type: "open_id" },
		});

		const data = res?.data as
			| { user?: { name?: string; display_name?: string; nickname?: string; en_name?: string } }
			| undefined;
		const name = data?.user?.name || data?.user?.display_name || data?.user?.nickname || data?.user?.en_name;

		if (name && typeof name === "string") {
			senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
			return name;
		}

		return undefined;
	} catch (err) {
		log.logWarning(`Failed to resolve Feishu sender name for ${senderOpenId}`, String(err));
		return undefined;
	}
}

// ============================================================================
// FeishuBot Class
// ============================================================================

export class FeishuBot implements PlatformAdapter {
	readonly platformId = "feishu" as const;

	private config: FeishuConfig;
	private handler: PlatformHandler;
	private workingDir: string;
	private store: ChannelStore;

	private client: Lark.Client;
	private wsClient: Lark.WSClient | null = null;
	private botOpenId: string | undefined;

	private users = new Map<string, PlatformUser>();
	private channels = new Map<string, PlatformChannel>();

	constructor(
		handler: PlatformHandler,
		config: {
			feishuConfig: FeishuConfig;
			workingDir: string;
			store: ChannelStore;
		},
	) {
		this.handler = handler;
		this.config = config.feishuConfig;
		this.workingDir = config.workingDir;
		this.store = config.store;

		const domain = this.config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

		this.client = new Lark.Client({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			appType: Lark.AppType.SelfBuild,
			domain,
		});
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		// Fetch bot info
		this.botOpenId = await this.fetchBotOpenId();
		log.logInfo(`Feishu bot open_id: ${this.botOpenId ?? "unknown"}`);

		// Fetch users and channels (best effort)
		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} chats, ${this.users.size} users`);

		// Create WebSocket client
		const domain = this.config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
		this.wsClient = new Lark.WSClient({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			domain,
			loggerLevel: Lark.LoggerLevel.info,
		});

		// Create event dispatcher
		const eventDispatcher = new Lark.EventDispatcher({
			encryptKey: this.config.encryptKey,
			verificationToken: this.config.verificationToken,
		});

		// Register message handler
		eventDispatcher.register({
			"im.message.receive_v1": async (data) => {
				try {
					await this.handleMessage(data as unknown as FeishuMessageEvent);
				} catch (err) {
					log.logWarning("Feishu message handling error", String(err));
				}
			},
			"im.message.message_read_v1": async () => {
				// Ignore read receipts
			},
			"im.chat.member.bot.added_v1": async (data) => {
				const event = data as unknown as { chat_id: string };
				log.logInfo(`Feishu bot added to chat ${event.chat_id}`);
				// Refresh channels list
				await this.fetchChannels();
			},
			"im.chat.member.bot.deleted_v1": async (data) => {
				const event = data as unknown as { chat_id: string };
				log.logInfo(`Feishu bot removed from chat ${event.chat_id}`);
				this.channels.delete(event.chat_id);
			},
		});

		// Start WebSocket connection
		this.wsClient.start({ eventDispatcher });

		log.logConnected();
	}

	async stop(): Promise<void> {
		this.wsClient = null;
		log.logInfo("Feishu bot stopped");
	}

	getUser(userId: string): PlatformUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): PlatformChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): PlatformUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): PlatformChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const receiveIdType = channel.startsWith("ou_") ? "open_id" : "chat_id";
		const content = JSON.stringify({ text });

		const response = await this.client.im.message.create({
			params: { receive_id_type: receiveIdType },
			data: {
				receive_id: channel,
				content,
				msg_type: "text",
			},
		});

		if (response.code !== 0) {
			throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
		}

		return response.data?.message_id ?? "unknown";
	}

	async updateMessage(_channel: string, messageId: string, text: string): Promise<void> {
		const content = JSON.stringify({ text });

		const response = await this.client.im.message.update({
			path: { message_id: messageId },
			data: {
				msg_type: "text",
				content,
			},
		});

		if (response.code !== 0) {
			throw new Error(`Feishu update failed: ${response.msg || `code ${response.code}`}`);
		}
	}

	async deleteMessage(_channel: string, messageId: string): Promise<void> {
		const response = await this.client.im.message.delete({
			path: { message_id: messageId },
		});

		if (response.code !== 0) {
			throw new Error(`Feishu delete failed: ${response.msg || `code ${response.code}`}`);
		}
	}

	async postInThread(_channel: string, threadId: string, text: string): Promise<string> {
		// Feishu threads are handled via reply
		const content = JSON.stringify({ text });

		const response = await this.client.im.message.reply({
			path: { message_id: threadId },
			data: {
				content,
				msg_type: "text",
			},
		});

		if (response.code !== 0) {
			throw new Error(`Feishu reply failed: ${response.msg || `code ${response.code}`}`);
		}

		return response.data?.message_id ?? "unknown";
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);

		// First upload the file
		const uploadResponse = (await this.client.im.file.create({
			data: {
				file_type: "stream",
				file_name: fileName,
				file: Buffer.from(fileContent),
			},
		})) as { code?: number; msg?: string; data?: { file_key?: string } } | null;

		if (!uploadResponse || uploadResponse.code !== 0) {
			throw new Error(`Feishu file upload failed: ${uploadResponse?.msg || `code ${uploadResponse?.code}`}`);
		}

		const fileKey = uploadResponse.data?.file_key;
		if (!fileKey) {
			throw new Error("Feishu file upload returned no file_key");
		}

		// Then send as file message
		const receiveIdType = channel.startsWith("ou_") ? "open_id" : "chat_id";
		const content = JSON.stringify({ file_key: fileKey });

		const sendResponse = await this.client.im.message.create({
			params: { receive_id_type: receiveIdType },
			data: {
				receive_id: channel,
				content,
				msg_type: "file",
			},
		});

		if (sendResponse.code !== 0) {
			throw new Error(`Feishu file send failed: ${sendResponse.msg || `code ${sendResponse.code}`}`);
		}
	}

	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	enqueueEvent(event: PlatformEvent): boolean {
		// Delegate to handler
		log.logInfo(`Enqueueing Feishu event for ${event.channel}: ${event.text.substring(0, 50)}`);
		this.handler.handleEvent(event, this, true).catch((err) => {
			log.logWarning("Failed to handle enqueued event", String(err));
		});
		return true;
	}

	// ==========================================================================
	// Private - Message Handling
	// ==========================================================================

	private async handleMessage(event: FeishuMessageEvent): Promise<void> {
		const senderOpenId = event.sender.sender_id.open_id || "";
		const chatId = event.message.chat_id;
		const isDM = event.message.chat_type === "p2p";

		// Parse message content
		const rawContent = parseMessageContent(event.message.content, event.message.message_type);
		const mentionedBot = checkBotMentioned(event, this.botOpenId);
		const content = stripBotMention(rawContent, event.message.mentions);

		// Resolve sender name
		const senderName = await resolveFeishuSenderName(this.client, senderOpenId);

		log.logInfo(
			`Feishu: received message from ${senderName || senderOpenId} in ${chatId} (${event.message.chat_type})`,
		);

		// For group chats, only respond if mentioned
		if (!isDM && !mentionedBot) {
			log.logInfo(`Feishu: message in group ${chatId} did not mention bot, logging only`);
			this.logUserMessage(event, content, senderOpenId, senderName);
			return;
		}

		// Log the message
		const attachments = this.logUserMessage(event, content, senderOpenId, senderName);

		// Check for stop command
		if (content.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(chatId)) {
				this.handler.handleStop(chatId, this);
			} else {
				this.postMessage(chatId, "_Nothing running_").catch((err) =>
					log.logWarning("Failed to post stop response", String(err)),
				);
			}
			return;
		}

		// Check if busy
		if (this.handler.isRunning(chatId)) {
			this.postMessage(chatId, "_Already working. Say `stop` to cancel._").catch((err) =>
				log.logWarning("Failed to post busy response", String(err)),
			);
			return;
		}

		// Create platform event
		const platformEvent: PlatformEvent = {
			type: isDM ? "dm" : "mention",
			channel: chatId,
			ts: event.message.message_id,
			user: senderOpenId,
			text: content,
			attachments,
		};

		// Handle the event
		await this.handler.handleEvent(platformEvent, this);
	}

	private logUserMessage(
		event: FeishuMessageEvent,
		content: string,
		senderOpenId: string,
		senderName?: string,
	): LocalAttachment[] {
		const chatId = event.message.chat_id;

		// TODO: Download attachments for image/file messages
		const attachments: LocalAttachment[] = [];

		this.logToFile(chatId, {
			date: new Date().toISOString(),
			ts: event.message.message_id,
			user: senderOpenId,
			userName: senderName,
			text: content,
			attachments,
			isBot: false,
		});

		return attachments;
	}

	// ==========================================================================
	// Private - Initialization
	// ==========================================================================

	private async fetchBotOpenId(): Promise<string | undefined> {
		try {
			// Use raw request API since bot.botInfo is not always available in SDK
			const response = (await (this.client as any).request({
				method: "GET",
				url: "/open-apis/bot/v3/info",
				data: {},
			})) as { code?: number; bot?: { open_id?: string }; data?: { bot?: { open_id?: string } } };

			if (response.code !== 0) {
				return undefined;
			}

			const bot = response.bot || response.data?.bot;
			return bot?.open_id;
		} catch (err) {
			log.logWarning("Failed to fetch Feishu bot info", String(err));
			return undefined;
		}
	}

	private async fetchUsers(): Promise<void> {
		// Feishu requires tenant-level permissions to list all users
		// For now, we cache users as we encounter them
		// This is a best-effort implementation
		try {
			let pageToken: string | undefined;
			do {
				const response = await this.client.contact.user.list({
					params: {
						page_size: 100,
						page_token: pageToken,
					},
				});

				const data = response?.data as
					| {
							items?: Array<{ user_id?: string; open_id?: string; name?: string; en_name?: string }>;
							page_token?: string;
							has_more?: boolean;
					  }
					| undefined;

				if (data?.items) {
					for (const user of data.items) {
						if (user.open_id) {
							this.users.set(user.open_id, {
								id: user.open_id,
								userName: user.name || user.en_name || user.open_id,
								displayName: user.name || user.en_name || user.open_id,
							});
						}
					}
				}

				pageToken = data?.has_more ? data?.page_token : undefined;
			} while (pageToken);
		} catch (err) {
			// This often fails due to permission issues, which is fine
			log.logInfo(`Feishu user list not available (may need additional permissions): ${String(err)}`);
		}
	}

	private async fetchChannels(): Promise<void> {
		try {
			let pageToken: string | undefined;
			do {
				const response = await this.client.im.chat.list({
					params: {
						page_size: 100,
						page_token: pageToken,
					},
				});

				const data = response?.data as
					| {
							items?: Array<{ chat_id?: string; name?: string; chat_mode?: string }>;
							page_token?: string;
							has_more?: boolean;
					  }
					| undefined;

				if (data?.items) {
					for (const chat of data.items) {
						if (chat.chat_id) {
							const chatType = chat.chat_mode === "p2p" ? "DM" : "Group";
							this.channels.set(chat.chat_id, {
								id: chat.chat_id,
								name: chat.name || `${chatType}:${chat.chat_id}`,
							});
						}
					}
				}

				pageToken = data?.has_more ? data?.page_token : undefined;
			} while (pageToken);
		} catch (err) {
			log.logWarning("Failed to fetch Feishu chat list", String(err));
		}
	}
}
