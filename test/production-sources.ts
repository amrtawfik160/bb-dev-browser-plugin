import { readdirSync } from "node:fs";
import { join } from "node:path";

export function productionSources(): string[] {
  const sourceRoot = join(process.cwd(), "src");
  return readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(?:ts|tsx)$/u.test(name))
    .map((name) => join(sourceRoot, name));
}
