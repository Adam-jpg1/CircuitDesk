// The community's projects and likes, kept in Postgres.
//
// Everything lives in the database server/db/client.ts opens: a hosted
// Postgres in production (DATABASE_URL), so nothing published is lost when
// the service redeploys, restarts or sleeps. The built-in projects ship with
// the code and are written into the database at startup, keeping the likes
// they have gathered.
//
// Likes are rows keyed by (user, project) with that pair unique, so a second
// like from the same browser is refused by the database itself. Adding or
// removing the row and moving the project's like_count happen in one
// transaction, and the count moves with `like_count = like_count + 1` — a row
// lock, not a read in JavaScript followed by a write — so two people liking at
// once both count.
//
// There are no accounts. A "user" is an anonymous per-browser id, stored only
// as a hash salted with a secret kept in the database, so the tables hold
// nothing that identifies a visitor. One person with several browsers can
// like twice; the rate limiter bounds how far that goes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { and, asc, count, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { openDatabase, type Database, type Db } from '../db/client.js';
import { likes, projects, settings } from '../db/schema.js';
import { cleanAuthor, cleanPreview, cleanProject, cleanTags, cleanText, CommunityInputError, LIMITS, type CommunityPreview } from './validate.js';

/** A project as the code and backups describe it (builtin.json uses this shape). */
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
  /** Salted hashes of the anonymous ids that liked it (backups only). */
  likers: string[];
  /** Hash of the token that lets the publisher delete it. */
  deleteTokenHash?: string;
  /** Salted hash of the publishing browser's anonymous id. */
  authorId?: string;
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

/** A backup: the salt and every post with its likers. Same format as before the database. */
export interface StoreFile {
  version: 1;
  salt: string;
  posts: CommunityPost[];
}

export interface StorageStatus {
  /** 'postgres' with DATABASE_URL; 'pglite' on local disk; 'memory' when nothing is kept. */
  mode: 'postgres' | 'pglite' | 'memory';
  /** Database host and name, or the local directory. Never credentials. */
  location: string | null;
  /** Whether what is published outlives a deploy of this service. */
  persistent: boolean;
  posts: number;
  publishedPosts: number;
  lastError: string | null;
}

export type PublishInput = Omit<CommunityPost, 'id' | 'createdAt' | 'likers' | 'baseLikes' | 'deleteTokenHash' | 'builtIn'> & {
  /** The publishing browser's anonymous id, recorded only as a salted hash. */
  authorClientId?: string;
};

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

export { onMountedVolume } from '../db/client.js';

/** The database is not reachable or not ready; routes answer 503. */
export class StorageUnavailableError extends Error {}

const SALT_KEY = 'like_salt';
const LEGACY_IMPORTED_KEY = 'legacy_file_imported';
/** After a failed connection, how long before a request tries again. */
const RETRY_AFTER_MS = 5_000;

/** Postgres error code of a failure, through Drizzle's wrapper if there is one. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

/** Escapes LIKE wildcards so a search for "100%" matches literally. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface CommunityStoreOptions {
  builtIns?: CommunityPost[];
  /** How to reach the database. Defaults to openDatabase() (DATABASE_URL, else PGlite). */
  open?: () => Promise<Database>;
  /** A JSON store from before the database, imported once into an empty database. */
  legacyFile?: string | null;
}

export class CommunityStore {
  private database: Database | null = null;
  private opening: Promise<Database> | null = null;
  private failedAt = 0;
  private salt = '';
  private lastError: string | null = null;
  /** Counts for /health, which must answer without waking the database. */
  private cachedCounts = { posts: 0, publishedPosts: 0 };
  private readonly builtIns: CommunityPost[];
  private readonly open: () => Promise<Database>;
  private readonly legacyFile: string | null;

  constructor(options: CommunityStoreOptions = {}) {
    this.builtIns = options.builtIns ?? [];
    this.open = options.open ?? openDatabase;
    this.legacyFile = options.legacyFile ?? null;
  }

  /** Connects, migrates and seeds. Safe to call again after a failure. */
  async load(): Promise<void> {
    await this.ready();
  }

