# Community

`#/community` is where people share projects, like them, and open copies of
them. `#/templates` holds the starters and showcases. Both sit in the header
next to Projects.

## How it works

The community lives on the existing backend under `/api/community`. There are
no accounts:

| Action | How it's controlled |
|---|---|
| Browse, search, sort | `GET /api/community/projects?sort=popular\|new&q=&board=&creator=1` |
| Open a copy | `GET /api/community/projects/:id`, then the same `normalizeProject` gate an imported file goes through. Unknown parts and dangling wires are dropped, custom boards are re-derived, and no thumbnail markup is kept |
| Like / unlike | `PUT` / `DELETE /api/community/projects/:id/like` with an anonymous per-browser id. Stored as a salted hash; liking twice counts once |
| Publish | `POST /api/community/projects`. Returns a delete token, once, which the browser keeps |
| Remove | `DELETE /api/community/projects/:id` with `x-delete-token`. Only the publishing browser holds it |

What it refuses:

- **Text and size limits:** text over its limit, control characters, more than 5 tags, and projects over 300 KB.
- **Unsafe code files:** names the compiler would refuse.
- **Impersonation:** display names claiming to be the creator, the site, an admin or staff.
- **Anything but plain data in previews:** a card's picture is rectangles, lines, numbers and hex colours, drawn through `<img>`.

Every post is rendered as text. Nothing in a post can become markup on someone else's page (see `tests/security.thumbnails.mts`).

Rate limits per address, each separate from the compiler's budget:

| Action | Limit |
|---|---|
| Reads | 600 per 5 min |
| Likes | 120 per 10 min |
| Publishes | 5 per hour |
| Deletes | 20 per hour |

The `COMMUNITY_*_MAX` variables exist only for local test runs. Deployments leave them unset.

## The creator badge

A post gets the badge only when the publish request carries `x-creator-token`
matching the server's `CREATOR_TOKEN`, compared in constant time. With no
token configured, nobody can publish as the creator. The name shown is
`CREATOR_NAME`, which defaults to `Adam`.

## Built-in projects

Nine projects ship with the code: six posted as Anonymous and three under the
creator's name. Likes recorded by the server add to each one's `baseLikes`.
Every one validates with nothing to report, uses only simulated parts,
compiles, and passes its own test bench (`tests/community.builtin.mts`).

To change one:
1. Edit `src/community/builtinProjects.ts`.
2. Run `npx tsx tools/community/buildBuiltins.mts` to rewrite `server/community/builtin.json`.

The test fails if the file is stale.

## Where posts are kept

In Postgres. In production that is a hosted database (Neon) named by
`DATABASE_URL`; the data lives with the database provider, so a deploy, a
restart, or the service sleeping on Render's free tier never touches it. The
backend container holds nothing that has to survive.

Tables (`server/db/schema.ts`):

| Table | What is in it |
|---|---|
| `projects` | Every post: title, description, author name, `author_id` (salted hash of the publishing browser's id), `circuit_data` (the whole project as JSON), preview, tags, board, `like_count`, `created_at`, `updated_at`, and the delete-token hash |
| `likes` | `(user_id, project_id, created_at)`, with `(user_id, project_id)` the primary key, so one browser can like a project once. `user_id` is a salted hash of the browser's anonymous id |
| `settings` | The salt like hashes are made with |

A like inserts the row and adds 1 to `like_count` in one transaction, and only
if the row was new (a second like from the same browser is refused by the
key and changes nothing). An unlike deletes the row and subtracts 1 the same
way. The count moves with `like_count = like_count + 1`, a row lock in the
database rather than a read and a write in the server, so likes arriving at
the same moment all count. `tests/community.api.mts` and
`tests/community.persistence.mts` check exactly that, the second with real
server processes redeployed onto empty disks.

**Migrations.** The schema is changed in `server/db/schema.ts`, then
`npm run db:generate` writes a new SQL migration into `server/db/migrations`,
which is committed. The server applies pending migrations when it starts
(under a Postgres advisory lock, so two instances cannot both apply one) and
records them in `drizzle.__drizzle_migrations`, so each runs once. Migrations
only add: `tests/db.migrations.mts` fails on any `DROP TABLE`, `DROP COLUMN`,
`TRUNCATE` or `DELETE FROM`, and nothing in the deploy resets a table.

Without `DATABASE_URL` (local development, tests) the same schema and
migrations run on PGlite, an embedded Postgres, in
`COMMUNITY_DATA_DIR/pglite` (default `.community-data/pglite`). In production
that is not persistent, and the server says so: a startup warning, and
`persistent: false` on `/health` and `/api/community/status`. A
`community.json` left from before the database is imported into an empty
database once.

To check a deployment, open `/api/community/status`: `mode` is `postgres` and
`persistent` is `true`. (`/health` reports the same, from cached counts, so
health checks never wake a database that has scaled to zero.)

### Backups, and moving to another host

With the creator token:

```sh
# download everything published, with likes
curl -H "x-creator-token: $CREATOR_TOKEN" https://<host>/api/community/backup -o community-backup.json

# merge a backup into a server (for example a new host)
curl -X POST -H "content-type: application/json" -H "x-creator-token: $CREATOR_TOKEN" \
  --data-binary @community-backup.json https://<host>/api/community/restore
```

A restore never deletes anything: posts already present keep their content and
gain the backup's likes, and new ones are added after the same checks a
publish goes through. On a server with nothing published yet it also takes the
backup's like salt, so browsers keep seeing the projects they liked as liked.

### What is not on the server

Each person's own projects and the custom boards they make are stored in their
browser (IndexedDB), not on the server, so a deploy does not touch them. A
custom board travels with a project when that project is published.

Other settings:

| Variable | Purpose |
|---|---|
| `CREATOR_TOKEN` | Secret, at least 16 characters, that grants the Creator badge |
| `CREATOR_NAME` | Name shown on creator posts |
| `DATABASE_URL` | The Postgres connection string. Required in production; a secret, set in the host's dashboard |
| `COMMUNITY_SALT` | Salt for like hashes. Optional; otherwise one is generated and kept in the `settings` table |

## Known limits

- **Likes are per browser.** With no accounts, one person with several browsers can like a project more than once. The rate limit bounds how far that goes.
- **No moderation queue or report button yet.** A post can be removed by its publisher, or by deleting its row in `projects` (its likes go with it).
