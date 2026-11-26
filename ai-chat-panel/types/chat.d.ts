// Shared shapes for the chat snapshot the extension host keeps on disk and sends to the window (TS-01).
// Declarations only: nothing here exists at runtime. JavaScript files opt in with `// @ts-check` and
// `@typedef {import('../types/chat').Chat} Chat`. Fields the code does not rely on stay open (`[key: string]: unknown`),
// because snapshots written by older versions carry extra data that must round-trip untouched.

/** A tool output stored apart from the snapshot (see lib/tool-output-store.js). */
export interface ToolOutputRef { sha256: string; bytes: number }

export interface ToolEvent {
  name?: string;
  file?: string;
  toolId?: string;
  output?: string;
  outputBlob?: ToolOutputRef;
  startedAt?: number;
  durationMs?: number;
  done?: boolean;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | (string & {});
  text?: string;
  agent?: string;
  modelLabel?: string;
  /** ISO time the message was completed; a reply without it is still running (or was cut off). */
  at?: string;
  inProgress?: boolean;
  /** The extension host process that is writing an `inProgress` reply, so another IDE window can tell it is alive. */
  hostPid?: number;
  interrupted?: boolean;
  interruptionReason?: string;
  compact?: boolean;
  checkpoint?: boolean;
  /** Context resets this reply's turn went through without the Compact button (lib/context-reset.js), shown as dividers. */
  contextResets?: { kind: 'native' | 'session' | 'resume' | 'drop'; title: string; detail: string; at: string }[];
  contextHandoff?: { from: { agent: string; label: string }; to: { agent: string; label: string } };
  event?: ToolEvent;
  done?: boolean;
  [key: string]: unknown;
}

export interface QueuedTurn { id: string; text: string; [key: string]: unknown }

export interface Chat {
  id: string;
  messages: ChatMessage[];
  title?: string;
  customTitle?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  projectId?: string | null;
  draft?: string;
  draftAttachments?: string[];
  textEntered?: boolean;
  workContext?: unknown;
  turnQueue?: { turns?: QueuedTurn[]; paused?: boolean };
  telegramTopicId?: number;
  telegramChatId?: number;
  storageFormat?: string;
  [key: string]: unknown;
}

/** What Manage Chats shows for one saved chat (lib/chat-store.js, ChatStore.list). */
export interface ChatSummary {
  id: string;
  projectId: string | null;
  title: string;
  customTitle: boolean;
  lastMessage: { role: string; agent: string | null; modelLabel: string | null; text: string; at: string | null } | null;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  models: string[];
  latestAgent: string | null;
  messageCount: number;
  [key: string]: unknown;
}
