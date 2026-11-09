/**
 * EmisIQ server: serves the single-page app and is the only thing that talks to
 * the Claude API. The Anthropic key lives in the server environment, never in
 * the browser.
 *
 *   GET  /               the app
 *   GET  /api/health     { ok, ai }
 *   POST /api/ai         { mode: 'chat', system, messages } | { mode: 'pulse', prompt }
 *
 * The model, token caps and tools are fixed here, not taken from the request, so
 * the endpoint can only do what the app does. Behind Cloudflare Access the
 * Access JWT is verified on every request (lib/gate.js); locally it is open.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gateFromEnv, verifyAccess } from './lib/gate.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4890;
const HOST = process.env.HOST || '127.0.0.1';
const MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const gate = gateFromEnv();

let clientPromise = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  clientPromise ||= import('@anthropic-ai/sdk')
    .then(({ default: Anthropic }) => new Anthropic({ timeout: 120_000, maxRetries: 1 }))
    .catch(() => null);
  return clientPromise;
}

/** Light per-process limit so a stuck page cannot run up the bill. */
const recent = [];
function rateLimited(max = 30) {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= max) return true;
  recent.push(now);
  return false;
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

function chatRequest(body) {
  const { system, messages } = body;
  if (!str(system, 40_000)) throw fail(400, 'Missing system prompt.');
  if (!Array.isArray(messages) || !messages.length || messages.length > 24) throw fail(400, 'Bad message list.');
  messages.forEach((m, i) => {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    if (m?.role !== role || !str(m.content, 8_000)) throw fail(400, 'Messages must alternate user/assistant text.');
  });
  if (messages.at(-1).role !== 'user') throw fail(400, 'The last message must be from the user.');
  return {
    max_tokens: 2_000,
    system,
    messages: messages.map(({ role, content }) => ({ role, content })),
  };
}

function pulseRequest(body) {
  if (!str(body.prompt, 8_000)) throw fail(400, 'Missing prompt.');
  return {
    max_tokens: 6_000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12 }],
    messages: [{ role: 'user', content: body.prompt }],
  };
}

async function askClaude(body) {
  const c = await client();
  if (!c) throw fail(503, 'The AI assistant is not configured on this server.');
  if (rateLimited()) throw fail(429, 'Too many requests; try again in a minute.');
  const base = body?.mode === 'pulse' ? pulseRequest(body) : body?.mode === 'chat' ? chatRequest(body) : null;
  if (!base) throw fail(400, 'Unknown mode.');

  const started = Date.now();
  const messages = [...base.messages];
  let res;
  // Web search runs a server-side loop that can pause; send the turn back to resume it.
  for (let round = 0; round < 4; round++) {
    res = await c.beta.messages.create({
      ...base,
      model: MODEL,
      messages,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  if (res.stop_reason === 'refusal') throw fail(422, 'The request could not be answered.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    model: res.model,
    stop: res.stop_reason,
    ms: Date.now() - started,
    usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens },
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req, limit = 300_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw fail(400, 'Body must be JSON.');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (gate) {
      const ok = await verifyAccess(req.headers, gate);
      if (!ok.ok) return send(res, ok.status, { error: ok.reason });
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, ai: Boolean(await client()), model: MODEL });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai') {
      const body = await readJson(req);
      try {
        return send(res, 200, await askClaude(body));
      } catch (err) {
        const status = err.status && err.status < 500 && !(err.status === 401 || err.status === 403) ? err.status : 503;
        if (!err.status || err.status >= 500 || err.status === 401 || err.status === 403) console.error('ai:', err.status || '', err.message);
        return send(res, status, { error: status === 503 ? 'The AI service is unavailable right now.' : err.message });
      }
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, await readFile(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  }
});

server.listen(PORT, HOST, () => console.log(`EmisIQ on http://${HOST}:${PORT} · AI ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off'} · gate ${gate ? 'on' : 'off'}`));
