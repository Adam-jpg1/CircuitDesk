// The community API: browse, open, publish, like, and delete your own post.
//
// No accounts. Publishing returns a delete token the publishing browser keeps;
// liking is keyed by an anonymous per-browser id. Each route has its own rate
// limit, set for what a person does — reading a lot, liking a fair amount,
// publishing rarely — so a script hammering one cannot starve the others, and
// none of them shares a budget with the compiler.
//
// The creator badge is the one thing a request cannot assert for itself: it is
// granted only to a request carrying CREATOR_TOKEN, compared in constant time,
// and with no token configured nobody can publish as the creator at all.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { rateLimit } from '../rateLimit.js';
import { CommunityStore, sameSecret, StorageUnavailableError, type CommunityPost } from './store.js';
import {
  CommunityInputError,
  LIMITS,
  cleanAuthor,
  cleanPreview,
  cleanProject,
  cleanTags,
  cleanText,
  isPlausibleClientId,
} from './validate.js';
import builtinFile from './builtin.json' with { type: 'json' };

export const CREATOR_NAME = process.env.CREATOR_NAME || 'Adam';

function isCreatorRequest(req: Request): boolean {
  const configured = process.env.CREATOR_TOKEN;
  const offered = req.get('x-creator-token');
  return Boolean(configured && offered && configured.length >= 16 && sameSecret(offered, configured));
}

function fail(res: Response, status: number, error: string, errorCode: string): void {
  res.status(status).json({ success: false, error, errorCode });
}

export const COMMUNITY_RESTORE_PATH = '/api/community/restore';

/**
 * The JSON file the community was kept in before the database. If one is
 * still there at startup it is imported once (see CommunityStore).
 */
export function communityDataFile(): string | null {
  if (process.env.COMMUNITY_DATA_DIR === 'memory') return null;
  const dir = process.env.COMMUNITY_DATA_DIR || path.resolve(process.cwd(), '.community-data');
  return path.join(dir, 'community.json');
}

export function builtinPosts(): CommunityPost[] {
  return (builtinFile as { posts: CommunityPost[] }).posts.map((p) => ({
    ...p,
    builtIn: true,
    likers: [],
    authorName: p.creator ? CREATOR_NAME : p.authorName || 'Anonymous',
  }));
}

/**
 * Runs an async handler, answering 503 when the database cannot be reached
 * rather than pretending the request worked, and 500 for anything else.
 */
const handle =
  (what: string, fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof StorageUnavailableError) {
        return fail(res, 503, 'The community is unavailable right now. Please try again in a moment.', 'UNAVAILABLE');
      }
      console.error(`[CircuitDesk] community ${what} failed:`, err);
      fail(res, 500, `Could not ${what}.`, 'INTERNAL');
    });
  };

