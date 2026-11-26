import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentSpecDisplay } from "../src/components/AgentSpecDisplay.js";

const { setSelection } = vi.hoisted(() => ({ setSelection: vi.fn() }));
vi.mock("../src/components/AppShell.js", () => ({ useDrawerSelection: () => ({ setSelection }) }));
afterEach(() => { cleanup(); setSelection.mockClear(); });

it.each([
  ["/specs/agent/agent.yaml", "/specs/guide.md"],
  ["C:\\specs\\agent\\agent.yaml", "C:\\specs\\guide.md"],
  ["\\\\host\\share\\specs\\agent\\agent.yaml", "\\\\host\\share\\specs\\guide.md"],
])("opens the file drawer using the daemon's path syntax: %s", (sourcePath, absolutePath) => {
  render(<AgentSpecDisplay yaml="name: fixture" sourcePath={sourcePath} review={{
    sourceState: "library_item", kind: "agent", name: "fixture", version: "1", raw: "name: fixture",
    profiles: [], resources: { skills: [], guidance: [], plugins: [], subagents: [] },
    startup: { files: [{ path: "../guide.md", required: true }], actions: [] },
  }} />);
  fireEvent.click(screen.getByTestId("agent-startup-file-trigger-../guide.md"));
  expect(setSelection).toHaveBeenCalledWith({ type: "file", data: { path: "../guide.md", absolutePath } });
});
