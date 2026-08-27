import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginNewThreadPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_PROFILE_ID,
  type BrowserStatus,
  type BrowserStatusInput,
  type rpcContract,
} from "./contracts.js";

const panelParams = { profileId: DEFAULT_PROFILE_ID } as const;

function SetupRequiredView({ status }: { status: BrowserStatus }) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center bg-background p-6">
      <section
        role="status"
        aria-label={status.label}
        className="max-w-md text-center"
      >
        <h2 className="text-lg font-semibold text-foreground">
          {status.label}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{status.message}</p>
        <p className="mt-3 font-mono text-xs text-muted-foreground">
          {status.profileId}
        </p>
      </section>
    </main>
  );
}

function BrowserPanel({ request }: { request: BrowserStatusInput }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<BrowserStatus | null>(null);

  useEffect(() => {
    void rpc.call("browser_status", request).then(setStatus);
  }, [request, rpc]);

  if (status === null) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Checking Browser setup…
      </div>
    );
  }
  return <SetupRequiredView status={status} />;
}

function ThreadBrowserPanel({ threadId }: PluginThreadPanelProps) {
  return (
    <BrowserPanel
      request={{ surface: "thread", threadId, profileId: DEFAULT_PROFILE_ID }}
    />
  );
}

function NewThreadBrowserPanel({ projectId }: PluginNewThreadPanelProps) {
  return (
    <BrowserPanel
      request={{
        surface: "new-thread",
        projectId,
        profileId: DEFAULT_PROFILE_ID,
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "browser",
    title: "Browser",
    icon: "Globe",
    component: ThreadBrowserPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "Browser", params: panelParams });
    },
  });

  app.slots.experimental_newThreadPanelAction({
    id: "browser",
    title: "Browser",
    icon: "Globe",
    component: NewThreadBrowserPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "Browser", params: panelParams });
    },
  });
});
