/**
 * Mock PMS — a tiny stand-in "Housekeeping Center" so the entire Phase-3
 * write-back loop (locate row -> select status -> save -> verify by re-read)
 * can be proven end-to-end with NO real hotel and NO Claude.
 *
 * Shape mirrors what a real PMS housekeeping page gives us: a table of room
 * rows, each with a status <select> + a Save button that POSTs and re-renders
 * the page from server state (so a re-read genuinely reflects persistence).
 * The seed deliberately includes rooms "10" and "110" so the exact-match
 * row finder's wrong-room guard is exercised against a real DOM.
 *
 * Test-only. Never imported by the worker entrypoint.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

const SEED: Record<string, string> = {
  '10': 'Dirty',
  '110': 'Clean',
  '204': 'Dirty',
  '205': 'Dirty',
  '210': 'Inspected',
};

/** The statuses the mock's <select> offers (PMS display strings). */
export const MOCK_STATUSES = ['Clean', 'Dirty', 'Inspected', 'Out of Order'];

export interface MockPms {
  /** Base URL, e.g. http://127.0.0.1:54321 */
  url: string;
  stop: () => Promise<void>;
  /** Read current persisted status for a room (in-process; for assertions). */
  getStatus: (room: string) => string | undefined;
  /** Reset all rooms to seed state. */
  reset: () => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

export async function startMockPms(): Promise<MockPms> {
  const state = new Map<string, string>(Object.entries(SEED));
  const reset = (): void => {
    state.clear();
    for (const [k, v] of Object.entries(SEED)) state.set(k, v);
  };

  const renderPage = (): string => {
    const rows = [...state.entries()]
      .map(([room, status]) => {
        const options = MOCK_STATUSES.map(
          (s) => `<option value="${escapeHtml(s)}"${s === status ? ' selected' : ''}>${escapeHtml(s)}</option>`,
        ).join('');
        return `<tr data-room="${escapeHtml(room)}">
            <td class="room">${escapeHtml(room)}</td>
            <td class="current" data-room="${escapeHtml(room)}">${escapeHtml(status)}</td>
            <td>
              <form method="POST" action="/set">
                <input type="hidden" name="room" value="${escapeHtml(room)}">
                <select name="status">${options}</select>
                <button type="submit" class="save">Save</button>
              </form>
            </td>
          </tr>`;
      })
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Housekeeping Center</title></head>
      <body>
        <h1 id="hk-title">Housekeeping Center</h1>
        <table id="hk"><tbody>${rows}</tbody></table>
      </body></html>`;
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url === '/' || url.startsWith('/housekeeping'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPage());
      return;
    }

    if (method === 'POST' && url === '/set') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const room = params.get('room') ?? '';
        const status = params.get('status') ?? '';
        // Only mutate known rooms + known statuses (a real PMS rejects junk).
        if (state.has(room) && MOCK_STATUSES.includes(status)) {
          state.set(room, status);
        }
        // Full-page re-render on save (classic PMS behavior) so a re-read
        // genuinely reflects persisted state.
        res.writeHead(303, { Location: '/housekeeping' });
        res.end();
      });
      return;
    }

    if (method === 'POST' && url === '/__reset') {
      reset();
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    getStatus: (room: string) => state.get(room),
    reset,
  };
}
