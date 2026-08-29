// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDownloadListingEntry } from "../contracts.js";
import { PanelDownloadsSurface } from "../panel-chrome.js";

/**
 * Host Downloads quarantine surface (issue #20 findings, P2). The export
 * control is a real button that initiates a client export through the
 * server RPC (wired in app.tsx), replacing the previous text-only hint.
 * These tests exercise the presentational surface directly: the export
 * button appears only for a controller's quarantined download, calls the
 * `onExportClient` callback with the download id, and reports export
 * errors inline.
 */
afterEach(() => {
  cleanup();
});

function quarantinedDownload(
  overrides: Partial<BrowserDownloadListingEntry> = {},
): BrowserDownloadListingEntry {
  return {
    downloadId: "d1",
    profileId: "p1",
    safeName: "report.pdf",
    contentType: "application/pdf",
    sizeBytes: 24,
    totalBytes: 24,
    phase: "quarantined",
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2024-01-08T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

describe("PanelDownloadsSurface export control (issue #20 findings, P2)", () => {
  it("renders an Export to client button for a controller's quarantined download", () => {
    const onExportClient = vi.fn();
    render(
      <PanelDownloadsSurface
        downloads={[quarantinedDownload()]}
        limits={null}
        isController={true}
        exportState={{ inFlightDownloadId: null, error: null }}
        onCancel={() => undefined}
        onExportClient={onExportClient}
      />,
    );
    const button = screen.getByRole("button", { name: "Export to client" });
    expect(button).toBeDefined();
  });

  it("initiates a client export through the callback when clicked", () => {
    const onExportClient = vi.fn();
    render(
      <PanelDownloadsSurface
        downloads={[quarantinedDownload()]}
        limits={null}
        isController={true}
        exportState={{ inFlightDownloadId: null, error: null }}
        onCancel={() => undefined}
        onExportClient={onExportClient}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export to client" }));
    expect(onExportClient).toHaveBeenCalledWith("d1");
  });

  it("does not show an export control to a spectator", () => {
    render(
      <PanelDownloadsSurface
        downloads={[quarantinedDownload()]}
        limits={null}
        isController={false}
        exportState={{ inFlightDownloadId: null, error: null }}
        onCancel={() => undefined}
        onExportClient={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Export to client" }),
    ).toBeNull();
  });

  it("disables the export button and shows Exporting while an export is in flight", () => {
    render(
      <PanelDownloadsSurface
        downloads={[quarantinedDownload()]}
        limits={null}
        isController={true}
        exportState={{ inFlightDownloadId: "d1", error: null }}
        onCancel={() => undefined}
        onExportClient={() => undefined}
      />,
    );
    const button = screen.getByRole("button", { name: "Exporting…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("displays an export error above the listing", () => {
    render(
      <PanelDownloadsSurface
        downloads={[quarantinedDownload()]}
        limits={null}
        isController={true}
        exportState={{
          inFlightDownloadId: null,
          error: "Export rejected: unauthorized.",
        }}
        onCancel={() => undefined}
        onExportClient={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Export rejected: unauthorized.",
    );
  });
});
