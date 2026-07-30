/**
 * Convergence test for SyncScript.
 *
 * Spawns N simulated clients that all connect to the running Socket.IO server,
 * join the same room, and insert text simultaneously into the same position.
 * Because Yjs is a CRDT, every client must end up with an identical document
 * even though updates arrive in different orders. This script asserts that.
 *
 * It also measures the average binary update payload size, since it sees every
 * update emitted by every client.
 *
 * Usage (server must be running: `npm run server`):
 *   npx tsx scripts/convergence-test.ts [numClients] [editsPerClient]
 *   e.g. npx tsx scripts/convergence-test.ts 50 20
 */

import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";

const SERVER_URL = "http://localhost:3001";
const NUM_CLIENTS = Number(process.argv[2] ?? 50);
const EDITS_PER_CLIENT = Number(process.argv[3] ?? 20);
// Fresh room per run so we never inherit state from a previous run's server doc.
const ROOM_ID = `convergence-${Date.now()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- payload measurement (shared across all clients) ---
let totalUpdateBytes = 0;
let totalUpdateCount = 0;

interface Client {
  id: number;
  socket: Socket;
  doc: Y.Doc;
  text: Y.Text;
  marker: string;
}

/** Wire one simulated client exactly like the real app in src/App.tsx. */
function createClient(id: number): Promise<Client> {
  return new Promise((resolve) => {
    const doc = new Y.Doc();
    const text = doc.getText("monaco");
    const socket = io(SERVER_URL, { forceNew: true });
    const marker = `C${id}|`;

    // Local edits go up; edits tagged "remote" came from the network — don't echo.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      totalUpdateBytes += update.length;
      totalUpdateCount += 1;
      socket.emit("doc-update", update);
    });

    socket.on("doc-sync", (state: ArrayBuffer) => {
      Y.applyUpdate(doc, new Uint8Array(state), "remote");
    });
    socket.on("doc-update", (update: ArrayBuffer) => {
      Y.applyUpdate(doc, new Uint8Array(update), "remote");
    });

    socket.on("connect", () => {
      socket.emit("join", ROOM_ID);
      // Give the join/doc-sync round-trip a beat before we consider the client ready.
      setTimeout(() => resolve({ id, socket, doc, text, marker }), 50);
    });
  });
}

/** Poll until every client's document is identical AND has stopped changing. */
async function waitForConvergence(
  clients: Client[],
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  let last: string[] | null = null;

  while (Date.now() - start < timeoutMs) {
    const strings = clients.map((c) => c.text.toString());
    const allEqual = strings.every((s) => s === strings[0]);
    const settled = last !== null && strings.every((s, i) => s === last![i]);
    if (allEqual && settled) return true; // identical everywhere and no longer moving
    last = strings;
    await sleep(150);
  }
  return false;
}

async function main() {
  console.log(
    `\nConvergence test: ${NUM_CLIENTS} clients x ${EDITS_PER_CLIENT} edits, room "${ROOM_ID}"\n`
  );

  // 1. Connect every client and wait until all have joined + received initial sync.
  const clients = await Promise.all(
    Array.from({ length: NUM_CLIENTS }, (_, i) => createClient(i))
  );
  console.log(`Connected ${clients.length} clients.`);

  // 2. Fire all edits "simultaneously": each client inserts its marker at
  //    position 0, with tiny random jitter so updates genuinely interleave.
  const editTasks: Promise<void>[] = [];
  for (const client of clients) {
    editTasks.push(
      (async () => {
        for (let e = 0; e < EDITS_PER_CLIENT; e++) {
          await sleep(Math.random() * 20);
          client.text.insert(0, client.marker);
        }
      })()
    );
  }
  await Promise.all(editTasks);
  console.log(
    `Applied ${NUM_CLIENTS * EDITS_PER_CLIENT} total edits. Waiting for convergence...`
  );

  // 3. Wait for the system to settle, then verify.
  const converged = await waitForConvergence(clients, 15_000);

  const strings = clients.map((c) => c.text.toString());
  const reference = strings[0];
  const allIdentical = strings.every((s) => s === reference);

  // No edit may be lost: each client's marker must appear exactly EDITS_PER_CLIENT times.
  let noLostEdits = true;
  for (const client of clients) {
    const occurrences = reference.split(client.marker).length - 1;
    if (occurrences !== EDITS_PER_CLIENT) {
      noLostEdits = false;
      console.error(
        `  ✗ marker ${client.marker} appears ${occurrences}x, expected ${EDITS_PER_CLIENT}`
      );
    }
  }

  const expectedLength = clients.reduce(
    (sum, c) => sum + c.marker.length * EDITS_PER_CLIENT,
    0
  );

  // --- report ---
  console.log("\n──────── results ────────");
  console.log(`Clients:            ${NUM_CLIENTS}`);
  console.log(`Edits per client:   ${EDITS_PER_CLIENT}`);
  console.log(`Total edits:        ${NUM_CLIENTS * EDITS_PER_CLIENT}`);
  console.log(`Converged & stable: ${converged ? "yes" : "NO (timed out)"}`);
  console.log(`All docs identical: ${allIdentical ? "yes" : "NO"}`);
  console.log(`No lost edits:      ${noLostEdits ? "yes" : "NO"}`);
  console.log(
    `Doc length:         ${reference.length} (expected ${expectedLength}) ${
      reference.length === expectedLength ? "✓" : "✗"
    }`
  );
  console.log(
    `Avg update payload: ${(totalUpdateBytes / totalUpdateCount).toFixed(
      1
    )} bytes/edit (${totalUpdateCount} updates)`
  );
  console.log("─────────────────────────\n");

  clients.forEach((c) => c.socket.disconnect());

  const pass = converged && allIdentical && noLostEdits;
  console.log(pass ? "PASS ✅\n" : "FAIL ❌\n");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
