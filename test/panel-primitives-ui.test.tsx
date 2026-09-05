// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);
import {
  Button,
  EmptyState,
  ErrorState,
  Glyph,
  IconButton,
  LoadingState,
  Notice,
  StatusDot,
} from "../src/app/panel-primitives.js";

describe("panel primitives", () => {
  it("keeps a visible focus ring on every button variant", () => {
    render(
      <>
        <Button variant="primary">Allow</Button>
        <Button variant="secondary">Deny</Button>
        <Button variant="destructive">Revoke</Button>
        <Button variant="link">Allow every site</Button>
      </>,
    );
    for (const name of ["Allow", "Deny", "Revoke", "Allow every site"]) {
      expect(screen.getByRole("button", { name }).className).toContain(
        "focus-visible:ring-2",
      );
    }
  });

  it("names icon buttons and hides their glyph from assistive technology", () => {
    render(<IconButton label="Go back" glyph="back" />);
    const button = screen.getByRole("button", { name: "Go back" });
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(button.getAttribute("title")).toBe("Go back");
    expect(button.className).toContain("h-7");
  });

  it("renders a standalone glyph as decoration", () => {
    const { container } = render(<Glyph name="check" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("gives notices the role their tone needs", () => {
    render(
      <>
        <Notice tone="info">Saved</Notice>
        <Notice tone="error">Failed</Notice>
      </>,
    );
    expect(screen.getByRole("status").textContent).toBe("Saved");
    expect(screen.getByRole("alert").textContent).toBe("Failed");
  });

  it("never lets the status dot be the only signal", () => {
    render(<StatusDot tone="ready" label="Ready" />);
    expect(screen.getByRole("img", { name: "Ready" })).toBeTruthy();
  });

  it("states the cause and next action in list states", () => {
    render(
      <>
        <LoadingState what="Browser Profiles" />
        <EmptyState title="No grants yet.">
          A project&apos;s first browser call records one.
        </EmptyState>
        <ErrorState message="The host did not answer." onRetry={() => {}} />
      </>,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Loading Browser Profiles",
    );
    expect(screen.getByText("No grants yet.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "The host did not answer.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
