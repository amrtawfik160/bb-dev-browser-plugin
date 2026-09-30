// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type {
  PluginMessageDirectiveProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server/server.js";
import {
  DEFAULT_PROFILE_ID,
  type BrowserProfileInventory,
  type BrowserStatus,
  type BrowserTabStrip,
} from "../src/shared/contracts.js";
import {
  BROWSER_CARD_LIVE_WINDOW_MS,
  BROWSER_CARD_REFRESH_INTERVAL_MS,
  parseBrowserLiveAttributes,
  parseBrowserSignInAttributes,
} from "../src/app/browser-card-presentation.js";
import {
  createPublicPluginHarness,
  healthyBrowserStatus,
} from "./public-plugin-harness.js";

/**
 * Browser Cards (ADR 0019) through the real plugin app: the directive
 * registrations the BB app renders, with owner RPCs answered by stubs so each
 * browser state can be asserted without a host. The server-side resolution
 * those RPCs stand for is covered by the panel and thread-isolation suites.
 */

const THREAD_ID = "thread-cards";
const HOST_ID = healthyBrowserStatus.hostId!;
const THREAD_PROFILE_ID = "thread-profile";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../src/app/app.js"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function status(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    ...healthyBrowserStatus,
    profileId: THREAD_PROFILE_ID,
    ...overrides,
  } as BrowserStatus;
}

const sleeping = status({
  state: "sleeping",
  code: "sleeping",
  label: "Sleeping",
  message: "Sleeping.",
} as Partial<BrowserStatus>);

function inventory(
  profiles: { profileId: string; name: string; archived?: boolean }[],
  selectedProfileId = THREAD_PROFILE_ID,
): BrowserProfileInventory {
  return {
    hostId: HOST_ID,
    installationId: "installation-cards",
    selectedProfileId,
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      name: profile.name,
      state: profile.archived === true ? "archived" : "active",
      selected: profile.profileId === selectedProfileId,
    })),
  } as unknown as BrowserProfileInventory;
}

const threadProfiles = inventory([
  { profileId: THREAD_PROFILE_ID, name: "Cards thread" },
  { profileId: "work", name: "Work" },
]);

const githubTab: BrowserTabStrip = {
  tabs: [
    {
      tabId: "tab-1",
      url: "https://github.com/login",
      title: "Sign in to GitHub",
      origin: "page",
      openerTabId: null,
    },
  ],
  activeTabId: "tab-1",
};

type Handlers = Record<string, (input: never) => unknown>;

function directive(id: string) {
  const registration = app.messageDirectives.find(
    (candidate) => candidate.id === id,
  );
  if (registration === undefined) throw new Error(`No ${id} directive`);
  return registration;
}

function renderCard(
  id: string,
  attributes: Record<string, string>,
  handlers: Handlers,
  options: { openThreadPanel?: () => boolean } = {},
): RenderedSlot {
  return renderSlot<PluginMessageDirectiveProps>(
    directive(id),
    {
      attributes,
      source: `::${id}`,
      message: {
        id: "message-1",
        threadId: THREAD_ID,
        turnId: null,
        projectId: "project-cards",
      },
      openWorkspaceFile: null,
    },
    {
      rpc: handlers as never,
      openThreadPanel: options.openThreadPanel ?? (() => true),
    },
  );
}

function stubs(overrides: Handlers = {}): Handlers {
  return {
    browser_status: () => status(),
    browser_profiles: () => threadProfiles,
    browser_tabs: () => githubTab,
    browser_navigate: () => ({
      address: { url: "https://github.com/" },
      tabId: "tab-1",
    }),
    browser_sign_in_done: () => ({ ok: true, delivery: "sent" }),
    ...overrides,
  };
}

function calls(card: RenderedSlot, method: string) {
  return card.inspection.rpcCalls.filter((call) => call.method === method);
}

function panelOpens(card: RenderedSlot) {
  return card.inspection.navigateCalls.filter(
    (call) => call.method === "openThreadPanel",
  );
}

