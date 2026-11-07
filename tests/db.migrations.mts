// The database migrations can only ever add.
//
// The server applies every committed migration when it starts, on every
// deploy, against the live database. So a migration that drops a table or a
// column, or truncates one, would destroy published projects and likes the
// moment it shipped. This refuses such a migration before it can be merged,
// and checks that the migration list the server reads matches the files.
// (A rename or a destructive change, if ever truly needed, is done as
// add-copy-then-stop-using, never as a drop in the same release.)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { migrationsFolder } from '../server/db/client';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const dir = migrationsFolder();
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const journal = JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };

check(files.length > 0, `there are migrations (${files.length})`);
check(
  JSON.stringify(journal.entries.map((e) => `${e.tag}.sql`)) === JSON.stringify(files),
  'every migration file is in the journal the server applies, in order',
);

const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE)\b/i;
for (const f of files) {
  const text = readFileSync(path.join(dir, f), 'utf8');
  const hit = DESTRUCTIVE.exec(text);
  check(!hit, `${f} only adds (${hit ? `found "${hit[0]}"` : 'no drops, truncates or deletes'})`);
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
