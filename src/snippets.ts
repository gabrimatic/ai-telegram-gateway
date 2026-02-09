/**
 * Snippet/bookmark system for saving and running frequently used commands
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { error } from "./logger";

export const SNIPPETS_PATH = `${process.env.HOME || require("os").homedir()}/.claude/gateway/snippets.json`;

export interface Snippet {
  name: string;
  content: string;
  createdAt: string;
}

export interface SnippetStore {
  snippets: Snippet[];
}

function ensureDir(): void {
  const dir = dirname(SNIPPETS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadSnippets(): SnippetStore {
  if (!existsSync(SNIPPETS_PATH)) {
    return { snippets: [] };
  }
  try {
    return JSON.parse(readFileSync(SNIPPETS_PATH, "utf-8")) as SnippetStore;
  } catch {
    return { snippets: [] };
  }
}

export function saveSnippets(store: SnippetStore): void {
  ensureDir();
  writeFileSync(SNIPPETS_PATH, JSON.stringify(store, null, 2));
}

export function getSnippet(name: string): Snippet | undefined {
  const store = loadSnippets();
  return store.snippets.find((s) => s.name === name);
}

export function addSnippet(name: string, content: string): void {
  const store = loadSnippets();
  const existing = store.snippets.findIndex((s) => s.name === name);
  const snippet: Snippet = {
    name,
    content,
    createdAt: new Date().toISOString(),
  };
  if (existing >= 0) {
    store.snippets[existing] = snippet;
  } else {
    store.snippets.push(snippet);
  }
  saveSnippets(store);
}

export function deleteSnippet(name: string): boolean {
  const store = loadSnippets();
  const idx = store.snippets.findIndex((s) => s.name === name);
  if (idx < 0) return false;
  store.snippets.splice(idx, 1);
  saveSnippets(store);
  return true;
}
