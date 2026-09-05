import { Script } from "node:vm";

const SCRIPT_FILENAME = "browser-script.js";
const QUICKJS_SYNTAX_FAILURE = "QuickJS evaluation failed";

/**
 * QuickJS reports a syntax error in agent code as a bare message such as
 * `expecting ','` with no position. Compiling the same code with Node's
 * parser, without running it, usually yields a clearer message and the line
 * it points at, so an agent can fix the script instead of guessing. Node
 * accepts the syntax QuickJS runs, so a script Node parses cleanly gets no
 * hint and the original message stands on its own.
 */
export function describeScriptSyntaxError(code: string): string | null {
  try {
    new Script(`(async () => {\n${code}\n})`, { filename: SCRIPT_FILENAME });
    return null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) return null;
    const location = new RegExp(`${SCRIPT_FILENAME}:(\\d+)`, "u").exec(
      error.stack ?? "",
    );
    // The wrapper contributes the first line, so the script's own numbering
    // starts one line later.
    const line = location === null ? null : Number(location[1]) - 1;
    const where = line !== null && line >= 1 ? ` at script line ${line}` : "";
    return `Syntax check: ${error.message}${where}.`;
  }
}

/**
 * Attach the Node parser's diagnosis to a QuickJS syntax failure. Any other
 * error, including runtime failures inside a well-formed script, is returned
 * unchanged.
 */
export function withScriptSyntaxHint(error: unknown, code: string): unknown {
  if (
    !(error instanceof Error) ||
    !error.message.includes(QUICKJS_SYNTAX_FAILURE)
  ) {
    return error;
  }
  const hint = describeScriptSyntaxError(code);
  if (hint === null) return error;
  const hinted = new Error(`${error.message}\n${hint}`, { cause: error });
  hinted.name = error.name;
  return hinted;
}
