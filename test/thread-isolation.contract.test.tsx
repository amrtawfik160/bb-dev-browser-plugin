// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  createPublicPluginHarness,
  createTabInventoryRuntime,
  healthyBrowserStatus,
} from "./public-plugin-harness.js";
import {
  DEFAULT_PROFILE_ID,
  BROWSER_PROFILE_SELECTION_CHANGED,
} from "../src/shared/contracts.js";
import { BrowserInstanceError } from "../src/browser/browser-runtime.js";

describe("default Browser Profile isolation", () => {
  it.each(["focus", "selection", "reconnect"])(
    "shows the agent's selected profile in an already-open panel after %s",
    async (trigger) => {
      const runtime = createTabInventoryRuntime();
      runtime.listPages = async (target) => [
        {
          id: `tab-${target.profileId}`,
          url: "https://example.com/agent-work",
          title: `Work in ${target.profileId}`,
          openerTabId: null,
        },
      ];
      runtime.activeTabId = async (target) => `tab-${target.profileId}`;
      const browser = await createPublicPluginHarness({
        status: healthyBrowserStatus,
        browserRuntime: runtime,
        sharedProfile: false,
      });
      try {
        const panel = browser.renderPanel();
        await waitFor(() =>
          expect(panel.queryByText("Checking Browser setup…")).toBeNull(),
        );
        const shared = await browser.createBrowserProfile({
          hostId: "host-browser-test",
          name: "Shared agent browser",
        });
        await act(async () => {
          await browser.runBrowserSessions({
            action: "select",
            profileId: shared.profileId,
          });
          await browser.runBrowserScriptWithProfile(undefined, {
            destinationOrigin: "https://example.com",
          });
        });
        if (trigger === "focus") fireEvent(window, new Event("focus"));
        else if (trigger === "selection") {
          const statusCalls = () =>
            panel.inspection.rpcCalls.filter(
              (call) => call.method === "browser_status",
            ).length;
          const before = statusCalls();
          await panel.behavior.emitRealtime(BROWSER_PROFILE_SELECTION_CHANGED, {
            hostId: "host-browser-test",
            threadId: "another-thread",
          });
          expect(statusCalls()).toBe(before);
          const signal = browser.realtimeSignals.find(
            (signal) => signal.channel === BROWSER_PROFILE_SELECTION_CHANGED,
          );
          expect(signal?.payload).toEqual({
            hostId: "host-browser-test",
            threadId: "thread-browser-test",
          });
          await panel.behavior.emitRealtime(
            BROWSER_PROFILE_SELECTION_CHANGED,
            signal!.payload,
          );
        } else {
          await panel.behavior.setRealtimeConnectionState("reconnecting");
          await panel.behavior.setRealtimeConnectionState("connected");
        }
        await waitFor(() => {
          expect(panel.inspection.rpcCalls).toContainEqual(
            expect.objectContaining({
              method: "browser_panel_control",
              input: expect.objectContaining({ profileId: shared.profileId }),
            }),
          );
        });
        expect(
          await panel.findByRole("button", {
            name: `Work in ${shared.profileId}`,
          }),
        ).toBeTruthy();
      } finally {
        await browser.dispose();
      }
    },
  );

  it("returns a typed capacity failure when every running browser is busy", async () => {
    const runtime = createTabInventoryRuntime();
    runtime.execute = async () => {
      throw new BrowserInstanceError(
        "awake-limit",
        "All three browsers are busy. This call did not run.",
      );
    };
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: runtime,
      sharedProfile: false,
    });
    try {
      const result = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://example.com",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        error: { code: "awake-limit" },
      });
    } finally {
      await browser.dispose();
    }
  });

  it("keeps a panel opened for a specific profile on that profile after selection changes", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: createTabInventoryRuntime(),
      sharedProfile: false,
    });
    try {
      const pinned = await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Pinned browser",
      });
      const selected = await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Selected browser",
      });
      const panel = browser.renderPanel({ profileId: pinned.profileId });
      await waitFor(() =>
        expect(panel.inspection.rpcCalls).toContainEqual(
          expect.objectContaining({
            method: "browser_panel_control",
            input: expect.objectContaining({ profileId: pinned.profileId }),
          }),
        ),
      );
      await browser.runBrowserSessions({
        action: "select",
        profileId: selected.profileId,
      });
      const signal = browser.realtimeSignals.find(
        (signal) => signal.channel === BROWSER_PROFILE_SELECTION_CHANGED,
      )!;
      await panel.behavior.emitRealtime(signal.channel, signal.payload);
      fireEvent(window, new Event("focus"));
      await waitFor(() =>
        expect(
          panel.inspection.rpcCalls.filter(
            (call) => call.method === "browser_status",
          ),
        ).toHaveLength(2),
      );
      expect(
        panel.inspection.rpcCalls
          .filter((call) => call.method === "browser_status")
          .map((call) => call.input),
      ).toEqual([
        expect.objectContaining({ profileId: pinned.profileId }),
        expect.objectContaining({ profileId: pinned.profileId }),
      ]);
    } finally {
      await browser.dispose();
    }
  });
  it("keeps overlapping agents and subsequent calls on their own profiles", async () => {
    const runtime = createTabInventoryRuntime();
    const visits = new Map<string, string>();
    const calls: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.execute = async (target, code) => {
      calls.push(target.profileId);
      if (code === "first") {
        visits.set(target.profileId, "first-site");
        await pending;
      } else if (code === "second") {
        visits.set(target.profileId, "second-site");
      }
      return visits.get(target.profileId) ?? "blank";
    };
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: runtime,
      sharedProfile: false,
    });
    try {
      const first = browser.runBrowserScriptWithProfile(undefined, {
        code: "first",
        destinationOrigin: "https://first.example",
      });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const second = await browser.runBrowserScriptWithProfile(undefined, {
        threadId: "thread-second",
        code: "second",
        destinationOrigin: "https://second.example",
      });
      expect(second.isError).not.toBe(true);
      expect(second.content[0].text).toContain("second-site");
      expect(calls[0]).not.toBe(calls[1]);
      expect(calls).not.toContain(DEFAULT_PROFILE_ID);
      release();
      expect((await first).content[0].text).toContain("first-site");
      const again = await browser.runBrowserScriptWithProfile(undefined, {
        code: "read",
        destinationOrigin: "https://first.example",
      });
      expect(again.content[0].text).toContain("first-site");
      expect(calls[2]).toBe(calls[0]);
      const status = await browser.runBrowserStatus({
        surface: "thread",
        threadId: "thread-browser-test",
        profileId: DEFAULT_PROFILE_ID,
        profileSelection: "selected",
      });
      expect(status.profileId).toBe(calls[0]);
      const cli = await browser.runBrowserCli([
        "script",
        "--purpose",
        "Verify CLI isolation",
        "--origin",
        "https://first.example",
        "--code",
        "read",
      ]);
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toContain("first-site");
      expect(calls[3]).toBe(calls[0]);
    } finally {
      release();
      await browser.dispose();
    }
  });

  it("isolates projects without a thread and preserves explicit profile sharing", async () => {
    const calls: string[] = [];
    const runtime = createTabInventoryRuntime();
    runtime.execute = async (target) => {
      calls.push(target.profileId);
      return "ok";
    };
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: runtime,
      sharedProfile: false,
    });
    try {
      const projectA = await browser.runBrowserProfiles(undefined, {
        projectId: "project-a",
      });
      const projectB = await browser.runBrowserProfiles(undefined, {
        projectId: "project-b",
      });
      expect(projectA.selectedProfileId).not.toBe(projectB.selectedProfileId);
      expect(projectA.selectedProfileId).not.toBe(DEFAULT_PROFILE_ID);
      for (const threadId of ["thread-browser-test", "thread-second"]) {
        const result = await browser.runBrowserScriptWithProfile(
          DEFAULT_PROFILE_ID,
          { threadId, destinationOrigin: "https://example.com" },
        );
        expect(result.isError).not.toBe(true);
      }
      expect(calls).toEqual([DEFAULT_PROFILE_ID, DEFAULT_PROFILE_ID]);
    } finally {
      await browser.dispose();
    }
  });
});
