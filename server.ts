import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginCliContext,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  createBrowserService,
  panelIdentity,
  type BrowserService,
} from "./browser-service.js";
import {
  browserScriptParametersSchema,
  rpcContract,
  type BrowserScriptFailure,
  type BrowserStatus,
} from "./contracts.js";

const CLI_USAGE = "Usage: bb browser status [--json]";
type BrowserScriptParameters = z.output<typeof browserScriptParametersSchema>;

function cliStatusText(status: BrowserStatus) {
  return `${status.label}\n${status.message}`;
}

async function runCli(
  browser: BrowserService,
  argv: string[],
  context: PluginCliContext,
) {
  const json = argv.includes("--json");
  const commands = argv.filter((argument) => argument !== "--json");
  if (commands.length !== 1 || commands[0] !== "status") {
    return { exitCode: 1, stderr: CLI_USAGE };
  }
  const status = await browser.status(context, undefined, context.signal);
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(status) : cliStatusText(status),
  };
}

function toolFailure(failure: BrowserScriptFailure) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(failure) }],
    isError: true,
  };
}

async function runBrowserScript(
  browser: BrowserService,
  parameters: BrowserScriptParameters,
  context: PluginAgentToolContext,
) {
  return toolFailure(await browser.browserScript(parameters, context));
}

function registerCli(bb: BbPluginApi, browser: BrowserService) {
  bb.cli.register({
    name: "browser",
    summary: "Inspect Browser status",
    commands: [
      {
        name: "status",
        summary: "Report Browser host setup status",
        usage: "bb browser status [--json]",
      },
    ],
    run: (argv, context) => runCli(browser, argv, context),
  });
}

function registerAgentTool(bb: BbPluginApi, browser: BrowserService) {
  bb.agents.registerTool({
    name: "browser_script",
    description: "Run Playwright code in the host-local Workspace Browser.",
    instructions:
      "Provide a purpose and QuickJS-compatible Playwright code. Report typed failures without retrying setup.",
    presentation: {
      label: {
        pending: "Running browser script",
        completed: "Ran browser script",
      },
      icon: { glyph: "Globe" },
    },
    parameters: browserScriptParametersSchema,
    execute: (parameters, context) =>
      runBrowserScript(browser, parameters, context),
  });
}

export default function plugin(bb: BbPluginApi) {
  const browser = createBrowserService(bb);
  bb.rpc.register(rpcContract, {
    browser_status: (input) =>
      browser.status(panelIdentity(input), input.profileId),
  });
  registerCli(bb, browser);
  registerAgentTool(bb, browser);
  bb.agents.configure(() => ({
    tools: ["browser_script"],
    skills: ["browser"],
  }));
}
