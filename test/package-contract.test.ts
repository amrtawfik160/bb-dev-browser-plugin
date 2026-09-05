import { readFile } from "node:fs/promises";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

describe("Browser package contract", () => {
  it("declares the accepted identity, pins, entry points, and skill", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const skill = await readFile("skills/browser/SKILL.md", "utf8");

    expect(packageJson).toMatchObject({
      name: "bb-plugin-browser",
      version: "0.1.0",
      license: "MIT",
      bb: {
        name: "Browser",
        server: "./src/server/server.ts",
        app: "./src/app/app.tsx",
        host: "./src/host/host.ts",
        skills: ["skills"],
      },
      dependencies: { "dev-browser": "0.2.9", playwright: "1.58.2" },
      devDependencies: { "@get-bb/plugin-sdk": "0.4.21" },
    });
    expect(skill).toMatch(/^---\nname: browser\n/);
    expect(packageJson.name.replace(/^bb-plugin-/, "")).toBe("browser");
    expect(packageJson.bb.branding).toEqual({ icon: "Globe" });
  });

  it("uses only public plugin contracts", () => {
    const scan = experimental_scanPublicSdkOnly(".", {
      allow: [
        /^@eslint\/js$/,
        /^@get-bb\/plugin-sdk\/testing(?:\/(?:app|host))?$/,
        /^@testing-library\/react$/,
        /^better-sqlite3$/,
        /^esbuild$/,
        /^react-dom\/client$/,
        /^playwright$/,
        /^react$/,
        /^typescript-eslint$/,
        /^vitest$/,
        /^ws$/,
        /^zod$/,
      ],
    });

    expect(scan.privateDependencies).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
});
