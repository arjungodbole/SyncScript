import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import * as Y from "yjs";

// Where the browser app is served from. Only this origin is allowed to open a
// socket, so it has to be set to the deployed frontend URL in production.
const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5173";
// Hosts like Render assign a port and health-check that exact port, so an
// injected PORT always wins over the local default.
const PORT = Number(process.env.PORT) || 3001;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_URL },
});

// socket.id -> Yjs clientID, so a disconnect can clear that user's cursor
const clientIds = new Map<string, number>();

// roomId -> authoritative document. Created lazily the first time a room is joined.
const docs = new Map<string, Y.Doc>();
function getDoc(roomId: string): Y.Doc {
  let doc = docs.get(roomId);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(roomId, doc);
    // (Step 4: load persisted state here)
  }
  return doc;
}

// roomId -> set of connected socket ids, for the per-room presence list.
const roomUsers = new Map<string, Set<string>>();
function usersIn(roomId: string): Set<string> {
  let set = roomUsers.get(roomId);
  if (!set) {
    set = new Set();
    roomUsers.set(roomId, set);
  }
  return set;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join", (roomId: string) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    // Send the newcomer the full current state so they're instantly in sync.
    socket.emit("doc-sync", Y.encodeStateAsUpdate(getDoc(roomId)));
    // Track presence for this room and tell everyone in it.
    usersIn(roomId).add(socket.id);
    io.to(roomId).emit("user-list", Array.from(usersIn(roomId)));
  });

  socket.on("hello", (clientId: number) => {
    clientIds.set(socket.id, clientId);
  });

  socket.on("doc-update", (update) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    Y.applyUpdate(getDoc(roomId), new Uint8Array(update)); // keep server authoritative
    socket.to(roomId).emit("doc-update", update); // relay to everyone else in the room
  });

  // Awareness (cursors, selections, names) is ephemeral — the server just
  // relays it within the room and keeps no state of its own.
  socket.on("awareness", (update) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    socket.to(roomId).emit("awareness", update);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId as string | undefined;
    const clientId = clientIds.get(socket.id);
    if (roomId) {
      if (clientId !== undefined) {
        socket.to(roomId).emit("user-left", clientId);
      }
      usersIn(roomId).delete(socket.id);
      io.to(roomId).emit("user-list", Array.from(usersIn(roomId)));
    }
    clientIds.delete(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}, allowing origin ${CLIENT_URL}`);
});