  /** The database, opened on first use; a failure is retried after a pause. */
  private async ready(): Promise<Db> {
    if (this.database) return this.database.db;
    if (!this.opening) {
      if (Date.now() - this.failedAt < RETRY_AFTER_MS && this.lastError) {
        throw new StorageUnavailableError(this.lastError);
      }
      this.opening = (async () => {
        const database = await this.open();
        try {
          await this.initialise(database.db);
        } catch (err) {
          await database.close().catch(() => {});
          throw err;
        }
        return database;
      })();
    }
    try {
      this.database = await this.opening;
      this.lastError = null;
      return this.database.db;
    } catch (err) {
      this.failedAt = Date.now();
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[CircuitDesk] community database unavailable:', this.lastError);
      throw new StorageUnavailableError(this.lastError);
    } finally {
      this.opening = null;
    }
  }

  private async initialise(db: Db): Promise<void> {
    // The like salt: made once, then the same for the life of the database.
    const initial = process.env.COMMUNITY_SALT || randomBytes(24).toString('hex');
    await db.insert(settings).values({ key: SALT_KEY, value: initial }).onConflictDoNothing();
    this.salt = (await db.select().from(settings).where(eq(settings.key, SALT_KEY)))[0].value;

    // Built-in projects come from the code: their text is the code's, their
    // likes are the database's, and one the code no longer ships is removed.
    await db.transaction(async (tx) => {
      for (const post of this.builtIns) {
        const values = {
          id: post.id,
          authorName: post.authorName,
          title: post.title,
          description: post.description,
          circuitData: post.project,
          preview: post.preview,
          tags: post.tags,
          board: post.board,
          boardId: post.boardId,
          partCount: post.partCount,
          creator: post.creator,
          builtIn: true,
          baseLikes: post.baseLikes ?? 0,
          createdAt: new Date(post.createdAt),
        };
        const { id: _id, ...update } = values;
        await tx
          .insert(projects)
          .values(values)
          .onConflictDoUpdate({ target: projects.id, set: { ...update, updatedAt: sql`now()` } });
      }
      const shipped = this.builtIns.map((p) => p.id);
      await tx
        .delete(projects)
        .where(shipped.length ? and(eq(projects.builtIn, true), notInArray(projects.id, shipped)) : eq(projects.builtIn, true));
    });

    await this.importLegacyFile(db);
    await this.refreshCounts(db);
  }

  /**
   * Before the database, the community was one JSON file. If one is still
   * there, its posts and likes are merged in — once, recorded in settings, so
   * a later deletion is never undone by the file coming back.
   */
  private async importLegacyFile(db: Db): Promise<void> {
    if (!this.legacyFile || !existsSync(this.legacyFile)) return;
    const done = await db.select().from(settings).where(eq(settings.key, LEGACY_IMPORTED_KEY));
    if (done.length) return;
    try {
      const data = JSON.parse(await readFile(this.legacyFile, 'utf8')) as unknown;
      const outcome = await this.importInto(db, data, process.env.CREATOR_NAME || 'Adam');
      console.log(`[CircuitDesk] imported the old community file: ${outcome.added} project(s), ${outcome.merged} with likes`);
    } catch (err) {
      console.error('[CircuitDesk] the old community file could not be imported:', err);
    }
    await db
      .insert(settings)
      .values({ key: LEGACY_IMPORTED_KEY, value: new Date().toISOString() })
      .onConflictDoNothing();
  }

  private async refreshCounts(db: Db): Promise<void> {
    const rows = await db
      .select({ builtIn: projects.builtIn, n: count() })
      .from(projects)
      .groupBy(projects.builtIn);
    const published = rows.find((r) => !r.builtIn)?.n ?? 0;
    const all = rows.reduce((sum, r) => sum + Number(r.n), 0);
    this.cachedCounts = { posts: all, publishedPosts: Number(published) };
  }

  private hashClient(clientId: string): string {
    return sha256(`${this.salt}:${clientId}`);
  }

