import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import * as Y from "yjs";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "http://localhost:5173" },
});

const users = new Set<string>();
// socket.id -> Yjs clientID, so a disconnect can clear that user's cursor
const clientIds = new Map<string, number>();

const doc = new Y.Doc();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.emit("doc-sync", Y.encodeStateAsUpdate(doc));
  users.add(socket.id);
  io.emit("user-list", Array.from(users));

  socket.on("hello", (clientId: number) => {
    clientIds.set(socket.id, clientId);
  });

  socket.on("doc-update", (update) => {
    Y.applyUpdate(doc, new Uint8Array(update));
    socket.broadcast.emit("doc-update", update);
  });

  // Awareness (cursors, selections, names) is ephemeral — the server just
  // relays it and keeps no state of its own.
  socket.on("awareness", (update) => {
    socket.broadcast.emit("awareness", update);
  });

  socket.on("disconnect", () => {
    const clientId = clientIds.get(socket.id);
    if (clientId !== undefined) {
      socket.broadcast.emit("user-left", clientId);
      clientIds.delete(socket.id);
    }
    users.delete(socket.id);
    io.emit("user-list", Array.from(users));
  });
});

httpServer.listen(3001, () => {
  console.log("Server running on http://localhost:3001");
});
