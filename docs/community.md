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

There is one JSON file, written atomically, in `COMMUNITY_DATA_DIR` (default
`.community-data/` in the working directory). Writes are debounced; when the
server is stopped (a deploy sends SIGTERM) it writes anything pending before it
exits.

**For posts and likes to survive a deploy, that directory must be on a disk
the deploy does not replace.** `render.yaml` attaches a 1 GB persistent disk
at `/var/data` and sets `COMMUNITY_DATA_DIR=/var/data/community`; Render
snapshots it daily. The built-in projects ship with the code and come back
either way.

To check a deployment, open `/health` (or `/api/community/status`):
`communityStorage.persistent` is `true` when the data directory is on its own
mounted volume. At startup in production the server logs a warning when it is
not. A host whose whole disk persists (so there is no separate mount) can say
so with `COMMUNITY_DISK_PERSISTENT=1`.

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
| `COMMUNITY_SALT` | Salt for like hashes. Optional; otherwise one is generated and kept in the data file |

## Known limits

- **Likes are per browser.** With no accounts, one person with several browsers can like a project more than once. The rate limit bounds how far that goes.
- **No moderation queue or report button yet.** A post can be removed by its publisher, or by editing the data file.