  /** The columns a summary needs, with `liked` for one browser when given. */
  private summaryColumns(clientId?: string) {
    const me = clientId ? this.hashClient(clientId) : null;
    return {
      id: projects.id,
      title: projects.title,
      description: projects.description,
      authorName: projects.authorName,
      creator: projects.creator,
      tags: projects.tags,
      board: projects.board,
      boardId: projects.boardId,
      partCount: projects.partCount,
      preview: projects.preview,
      createdAt: projects.createdAt,
      likes: sql<number>`(${projects.baseLikes} + ${projects.likeCount})`.mapWith(Number),
      liked: me
        ? sql<boolean>`exists (select 1 from ${likes} where ${likes.projectId} = ${projects.id} and ${likes.userId} = ${me})`.mapWith(Boolean)
        : sql<boolean>`false`.mapWith(Boolean),
    };
  }

  private toSummary(row: {
    id: string; title: string; description: string; authorName: string; creator: boolean; tags: string[];
    board: string; boardId: string; partCount: number; preview: unknown; createdAt: Date; likes: number; liked: boolean;
  }): CommunitySummary {
    return { ...row, preview: row.preview as CommunityPreview, createdAt: iso(row.createdAt), likes: Number(row.likes), liked: Boolean(row.liked) };
  }

  async list(opts: { sort: 'popular' | 'new'; q?: string; boardId?: string; creatorOnly?: boolean; clientId?: string; limit: number; offset: number }): Promise<{
    total: number;
    items: CommunitySummary[];
  }> {
    const db = await this.ready();
    const where: SQL[] = [];
    const q = opts.q?.trim();
    if (q) {
      where.push(
        sql`(${projects.title} || ' ' || ${projects.description} || ' ' || ${projects.authorName} || ' ' || ${projects.board} || ' ' || ${projects.tags}::text) ilike ${likePattern(q)} escape '\\'`,
      );
    }
    if (opts.boardId) where.push(eq(projects.boardId, opts.boardId));
    if (opts.creatorOnly) where.push(eq(projects.creator, true));
    const filter = where.length ? and(...where) : undefined;
    const order =
      opts.sort === 'new'
        ? [desc(projects.createdAt), asc(projects.id)]
        : [desc(sql`${projects.baseLikes} + ${projects.likeCount}`), desc(projects.createdAt), asc(projects.id)];
    const [rows, [{ n }]] = await Promise.all([
      db.select(this.summaryColumns(opts.clientId)).from(projects).where(filter).orderBy(...order).limit(opts.limit).offset(opts.offset),
      db.select({ n: count() }).from(projects).where(filter),
    ]);
    return { total: Number(n), items: rows.map((r) => this.toSummary(r)) };
  }

  /** One project with its full circuit, or undefined. */
  async getProject(id: string, clientId?: string): Promise<{ item: CommunitySummary; project: Record<string, unknown> } | undefined> {
    const db = await this.ready();
    const [row] = await db
      .select({ ...this.summaryColumns(clientId), project: projects.circuitData })
      .from(projects)
      .where(eq(projects.id, id));
    if (!row) return undefined;
    const { project, ...summary } = row;
    return { item: this.toSummary(summary), project: project as Record<string, unknown> };
  }

