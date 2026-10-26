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

import type { Express, Request, Response } from 'express';
import path from 'node:path';
import { rateLimit } from '../rateLimit.js';
import { CommunityStore, sameSecret, type CommunityPost } from './store.js';
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

/** The data file, or null to keep everything in memory (tests). */
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

export async function registerCommunityRoutes(app: Express, store?: CommunityStore): Promise<CommunityStore> {
  const community = store ?? new CommunityStore(communityDataFile(), builtinPosts());
  if (!store) await community.load();

  const readLimit = rateLimit({ windowMs: 5 * 60_000, max: Number(process.env.COMMUNITY_READ_MAX ?? 600), name: 'community read' });
  const likeLimit = rateLimit({ windowMs: 10 * 60_000, max: Number(process.env.COMMUNITY_LIKE_MAX ?? 120), name: 'like' });
  const publishLimit = rateLimit({ windowMs: 60 * 60_000, max: Number(process.env.COMMUNITY_PUBLISH_MAX ?? 5), name: 'publish' });
  const deleteLimit = rateLimit({ windowMs: 60 * 60_000, max: 20, name: 'delete' });

  app.get('/api/community/projects', readLimit, (req, res) => {
    const sort = req.query.sort === 'new' ? 'new' : 'popular';
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined;
    const boardId = typeof req.query.board === 'string' ? req.query.board.slice(0, LIMITS.boardId) : undefined;
    const clientId = isPlausibleClientId(req.query.clientId) ? req.query.clientId : undefined;
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
    const offset = Math.max(0, Math.min(100_000, Number(req.query.offset) || 0));
    const creatorOnly = req.query.creator === '1';
    res.json({ success: true, creatorName: CREATOR_NAME, ...community.list({ sort, q, boardId, creatorOnly, clientId, limit, offset }) });
  });

  app.get('/api/community/projects/:id', readLimit, (req, res) => {
    const post = community.get(String(req.params.id));
    if (!post) return fail(res, 404, 'That project is not in the community.', 'NOT_FOUND');
    const clientId = isPlausibleClientId(req.query.clientId) ? req.query.clientId : undefined;
    res.json({ success: true, item: community.summary(post, clientId), project: post.project });
  });

  app.post('/api/community/projects', publishLimit, (req, res) => {
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
      const { post, deleteToken } = community.publish({
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
      res.status(201).json({ success: true, item: community.summary(post), deleteToken });
    } catch (err) {
      if (err instanceof CommunityInputError) return fail(res, 400, err.message, 'INVALID');
      if (err instanceof Error && err.message === 'COMMUNITY_FULL') {
        return fail(res, 507, 'The community is full right now. Please try again later.', 'FULL');
      }
      console.error('[CircuitDesk] publish failed:', err);
      fail(res, 500, 'Could not publish the project.', 'INTERNAL');
    }
  });

  const like = (liked: boolean) => (req: Request, res: Response) => {
    const clientId = (req.body as { clientId?: unknown } | undefined)?.clientId ?? req.query.clientId;
    if (!isPlausibleClientId(clientId)) return fail(res, 400, 'A valid anonymous id is required to like.', 'INVALID');
    const summary = community.setLike(String(req.params.id), clientId, liked);
    if (!summary) return fail(res, 404, 'That project is not in the community.', 'NOT_FOUND');
    res.json({ success: true, item: summary });
  };
  app.put('/api/community/projects/:id/like', likeLimit, like(true));
  app.delete('/api/community/projects/:id/like', likeLimit, like(false));

  app.delete('/api/community/projects/:id', deleteLimit, (req, res) => {
    const token = req.get('x-delete-token') ?? '';
    if (!/^[0-9a-f]{48}$/.test(token)) return fail(res, 403, 'Only the browser that published a project can remove it.', 'FORBIDDEN');
    const outcome = community.remove(String(req.params.id), token);
    if (outcome === 'not-found') return fail(res, 404, 'That project is not in the community.', 'NOT_FOUND');
    if (outcome === 'forbidden') return fail(res, 403, 'Only the browser that published a project can remove it.', 'FORBIDDEN');
    res.json({ success: true });
  });

  return community;
}