describe("Browser Card registration", () => {
  it("registers the live and sign-in directives", () => {
    expect(app.messageDirectives.map((entry) => entry.id)).toEqual([
      "browser-live",
      "browser-sign-in",
    ]);
  });

  it("tells agents when to embed each card", async () => {
    const browser = await createPublicPluginHarness();
    try {
      const { tools } = await browser.resolveAgentCapabilities();
      const instructions = tools[0]?.instructions ?? "";
      expect(instructions).toContain("::browser-live");
      expect(instructions).toContain(
        '::browser-sign-in{origin="https://example.com"}',
      );
      expect(instructions).toMatch(/at most one card per reply/u);
      expect(instructions).toMatch(/never ask for credentials/u);
      expect(instructions).toMatch(/embed the card again/u);
    } finally {
      await browser.dispose();
    }
  });
});

describe("Browser Card attributes", () => {
  it("accepts an optional profile id and nothing else on a live card", () => {
    expect(parseBrowserLiveAttributes({})).toEqual({
      outcome: "valid",
      profileId: undefined,
    });
    expect(parseBrowserLiveAttributes({ "profile-id": "work" })).toEqual({
      outcome: "valid",
      profileId: "work",
    });
    expect(parseBrowserLiveAttributes({ "profile-id": "../etc" }).outcome).toBe(
      "invalid",
    );
    expect(parseBrowserLiveAttributes({ profile: "work" })).toEqual({
      outcome: "invalid",
      reason: "Unknown attribute profile.",
    });
  });

  it("requires an exact http(s) origin on a sign-in card", () => {
    expect(
      parseBrowserSignInAttributes({ origin: " https://GitHub.com/ " }),
    ).toEqual({
      outcome: "valid",
      origin: "https://github.com",
      profileId: undefined,
    });
    for (const origin of [
      "",
      "github.com",
      "https://github.com/login",
      "https://github.com/?next=/",
      "https://github.com/#x",
      "https://user:pass@github.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://*.github.com",
    ]) {
      expect(parseBrowserSignInAttributes({ origin }).outcome).toBe("invalid");
    }
    expect(parseBrowserSignInAttributes({}).outcome).toBe("invalid");
    expect(
      parseBrowserSignInAttributes({
        origin: "https://github.com",
        href: "https://evil.example",
      }).outcome,
    ).toBe("invalid");
  });

  it("explains an invalid card without reading any browser state", () => {
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com/login" },
      stubs(),
    );
    expect(card.getByRole("alert").textContent).toContain(
      "must be an exact http(s) origin",
    );
    expect(card.inspection.rpcCalls).toEqual([]);
  });
});

