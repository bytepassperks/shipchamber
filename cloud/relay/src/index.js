// ShipChamber private relay (Layer 1 only). One Durable Object per host
// `serverId` brokers a single signed `host-control` socket, per-client
// `host-data` sockets, and `client` sockets; frames are forwarded verbatim.
// The relay never sees plaintext: Layers 2-3 are end-to-end encrypted.

import { DurableObject } from 'cloudflare:workers';

const PROTOCOL_VERSION = '1';
const AUTH_SKEW_MS = 5 * 60 * 1000;
const MAX_CLIENTS_PER_HOST = 32;
const MAX_PENDING_FRAMES = 64;

const CloseCode = {
  ControlReplaced: 4001,
  DuplicateClient: 4002,
  HostUnavailable: 4008,
  AuthFailed: 4010,
  LimitExceeded: 4029,
};

const b64urlToBytes = (value) => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const bytesToB64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// pk = base64url(JSON {crv,kty,x,y}); serverId = base64url(sha256(that JSON));
// sig = ECDSA P-256 / SHA-256 (P1363) over `${ts}.${serverId}.${role}.${connectionId ?? ''}`.
const verifyHostAuth = async ({ serverId, role, connectionId, ts, sig, pk }) => {
  if (!serverId || !ts || !sig || !pk) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > AUTH_SKEW_MS) return false;

  let jwkText;
  let jwk;
  try {
    jwkText = new TextDecoder().decode(b64urlToBytes(pk));
    jwk = JSON.parse(jwkText);
  } catch {
    return false;
  }
  if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256') return false;

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jwkText)));
  if (bytesToB64url(digest) !== serverId) return false;

  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const message = new TextEncoder().encode(`${ts}.${serverId}.${role}.${connectionId ?? ''}`);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(sig), message);
  } catch {
    return false;
  }
};

// Complete the upgrade, then close with a protocol code so clients can tell a
// terminal refusal apart from a transient network failure.
const rejectUpgrade = (code, reason) => {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
};

const tagOf = (role, connectionId) => (connectionId ? `${role}:${connectionId}` : role);