  /** Adds a post. Returns its summary and the plaintext delete token, which is shown once. */
  async publish(post: PublishInput): Promise<{ item: CommunitySummary; deleteToken: string }> {
    const db = await this.ready();
    const [{ n }] = await db.select({ n: count() }).from(projects).where(eq(projects.builtIn, false));
    if (Number(n) >= MAX_POSTS) throw new Error('COMMUNITY_FULL');
    const id = `cp_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
    const deleteToken = randomBytes(24).toString('hex');
    await db.insert(projects).values({
      id,
      authorId: post.authorClientId ? this.hashClient(post.authorClientId) : null,
      authorName: post.authorName,
      title: post.title,
      description: post.description,
      circuitData: post.project,
      preview: post.preview,
      tags: post.tags,
      board: post.board,
      boardId: post.boardId,
      partCount: post.partCount,
      creator: post.creator,
      deleteTokenHash: sha256(deleteToken),
    });
    this.cachedCounts.posts++;
    this.cachedCounts.publishedPosts++;
    const created = await this.getProject(id, post.authorClientId);
    return { item: created!.item, deleteToken };
  }

  /**
   * Sets whether this anonymous id likes the post, and returns the post as it
   * now stands. Idempotent: liking twice is one like, unliking twice is none.
   */
  async setLike(id: string, clientId: string, liked: boolean): Promise<CommunitySummary | undefined> {
    const db = await this.ready();
    const me = this.hashClient(clientId);
    try {
      return await db.transaction(async (tx) => {
        if (liked) {
          const added = await tx
            .insert(likes)
            .values({ userId: me, projectId: id })
            .onConflictDoNothing()
            .returning({ projectId: likes.projectId });
          if (added.length) {
            await tx.update(projects).set({ likeCount: sql`${projects.likeCount} + 1` }).where(eq(projects.id, id));
          }
        } else {
          const removed = await tx
            .delete(likes)
            .where(and(eq(likes.userId, me), eq(likes.projectId, id)))
            .returning({ projectId: likes.projectId });
          if (removed.length) {
            await tx
              .update(projects)
              .set({ likeCount: sql`greatest(${projects.likeCount} - 1, 0)` })
              .where(eq(projects.id, id));
          }
        }
        const [row] = await tx.select(this.summaryColumns(clientId)).from(projects).where(eq(projects.id, id));
        return row ? this.toSummary(row) : undefined;
      });
    } catch (err) {
      // A like for a project that does not exist breaks the foreign key.
      if (pgCode(err) === '23503') return undefined;
      throw err;
    }
  }

  /** Removes a post if the token is the one issued when it was published. */
  async remove(id: string, deleteToken: string): Promise<'removed' | 'not-found' | 'forbidden'> {
    const db = await this.ready();
    const [row] = await db
      .select({ hash: projects.deleteTokenHash })
      .from(projects)
      .where(eq(projects.id, id));
    if (!row) return 'not-found';
    if (!row.hash || !sameSecret(sha256(deleteToken), row.hash)) return 'forbidden';
    const gone = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
    if (gone.length) {
      this.cachedCounts.posts--;
      this.cachedCounts.publishedPosts--;
    }
    return 'removed';
  }

  /**
   * Where the data is and whether it survives a deploy. With `live`, the
   * counts are read from the database; without, they are the last known ones,
   * so /health never has to wake a database that has scaled to zero.
   */
  async storageStatus(live = false): Promise<StorageStatus> {
    const database = this.database;
    if (live && database) {
      try {
        await this.refreshCounts(database.db);
        this.lastError = null;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    const configured = process.env.DATABASE_URL?.trim();
    return {
      mode: database ? (database.location === 'memory' ? 'memory' : database.kind) : configured ? 'postgres' : 'pglite',
      location: database?.location ?? null,
      persistent: database?.persistent ?? Boolean(configured),
      posts: this.cachedCounts.posts,
      publishedPosts: this.cachedCounts.publishedPosts,
      lastError: this.lastError,
    };
  }

  /** Closes the database connection. */
  async close(): Promise<void> {
    const database = this.database;
    this.database = null;
    await database?.close();
  }

  /**
   * Everything a restore needs: the salt, so likes keep matching the browsers
   * that gave them, and every post with its likes and delete-token hash.
   * Built-in posts carry only their likes — the rest comes from the code.
   */
  async exportData(): Promise<StoreFile> {
    const db = await this.ready();
    const rows = await db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id));
    const likeRows = await db.select({ userId: likes.userId, projectId: likes.projectId }).from(likes);
    const likers = new Map<string, string[]>();
    for (const l of likeRows) {
      const list = likers.get(l.projectId) ?? [];
      list.push(l.userId);
      likers.set(l.projectId, list);
    }
    return {
      version: 1,
      salt: this.salt,
      posts: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        authorName: r.authorName,
        creator: r.creator,
        tags: r.tags,
        board: r.board,
        boardId: r.boardId,
        partCount: r.partCount,
        preview: r.preview as CommunityPreview,
        project: r.builtIn ? {} : (r.circuitData as Record<string, unknown>),
        createdAt: iso(r.createdAt),
        ...(r.builtIn ? { builtIn: true } : {}),
        baseLikes: r.baseLikes,
        likers: likers.get(r.id) ?? [],
        ...(r.deleteTokenHash ? { deleteTokenHash: r.deleteTokenHash } : {}),
        ...(r.authorId ? { authorId: r.authorId } : {}),
      })),
    };
  }

  /**
   * Merges a backup in. Nothing is deleted: a post already here keeps its
   * content and gains the backup's likes; a post that is not is added, after
   * the same checks a publish goes through, so a backup file cannot carry in
   * what the API would refuse. When nothing is published here yet, the
   * backup's salt is adopted, so existing likes still recognise their
   * browsers. Returns how many posts were added and how many gained likes.
   */
  async importData(data: unknown, creatorName: string): Promise<{ added: number; merged: number; skipped: number }> {
    const db = await this.ready();
    const outcome = await this.importInto(db, data, creatorName);
    await this.refreshCounts(db);
    return outcome;
  }

  private async importInto(db: Db, data: unknown, creatorName: string): Promise<{ added: number; merged: number; skipped: number }> {
    const file = data as Partial<StoreFile> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.posts)) {
      throw new CommunityInputError('That is not a CircuitDesk community backup.');
    }
    return db.transaction(async (tx) => {
      const [{ n: publishedBefore }] = await tx.select({ n: count() }).from(projects).where(eq(projects.builtIn, false));
      if (Number(publishedBefore) === 0 && typeof file.salt === 'string' && /^[0-9a-f]{16,128}$/.test(file.salt)) {
        await tx.update(settings).set({ value: file.salt }).where(eq(settings.key, SALT_KEY));
        this.salt = file.salt;
      }
      let added = 0;
      let merged = 0;
      let skipped = 0;
      let published = Number(publishedBefore);
      const touched = new Set<string>();
      for (const raw of file.posts!) {
        const incoming = raw as Partial<CommunityPost>;
        const likers = Array.isArray(incoming.likers)
          ? [...new Set(incoming.likers.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)))]
          : [];
        const id = typeof incoming.id === 'string' ? incoming.id : '';
        const [existing] = id ? await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)) : [];
        if (existing) {
          if (likers.length) {
            const inserted = await tx
              .insert(likes)
              .values(likers.map((userId) => ({ userId, projectId: id })))
              .onConflictDoNothing()
              .returning({ userId: likes.userId });
            if (inserted.length) {
              merged++;
              touched.add(id);
            }
          }
          continue;
        }
        if (incoming.builtIn) {
          skipped++; // a built-in the code no longer ships
          continue;
        }
        if (published >= MAX_POSTS) throw new Error('COMMUNITY_FULL');
        try {
          if (!/^cp_[0-9a-z]{6,40}$/.test(id)) throw new CommunityInputError('bad id');
          const createdAt =
            typeof incoming.createdAt === 'string' && !Number.isNaN(Date.parse(incoming.createdAt)) ? new Date(incoming.createdAt) : new Date();
          const project = cleanProject(incoming.project);
          const boards = project.boardInstances as { definitionId?: unknown }[];
          const boardId = typeof boards[0]?.definitionId === 'string' ? boards[0].definitionId.slice(0, LIMITS.boardId) : '';
          const values = {
            id,
            authorId: typeof incoming.authorId === 'string' && /^[0-9a-f]{64}$/.test(incoming.authorId) ? incoming.authorId : null,
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
            circuitData: project,
            createdAt,
            deleteTokenHash:
              typeof incoming.deleteTokenHash === 'string' && /^[0-9a-f]{64}$/.test(incoming.deleteTokenHash)
                ? incoming.deleteTokenHash
                : null,
          };
          await tx.insert(projects).values(values);
          if (likers.length) await tx.insert(likes).values(likers.map((userId) => ({ userId, projectId: id }))).onConflictDoNothing();
          touched.add(id);
          added++;
          published++;
        } catch (err) {
          if (!(err instanceof CommunityInputError)) throw err;
          skipped++;
        }
      }
      // The counts of every project that gained likes, from the likes themselves.
      if (touched.size) {
        await tx
          .update(projects)
          .set({ likeCount: sql`(select count(*) from ${likes} where ${likes.projectId} = ${projects.id})::int` })
          .where(inArray(projects.id, [...touched]));
      }
      return { added, merged, skipped };
    });
  }
}