describe("::browser-live", () => {
  it("shows the thread's profile and active page, resolved like its panel", async () => {
    const card = renderCard("browser-live", {}, stubs());
    await card.findByText("Browser · Cards thread");
    expect(card.getByText("Sign in to GitHub")).toBeDefined();
    expect(card.getByText("https://github.com/login")).toBeDefined();
    expect(card.getByText("Ready")).toBeDefined();
    expect(calls(card, "browser_status")[0]?.input).toEqual({
      surface: "thread",
      threadId: THREAD_ID,
      profileId: DEFAULT_PROFILE_ID,
      profileSelection: "selected",
    });
    expect(calls(card, "browser_tabs")[0]?.input).toEqual({
      hostId: HOST_ID,
      profileId: THREAD_PROFILE_ID,
    });
    // The address is text, not a link that would open without the profile.
    expect(card.queryByRole("link")).toBeNull();
  });

  it("names the agent driving the browser", async () => {
    const card = renderCard(
      "browser-live",
      {},
      stubs({
        browser_status: () =>
          status({
            controlLease: { actor: "agent", purpose: "Check the dashboard" },
          }),
      }),
    );
    await card.findByText("An agent is driving it: Check the dashboard");
  });

  it("does not wake a sleeping browser to read its tabs", async () => {
    const card = renderCard(
      "browser-live",
      {},
      stubs({ browser_status: () => sleeping }),
    );
    await card.findByText("Sleeping");
    expect(
      card.getByText("Opening it wakes the browser where it left off."),
    ).toBeDefined();
    expect(calls(card, "browser_tabs")).toEqual([]);
  });

  it.each([
    [
      "host offline",
      status({
        state: "host-offline",
        code: "host_offline",
        label: "Host offline",
        message: "Offline.",
      } as Partial<BrowserStatus>),
      "Reconnect this thread's workspace host to use its browser.",
    ],
    [
      "no host yet",
      status({
        hostId: null,
        state: "setup-required",
        code: "setup_required",
        label: "Setup required",
        message: "Select a host.",
      } as Partial<BrowserStatus>),
      "Open the Browser Panel to choose a workspace host.",
    ],
    [
      "Safe Login",
      status({
        state: "safe-login-elsewhere",
        code: "safe_login_elsewhere",
        label: "Safe Login elsewhere",
        message: "Safe Login.",
      } as Partial<BrowserStatus>),
      "You are signing in with Safe Login in another panel. Agents cannot see this browser until you finish.",
    ],
  ])("explains %s without reading tabs", async (_name, current, text) => {
    const card = renderCard(
      "browser-live",
      {},
      stubs({ browser_status: () => current }),
    );
    await card.findByText(text);
    expect(calls(card, "browser_tabs")).toEqual([]);
  });

  it("reports a profile id the host does not have", async () => {
    const card = renderCard(
      "browser-live",
      { "profile-id": "missing" },
      stubs({
        browser_status: () =>
          status({
            profileId: "missing",
            state: "repair-required",
            code: "repair_required",
            label: "Repair required",
            message: "Unavailable.",
          } as Partial<BrowserStatus>),
      }),
    );
    await card.findByText("This host has no Browser Profile missing.");
    expect(calls(card, "browser_status")[0]?.input).toEqual({
      surface: "thread",
      threadId: THREAD_ID,
      profileId: "missing",
    });
  });

  it("opens the thread's Browser tab", async () => {
    const card = renderCard("browser-live", {}, stubs());
    await card.findByText("Browser · Cards thread");
    fireEvent.click(card.getByRole("button", { name: "Open in panel" }));
    expect(panelOpens(card)).toEqual([
      {
        method: "openThreadPanel",
        options: {
          actionId: "browser",
          title: "Browser",
          params: { profileId: DEFAULT_PROFILE_ID },
        },
      },
    ]);
  });

  it("opens another profile in its own tab without changing the thread's", async () => {
    const card = renderCard(
      "browser-live",
      { "profile-id": "work" },
      stubs({ browser_status: () => status({ profileId: "work" }) }),
    );
    await card.findByText("Browser · Work");
    fireEvent.click(card.getByRole("button", { name: "Open in panel" }));
    expect(panelOpens(card)[0]).toEqual({
      method: "openThreadPanel",
      options: {
        actionId: "browser",
        title: "Browser · Work",
        params: { profileId: "work" },
      },
    });
    expect(calls(card, "browser_profile_select")).toEqual([]);
  });

  it("stops refreshing after its live window until the owner asks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const card = renderCard("browser-live", {}, stubs());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_CARD_REFRESH_INTERVAL_MS * 2);
    });
    expect(calls(card, "browser_status").length).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_CARD_LIVE_WINDOW_MS);
    });
    const settled = calls(card, "browser_status").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_CARD_LIVE_WINDOW_MS);
    });
    expect(calls(card, "browser_status").length).toBe(settled);
    fireEvent.click(card.getByRole("button", { name: "Refresh" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls(card, "browser_status").length).toBe(settled + 1);
    expect(card.queryByRole("button", { name: "Refresh" })).toBeNull();
  });
});

