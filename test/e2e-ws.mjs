// One-off end-to-end WebSocket smoke test (run with the server up).
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';

const { sessionId, hostToken } = JSON.parse(readFileSync('/tmp/zlt-session.json', 'utf8'));

const timeout = setTimeout(() => {
  console.log('TIMEOUT-FAIL');
  process.exit(1);
}, 8000);

let translations = 0;

const viewer = new WebSocket(`ws://localhost:3000/ws/live?session=${sessionId}`);
const seen = [];
viewer.on('message', (m) => {
  const t = JSON.parse(m.toString());
  seen.push(t);
  console.log(`viewer <- ${t.type}${t.sequence !== undefined ? ` seq=${t.sequence}` : ''}` +
    (t.language ? ` ${t.language}` : '') + (t.text !== undefined ? ` ${JSON.stringify(t.text)}` : '') +
    (t.message ? ` "${t.message}"` : ''));
  if (t.type === 'translation') translations++;
  if (t.type === 'session_stopped') {
    // Verify ordering: source seq 1 broadcast before its translation.
    const srcIdx = seen.findIndex((s) => s.type === 'source' && s.sequence === 1 && !s.interim);
    const trIdx = seen.findIndex((s) => s.type === 'translation' && s.sequence === 1);
    console.log('ORDER OK:', srcIdx !== -1 && trIdx !== -1 && trIdx > srcIdx,
      '| translations:', translations, '/ 4 expected');
    clearTimeout(timeout);
    setTimeout(() => process.exit(0), 200);
  }
});

const bad = new WebSocket(`ws://localhost:3000/ws/host?session=${sessionId}&token=WRONG`);
bad.on('message', (m) => {
  console.log('bad-token ->', m.toString());
  bad.close();
});
bad.on('error', () => {});

setTimeout(() => {
  const host = new WebSocket(`ws://localhost:3000/ws/host?session=${sessionId}&token=${hostToken}`);
  host.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    console.log(`host <- ${msg.type}`);
    if (msg.type === 'session_joined') {
      host.send(JSON.stringify({ type: 'final_text', text: "Dr. Smith is joining us. Let's begin." }));
      // End the session after translations have had time to flow.
      setTimeout(() => host.send(JSON.stringify({ type: 'stop_session' })), 2500);
    }
  });
  host.on('error', () => {});
}, 400);
