import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  UI_MAINTENANCE_NOTICE_STORAGE_KEY,
  UiMaintenanceNotice,
} from "../src/components/UiMaintenanceNotice.js";

describe("UI maintenance notice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(cleanup);

  it("shows the supported-interface posture on first load", () => {
    render(<UiMaintenanceNotice />);

    expect(screen.getByTestId("ui-maintenance-notice").textContent).toContain(
      "The OpenRig UI is experimental and in maintenance mode.",
    );
    expect(screen.getByTestId("ui-maintenance-notice").textContent).toContain(
      "The CLI is the primary supported interface.",
    );
  });

  it("dismisses without reserving layout space and stays dismissed after remount", () => {
    const first = render(<UiMaintenanceNotice />);
    const notice = screen.getByTestId("ui-maintenance-notice");

    expect(notice.className).not.toContain("fixed");
    expect(notice.className).toContain("shrink-0");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss maintenance notice" }));

    expect(screen.queryByTestId("ui-maintenance-notice")).toBeNull();
    expect(localStorage.getItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY)).toBe("1");

    first.unmount();
    render(<UiMaintenanceNotice />);
    expect(screen.queryByTestId("ui-maintenance-notice")).toBeNull();
  });
});
