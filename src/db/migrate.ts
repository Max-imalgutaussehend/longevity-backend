import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from './client.js';

await migrate(db, { migrationsFolder: './src/db/migrations' });
console.log('Migrations complete');
process.exit(0);
