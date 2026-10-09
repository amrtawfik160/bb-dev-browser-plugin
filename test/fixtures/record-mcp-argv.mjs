/* global process */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(
  join(process.env.HOME, "mcp-argv.json"),
  JSON.stringify(process.argv),
);
