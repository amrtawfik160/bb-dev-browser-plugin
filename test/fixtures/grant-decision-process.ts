import Database from "better-sqlite3";
import { createGrantRequestStore } from "../../grant-requests.js";

const databasePath = process.env.R9_DECISION_DATABASE_PATH;
const requestId = process.env.R9_DECISION_REQUEST_ID;
if (databasePath === undefined || requestId === undefined) {
  throw new Error("Grant decision process configuration is missing.");
}

const database = new Database(databasePath);
database.pragma("busy_timeout = 5000");
const store = createGrantRequestStore(database, {
  clock: () => new Date("2026-08-28T00:00:00.000Z"),
  idFactory: () => `unused-${process.pid}`,
});

process.send?.({ type: "ready" });
process.once("message", (message) => {
  if (message !== "decide") return;
  process.send?.({ type: "entered" });
  try {
    const response = store.decideRequest({ requestId, decision: "retry" });
    process.send?.({ type: "result", outcome: response.outcome });
  } catch (error) {
    process.send?.({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    database.close();
  }
});
