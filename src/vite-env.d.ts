/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the socket.io server, e.g. https://syncscript.onrender.com */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
