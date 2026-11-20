/**
 * Robustness probe for the Node HTTP transport (src/http.ts): a request whose
 * Host header or request target cannot be parsed must never throw out of the
 * request listener (which would take the whole process down before auth).
 * Unparseable targets answer 400 and the server keeps serving.
 *
 * Raw sockets are used because fetch() refuses to send these requests.
 * Regression test for WYREAI-741 (reference fix: halopsa-mcp#113).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect } from 'node:net';
import type { Server } from 'node:http';
import { createBridgeHttpServer, type BridgeHttp } from '../http.js';
import { ChildPool } from '../pool.js';

let bridge: BridgeHttp;
let pool: ChildPool;
let server: Server;
let port: number;

beforeAll(async () => {
  pool = new ChildPool({ upstreamBin: '/nonexistent/nutanix-mcp' });
  // Explicit insecure mode: this suite covers request parsing, not S2S.
  bridge = createBridgeHttpServer(pool, '');
  server = bridge.httpServer;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await bridge.closeMcpHandler();
  await pool.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Send raw HTTP bytes, return the status line and body. */
function rawRequest(payload: string): Promise<{ status: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const [head, body = ''] = data.split('\r\n\r\n');
      resolve({ status: head.split('\r\n')[0], body });
    });
  });
}

const HEALTH = 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n';

describe('malformed requests on the Node HTTP transport (nutanix-mcp)', () => {
  it('serves a request with a malformed Host header and keeps running', async () => {
    const res = await rawRequest('GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
    expect(res.status).toBe('HTTP/1.1 200 OK');
    expect((await rawRequest(HEALTH)).status).toBe('HTTP/1.1 200 OK');
  });

  it('answers 400 for an unparseable request target and keeps running', async () => {
    const res = await rawRequest('GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(res.status).toBe('HTTP/1.1 400 Bad Request');
    expect(res.body).toContain('{"error":"Bad request"}');
    expect((await rawRequest(HEALTH)).status).toBe('HTTP/1.1 200 OK');
  });

  it('serves an HTTP/1.0 request that has no Host header', async () => {
    const res = await rawRequest('GET /health HTTP/1.0\r\n\r\n');
    expect(res.status).toBe('HTTP/1.1 200 OK');
  });
});
