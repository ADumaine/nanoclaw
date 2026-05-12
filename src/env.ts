import fs from 'fs';
import path from 'path';
import { log } from './log.js';

function parseValue(raw: string): string {
  let value = raw.trim();
  // Quoted value — strip quotes, preserve content literally (no comment stripping)
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  // Unquoted — strip inline comment (space + #)
  const commentIdx = value.indexOf(' #');
  if (commentIdx !== -1) value = value.slice(0, commentIdx).trimEnd();
  return value;
}

function readEnvLines(): string[] {
  const envFile = path.join(process.cwd(), '.env');
  try {
    return fs.readFileSync(envFile, 'utf-8').split('\n');
  } catch {
    return [];
  }
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const lines = readEnvLines();
  if (lines.length === 0) {
    log.debug('.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    const value = parseValue(trimmed.slice(eqIdx + 1));
    if (value) result[key] = value;
  }

  return result;
}

/**
 * Return all key/value pairs whose key starts with `prefix`.
 * The prefix is stripped from the returned keys.
 * E.g. prefix "WEBAPP_CALLBACK_URL_" returns { "dev": "http://...", "beta": "http://..." }.
 */
export function readEnvPrefix(prefix: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readEnvLines()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key.startsWith(prefix)) continue;
    const value = parseValue(trimmed.slice(eqIdx + 1));
    if (value) result[key.slice(prefix.length)] = value;
  }
  return result;
}