export class RelayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Client frames that arrive before the host-data socket attaches. Lost on
    // hibernation, which is fine: the client re-sends its hello on a timer.
    this.pending = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const connectionId = url.searchParams.get('connectionId');

    if (role === 'host-control') return this.acceptHostControl();
    if (role === 'host-data') return this.acceptHostData(connectionId);
    if (role === 'client') return this.acceptClient();
    return new Response('bad role', { status: 400 });
  }

  sockets(tag) {
    return this.ctx.getWebSockets(tag);
  }

  control() {
    return this.sockets('host-control')[0] ?? null;
  }

  activeConnectionIds() {
    const ids = [];
    for (const ws of this.sockets('client')) {
      const meta = ws.deserializeAttachment();
      if (meta?.connectionId) ids.push(meta.connectionId);
    }
    return ids;
  }

  notifyControl(message) {
    const control = this.control();
    if (!control) return;
    try {
      control.send(JSON.stringify(message));
    } catch {
      // Control is gone; the host will reconnect and receive a `sync`.
    }
  }

  acceptHostControl() {
    for (const previous of this.sockets('host-control')) {
      previous.close(CloseCode.ControlReplaced, 'Control replaced');
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ role: 'host-control' });
    this.ctx.acceptWebSocket(server, ['host-control']);
    server.send(JSON.stringify({ type: 'sync', connectionIds: this.activeConnectionIds() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  acceptHostData(connectionId) {
    if (!connectionId) return new Response('connectionId required', { status: 400 });
    const peer = this.sockets(tagOf('client', connectionId))[0];
    if (!peer) return new Response('no such client', { status: 404 });
    for (const previous of this.sockets(tagOf('host-data', connectionId))) {
      previous.close(CloseCode.DuplicateClient, 'Data socket replaced');
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ role: 'host-data', connectionId });
    this.ctx.acceptWebSocket(server, ['host-data', tagOf('host-data', connectionId)]);

    const queued = this.pending.get(connectionId);
    if (queued) {
      this.pending.delete(connectionId);
      for (const frame of queued) server.send(frame);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  acceptClient() {
    if (!this.control()) return rejectUpgrade(CloseCode.HostUnavailable, 'Host unavailable');
    if (this.sockets('client').length >= MAX_CLIENTS_PER_HOST) return rejectUpgrade(CloseCode.LimitExceeded, 'Too many clients');
    const connectionId = crypto.randomUUID();
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ role: 'client', connectionId });
    this.ctx.acceptWebSocket(server, ['client', tagOf('client', connectionId)]);
    this.notifyControl({ type: 'connected', connectionId });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment();
    if (!meta) return;
    if (meta.role === 'host-control') return; // control is relay -> host only
    const peerRole = meta.role === 'client' ? 'host-data' : 'client';
    const peer = this.sockets(tagOf(peerRole, meta.connectionId))[0];
    if (peer) {
      try {
        peer.send(message);
      } catch {
        ws.close(CloseCode.HostUnavailable, 'peer gone');
      }
      return;
    }
    if (meta.role === 'client') {
      const queue = this.pending.get(meta.connectionId) ?? [];
      if (queue.length < MAX_PENDING_FRAMES) queue.push(message);
      this.pending.set(meta.connectionId, queue);
    }
  }

  webSocketClose(ws, code, reason) {
    this.teardown(ws, code, reason);
  }

  webSocketError(ws) {
    this.teardown(ws, 1011, 'error');
  }

  teardown(ws, code, reason) {
    const meta = ws.deserializeAttachment();
    try {
      ws.close(code >= 1000 && code < 5000 ? code : 1000, String(reason ?? '').slice(0, 100));
    } catch {
      // Already closed.
    }
    if (!meta) return;

    if (meta.role === 'host-control') {
      // Host went away: every client loses its path.
      for (const client of this.sockets('client')) client.close(CloseCode.HostUnavailable, 'Host disconnected');
      for (const data of this.sockets('host-data')) data.close(1000, 'Host control closed');
      this.pending.clear();
      return;
    }

    const { connectionId } = meta;
    this.pending.delete(connectionId);
    if (meta.role === 'client') {
      for (const data of this.sockets(tagOf('host-data', connectionId))) data.close(1000, 'Client disconnected');
      this.notifyControl({ type: 'disconnected', connectionId });
    } else if (meta.role === 'host-data') {
      for (const client of this.sockets(tagOf('client', connectionId))) client.close(CloseCode.HostUnavailable, 'Host data closed');
    }
  }
}

const upgradeRefused = (status, text) => new Response(text, { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'shipchamber-relay' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname !== '/ws') return upgradeRefused(404, 'not found');
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return upgradeRefused(426, 'websocket required');

    const v = url.searchParams.get('v');
    const role = url.searchParams.get('role');
    const serverId = url.searchParams.get('serverId');
    const connectionId = url.searchParams.get('connectionId');
    if (v !== PROTOCOL_VERSION) return upgradeRefused(400, 'unsupported protocol version');
    if (!serverId || !/^[A-Za-z0-9_-]{20,128}$/.test(serverId)) return upgradeRefused(400, 'bad serverId');

    if (role === 'host-control' || role === 'host-data') {
      const ok = await verifyHostAuth({
        serverId,
        role,
        connectionId,
        ts: url.searchParams.get('ts'),
        sig: url.searchParams.get('sig'),
        pk: url.searchParams.get('pk'),
      });
      if (!ok) return rejectUpgrade(CloseCode.AuthFailed, 'Authentication failed');
    } else if (role !== 'client') {
      return upgradeRefused(400, 'bad role');
    }

    const id = env.RELAY_ROOM.idFromName(serverId);
    return env.RELAY_ROOM.get(id).fetch(request);
  },
};
