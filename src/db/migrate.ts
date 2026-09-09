import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from './client.js';

migrate(db, { migrationsFolder: './src/db/migrations' })
  .then(() => { console.log('Migrations complete'); process.exit(0); })
  .catch((err) => { console.error('Migration failed:', err); process.exit(1); });
