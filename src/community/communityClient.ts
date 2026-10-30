// The app's side of the community API.
//
// Talks to the same backend as the compiler. Two things live in the browser:
// an anonymous id, which is how a like is remembered without an account, and
// the delete tokens for posts published from this browser, which are the only
// way to take one down again. Both are per-browser conveniences, so storage
// that throws (private windows, blocked site data) degrades to "works, but
// forgets" rather than failing.

import { compilerApiUrl } from '../compiler/apiBase';
import { normalizeProject, saveProject } from '../project/projectService';
import { projectPreview, type CommunityPreview } from './preview';
import { resolveDefinition } from '../project/partsRegistry';
import { uid, type CircuitProject } from '../types';

export interface CommunityItem {
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

export class CommunityError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const CLIENT_KEY = 'circuitdesk.community.clientId';
const TOKENS_KEY = 'circuitdesk.community.deleteTokens';
const NAME_KEY = 'circuitdesk.community.displayName';
const CREATOR_KEY = 'circuitdesk.community.creatorKey';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let memoryClientId: string | null = null;
/** The anonymous id this browser likes things as. */
export function clientId(): string {
  const store = storage();
  try {
    const existing = store?.getItem(CLIENT_KEY);
    if (existing) return existing;
  } catch {
    /* fall through */
  }
  memoryClientId ??= crypto.randomUUID();
  try {
    store?.setItem(CLIENT_KEY, memoryClientId);
  } catch {
    /* remembered for this page only */
  }
  return memoryClientId;
}

function readTokens(): Record<string, string> {
  try {
    return JSON.parse(storage()?.getItem(TOKENS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function writeTokens(tokens: Record<string, string>): void {
  try {
    storage()?.setItem(TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    /* the post can still be published; it just cannot be removed later */
  }
}
export function canDelete(id: string): boolean {
  return Boolean(readTokens()[id]);
}
/** The creator key this browser has used before, if any. Never sent anywhere else. */
export function rememberedCreatorKey(): string {
  try {
    return storage()?.getItem(CREATOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberedDisplayName(): string {
  try {
    return storage()?.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(compilerApiUrl(path), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new CommunityError('The community service could not be reached.', 0);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* not JSON: reported by status below */
  }
  if (!res.ok || body.success === false) {
    throw new CommunityError(typeof body.error === 'string' ? body.error : `The community service answered ${res.status}.`, res.status);
  }
  return body as T;
}

export async function listCommunity(opts: {
  sort?: 'popular' | 'new';
  q?: string;
  board?: string;
  creatorOnly?: boolean;
  limit?: number;
}): Promise<{ total: number; items: CommunityItem[]; creatorName: string }> {
  const params = new URLSearchParams({ clientId: clientId(), sort: opts.sort ?? 'popular', limit: String(opts.limit ?? 60) });
  if (opts.q) params.set('q', opts.q);
  if (opts.board) params.set('board', opts.board);
  if (opts.creatorOnly) params.set('creator', '1');
  return call(`/api/community/projects?${params}`);
}

export async function getCommunityProject(id: string): Promise<{ item: CommunityItem; project: unknown }> {
  return call(`/api/community/projects/${encodeURIComponent(id)}?clientId=${clientId()}`);
}

export async function setLiked(id: string, liked: boolean): Promise<CommunityItem> {
  const { item } = await call<{ item: CommunityItem }>(`/api/community/projects/${encodeURIComponent(id)}/like`, {
    method: liked ? 'PUT' : 'DELETE',
    body: JSON.stringify({ clientId: clientId() }),
  });
  return item;
}

export async function publishProject(input: {
  project: CircuitProject;
  title: string;
  description: string;
  authorName: string;
  tags: string[];
  /** The server's CREATOR_TOKEN, for the site creator only. */
  creatorKey?: string;
}): Promise<CommunityItem> {
  const board = input.project.boardInstances[0];
  const def = board ? resolveDefinition(board.definitionId, input.project) : undefined;
  const { thumbnailSvg: _t, ...project } = input.project;
  const creatorKey = input.creatorKey?.trim();
  const { item, deleteToken } = await call<{ item: CommunityItem; deleteToken: string }>('/api/community/projects', {
    method: 'POST',
    headers: creatorKey ? { 'x-creator-token': creatorKey } : {},
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      authorName: input.authorName,
      tags: input.tags,
      board: def?.name ?? '',
      preview: projectPreview(input.project),
      project,
      // Recorded only as a salted hash: the project's author id.
      clientId: clientId(),
    }),
  });
  writeTokens({ ...readTokens(), [item.id]: deleteToken });
  if (creatorKey && item.creator) {
    try {
      storage()?.setItem(CREATOR_KEY, creatorKey);
    } catch {
      /* typed again next time */
    }
  }
  try {
    storage()?.setItem(NAME_KEY, input.authorName);
  } catch {
    /* not remembered */
  }
  return item;
}

export async function deleteCommunityProject(id: string): Promise<void> {
  const tokens = readTokens();
  const token = tokens[id];
  if (!token) throw new CommunityError('Only the browser that published a project can remove it.', 403);
  await call(`/api/community/projects/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-delete-token': token } });
  delete tokens[id];
  writeTokens(tokens);
}

/**
 * Opens someone's project as a new project of your own.
 *
 * Through normalizeProject, the same gate an imported file passes: unknown
 * parts and dangling wires are dropped, embedded custom boards are re-derived
 * rather than trusted, and no thumbnail markup comes along.
 */
export async function openCopy(id: string): Promise<CircuitProject> {
  const { item, project } = await getCommunityProject(id);
  const now = new Date().toISOString();
  const copy = normalizeProject({
    ...(project as Record<string, unknown>),
    id: uid('proj'),
    name: item.title,
    createdAt: now,
    updatedAt: now,
  });
  await saveProject(copy);
  return copy;
}
