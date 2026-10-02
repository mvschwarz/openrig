import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CliDriftIndicator,
  MissingFieldPlaceholder,
} from "../src/components/mission-control/components/CliDriftIndicator";

describe("Mission Control CLI capability display", () => {
  it("shows no warning when capabilities are available and no version is outdated", () => {
    render(<CliDriftIndicator staleCliCount={0} degradedFields={[]} />);

    expect(screen.queryByTestId("mc-cli-drift-indicator")).toBeNull();
  });

  it.each([1, 2])("labels %i unknown capability observations without calling them stale", (count) => {
    render(
      <CliDriftIndicator
        staleCliCount={0}
        unknownCliCount={count}
        degradedFields={[]}
      />,
    );

    expect(screen.getByTestId("mc-cli-drift-unknown-count").textContent).toContain(
      `${count} ${count === 1 ? "rig" : "rigs"} with unknown CLI capabilities`,
    );
    expect(screen.queryByTestId("mc-cli-drift-stale-count")).toBeNull();
  });

  it("shows unavailable fields without claiming an outdated installation", () => {
    render(
      <>
        <CliDriftIndicator staleCliCount={0} degradedFields={["agentActivity"]} />
        <MissingFieldPlaceholder fieldName="agentActivity" />
      </>,
    );

    expect(screen.getByTestId("mc-cli-drift-fields").textContent).toContain("agentActivity");
    expect(screen.queryByTestId("mc-cli-drift-stale-count")).toBeNull();
    const placeholder = screen.getByTestId("mc-missing-field-placeholder");
    expect(placeholder.textContent).toBe("agentActivity: field unavailable on this rig");
    expect(placeholder.title).toBe("field unavailable on this rig");
  });

  it("reserves the stale CLI label for independently confirmed outdated versions", () => {
    render(
      <CliDriftIndicator
        staleCliCount={1}
        unknownCliCount={2}
        degradedFields={["agentActivity"]}
      />,
    );

    expect(screen.getByTestId("mc-cli-drift-stale-count").textContent).toContain("1 rig running stale CLI");
    expect(screen.getByTestId("mc-cli-drift-unknown-count").textContent).toContain("2 rigs with unknown CLI capabilities");
    expect(screen.getByTestId("mc-cli-drift-fields").textContent).toContain("agentActivity");
  });
});
