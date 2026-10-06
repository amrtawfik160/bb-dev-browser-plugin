/**
 * Browser Commands: the agent-ergonomic way to drive a Workspace Browser,
 * modelled on chrome-devtools-axi. An agent sends one short command
 * ("open https://example.com", "click @g2:e5", "fill @g2:e7 hello") and gets
 * back the page, a compact accessibility snapshot whose interactive elements
 * carry refs, and the next commands it could run.
 *
 * Each command compiles to an ordinary Browser Script, so grants, Origin
 * Scope, the agent's own tab and lane, and Activity Records apply unchanged.
 */

export const BROWSER_COMMAND_NAMES = [
  "open",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "type",
  "press",
  "hover",
  "select",
  "scroll",
  "back",
  "wait",
  "eval",
] as const;

export type BrowserCommandName = (typeof BROWSER_COMMAND_NAMES)[number];

export type BrowserCommandRef = { generation: number; ref: string };

export type BrowserCommand =
  | { name: "open"; url: string }
  | { name: "snapshot" }
  | { name: "screenshot" }
  | { name: "click" | "hover"; target: BrowserCommandRef }
  | { name: "fill" | "select"; target: BrowserCommandRef; text: string }
  | { name: "type"; text: string }
  | { name: "press"; key: string }
  | { name: "scroll"; direction: "up" | "down" | "top" | "bottom" }
  | { name: "back" }
  | { name: "wait"; ms: number }
  | { name: "wait"; text: string }
  | { name: "eval"; expression: string };

export class BrowserCommandError extends Error {
  constructor(
    public readonly code: "invalid_command" | "stale_ref",
    message: string,
  ) {
    super(message);
    this.name = "BrowserCommandError";
  }
}

/** Longest wait a command may request; the script deadline bounds the rest. */
const MAX_WAIT_MS = 20_000;
/** Snapshot lines shown before the rest is summarised. */
const MAX_SNAPSHOT_LINES = 400;
/** Next-step hints offered after a snapshot. */
const MAX_HINTS = 3;

/** Roles an agent can act on; only these carry refs in the output. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const FILLABLE_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
]);

const RESULT_MARKER = "__bbBrowserCommand:";

/** Split a command line into words, keeping quoted text together. */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote !== null) {
      if (character === "\\" && input[index + 1] === quote) {
        current += quote;
        index += 1;
      } else if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== null) {
    throw new BrowserCommandError(
      "invalid_command",
      "A quoted value is missing its closing quote.",
    );
  }
  if (started) tokens.push(current);
  return tokens;
}

function parseRef(
  word: string | undefined,
  command: string,
): BrowserCommandRef {
  const match = word === undefined ? null : /^@g(\d+):(e\d+)$/.exec(word);
  if (match === null) {
    throw new BrowserCommandError(
      "invalid_command",
      `${command} needs a ref exactly as printed in the last snapshot, such as @g1:e5.`,
    );
  }
  return { generation: Number(match[1]), ref: match[2]! };
}

function rest(tokens: string[], from: number, what: string, command: string) {
  const value = tokens.slice(from).join(" ");
  if (value.length === 0) {
    throw new BrowserCommandError(
      "invalid_command",
      `${command} needs ${what}.`,
    );
  }
  return value;
}

/**
 * Read one command. `eval` keeps everything after the word as written, so
 * JavaScript with spaces and quotes needs no extra quoting.
 */
export function parseBrowserCommand(input: string): BrowserCommand {
  const trimmed = input.trim();
  const name = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (name === "eval") {
    const expression = trimmed.slice(4).trim();
    if (expression.length === 0) {
      throw new BrowserCommandError(
        "invalid_command",
        "eval needs a JavaScript expression or function.",
      );
    }
    return { name: "eval", expression };
  }
  const tokens = tokenizeCommand(trimmed);
  switch (name) {
    case "open": {
      const url = rest(tokens, 1, "an http(s) URL", "open");
      if (!/^https?:\/\//i.test(url)) {
        throw new BrowserCommandError(
          "invalid_command",
          "open needs an http(s) URL, such as https://example.com.",
        );
      }
      return { name: "open", url };
    }
    case "snapshot":
    case "screenshot":
    case "back":
      return { name };
    case "click":
    case "hover":
      return { name, target: parseRef(tokens[1], name) };
    case "fill":
    case "select":
      return {
        name,
        target: parseRef(tokens[1], name),
        text: tokens.slice(2).join(" "),
      };
    case "type":
      return { name: "type", text: rest(tokens, 1, "text to type", "type") };
    case "press":
      return {
        name: "press",
        key: rest(tokens, 1, "a key, such as Enter", "press"),
      };
    case "scroll": {
      const direction = tokens[1]?.toLowerCase();
      if (
        direction !== "up" &&
        direction !== "down" &&
        direction !== "top" &&
        direction !== "bottom"
      ) {
        throw new BrowserCommandError(
          "invalid_command",
          "scroll needs up, down, top, or bottom.",
        );
      }
      return { name: "scroll", direction };
    }
    case "wait": {
      const value = rest(tokens, 1, "milliseconds or text to wait for", "wait");
      if (/^\d+$/.test(value)) {
        return { name: "wait", ms: Math.min(Number(value), MAX_WAIT_MS) };
      }
      return { name: "wait", text: value };
    }
    default:
      throw new BrowserCommandError(
        "invalid_command",
        `Unknown command "${name}". Use one of: ${BROWSER_COMMAND_NAMES.join(", ")}.`,
      );
  }
}

