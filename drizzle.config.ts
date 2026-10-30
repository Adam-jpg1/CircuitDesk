// drizzle-kit reads this to generate migrations from server/db/schema.ts:
//   npm run db:generate
// It needs no database connection to generate. The server applies the
// committed migrations itself when it starts (server/db/client.ts).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
});
