// The community's projects and likes, kept in one JSON file.
//
// Deliberately small: one process, one file, written atomically (a temporary
// file renamed over the old one, so a crash mid-write leaves the previous
// version rather than half of a new one), debounced so a burst of likes is one
// write, and flushed when the process is told to stop, so a deploy does not
// drop the last few seconds. That is the right size for this service, which
// runs as a single instance.
//
// Surviving a deploy is a matter of where the file lives: COMMUNITY_DATA_DIR
// has to be on a disk the deploy does not replace (on Render, an attached
// persistent disk — render.yaml mounts one). storageStatus() says whether the
// directory is on its own mounted volume, and the server reports that on
// /health and warns at startup when it is not. The built-in projects come
// back regardless, because they ship with the code.
//
// Likes are kept as hashes of an anonymous per-browser id, salted with a
// secret that never leaves the server, so the file does not hold anything that
// identifies a visitor and the same id cannot be correlated across instances.
// There are no accounts, so one person with several browsers can like twice;
// the rate limiter bounds how far that goes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanAuthor, cleanPreview, cleanProject, cleanTags, cleanText, CommunityInputError, LIMITS, type CommunityPreview } from './validate.js';

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

export interface StoreFile {
  version: 1;
  salt: string;
  posts: CommunityPost[];
}

/** Where the store keeps its file, and whether that is likely to survive a deploy. */
export interface StorageStatus {
  /** 'file' when posts are written to disk; 'memory' when nothing is kept. */
  mode: 'file' | 'memory';
  directory: string | null;
  /**
   * Whether the directory is on a volume mounted separately from the
   * container's own filesystem — what a persistent disk is. A host whose
   * whole disk persists reads false here; COMMUNITY_DISK_PERSISTENT=1 says so.
   */
  persistent: boolean;
  posts: number;
  publishedPosts: number;
  lastSavedAt: string | null;
  lastError: string | null;
}

/** The nearest directory that exists at or above `dir`. */
function existingAncestor(dir: string): string {
  let at = path.resolve(dir);
  while (!existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return at;
}

/** Whether `dir` sits on a different device from the root filesystem: a mounted volume. */
export function onMountedVolume(dir: string): boolean {
  try {
    return statSync(existingAncestor(dir)).dev !== statSync('/').dev;
  } catch {
    return false;
  }
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
  private lastSavedAt: string | null = null;
  private lastError: string | null = null;

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
    // Built-in posts come from the code, not from the file: one the code no
    // longer ships (renamed or removed) is dropped rather than kept forever.
    const shipped = new Set(this.builtIns.map((p) => p.id));
    for (const post of stored?.posts ?? []) {
      const fromCode = post.builtIn === true || (post as { seeded?: boolean }).seeded === true;
      if (fromCode && !shipped.has(post.id)) continue;
      this.posts.set(post.id, post);
    }
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
        this.lastError = err instanceof Error ? err.message : String(err);
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
    this.lastSavedAt = new Date().toISOString();
    this.lastError = null;
  }

  storageStatus(): StorageStatus {
    const directory = this.file ? path.dirname(this.file) : null;
    const asserted = process.env.COMMUNITY_DISK_PERSISTENT === '1';
    return {
      mode: this.file ? 'file' : 'memory',
      directory,
      persistent: directory !== null && (asserted || onMountedVolume(directory)),
      posts: this.posts.size,
      publishedPosts: [...this.posts.values()].filter((p) => !p.builtIn).length,
      lastSavedAt: this.lastSavedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Everything a restore needs: the salt, so likes keep matching the browsers
   * that gave them, and every published post with its likes and delete-token
   * hash. Built-in posts are left out — they come from the code — except for
   * the likes they have gathered.
   */
  exportData(): StoreFile {
    return {
      version: 1,
      salt: this.salt,
      posts: [...this.posts.values()].map((p) => (p.builtIn ? { ...p, project: {}, preview: p.preview } : p)),
    };
  }

  /**
   * Merges a backup in. Nothing is deleted: a post already here keeps its
   * content and gains the backup's likes; a post that is not is added, after
   * the same checks a publish goes through, so a backup file cannot carry in
   * what the API would refuse. When this store holds nothing published yet,
   * it adopts the backup's salt, so existing likes still recognise their
   * browsers. Returns how many posts were added and how many gained likes.
   */
  importData(data: unknown, creatorName: string): { added: number; merged: number; skipped: number } {
    const file = data as Partial<StoreFile> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.posts)) {
      throw new CommunityInputError('That is not a CircuitDesk community backup.');
    }
    const nothingPublished = ![...this.posts.values()].some((p) => !p.builtIn);
    if (nothingPublished && typeof file.salt === 'string' && /^[0-9a-f]{16,128}$/.test(file.salt)) {
      this.salt = file.salt;
    }
    let added = 0;
    let merged = 0;
    let skipped = 0;
    for (const raw of file.posts) {
      const incoming = raw as Partial<CommunityPost>;
      const likers = Array.isArray(incoming.likers)
        ? incoming.likers.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))
        : [];
      const existing = typeof incoming.id === 'string' ? this.posts.get(incoming.id) : undefined;
      if (existing) {
        const before = existing.likers.length;
        existing.likers = [...new Set([...existing.likers, ...likers])];
        if (existing.likers.length > before) merged++;
        continue;
      }
      if (incoming.builtIn) {
        skipped++; // a built-in the code no longer ships
        continue;
      }
      if (this.posts.size >= MAX_POSTS) throw new Error('COMMUNITY_FULL');
      try {
        if (typeof incoming.id !== 'string' || !/^cp_[0-9a-z]{6,40}$/.test(incoming.id)) {
          throw new CommunityInputError('bad id');
        }
        const createdAt = typeof incoming.createdAt === 'string' && !Number.isNaN(Date.parse(incoming.createdAt))
          ? new Date(incoming.createdAt).toISOString()
          : new Date().toISOString();
        const project = cleanProject(incoming.project);
        const boards = project.boardInstances as { definitionId?: unknown }[];
        const boardId = typeof boards[0]?.definitionId === 'string' ? boards[0].definitionId.slice(0, LIMITS.boardId) : '';
        const post: CommunityPost = {
          id: incoming.id,
          title: cleanText(incoming.title, LIMITS.title, 'Title'),
          description: cleanText(incoming.description, LIMITS.description, 'Description', { multiline: true }),
          authorName: cleanAuthor(incoming.authorName, incoming.creator === true, creatorName),
          creator: incoming.creator === true,
          tags: cleanTags(incoming.tags),
          board: cleanText(incoming.board, LIMITS.board, 'Board') || boardId,
          boardId,
          partCount:
            (project.boardInstances as unknown[]).length + ((project.componentInstances as unknown[] | undefined)?.length ?? 0),
          preview: cleanPreview(incoming.preview),
          project,
          createdAt,
          baseLikes: 0,
          likers,
          deleteTokenHash:
            typeof incoming.deleteTokenHash === 'string' && /^[0-9a-f]{64}$/.test(incoming.deleteTokenHash)
              ? incoming.deleteTokenHash
              : undefined,
        };
        this.posts.set(post.id, post);
        added++;
      } catch (err) {
        if (!(err instanceof CommunityInputError)) throw err;
        skipped++;
      }
    }
    if (added || merged) this.scheduleWrite();
    return { added, merged, skipped };
  }
}
