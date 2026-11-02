import { Server } from 'socket.io';
import { verifyToken, getMembership } from './auth.js';

let io;

export function initRealtime(httpServer, origin) {
  io = new Server(httpServer, { cors: { origin, credentials: true } });

  io.use((socket, next) => {
    try {
      socket.userId = verifyToken(socket.handshake.auth?.token).uid;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // Clients may only join rooms of workspaces they belong to (tenant isolation).
    socket.on('workspace:join', async (wid, ack) => {
      const role = await getMembership(Number(wid), socket.userId);
      if (!role) return ack?.({ ok: false });
      for (const r of socket.rooms) if (r.startsWith('ws:')) socket.leave(r);
      socket.join(`ws:${wid}`);
      ack?.({ ok: true });
    });
  });
  return io;
}

export const emitToWorkspace = (wid, event, payload) => io?.to(`ws:${wid}`).emit(event, payload);
