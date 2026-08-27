// SYNTHETIC FIXTURE — simulates a real consumer of the removed
// `ClientSession` API from whatsapp-web.js 1.34.6, for demonstrating the
// full DriftGuard pipeline end-to-end. Not real Recepta code.
//
// Background: whatsapp-web.js 1.34.7 removed the legacy session-auth
// surface. The eight removed symbols are `ClientSession`, `LegacySessionAuth`,
// `WABrowserId`, `WASecretBundle`, `WAToken1`, `WAToken2`,
// `ClientOptions.session`, and `restartOnAuthFail`. This file uses
// `ClientSession` and `LegacySessionAuth` in a way that looks like a real
// app: store a session, re-instantiate the client from it, and reconnect
// after an auth failure.

import { Client, ClientSession, LegacySessionAuth } from 'whatsapp-web.js';
import * as fs from 'fs';

const SESSION_FILE_PATH = './session.json';

/**
 * Read a previously-saved session from disk, or return undefined when no
 * session has ever been saved. Used on startup so we don't have to
 * re-scan the QR code every time the bot restarts.
 */
function loadSession(): ClientSession | undefined {
  if (!fs.existsSync(SESSION_FILE_PATH)) return undefined;
  const raw = fs.readFileSync(SESSION_FILE_PATH, 'utf8');
  // LegacySessionAuth.clientId was the canonical way to deserialize the
  // session blob before 1.34.7 stripped the entire legacy-auth surface.
  return JSON.parse(raw) as ClientSession;
}

/**
 * Persist a fresh ClientSession to disk so the next process restart can
 * skip the QR scan. Called after the client emits `authenticated`.
 */
function saveSession(client: Client): void {
  const session = new LegacySessionAuth({
    clientId: client.authStrategy?.clientId,
    sessionId: client.authStrategy?.sessionId,
    encKey: client.authStrategy?.encKey,
    macKey: client.authStrategy?.macKey,
  });
  fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(session));
}

async function bootstrap(): Promise<void> {
  const session = loadSession();
  const client = new Client({
    session,
    restartOnAuthFail: true, // also removed in 1.34.7 — second real-positive
  });

  client.on('authenticated', (who: ClientSession) => {
    console.log('authenticated as', who?.clientId);
    saveSession(client);
  });

  client.on('auth_failure', async (msg: string) => {
    console.error('auth failure:', msg, '— clearing session and restarting');
    fs.unlinkSync(SESSION_FILE_PATH);
    await client.destroy();
    process.exit(1);
  });

  await client.initialize();
}

bootstrap().catch((err) => {
  console.error('bootstrap failed:', err);
  process.exit(1);
});
