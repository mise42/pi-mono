/**
 * Platform abstraction layer for multi-platform support.
 *
 * This module defines interfaces that abstract away platform-specific details,
 * allowing pi-mom to work with Slack, Feishu, and other messaging platforms.
 */

// ============================================================================
// Message Context
// ============================================================================

/** Attachment that has been downloaded to local storage */
export interface LocalAttachment {
	local: string;
}

/** Incoming message from any platform */
export interface PlatformMessage {
	/** Platform-specific chat/channel ID */
	chatId: string;
	/** Platform-specific message ID */
	messageId: string;
	/** Sender's platform-specific ID */
	senderId: string;
	/** Sender's display name (if available) */
	senderName?: string;
	/** Chat type */
	chatType: "dm" | "group";
	/** Message text content (with bot mentions stripped) */
	content: string;
	/** Raw message text (before processing) */
	rawContent?: string;
	/** Downloaded attachments */
	attachments?: LocalAttachment[];
	/** Whether the bot was explicitly mentioned */
	mentionedBot: boolean;
	/** Parent message ID for replies/threads */
	replyToMessageId?: string;
	/** Message timestamp (platform-specific format) */
	timestamp: string;
}

/** User info from the platform */
export interface PlatformUser {
	id: string;
	userName: string;
	displayName: string;
}

/** Channel/chat info from the platform */
export interface PlatformChannel {
	id: string;
	name: string;
}

// ============================================================================
// Reply Context (passed to AgentRunner)
// ============================================================================

/**
 * Context for replying to a message.
 * This is the interface that AgentRunner uses to send responses.
 */
export interface PlatformReplyContext {
	/** The incoming message that triggered this response */
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: LocalAttachment[];
	};

	/** Channel name (for logging) */
	channelName?: string;

	/** All channels the bot is in */
	channels: PlatformChannel[];

	/** All users in the workspace */
	users: PlatformUser[];

	/**
	 * Append text to the main response message.
	 * Creates the message if it doesn't exist.
	 * @param text Text to append
	 * @param shouldLog Whether to log this to the channel's log.jsonl
	 */
	respond(text: string, shouldLog?: boolean): Promise<void>;

	/**
	 * Replace the entire main response message.
	 * @param text New message text
	 */
	replaceMessage(text: string): Promise<void>;

	/**
	 * Post a message in the thread (for tool details, etc.)
	 * @param text Thread message text
	 */
	respondInThread(text: string): Promise<void>;

	/**
	 * Set typing indicator state.
	 * @param isTyping Whether to show typing indicator
	 */
	setTyping(isTyping: boolean): Promise<void>;

	/**
	 * Upload a file to the chat.
	 * @param filePath Local file path
	 * @param title Optional title for the file
	 */
	uploadFile(filePath: string, title?: string): Promise<void>;

	/**
	 * Set working indicator (e.g., "..." suffix).
	 * @param working Whether to show working indicator
	 */
	setWorking(working: boolean): Promise<void>;

	/**
	 * Delete the main response message and its thread.
	 * Used for [SILENT] responses.
	 */
	deleteMessage(): Promise<void>;
}

// ============================================================================
// Event Types
// ============================================================================

/** Event that triggers the bot */
export interface PlatformEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url?: string }>;
	/** Processed attachments with local paths */
	attachments?: LocalAttachment[];
}

// ============================================================================
// Platform Adapter
// ============================================================================

/** Handler interface that platforms call when events occur */
export interface PlatformHandler {
	/** Check if channel is currently processing (sync) */
	isRunning(channelId: string): boolean;

	/** Handle an incoming event (async) */
	handleEvent(event: PlatformEvent, platform: PlatformAdapter, isScheduledEvent?: boolean): Promise<void>;

	/** Handle stop command (async) */
	handleStop(channelId: string, platform: PlatformAdapter): Promise<void>;
}

/**
 * Platform adapter interface.
 * Each platform (Slack, Feishu, etc.) implements this interface.
 */
export interface PlatformAdapter {
	/** Platform identifier */
	readonly platformId: "slack" | "feishu";

	/** Start the platform connection */
	start(): Promise<void>;

	/** Stop the platform connection */
	stop(): Promise<void>;

	/**
	 * Whether the platform supports native thread/reply folding.
	 * If true, tool details are posted as thread replies (like Slack).
	 * If false, tool details are silently skipped to avoid cluttering the chat.
	 */
	readonly supportsThreads: boolean;

	/** Get a user by ID */
	getUser(userId: string): PlatformUser | undefined;

	/** Get a channel by ID */
	getChannel(channelId: string): PlatformChannel | undefined;

	/** Get all users */
	getAllUsers(): PlatformUser[];

	/** Get all channels the bot is in */
	getAllChannels(): PlatformChannel[];

	/** Post a new message to a channel */
	postMessage(channel: string, text: string): Promise<string>;

	/** Update an existing message */
	updateMessage(channel: string, messageId: string, text: string): Promise<void>;

	/** Delete a message */
	deleteMessage(channel: string, messageId: string): Promise<void>;

	/** Post a message in a thread */
	postInThread(channel: string, threadId: string, text: string): Promise<string>;

	/** Upload a file to a channel */
	uploadFile(channel: string, filePath: string, title?: string): Promise<void>;

	/** Log a message to the channel's log.jsonl */
	logToFile(channel: string, entry: object): void;

	/** Log a bot response */
	logBotResponse(channel: string, text: string, ts: string): void;

	/** Enqueue a scheduled event */
	enqueueEvent(event: PlatformEvent): boolean;
}

// ============================================================================
// Platform-specific formatting
// ============================================================================

/** Platform-specific text formatting hints for system prompts */
export interface PlatformFormatHints {
	/** Platform name for system prompt */
	name: string;
	/** Bold text syntax */
	bold: string;
	/** Italic text syntax */
	italic: string;
	/** Inline code syntax */
	code: string;
	/** Code block syntax */
	codeBlock: string;
	/** Link syntax */
	link: string;
	/** User mention syntax (with {userId} placeholder) */
	mention: string;
	/** Additional formatting notes */
	notes?: string[];
}

/** Slack formatting */
export const SLACK_FORMAT_HINTS: PlatformFormatHints = {
	name: "Slack",
	bold: "*text*",
	italic: "_text_",
	code: "`code`",
	codeBlock: "```code```",
	link: "<url|text>",
	mention: "<@{userId}>",
	notes: [
		"Use mrkdwn format, NOT standard Markdown.",
		"Do NOT use **double asterisks** for bold.",
		"Do NOT use [markdown](links) for links.",
	],
};

/** Feishu/Lark formatting */
export const FEISHU_FORMAT_HINTS: PlatformFormatHints = {
	name: "Feishu",
	bold: "**text**",
	italic: "*text*",
	code: "`code`",
	codeBlock: "```code```",
	link: "[text](url)",
	mention: "<at id={userId}></at>",
	notes: ["Use standard Markdown format.", "Feishu supports rich text cards for complex formatting."],
};

/** Get format hints for a platform */
export function getPlatformFormatHints(platformId: "slack" | "feishu"): PlatformFormatHints {
	switch (platformId) {
		case "feishu":
			return FEISHU_FORMAT_HINTS;
		default:
			return SLACK_FORMAT_HINTS;
	}
}