/** Commands whose ref must come from the session's latest snapshot. */
export function commandRef(
  command: BrowserCommand,
): BrowserCommandRef | undefined {
  return "target" in command ? command.target : undefined;
}

/** Plain-language purpose shown to the owner while the command runs. */
export function commandPurpose(command: BrowserCommand): string {
  switch (command.name) {
    case "open":
      return `Open ${command.url}`.slice(0, 200);
    case "snapshot":
      return "Read the page";
    case "screenshot":
      return "Take a screenshot";
    case "click":
      return "Click an element";
    case "hover":
      return "Hover over an element";
    case "fill":
      return "Fill in a field";
    case "select":
      return "Choose an option";
    case "type":
      return "Type text";
    case "press":
      return `Press ${command.key}`.slice(0, 200);
    case "scroll":
      return `Scroll ${command.direction}`;
    case "back":
      return "Go back";
    case "wait":
      return "Wait for the page";
    case "eval":
      return "Run JavaScript on the page";
  }
}

/** The exact origin a command needs a grant for, when it names one. */
export function commandOrigin(command: BrowserCommand): string | undefined {
  if (command.name !== "open") return undefined;
  try {
    return new URL(command.url).origin;
  } catch {
    throw new BrowserCommandError(
      "invalid_command",
      "open needs a valid http(s) URL.",
    );
  }
}

/**
 * The QuickJS Browser Script for one command. It acts on `page` (this
 * session's own tab), then reports the page and, unless the command is
 * `eval`, a fresh snapshot for the next refs.
 */
export function browserCommandScript(command: BrowserCommand): string {
  const json = JSON.stringify;
  const settle = `try { await page.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch {}`;
  let action = "";
  let snapshot = true;
  switch (command.name) {
    case "open":
      action = `await page.goto(${json(command.url)}, { waitUntil: "domcontentloaded" });`;
      break;
    case "snapshot":
    case "screenshot":
      break;
    case "click":
      action = `await page.locator(${json(`aria-ref=${command.target.ref}`)}).click({ timeout: 5000 });\n${settle}`;
      break;
    case "hover":
      action = `await page.locator(${json(`aria-ref=${command.target.ref}`)}).hover({ timeout: 5000 });`;
      break;
    case "fill":
      action = `await page.locator(${json(`aria-ref=${command.target.ref}`)}).fill(${json(command.text)}, { timeout: 5000 });`;
      break;
    case "select":
      action = `await page.locator(${json(`aria-ref=${command.target.ref}`)}).selectOption(${json(command.text)}, { timeout: 5000 });`;
      break;
    case "type":
      action = `await page.keyboard.type(${json(command.text)});`;
      break;
    case "press":
      action = `await page.keyboard.press(${json(command.key)});\n${settle}`;
      break;
    case "scroll":
      action =
        command.direction === "top" || command.direction === "bottom"
          ? `await page.evaluate((toBottom) => window.scrollTo(0, toBottom ? document.documentElement.scrollHeight : 0), ${json(command.direction === "bottom")});`
          : `await page.mouse.wheel(0, ${command.direction === "down" ? 600 : -600});`;
      break;
    case "back":
      action = `await page.goBack({ waitUntil: "domcontentloaded" });`;
      break;
    case "wait":
      action =
        "ms" in command
          ? `await page.waitForTimeout(${command.ms});`
          : `await page.getByText(${json(command.text)}).first().waitFor({ timeout: ${MAX_WAIT_MS} });`;
      break;
    case "eval": {
      snapshot = false;
      const source = command.expression;
      // Plain expressions become a function, as in chrome-devtools-axi.
      const body =
        /^(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source) ||
        /^(async\s+)?function\b/.test(source)
          ? source
          : `() => (${source})`;
      action = `const __bbValue = await page.evaluate(${body});\nconst __bbEval = __bbValue === undefined ? "undefined" : JSON.stringify(__bbValue);`;
      break;
    }
  }
  const report = snapshot
    ? `const __bbSnapshot = await page.snapshotForAI({ track: "bb-browser-command" });
return ${json(RESULT_MARKER)} + JSON.stringify({ title: await page.title(), url: page.url(), snapshot: __bbSnapshot.full });`
    : `return ${json(RESULT_MARKER)} + JSON.stringify({ title: await page.title(), url: page.url(), value: __bbEval });`;
  return `${action}\n${report}`;
}

