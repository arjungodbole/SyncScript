# SyncScript

A real-time collaborative code editor. Two people can type in the same line at the same time and the document always converges — plus live cursors showing where everyone is.

Built with **Monaco** (the editor from VS Code) for editing, **Yjs** (a CRDT) for conflict-free merging, and a **custom Socket.IO provider** that relays binary document updates through an authoritative server.

> **Why this is interesting:** most "collaborative" demos just broadcast text, which races and loses edits when two people type at once. SyncScript uses a CRDT, so concurrent edits *commute* — every client converges to the same document regardless of the order updates arrive.

---

## Demo

Open the app in two browser windows side by side at the same room URL (e.g. `/doc/alpha`), then type in both — including on the same line. Both converge, and you'll see each other's cursors in real time.

<!-- TODO: add a GIF of two windows editing the same line, and a live deploy link here -->

---

## Architecture

```
 Client A (Monaco)                          Client B (Monaco)
   │  MonacoBinding                            │  MonacoBinding
   ▼                                            ▼
 Y.Doc  ──update──►  socket.emit ──►  ┌─────────────────┐  ◄── socket.emit ── Y.Doc
   ▲                                  │  Express +      │                       ▲
   └──── applyUpdate ◄── socket.on ◄──│  Socket.IO      │── socket.to(room) ────┘
                                      │  authoritative  │
                                      │  Y.Doc per room │
                                      └─────────────────┘
```

- **Client** — Monaco is bound to a Yjs document via `MonacoBinding`. Every local edit produces a small binary update that is emitted over Socket.IO; updates from others are applied back into the same Yjs doc, which Monaco mirrors automatically.
- **Server** — Express + Socket.IO holds one authoritative `Y.Doc` per room. It applies every update to stay authoritative and relays it to the rest of the room. On join it sends the newcomer the full encoded state, so late-joiners and reconnecting clients catch up instantly.

## How sync works

| Concern | Approach |
| --- | --- |
| **Concurrent edits to the same spot** | Yjs represents the document as a CRDT. Concurrent operations commute, so all clients converge to identical state regardless of arrival order — no manual conflict resolution. |
| **Late join / reconnect** | The server keeps an authoritative `Y.Doc` per room and sends `Y.encodeStateAsUpdate(doc)` on `join`, so a client is fully caught up the moment it connects. |
| **Echo loops** | Updates that arrive from the network are applied with a `"remote"` origin tag; the client only re-emits updates whose origin is *not* `"remote"`, so a received edit is never bounced back. |
| **Live cursors / presence** | The Yjs *awareness* protocol carries ephemeral per-user state (cursor, selection, name, color). `y-monaco` renders remote cursors from it; the server relays awareness within the room and never persists it. |
| **Multiple documents** | The room comes from the URL path (`/doc/:id`). Each room is an independent `Y.Doc` and Socket.IO room, so edits and presence are scoped to that document. |

### What I built vs. what I used

- **Yjs provides** the CRDT and the awareness protocol.
- **I built** the Socket.IO transport/provider (client and server), the authoritative per-room server `Y.Doc`, the join/sync catch-up flow, per-room presence tracking, and the cursor-eviction-on-disconnect logic.

---

## Tech stack

- **Frontend:** React 19, TypeScript, Vite, `@monaco-editor/react`
- **Collaboration:** Yjs, `y-monaco`, `y-protocols` (awareness)
- **Backend:** Node.js, Express 5, Socket.IO (binary `Uint8Array` transport)

## Getting started

### Prerequisites
- Node.js 18+

### Install
```bash
npm install
```

### Run (two terminals)
```bash
npm run server   # Socket.IO + Express server on http://localhost:3001
npm run dev      # Vite dev server on http://localhost:5173
```

Then open **http://localhost:5173/doc/alpha** in two windows and start typing. Open **/doc/beta** to see an independent, isolated document.

### Other scripts
```bash
npm run build    # type-check + production build
npm run preview  # preview the production build
npm run lint     # ESLint
```

---

## Project structure

```
my-app/
├─ server/
│  └─ index.ts        # Express + Socket.IO, authoritative Y.Doc per room
├─ src/
│  ├─ App.tsx         # Monaco editor, MonacoBinding, socket relay, awareness/cursors
│  └─ main.tsx
└─ ...
```

## Roadmap

- **Persistence** — the server's per-room docs currently live in memory, so a restart loses them. Next: debounced save of `Y.encodeStateAsUpdate(doc)` per room to disk (or Postgres `bytea`), loaded back in on room creation.
- **Deploy** — host the client (e.g. Vercel) and the Socket.IO server (e.g. Render/Railway/Fly) and put a live link at the top of this README.
- **Horizontal scaling** — a single server is the bottleneck; a shared backend (e.g. the Socket.IO Redis adapter) would let multiple server instances share a room.
- **Offline support** — `y-indexeddb` for local persistence and offline edits that sync on reconnect.
