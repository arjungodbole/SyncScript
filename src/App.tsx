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
const socket = io("http://localhost:3001");

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

function App() {
  const [users, setUsers] = useState<string[]>([]);

  function handleEditorMount(editor: monaco.editor.IStandaloneCodeEditor) {
    const model = editor.getModel();
    if (!model) return;

    // Passing `awareness` is what turns on cursor tracking: the binding writes
    // our selection into awareness on every cursor move, and renders everyone
    // else's selection as Monaco decorations.
    new MonacoBinding(text, model, new Set([editor]), awareness);
  }

  useEffect(() => {
    // Tell the server which Yjs client we are, so it can evict our cursor from
    // everyone else's editor the moment this socket drops.
    const announce = () => socket.emit("hello", doc.clientID);
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

    socket.on("user-list", (userList: string[]) => {
      setUsers(userList);
    });

    return () => {
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      socket.off("connect", announce);
      socket.off("doc-sync");
      socket.off("doc-update");
      socket.off("awareness");
      socket.off("user-left");
      socket.off("user-list");
    };
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>SyncScript</h1>
        <div className="header-right">
          <span>{users.length} online</span>
          <ul className="user-list">
            {users.map((id) => (
              <li key={id}>{id === socket.id ? "You" : id.slice(0, 6)}</li>
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
