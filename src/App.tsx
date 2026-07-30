import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import Editor from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import "./App.css";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness.js";

const doc = new Y.Doc();
const text = doc.getText("monaco");
const awareness = new Awareness(doc);
// Baked in at build time by Vite, so this must be set on the static host that
// builds the frontend — not on the server.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
const socket = io(SERVER_URL);

// Room comes from the URL path: /doc/:id  ->  "room-1" by default.
const roomId = window.location.pathname.split("/")[2] || "room-1";

const USER_NAME = "Anonymous " + Math.floor(Math.random() * 100);
const USER_COLOR =
  "#" +
  Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");

awareness.setLocalStateField("user", { name: USER_NAME, color: USER_COLOR });

const styleEl = document.createElement("style");
document.head.appendChild(styleEl);
const styledClients = new Set<number>();

function ensureCursorStyles() {
  awareness.getStates().forEach((state, clientID) => {
    if (clientID === doc.clientID || styledClients.has(clientID)) return;
    const user = state.user as { name: string; color: string } | undefined;
    if (!user) return;

    styledClients.add(clientID);
    styleEl.sheet?.insertRule(
      `.yRemoteSelection-${clientID} { background-color: ${user.color}55; }`
    );
    styleEl.sheet?.insertRule(
      `.yRemoteSelectionHead-${clientID} { border-left: 2px solid ${user.color}; }`
    );
    styleEl.sheet?.insertRule(
      `.yRemoteSelectionHead-${clientID}::after { background-color: ${user.color}; content: "${user.name}"; }`
    );
  });
}

type Peer = { clientID: number; name: string; color: string };

function App() {
  const [peers, setPeers] = useState<Peer[]>([]);

  function handleEditorMount(editor: monaco.editor.IStandaloneCodeEditor) {
    const model = editor.getModel();
    if (!model) return;

    // Passing `awareness` is what turns on cursor tracking: the binding writes
    // our selection into awareness on every cursor move, and renders everyone
    // else's selection as Monaco decorations.
    new MonacoBinding(text, model, new Set([editor]), awareness);
  }

  useEffect(() => {
    // On (re)connect: join our room so the server sends us its state, then tell
    // it which Yjs client we are, so it can evict our cursor when this socket drops.
    const announce = () => {
      socket.emit("join", roomId);
      socket.emit("hello", doc.clientID);
    };
    socket.on("connect", announce);
    if (socket.connected) announce();

    // --- document ---
    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      socket.emit("doc-update", update);
    };
    doc.on("update", onDocUpdate);

    socket.on("doc-update", (update) => {
      Y.applyUpdate(doc, new Uint8Array(update), "remote");
    });
    socket.on("doc-sync", (update) => {
      Y.applyUpdate(doc, new Uint8Array(update), "remote");
    });

    // --- cursors / presence ---
    const onAwarenessUpdate = (
      {
        added,
        updated,
        removed,
      }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ) => {
      ensureCursorStyles();
      if (origin === "remote") return;
      const changed = [...added, ...updated, ...removed];
      socket.emit("awareness", encodeAwarenessUpdate(awareness, changed));
    };
    awareness.on("update", onAwarenessUpdate);

    socket.on("awareness", (payload) => {
      applyAwarenessUpdate(awareness, new Uint8Array(payload), "remote");
    });

    socket.on("user-left", (clientID: number) => {
      removeAwarenessStates(awareness, [clientID], "remote");
      styledClients.delete(clientID);
    });

    // The presence list is derived from awareness — the same source that labels
    // the cursors — so the header and the editor can never disagree about who
    // is here. "change" fires only when a state is actually added/removed or
    // its contents differ, so this doesn't re-render on every keystroke.
    const onAwarenessChange = () => {
      const next: Peer[] = [];
      awareness.getStates().forEach((state, clientID) => {
        const user = state.user as { name: string; color: string } | undefined;
        if (user) next.push({ clientID, ...user });
      });
      // Keep ourselves pinned first, then alphabetical, so entries don't shuffle
      // around as people join and leave.
      next.sort((a, b) => {
        if (a.clientID === doc.clientID) return -1;
        if (b.clientID === doc.clientID) return 1;
        return a.name.localeCompare(b.name);
      });
      setPeers(next);
    };
    awareness.on("change", onAwarenessChange);
    onAwarenessChange(); // seed with what's already known (at minimum, ourselves)

    return () => {
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      awareness.off("change", onAwarenessChange);
      socket.off("connect", announce);
      socket.off("doc-sync");
      socket.off("doc-update");
      socket.off("awareness");
      socket.off("user-left");
    };
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>SyncScript</h1>
        <div className="header-right">
          <span>{peers.length} online</span>
          <ul className="user-list">
            {peers.map((peer) => (
              <li key={peer.clientID}>
                <span
                  className="user-dot"
                  style={{ backgroundColor: peer.color }}
                />
                {peer.name}
                {peer.clientID === doc.clientID && " (you)"}
              </li>
            ))}
          </ul>
        </div>
      </header>
      <div className="main">
        <div className="editor-container">
          <Editor
            height="calc(100vh - 48px)"
            defaultLanguage="javascript"
            theme="vs-dark"
            defaultValue=""
            onMount={handleEditorMount}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
