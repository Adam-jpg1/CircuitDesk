// The community's tables. Changing anything here means generating a migration
// (`npm run db:generate`) and committing it; the server applies pending
// migrations when it starts. Migrations only ever add: never generate one that
// drops a table or column holding published projects or likes.

import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    /**
     * Salted hash of the publishing browser's anonymous id. There are no
     * accounts, so this is the same kind of identity a like carries; null for
     * built-in projects and for anything published before it was recorded.
     */
    authorId: text('author_id'),
    authorName: text('author_name').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** The whole CircuitProject: boards, parts, wires, code. */
    circuitData: jsonb('circuit_data').notNull(),
    preview: jsonb('preview').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    board: text('board').notNull().default(''),
    boardId: text('board_id').notNull().default(''),
    partCount: integer('part_count').notNull().default(0),
    /** Published with the creator token; never set from anything a client typed. */
    creator: boolean('creator').notNull().default(false),
    /** Ships with the code rather than being published through the API. */
    builtIn: boolean('built_in').notNull().default(false),
    /** A built-in project's starting likes. Zero for everything published. */
    baseLikes: integer('base_likes').notNull().default(0),
    /** Rows in `likes` for this project, kept in step in the same transaction. */
    likeCount: integer('like_count').notNull().default(0),
    deleteTokenHash: text('delete_token_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('projects_created_at_idx').on(t.createdAt)],
);

export const likes = pgTable(
  'likes',
  {
    /** Salted hash of the liking browser's anonymous id. */
    userId: text('user_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // One like per browser per project: the database refuses a second.
  (t) => [primaryKey({ name: 'likes_user_project_pk', columns: [t.userId, t.projectId] }), index('likes_project_idx').on(t.projectId)],
);

/** Server-side values that must outlive a deploy: the salt likes are hashed with. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
