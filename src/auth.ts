// Baked in at build time by Vite, so this must be set on the static host that
// builds the frontend — not on the server.
export const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";

export const SIGN_IN_URL = `${SERVER_URL}/auth/github`;

export type SessionUser = {
  id: number;
  login: string;
  name: string;
  avatar: string;
};

export type Session = { token: string; user: SessionUser };

const STORAGE_KEY = "syncscript.token";

// atob yields one byte per character, so a name with non-ASCII characters
// (accents, non-Latin scripts) comes out mangled without this re-decode.
function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = atob(padded);
  return decodeURIComponent(
    Array.from(bytes, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
  );
}

// Reads the payload WITHOUT checking the signature — impossible in the browser
// anyway, since the signing key lives only on the server. That's fine: this
// only decides what to display. The server re-verifies on every socket
// connection, and that check is the one that actually protects anything.
function decodeUser(token: string): SessionUser | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(base64UrlDecode(payload)) as Partial<SessionUser> & {
      exp?: number;
    };
    // Expired tokens are rejected server-side too; catching it here just avoids
    // showing a signed-in header for a session that can't actually connect.
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    if (typeof claims.name !== "string" || typeof claims.login !== "string") {
      return null;
    }
    return {
      id: Number(claims.id),
      login: claims.login,
      name: claims.name,
      avatar: claims.avatar ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Find the session: either fresh out of the #token=... the server just
 * redirected us to, or one saved from a previous visit.
 */
export function loadSession(): Session | null {
  const fromUrl = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (fromUrl) {
    localStorage.setItem(STORAGE_KEY, fromUrl);
    // Scrub the token from the address bar so it isn't left in browser history
    // or copied into a shared link. replaceState avoids adding a history entry.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const token = fromUrl ?? localStorage.getItem(STORAGE_KEY);
  if (!token) return null;

  const user = decodeUser(token);
  if (!user) {
    // Malformed or expired — drop it so we show the sign-in screen instead of
    // retrying a connection that can only fail.
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return { token, user };
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
