// The community's projects and likes, kept in one JSON file.
//
// Deliberately small: one process, one file, written atomically (a temporary
// file renamed over the old one, so a crash mid-write leaves the previous
// version rather than half of a new one), debounced so a burst of likes is one
// write. That is the right size for this service, which runs as a single
// instance — and it is honest about its one real limit: the file lives where
// COMMUNITY_DATA_DIR says, and on a host whose disk is replaced at every
// deploy, posts published since the last deploy go with it. The built-in
// projects come back regardless, because they ship with the code.
//
// Likes are kept as hashes of an anonymous per-browser id, salted with a
// secret that never leaves the server, so the file does not hold anything that
// identifies a visitor and the same id cannot be correlated across instances.
// There are no accounts, so one person with several browsers can like twice;
// the rate limiter bounds how far that goes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommunityPreview } from './validate.js';

export interface CommunityPost {
  id: string;
  title: string;
  description: string;
  authorName: string;
  /** Published with the creator token. Never set from anything a client typed. */
  creator: boolean;
  tags: string[];
  board: string;
  boardId: string;
  partCount: number;
  preview: CommunityPreview;
  project: Record<string, unknown>;
  createdAt: string;
  /** Ships with the code rather than being published through the API. */
  builtIn?: boolean;
  /** Added to the likes recorded here. Zero for everything published through the API. */
  baseLikes: number;
  /** Salted hashes of the anonymous ids that liked it. */
  likers: string[];
  /** Hash of the token that lets the publisher delete it. */
  deleteTokenHash?: string;
}

/** What a list or a card shows. No project body, no likers, no secrets. */
export interface CommunitySummary {
  id: string;
  title: string;
  description: string;
  authorName: string;
  creator: boolean;
  tags: string[];
  board: string;
  boardId: string;
  partCount: number;
  preview: CommunityPreview;
  createdAt: string;
  likes: number;
  liked: boolean;
}

interface StoreFile {
  version: 1;
  salt: string;
  posts: CommunityPost[];
}

export const MAX_POSTS = 5000;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Constant-time comparison of two secrets of any length. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(x, y);
}

export class CommunityStore {
  private posts = new Map<string, CommunityPost>();
  private salt = '';
  private writeTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string | null,
    private readonly builtIns: CommunityPost[] = [],
  ) {}

  async load(): Promise<void> {
    let stored: StoreFile | null = null;
    if (this.file && existsSync(this.file)) {
      try {
        stored = JSON.parse(await readFile(this.file, 'utf8')) as StoreFile;
      } catch (err) {
        console.error('[CircuitDesk] community store is unreadable; starting from the built-in projects:', err);
      }
    }
    this.salt = stored?.salt || process.env.COMMUNITY_SALT || randomBytes(24).toString('hex');
    for (const post of stored?.posts ?? []) this.posts.set(post.id, post);
    // Built-in projects ship with the code, so their text is the code's: one
    // already in the file keeps the likes it has gathered, and takes everything
    // else from the current built-in file.
    for (const post of this.builtIns) {
      const existing = this.posts.get(post.id);
      this.posts.set(post.id, { ...post, likers: existing?.likers ?? [] });
    }
    this.scheduleWrite();
  }

  private hashClient(clientId: string): string {
    return sha256(`${this.salt}:${clientId}`);
  }

  summary(post: CommunityPost, clientId?: string): CommunitySummary {
    const me = clientId ? this.hashClient(clientId) : null;
    return {
      id: post.id,
      title: post.title,
      description: post.description,
      authorName: post.authorName,
      creator: post.creator,
      tags: post.tags,
      board: post.board,
      boardId: post.boardId,
      partCount: post.partCount,
      preview: post.preview,
      createdAt: post.createdAt,
      likes: post.baseLikes + post.likers.length,
      liked: me !== null && post.likers.includes(me),
    };
  }

  list(opts: { sort: 'popular' | 'new'; q?: string; boardId?: string; creatorOnly?: boolean; clientId?: string; limit: number; offset: number }): {
    total: number;
    items: CommunitySummary[];
  } {
    const q = opts.q?.trim().toLowerCase() ?? '';
    let posts = [...this.posts.values()];
    if (q) {
      posts = posts.filter((p) =>
        [p.title, p.description, p.authorName, p.board, ...p.tags].some((s) => s.toLowerCase().includes(q)),
      );
    }
    if (opts.boardId) posts = posts.filter((p) => p.boardId === opts.boardId);
    if (opts.creatorOnly) posts = posts.filter((p) => p.creator);
    const likes = (p: CommunityPost) => p.baseLikes + p.likers.length;
    posts.sort((a, b) =>
      opts.sort === 'new'
        ? b.createdAt.localeCompare(a.createdAt)
        : likes(b) - likes(a) || b.createdAt.localeCompare(a.createdAt),
    );
    return {
      total: posts.length,
      items: posts.slice(opts.offset, opts.offset + opts.limit).map((p) => this.summary(p, opts.clientId)),
    };
  }

  get(id: string): CommunityPost | undefined {
    return this.posts.get(id);
  }

  get size(): number {
    return this.posts.size;
  }

  /** Adds a post. Returns it with the plaintext delete token, which is shown once. */
  publish(post: Omit<CommunityPost, 'id' | 'createdAt' | 'likers' | 'baseLikes' | 'deleteTokenHash'>): {
    post: CommunityPost;
    deleteToken: string;
  } {
    if (this.posts.size >= MAX_POSTS) throw new Error('COMMUNITY_FULL');
    const id = `cp_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
    const deleteToken = randomBytes(24).toString('hex');
    const full: CommunityPost = {
      ...post,
      id,
      createdAt: new Date().toISOString(),
      baseLikes: 0,
      likers: [],
      deleteTokenHash: sha256(deleteToken),
    };
    this.posts.set(id, full);
    this.scheduleWrite();
    return { post: full, deleteToken };
  }

  /** Sets whether this anonymous id likes the post. Idempotent either way. */
  setLike(id: string, clientId: string, liked: boolean): CommunitySummary | undefined {
    const post = this.posts.get(id);
    if (!post) return undefined;
    const me = this.hashClient(clientId);
    const has = post.likers.includes(me);
    if (liked && !has) post.likers.push(me);
    if (!liked && has) post.likers = post.likers.filter((h) => h !== me);
    if (liked !== has) this.scheduleWrite();
    return this.summary(post, clientId);
  }

  /** Removes a post if the token is the one issued when it was published. */
  remove(id: string, deleteToken: string): 'removed' | 'not-found' | 'forbidden' {
    const post = this.posts.get(id);
    if (!post) return 'not-found';
    if (!post.deleteTokenHash || !sameSecret(sha256(deleteToken), post.deleteTokenHash)) return 'forbidden';
    this.posts.delete(id);
    this.scheduleWrite();
    return 'removed';
  }

  private scheduleWrite(): void {
    if (!this.file) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writing = this.writing.then(() => this.writeNow()).catch((err) => {
        console.error('[CircuitDesk] community store write failed:', err);
      });
    }, 300);
    this.writeTimer.unref?.();
  }

  /** Writes now; resolves once the file is on disk. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
      this.writing = this.writing.then(() => this.writeNow());
    }
    await this.writing;
  }

  private async writeNow(): Promise<void> {
    if (!this.file) return;
    const body: StoreFile = { version: 1, salt: this.salt, posts: [...this.posts.values()] };
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(body), 'utf8');
    await rename(tmp, this.file);
  }
}
