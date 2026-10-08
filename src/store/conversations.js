/**
 * Conversation storage in a single JSON file. No database to install, and the file is
 * small enough for personal use. Writes are atomic (temp file + rename) and serialized.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_MESSAGES = 300;

export class ConversationStore {
  constructor({ filePath, maxConversations = 200, logger }) {
    this.filePath = filePath;
    this.maxConversations = maxConversations;
    this.logger = logger;
    this.conversations = new Map();
    this.queue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return this;
      throw err;
    }
    try {
      const data = JSON.parse(raw);
      for (const c of data.conversations ?? []) {
        if (c && typeof c.id === 'string') this.conversations.set(c.id, c);
      }
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup).catch(() => {});
      this.logger?.warn('Conversation file was unreadable; moved it aside', { backup: path.basename(backup) });
    }
    return this;
  }

  list() {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length }));
  }

  get(id) {
    return this.conversations.get(id) ?? null;
  }

  async create(title = 'New research') {
    const now = new Date().toISOString();
    const conv = { id: randomUUID(), title: cleanTitle(title), createdAt: now, updatedAt: now, messages: [] };
    this.conversations.set(conv.id, conv);
    this.pruneOld();
    await this.save();
    return conv;
  }

  async appendMessages(id, messages) {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    conv.messages.push(...messages);
    if (conv.messages.length > MAX_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_MESSAGES);
    conv.updatedAt = new Date().toISOString();
    await this.save();
    return conv;
  }

  async rename(id, title) {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    conv.title = cleanTitle(title);
    await this.save();
    return conv;
  }

  async delete(id) {
    const existed = this.conversations.delete(id);
    if (existed) await this.save();
    return existed;
  }

  pruneOld() {
    if (this.conversations.size <= this.maxConversations) return;
    const oldest = [...this.conversations.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const c of oldest.slice(0, this.conversations.size - this.maxConversations)) this.conversations.delete(c.id);
  }

  save() {
    // Serialize writes so concurrent requests cannot interleave file operations.
    this.queue = this.queue.then(async () => {
      const payload = JSON.stringify({ version: 1, conversations: [...this.conversations.values()] }, null, 2);
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, payload, { mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    });
    return this.queue;
  }
}

function cleanTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t || 'New research';
}
