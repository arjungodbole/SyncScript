import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
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

// --- GitHub OAuth ----------------------------------------------------------

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";
// No default: an unset signing key would silently let anyone forge a session,
// so refuse to start rather than run insecurely.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET is not set");

type GitHubProfile = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
};

// What we put inside the session token. Readable by anyone holding it — a JWT
// is signed, not encrypted — so this must stay limited to public identity.
export type SessionUser = {
  id: number;
  login: string;
  name: string;
  avatar: string;
};

// Step 1 of the dance: hand the browser off to GitHub to get the user's
// approval. Nothing secret is involved, so this is a plain redirect.
app.get("/auth/github", (_req, res) => {
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authorize.searchParams.set("scope", "read:user");
  res.redirect(authorize.toString());
});

// Step 2: GitHub sends the user back here with a short-lived ?code=. Only the
// server can trade that for a real token, because only the server has the
// client secret — which is the whole reason this step isn't done in the browser.
app.get("/auth/github/callback", async (req, res) => {
  const code = req.query.code;
  if (typeof code !== "string") {
    res.status(400).send("Missing ?code");
    return;
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Without this GitHub replies form-encoded and .json() blows up.
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const token = (await tokenRes.json()) as {
      access_token?: string;
      error_description?: string;
    };
    // GitHub reports bad credentials with HTTP 200 and an error body, so the
    // response status is not enough to tell whether this worked.
    if (!token.access_token) {
      throw new Error(token.error_description ?? "no access_token in response");
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        // The GitHub API rejects requests with no User-Agent.
        "User-Agent": "SyncScript",
      },
    });
    if (!userRes.ok) throw new Error(`GET /user returned ${userRes.status}`);
    const profile = (await userRes.json()) as GitHubProfile;

    // `name` is null for accounts that never filled in a display name.
    const displayName = profile.name ?? profile.login;

    const user: SessionUser = {
      id: profile.id,
      login: profile.login,
      name: displayName,
      avatar: profile.avatar_url,
    };
    console.log("GitHub login:", user);

    // From here on GitHub is out of the picture — this token is our own proof
    // of who the user is, and the expiry is inside the signature so it can't
    // be extended by editing the token.
    const session = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });

    // In the fragment, not the query string: fragments are never sent to a
    // server, so the token stays out of access logs and Referer headers.
    res.redirect(`${CLIENT_URL}/#token=${session}`);
  } catch (err) {
    console.error("OAuth callback failed:", err);
    res.status(500).send("Login failed — check the server terminal.");
  }
});

// --- Collaboration ---------------------------------------------------------

// Runs before a socket is allowed to connect at all. A bad or missing token
// means the handshake fails, so nothing below this line ever sees an
// unauthenticated client.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string") {
    next(new Error("unauthorized"));
    return;
  }
  try {
    // Throws on a forged signature or an expired token.
    socket.data.user = jwt.verify(token, JWT_SECRET) as SessionUser;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
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
  const user = socket.data.user as SessionUser;
  console.log(`Connected: ${user.name} (@${user.login}) ${socket.id}`);

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