export async function registerCommunityRoutes(app: Express, store?: CommunityStore): Promise<CommunityStore> {
  const community = store ?? new CommunityStore({ builtIns: builtinPosts(), legacyFile: communityDataFile() });
  // Connect and migrate now, so a deploy shows its database in the startup
  // log. If it is unreachable the server still starts — the compiler does not
  // need it — and each community request tries again.
  try {
    await community.load();
  } catch (err) {
    console.error('[CircuitDesk] community database not ready at startup; requests will retry:', err instanceof Error ? err.message : err);
  }

  const readLimit = rateLimit({ windowMs: 5 * 60_000, max: Number(process.env.COMMUNITY_READ_MAX ?? 600), name: 'community read' });
  const likeLimit = rateLimit({ windowMs: 10 * 60_000, max: Number(process.env.COMMUNITY_LIKE_MAX ?? 120), name: 'like' });
  const publishLimit = rateLimit({ windowMs: 60 * 60_000, max: Number(process.env.COMMUNITY_PUBLISH_MAX ?? 5), name: 'publish' });
  const deleteLimit = rateLimit({ windowMs: 60 * 60_000, max: 20, name: 'delete' });

  app.get('/api/community/projects', readLimit, handle('list projects', async (req, res) => {
    const sort = req.query.sort === 'new' ? 'new' : 'popular';
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined;
    const boardId = typeof req.query.board === 'string' ? req.query.board.slice(0, LIMITS.boardId) : undefined;
    const clientId = isPlausibleClientId(req.query.clientId) ? req.query.clientId : undefined;
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
    const offset = Math.max(0, Math.min(100_000, Number(req.query.offset) || 0));
    const creatorOnly = req.query.creator === '1';
    const page = await community.list({ sort, q, boardId, creatorOnly, clientId, limit, offset });
    res.json({ success: true, creatorName: CREATOR_NAME, ...page });
  }));

  app.get('/api/community/projects/:id', readLimit, handle('open the project', async (req, res) => {
    const clientId = isPlausibleClientId(req.query.clientId) ? req.query.clientId : undefined;
    const found = await community.getProject(String(req.params.id), clientId);
    if (!found) return fail(res, 404, 'That project is not in the community.', 'NOT_FOUND');
    res.json({ success: true, item: found.item, project: found.project });
  }));

  app.post('/api/community/projects', publishLimit, handle('publish the project', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const creator = isCreatorRequest(req);
      const title = cleanText(body.title, LIMITS.title, 'Title');
      if (title.length < LIMITS.titleMin) throw new CommunityInputError(`Title needs at least ${LIMITS.titleMin} characters.`);
      const project = cleanProject(body.project);
      const boards = project.boardInstances as { definitionId?: unknown }[];
      const boardId = typeof boards[0]?.definitionId === 'string' ? boards[0].definitionId.slice(0, LIMITS.boardId) : '';
      const partCount =
        (project.boardInstances as unknown[]).length + ((project.componentInstances as unknown[] | undefined)?.length ?? 0);
      const authorClientId = isPlausibleClientId(body.clientId) ? body.clientId : undefined;
      const { item, deleteToken } = await community.publish({
        authorClientId,
        title,
        description: cleanText(body.description, LIMITS.description, 'Description', { multiline: true }),
        authorName: cleanAuthor(body.authorName, creator, CREATOR_NAME),
        creator,
        tags: cleanTags(body.tags),
        board: cleanText(body.board, LIMITS.board, 'Board') || boardId,
        boardId,
        partCount,
        preview: cleanPreview(body.preview),
        project,
      });
      res.status(201).json({ success: true, item, deleteToken });
    } catch (err) {
      if (err instanceof CommunityInputError) return fail(res, 400, err.message, 'INVALID');
      if (err instanceof Error && err.message === 'COMMUNITY_FULL') {
        return fail(res, 507, 'The community is full right now. Please try again later.', 'FULL');
      }
      throw err;
    }
  }));

  // The answer is the project as the database now has it — its real count and
  // whether this browser likes it — which is what the page then shows.
  const like = (liked: boolean) =>
    handle(liked ? 'like the project' : 'unlike the project', async (req, res) => {
      const clientId = (req.body as { clientId?: unknown } | undefined)?.clientId ?? req.query.clientId;
      if (!isPlausibleClientId(clientId)) return fail(res, 400, 'A valid anonymous id is required to like.', 'INVALID');
      const summary = await community.setLike(String(req.params.id), clientId, liked);
      if (!summary) return fail(res, 404, 'That project is not in the community.', 'NOT_FOUND');
      res.json({ success: true, item: summary });
    });
  app.put('/api/community/projects/:id/like', likeLimit, like(true));
  app.delete('/api/community/projects/:id/like', likeLimit, like(false));

  // ---- backup and restore, for the creator ----
  //
  // A copy of everything published — posts, likes, the like salt — and a way
  // to merge one back in. For an offline backup, or for moving to another host
  // without losing the community. Restore never deletes: see importData().
  const backupLimit = rateLimit({ windowMs: 60 * 60_000, max: 30, name: 'community backup' });
  app.get('/api/community/backup', backupLimit, handle('make a backup', async (req, res) => {
    if (!isCreatorRequest(req)) return fail(res, 403, 'Only the creator can download a backup.', 'FORBIDDEN');
    const data = await community.exportData();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="circuitdesk-community-${stamp}.json"`);
    res.json(data);
  }));
  app.post(COMMUNITY_RESTORE_PATH, backupLimit, express.json({ limit: '200mb' }), handle('restore the backup', async (req, res) => {
    if (!isCreatorRequest(req)) return fail(res, 403, 'Only the creator can restore a backup.', 'FORBIDDEN');
    try {
      const outcome = await community.importData(req.body, CREATOR_NAME);
      res.json({ success: true, ...outcome, storage: await community.storageStatus() });
    } catch (err) {
      if (err instanceof CommunityInputError) return fail(res, 400, err.message, 'INVALID');
      if (err instanceof Error && err.message === 'COMMUNITY_FULL') {
        return fail(res, 507, 'The backup would take the community past its limit.', 'FULL');
      }
      throw err;
    }
  }));

  app.delete('/api/community/projects/:id', deleteLimit, handle('remove the project', async (req, res) => {
    const token = req.get('x-delete-token') ?? '';
    if (!/^[0-9a-f]{48}$/.test(token)) return fail(res, 403, 'Only the browser that published a project can remove it.', 'FORBIDDEN');
    const outcome = await community.remove(String(req.params.id), token);
    if (outcome === 'not-found') return fail(res, 404, 'That project is not in the community.', 'NOT_FOUND');
    if (outcome === 'forbidden') return fail(res, 403, 'Only the browser that published a project can remove it.', 'FORBIDDEN');
    res.json({ success: true });
  }));

  return community;
}
