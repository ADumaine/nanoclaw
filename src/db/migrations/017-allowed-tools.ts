import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'allowed-tools',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT \'"all"\'').run();
  },
};
