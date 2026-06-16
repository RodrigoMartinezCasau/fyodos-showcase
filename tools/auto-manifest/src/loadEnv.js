/**
 * Load KEY=VALUE pairs from local .env files into process.env.
 * Does not overwrite variables already set in the shell.
 *
 * Search order (first found wins per key, later files only fill gaps):
 *   1. tools/auto-manifest/.env
 *   2. fyodos/backend/.env
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function applyEnv(parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

/** Derive FYODOS_API_KEY from FYODOS_CLIENT_KEYS (api_key:client_id,...). */
function deriveFyodosApiKey() {
  if (process.env.FYODOS_API_KEY) return;
  const raw = process.env.FYODOS_CLIENT_KEYS || '';
  const first = raw.split(',')[0]?.trim();
  if (!first || !first.includes(':')) return;
  const [apiKey] = first.split(':');
  if (apiKey) process.env.FYODOS_API_KEY = apiKey;
}

/** Prefer the target app's Fyodos API key from .env when publishing that app. */
function loadAppEnv(appRoot) {
  if (!appRoot) return;
  const appEnv = parseEnvFile(path.join(appRoot, '.env'));
  const appKey =
    appEnv.VITE_FYODOS_API_KEY?.trim() ||
    appEnv.NEXT_PUBLIC_FYODOS_API_KEY?.trim() ||
    appEnv.EXPO_PUBLIC_FYODOS_API_KEY?.trim();
  if (appKey) process.env.FYODOS_API_KEY = appKey;
  const appUrl =
    appEnv.VITE_FYODOS_API_URL?.trim() ||
    appEnv.NEXT_PUBLIC_FYODOS_API_URL?.trim() ||
    appEnv.EXPO_PUBLIC_FYODOS_API_URL?.trim();
  if (appUrl) process.env.FYODOS_API_URL = appUrl;
}

function loadEnv() {
  const root = path.join(__dirname, '..');
  const files = [
    path.join(root, '.env'),
    path.join(root, '../../backend/.env'),
  ];
  for (const file of files) {
    applyEnv(parseEnvFile(file));
  }
  deriveFyodosApiKey();
}

module.exports = { loadEnv, loadAppEnv };
