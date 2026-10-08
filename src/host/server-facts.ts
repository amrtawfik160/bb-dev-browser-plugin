import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  browserServerFactsSchema,
  type BrowserServerFacts,
} from "../shared/contracts.js";

/**
 * What only the BB server knows and the host needs: whether BB Connect is
 * paired, and where the Browser plugin is installed. The server half sends
 * them (`serverFacts`) and the host keeps them in its own data directory.
 *
 * The host must never read them from the server's database: a second process
 * opening that live WAL database can truncate its shared wal-index and kill
 * the server with SIGBUS.
 */
const SERVER_FACTS_FILE = "server-facts.json";

const UNKNOWN_SERVER_FACTS: BrowserServerFacts = {
  connectEnrolled: false,
  pluginSourcePath: null,
};

export function daemonRootFromHostDataDir(dataDir: string) {
  return resolve(dataDir, "../../..");
}

export async function writeServerFacts(
  dataDir: string,
  facts: BrowserServerFacts,
): Promise<void> {
  const path = join(dataDir, SERVER_FACTS_FILE);
  const staged = `${path}.${process.pid}.tmp`;
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    staged,
    JSON.stringify(browserServerFactsSchema.parse(facts)),
    {
      mode: 0o600,
    },
  );
  await rename(staged, path);
}

/** The last facts the server sent; unknown until it has sent any. */
export function readServerFacts(dataDir: string): BrowserServerFacts {
  try {
    const parsed = browserServerFactsSchema.safeParse(
      JSON.parse(readFileSync(join(dataDir, SERVER_FACTS_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : UNKNOWN_SERVER_FACTS;
  } catch {
    return UNKNOWN_SERVER_FACTS;
  }
}
