/**
 * Passive topic registry - tracks Telegram forum topics from incoming messages
 * and service events since Telegram has no getForumTopics API.
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

interface TopicEntry {
  name: string;
  iconEmoji?: string;
  createdAt: string;
  updatedAt: string;
}

// chat_id -> thread_id -> TopicEntry
type RegistryData = Record<string, Record<string, TopicEntry>>;

const REGISTRY_PATH = join(homedir(), ".claude", "gateway", "topic-registry.json");

let cache: RegistryData | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function ensureLoaded(): RegistryData {
  if (cache !== null) return cache;
  try {
    if (existsSync(REGISTRY_PATH)) {
      cache = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache!;
}

function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dir = join(homedir(), ".claude", "gateway");
      mkdirSync(dir, { recursive: true });
      writeFileSync(REGISTRY_PATH, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
      // silent - best effort persistence
    }
  }, 2000);
}

export function registerTopic(chatId: number, threadId: number, name: string, iconEmoji?: string): void {
  const data = ensureLoaded();
  const chatKey = String(chatId);
  const threadKey = String(threadId);
  if (!data[chatKey]) data[chatKey] = {};
  const now = new Date().toISOString();
  const existing = data[chatKey][threadKey];
  data[chatKey][threadKey] = {
    name,
    ...(iconEmoji ? { iconEmoji } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  scheduleSave();
}

export function removeTopic(chatId: number, threadId: number): void {
  const data = ensureLoaded();
  const chatKey = String(chatId);
  const threadKey = String(threadId);
  if (data[chatKey]) {
    delete data[chatKey][threadKey];
    if (Object.keys(data[chatKey]).length === 0) {
      delete data[chatKey];
    }
    scheduleSave();
  }
}

export function getKnownTopics(chatId: number): Array<{ threadId: number; name: string; iconEmoji?: string }> {
  const data = ensureLoaded();
  const chatTopics = data[String(chatId)];
  if (!chatTopics) return [];
  return Object.entries(chatTopics).map(([threadKey, entry]) => ({
    threadId: Number(threadKey),
    name: entry.name,
    ...(entry.iconEmoji ? { iconEmoji: entry.iconEmoji } : {}),
  }));
}

export function formatTopicsForContext(chatId: number): string {
  const topics = getKnownTopics(chatId);
  if (topics.length === 0) return "";
  const parts = topics.map((t) => `#${t.threadId} "${t.name}"`);
  return `[Group topics: ${parts.join(", ")}]`;
}

export function registerTopicFromMessage(chatId: number, msg: any): void {
  if (!msg) return;

  // Service message: topic created
  if (msg.forum_topic_created && msg.message_thread_id) {
    registerTopic(
      chatId,
      msg.message_thread_id,
      msg.forum_topic_created.name,
      msg.forum_topic_created.icon_custom_emoji_id,
    );
    return;
  }

  // Service message: topic edited
  if (msg.forum_topic_edited && msg.message_thread_id) {
    const edited = msg.forum_topic_edited;
    if (edited.name) {
      registerTopic(
        chatId,
        msg.message_thread_id,
        edited.name,
        edited.icon_custom_emoji_id,
      );
    }
    return;
  }
}
