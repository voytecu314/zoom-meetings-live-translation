// Integration tests for the live path: host → server → viewer over real
// WebSockets (mock translation provider, no network).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { config } from '../server/config.js';
import { createSession, __resetAll } from '../server/sessions.js';
import { setupWebSocket } from '../server/websocket.js';
import { normalize } from '../server/translation/google-translate.js';
import { translateText, __setProviderForTests } from '../server/translation/index.js';
import { createMockProvider } from '../server/translation/mock.js';

let server;
let wsServer;
let port;

before(async () => {
  config.segmentation.pauseThresholdMs = 300; // fast idle flush for tests
  config.ws.maxConnectionsPerIp = 6;
  __setProviderForTests(createMockProvider());
  server = http.createServer();
  wsServer = setupWebSocket(server, server).wss;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  __resetAll();
  for (const c of wsServer.clients) c.terminate();
  await new Promise((r) => wsServer.close(r)); // also stops heartbeat/cleanup intervals
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const open = (path) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.messages = [];
  ws.on('message', (m) => ws.messages.push(JSON.parse(m.toString())));
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const translations = (ws) => ws.messages.filter((m) => m.type === 'translation');

test('unpunctuated speech is translated while capture is still running', async () => {
  const s = createSession({ sourceLanguage: 'en-US', targetLanguages: ['de'] });
  const viewer = await open(`/ws/live?session=${s.id}`);
  const host = await open(`/ws/host?session=${s.id}&token=${s.hostToken}`);

  // No punctuation, never sends stop_capture.
  host.send(JSON.stringify({ type: 'start_capture' }));
  host.send(JSON.stringify({ type: 'final_text', text: 'so today we are going to talk about the new roadmap' }));
  await sleep(250);
  assert.ok(translations(viewer).length >= 1, 'long clause streams immediately');

  // A short phrase must not wait for stop either: idle flush kicks in.
  host.send(JSON.stringify({ type: 'final_text', text: 'any questions' }));
  await sleep(700);
  const all = translations(viewer).map((t) => t.text).join(' | ');
  assert.match(all, /any questions/);
  host.close(); viewer.close();
});

test('legitimate repeated words are not swallowed by dedupe', async () => {
  const s = createSession({ sourceLanguage: 'en-US', targetLanguages: ['de'] });
  const viewer = await open(`/ws/live?session=${s.id}`);
  const host = await open(`/ws/host?session=${s.id}&token=${s.hostToken}`);
  host.send(JSON.stringify({ type: 'final_text', text: 'Thank you.' }));
  host.send(JSON.stringify({ type: 'final_text', text: 'Thank you.' }));
  await sleep(300);
  const sources = viewer.messages.filter((m) => m.type === 'source' && !m.interim);
  assert.equal(sources.length, 2);
  host.close(); viewer.close();
});

test('rejected connections do not leak per-IP slots', async () => {
  // limit is 6; hammer a non-existent session far more often than that
  for (let i = 0; i < 20; i++) {
    const ws = await open('/ws/live?session=doesnotexist');
    await new Promise((r) => ws.once('close', r));
  }
  await sleep(50);
  const s = createSession({ sourceLanguage: 'en-US', targetLanguages: ['de'] });
  const viewer = await open(`/ws/live?session=${s.id}`); // must still be accepted
  await sleep(100);
  assert.equal(viewer.messages[0].type, 'session_joined');
  viewer.close();
});

test('failed attach closes with a fatal code so clients stop retrying', async () => {
  const ws = await open('/ws/live?session=nope');
  const code = await new Promise((r) => ws.once('close', (c) => r(c)));
  assert.equal(code, 4404);
});

test('host can reconnect while the old socket is still attached', async () => {
  const s = createSession({ sourceLanguage: 'en-US', targetLanguages: ['de'] });
  const host1 = await open(`/ws/host?session=${s.id}&token=${s.hostToken}`);
  const host2 = await open(`/ws/host?session=${s.id}&token=${s.hostToken}`);
  await sleep(100);
  assert.equal(host2.messages[0].type, 'session_joined');
  await new Promise((r) => (host1.readyState === WebSocket.CLOSED ? r() : host1.once('close', r)));
  host2.close();
});

test('stop_capture still flushes the trailing fragment', async () => {
  const s = createSession({ sourceLanguage: 'en-US', targetLanguages: ['de'] });
  const viewer = await open(`/ws/live?session=${s.id}`);
  const host = await open(`/ws/host?session=${s.id}&token=${s.hostToken}`);
  host.send(JSON.stringify({ type: 'final_text', text: 'last words' }));
  host.send(JSON.stringify({ type: 'stop_capture' }));
  await sleep(250);
  assert.match(translations(viewer).map((t) => t.text).join(' '), /last words/);
  host.close(); viewer.close();
});

test('google code mapping + same-language shortcut', async () => {
  assert.equal(normalize('zh'), 'zh-CN');
  assert.equal(normalize('zh-TW'), 'zh-TW');
  assert.equal(normalize('en-US'), 'en');
  assert.equal(normalize('pl-PL'), 'pl');
  const r = await translateText('Hello there', 'en-US', 'en');
  assert.deepEqual(r, { ok: true, text: 'Hello there' });
});
