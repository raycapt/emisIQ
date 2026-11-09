#!/usr/bin/env node
/**
 * Deploy preflight, run on the server BEFORE the new code is unpacked:
 *   node deploy/preflight.mjs /etc/<app>/env
 * Reads the env file the way systemd does (KEY=value lines), applies the production
 * start-up rules from lib/gate.js, and exits 1 with the reason if the new version would
 * refuse to start. Prints setting names and counts only, never values.
 */
import fs from 'node:fs';
import { startupProblem } from '../lib/gate.js';

const file = process.argv[2];
const env = { NODE_ENV: 'production' };
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch { console.error(`preflight: cannot read ${file}`); process.exit(1); }
for (const line of text.split('\n')) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}
const problem = startupProblem(env);
const names = Object.keys(env).filter((k) => k !== 'NODE_ENV').sort();
const emails = String(env.ACCESS_ALLOWED_EMAILS || '').split(',').filter((e) => e.trim()).length;
const mcp = (env.MCP_TOKEN ? 1 : 0) + String(env.MCP_TOKENS || '').split(',').filter((p) => p.includes(':')).length;
console.log(`preflight: settings present: ${names.join(', ') || 'none'}; allow-list ${emails} email(s); MCP tokens ${mcp}`);
if (problem) { console.error(`preflight: ${problem}`); process.exit(1); }
console.log('preflight: OK');