describe("::browser-sign-in", () => {
  it("notifies Done for the profile opened even after the thread selection changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let selectedProfileId = THREAD_PROFILE_ID;
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs({
        browser_status: () => status({ profileId: selectedProfileId }),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(card.getByRole("button", { name: "Open github.com" }));
    await act(async () => undefined);
    selectedProfileId = "work";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_CARD_REFRESH_INTERVAL_MS);
    });
    fireEvent.click(card.getByRole("button", { name: "Done" }));
    await act(async () => undefined);
    expect(calls(card, "browser_sign_in_done")[0]?.input).toMatchObject({
      profileId: THREAD_PROFILE_ID,
      hostId: HOST_ID,
    });
  });

  it("hands the sign-in to the owner through their own navigation", async () => {
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs({ browser_tabs: () => ({ tabs: [], activeTabId: null }) }),
    );
    await card.findByText(
      /An agent needs you to sign in to https:\/\/github\.com in Cards thread\./u,
    );
    expect(card.getByText(/Never paste a password into chat\./u)).toBeDefined();
    fireEvent.click(card.getByRole("button", { name: "Open github.com" }));
    await card.findByText(
      "Opened github.com in the Browser Panel. Click Done once you are signed in.",
    );
    expect(panelOpens(card)).toHaveLength(1);
    // An owner navigation carries no panel identity: the card is not a panel.
    expect(calls(card, "browser_navigate")[0]?.input).toEqual({
      surface: "thread",
      threadId: THREAD_ID,
      hostId: HOST_ID,
      profileId: THREAD_PROFILE_ID,
      input: "https://github.com",
    });
  });

  it("says when the browser is already on the site", async () => {
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs(),
    );
    await card.findByText("The browser is on https://github.com/login.");
  });

  it("notifies the card's thread without reopening or navigating the browser", async () => {
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com", "profile-id": "work" },
      stubs({ browser_status: () => status({ profileId: "work" }) }),
    );
    await card.findByText(/in Work\./u);
    fireEvent.click(card.getByRole("button", { name: "Done" }));
    await card.findByText(
      "Agent notified. Your sign-in reply was sent to this thread.",
    );
    expect(calls(card, "browser_sign_in_done")[0]?.input).toEqual({
      threadId: THREAD_ID,
      origin: "https://github.com",
      profileId: "work",
      hostId: HOST_ID,
    });
    fireEvent.click(card.getByRole("button", { name: "Agent notified" }));
    expect(calls(card, "browser_sign_in_done")).toHaveLength(1);
    expect(calls(card, "browser_navigate")).toEqual([]);
    expect(panelOpens(card)).toEqual([]);
  });

  it("blocks repeated clicks while notifying the agent", async () => {
    let finish!: (value: { ok: true; delivery: "sent" }) => void;
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs({
        browser_sign_in_done: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }),
    );
    await card.findByText("The browser is on https://github.com/login.");
    fireEvent.click(card.getByRole("button", { name: "Done" }));
    const button = card.getByRole("button", { name: "Notifying…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(calls(card, "browser_sign_in_done")).toHaveLength(1);
    await act(async () => finish({ ok: true, delivery: "sent" }));
    expect(card.getByRole("button", { name: "Agent notified" })).toBeDefined();
  });

  it("lets the owner retry a failed notification", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not send the reply."))
      .mockResolvedValueOnce({ ok: true, delivery: "sent" });
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs({ browser_sign_in_done: send }),
    );
    fireEvent.click(card.getByRole("button", { name: "Done" }));
    await card.findByText("Could not send the reply.");
    fireEvent.click(card.getByRole("button", { name: "Done" }));
    await card.findByText(
      "Agent notified. Your sign-in reply was sent to this thread.",
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(card.queryByText("Could not send the reply.")).toBeNull();
  });

  it.each(["queued", "deferred"])(
    "explains a %s reply even when the browser host is offline",
    async (delivery) => {
      const card = renderCard(
        "browser-sign-in",
        { origin: "https://github.com" },
        stubs({
          browser_status: () =>
            status({ state: "host-offline", code: "host_offline" }),
          browser_sign_in_done: () => ({ ok: true, delivery }),
        }),
      );
      await card.findByText(
        "Reconnect this thread's workspace host to use its browser.",
      );
      fireEvent.click(card.getByRole("button", { name: "Done" }));
      await card.findByText(
        delivery === "queued"
          ? "Your sign-in reply is queued for the agent's next turn."
          : "Your sign-in reply will be delivered when the agent can receive it.",
      );
      expect(calls(card, "browser_sign_in_done")).toHaveLength(1);
    },
  );

  it("does not navigate when the thread has no side panel", async () => {
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs(),
      { openThreadPanel: () => false },
    );
    const button = await card.findByRole("button", { name: "Open github.com" });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
    await card.findByText(
      "Open this thread in BB to sign in from its Browser Panel.",
    );
    expect(calls(card, "browser_navigate")).toEqual([]);
  });

  it("reports a failed navigation", async () => {
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs({
        browser_navigate: () => {
          throw new Error("The Workspace Browser runtime is unavailable.");
        },
      }),
    );
    const button = await card.findByRole("button", { name: "Open github.com" });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
    await card.findByText("The Workspace Browser runtime is unavailable.");
  });

  it("keeps the sign-in button off while the browser cannot be reached", async () => {
    const card = renderCard(
      "browser-sign-in",
      { origin: "https://github.com" },
      stubs({
        browser_status: () =>
          status({
            state: "host-offline",
            code: "host_offline",
            label: "Host offline",
            message: "Offline.",
          } as Partial<BrowserStatus>),
      }),
    );
    await card.findByText(
      "Reconnect this thread's workspace host to use its browser.",
    );
    expect(
      (
        card.getByRole("button", {
          name: "Open github.com",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(card.getByRole("button", { name: "Open in panel" }));
    expect(panelOpens(card)).toHaveLength(1);
    expect(calls(card, "browser_navigate")).toEqual([]);
  });
});

describe("Sign-in Handoff notification RPC", () => {
  it.each(["sent", "queued", "deferred"] as const)(
    "sends an owner reply to the requested thread and returns %s delivery",
    async (delivery) => {
      const send = vi.fn().mockResolvedValue({ ok: true, delivery });
      const { bb, harness } = createFakePluginHost({
        sdk: { subscribe: () => () => {}, threads: { send } },
      });
      try {
        plugin(bb);
        expect(
          await harness.behavior.callRpc("browser_sign_in_done", {
            threadId: THREAD_ID,
            origin: "https://GitHub.com/",
            profileId: "work",
          }),
        ).toEqual({ ok: true, delivery });
        expect(send).toHaveBeenCalledWith({
          threadId: THREAD_ID,
          mode: "steer-if-active",
          input: [
            {
              type: "text",
              mentions: [],
              text: "I'm done signing in to https://github.com in Browser Profile work. Please check the browser and continue.",
            },
          ],
        });
      } finally {
        await harness.lifecycle.dispose();
      }
    },
  );

  it("rejects invalid origins before sending a reply", async () => {
    const send = vi.fn();
    const { bb, harness } = createFakePluginHost({
      sdk: { subscribe: () => () => {}, threads: { send } },
    });
    try {
      plugin(bb);
      await expect(
        harness.behavior.callRpc("browser_sign_in_done", {
          threadId: THREAD_ID,
          origin: "https://github.com/login",
        }),
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("reports a send failure to the card", async () => {
    const { bb, harness } = createFakePluginHost({
      sdk: {
        subscribe: () => () => {},
        threads: {
          send: async () => {
            throw new Error("Thread is archived.");
          },
        },
      },
    });
    try {
      plugin(bb);
      await expect(
        harness.behavior.callRpc("browser_sign_in_done", {
          threadId: THREAD_ID,
          origin: "https://github.com",
        }),
      ).rejects.toThrow("Thread is archived.");
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("Browser Panel tab for a named profile", () => {
  function renderThreadPanel(params: PluginThreadPanelProps["params"]) {
    const statuses: unknown[] = [];
    const panel = renderSlot<PluginThreadPanelProps>(
      app.threadPanelActions[0]!,
      { threadId: THREAD_ID, params },
      {
        rpc: {
          browser_status: (input: unknown) => {
            statuses.push(input);
            return status({
              hostId: null,
              state: "setup-required",
              code: "setup_required",
              label: "Setup required",
              message: "Select a host.",
            } as Partial<BrowserStatus>);
          },
          browser_host_choices: () => [],
        } as never,
      },
    );
    return { panel, statuses };
  }

  it("shows the named profile instead of the thread's selection", async () => {
    const { statuses } = renderThreadPanel({ profileId: "work" });
    await waitFor(() => expect(statuses).toHaveLength(1));
    expect(statuses[0]).toEqual({
      surface: "thread",
      threadId: THREAD_ID,
      profileId: "work",
    });
  });

  it("falls back to the thread's selection for untrusted params", async () => {
    const { statuses } = renderThreadPanel({ profileId: "../../etc" });
    await waitFor(() => expect(statuses).toHaveLength(1));
    expect(statuses[0]).toEqual({
      surface: "thread",
      threadId: THREAD_ID,
      profileId: DEFAULT_PROFILE_ID,
      profileSelection: "selected",
    });
  });
});