export type BrowserCommandPayload = {
  title: string;
  url: string;
  snapshot?: string;
  value?: string;
};

export function parseBrowserCommandOutput(
  output: string,
): BrowserCommandPayload | undefined {
  const index = output.lastIndexOf(RESULT_MARKER);
  if (index < 0) return undefined;
  try {
    const parsed = JSON.parse(
      output.slice(index + RESULT_MARKER.length).trim(),
    ) as BrowserCommandPayload;
    return typeof parsed.url === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type SnapshotElement = { uid: string; role: string; name: string };

/**
 * Turn Playwright's AI snapshot into the compact form agents read: one node
 * per line, indented by depth, with `uid=g<generation>:<ref>` on elements an
 * agent can act on. URLs and cursor hints are dropped to save tokens.
 */
export function compactSnapshot(
  snapshot: string,
  generation: number,
): { text: string; elements: SnapshotElement[] } {
  const lines: string[] = [];
  const elements: SnapshotElement[] = [];
  for (const raw of snapshot.split("\n")) {
    const match = /^(\s*)-\s+(.*)$/.exec(raw);
    if (match === null) continue;
    const depth = Math.floor(match[1]!.length / 2);
    let body = match[2]!.replace(/:\s*$/, "");
    if (body.startsWith("/url:") || body.startsWith("/placeholder:")) continue;
    const refMatch = /\s*\[ref=(e\d+)\]/.exec(body);
    body = body
      .replace(/\s*\[ref=e\d+\]/g, "")
      .replace(/\s*\[cursor=[^\]]*\]/g, "")
      .trim();
    if (body.length === 0) continue;
    const role = /^([a-z]+)/.exec(body)?.[1] ?? "";
    const name = /"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? "";
    let line = body;
    if (refMatch !== null && INTERACTIVE_ROLES.has(role)) {
      const uid = `g${generation}:${refMatch[1]}`;
      line = `uid=${uid} ${body}`;
      elements.push({ uid, role, name });
    }
    lines.push(`${"  ".repeat(depth)}${line}`);
  }
  const shown = lines.slice(0, MAX_SNAPSHOT_LINES);
  if (lines.length > shown.length) {
    shown.push(
      `… ${lines.length - shown.length} more lines. Scroll, or use eval to read specific content.`,
    );
  }
  return { text: shown.join("\n"), elements };
}

function hintFor(element: SnapshotElement): string {
  const label =
    element.name.length > 0
      ? ` the "${element.name.slice(0, 60)}" ${element.role}`
      : ` the ${element.role}`;
  if (FILLABLE_ROLES.has(element.role))
    return `Run \`fill @${element.uid} <text>\` to fill${label}`;
  return `Run \`click @${element.uid}\` to click${label}`;
}

function quoted(value: string) {
  return JSON.stringify(value);
}

/** The text an agent reads back: page, snapshot or value, and next steps. */
export function formatBrowserCommandResult(
  command: BrowserCommand,
  payload: BrowserCommandPayload,
  generation: number,
): string {
  const out: string[] = [];
  if (payload.snapshot === undefined) {
    out.push(
      `page: {title: ${quoted(payload.title)}, url: ${quoted(payload.url)}}`,
    );
    out.push(`result: ${payload.value ?? "undefined"}`);
    out.push("help[1]:", "  Run `snapshot` to see the page and its refs");
    return out.join("\n");
  }
  const { text, elements } = compactSnapshot(payload.snapshot, generation);
  out.push(
    `page: {title: ${quoted(payload.title)}, url: ${quoted(payload.url)}, refs: ${elements.length}}`,
  );
  out.push("snapshot:", text);
  const hints = elements.slice(0, MAX_HINTS).map(hintFor);
  if (command.name === "fill" || command.name === "type") {
    hints.unshift("Run `press Enter` to submit");
  }
  hints.push(
    "Refs change after every command; pass them back exactly as printed",
  );
  out.push(`help[${hints.length}]:`, ...hints.map((hint) => `  ${hint}`));
  return out.join("\n");
}
