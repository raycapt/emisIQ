import test from 'node:test';
import assert from 'node:assert/strict';
import { startupProblem, verifyAccess } from '../lib/gate.js';

const full = { NODE_ENV: 'production', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', ACCESS_AUD: 'aud', ACCESS_ALLOWED_EMAILS: 'a@b.c' };

test('production without the gate refuses to start', () => {
  assert.equal(startupProblem(full), null);
  for (const k of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ACCESS_ALLOWED_EMAILS']) {
    assert.match(startupProblem({ ...full, [k]: '' }), new RegExp(k));
  }
  assert.equal(startupProblem({ NODE_ENV: 'production', EMISIQ_OPEN: '1' }), null, 'explicit opt-out');
  assert.equal(startupProblem({}), null, 'local runs unchanged');
});

test('a token without an expiry is rejected', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = `${b64({ kid: 'k', alg: 'RS256' })}.${b64({ iss: 'https://t', email: 'a@b.c' })}.sig`;
  const r = await verifyAccess({ 'cf-access-jwt-assertion': tok }, { team: 't', aud: null, allowed: ['a@b.c'] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});
