/**
 * Type definitions for the Telegram Gateway bot
 */

export interface Allowlist {
  allowedUsers: string[];
  pairingEnabled: boolean;
  pairingCode: string;
}

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

export interface TodoList {
  items: TodoItem[];
  nextId: number;
}

export interface NoteItem {
  id: number;
  text: string;
  createdAt: string;
}

export interface NotesList {
  items: NoteItem[];
  nextId: number;
}

export interface ReminderItem {
  id: number;
  text: string;
  triggerAt: string;
  userId: string;
  createdAt: string;
}

export interface RemindersList {
  items: ReminderItem[];
  nextId: number;
}
