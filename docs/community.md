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

There is one JSON file, written atomically, in `COMMUNITY_DATA_DIR`. The
default is `.community-data/` in the working directory.

**On a host whose disk is replaced at every deploy, published posts and likes
are lost at the next deploy.** The built-in projects come back, because they
ship with the code. To keep what people publish, put `COMMUNITY_DATA_DIR` on a
persistent disk. On Render, that means attaching a disk to the service and
pointing the variable at its mount path.

Other settings:

| Variable | Purpose |
|---|---|
| `CREATOR_TOKEN` | Secret, at least 16 characters, that grants the Creator badge |
| `CREATOR_NAME` | Name shown on creator posts |
| `COMMUNITY_SALT` | Salt for like hashes. Optional; otherwise one is generated and kept in the data file |

## Known limits

- **Likes are per browser.** With no accounts, one person with several browsers can like a project more than once. The rate limit bounds how far that goes.
- **No moderation queue or report button yet.** A post can be removed by its publisher, or by editing the data file.
