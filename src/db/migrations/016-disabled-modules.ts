import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'disabled-modules',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN disabled_modules TEXT NOT NULL DEFAULT '[]'").run();
  },
};
