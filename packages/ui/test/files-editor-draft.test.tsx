import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FilesWorkspace } from "../src/components/files/FilesWorkspace.js";

vi.mock("../src/hooks/useWorkspace.js", () => ({ useWorkspace: () => ({ data: null }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const read = (content: string, revision: string) => ({
  root: "ws", path: "notes.txt", absolutePath: "/workspace/notes.txt",
  content, mtime: revision, contentHash: revision, size: content.length,
});

async function openEditor() {
  let current = read("original", "v1");
  const writes: Record<string, unknown>[] = [];
  let writer: (() => Promise<Response>) | undefined;
  let reader: (() => Promise<Response>) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/api/files/roots") return Response.json({ roots: [{ name: "ws", path: "/workspace" }] });
    if (input.startsWith("/api/files/list?")) return Response.json({ root: "ws", path: "", entries: [{ name: "notes.txt", type: "file", size: 8, mtime: "v1" }] });
    if (input.startsWith("/api/files/read?")) return reader ? reader() : Response.json(current);
    if (input === "/api/files/write") {
      writes.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      if (writer) return writer();
      return Response.json({ currentMtime: "v2", currentContentHash: "v2" }, { status: 409 });
    }
    throw new Error(`Unexpected fetch ${input}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><FilesWorkspace /></QueryClientProvider>);
  fireEvent.click(await screen.findByText("notes.txt"));
  await screen.findByTestId("files-code-view");
  fireEvent.click(screen.getByTestId("files-edit-toggle"));
  const textarea = screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement;
  return { client, textarea, writes,
    update: (content: string, revision: string) => { current = read(content, revision); },
    setWriter: (next: () => Promise<Response>) => { writer = next; },
    setReader: (next: () => Promise<Response>) => { reader = next; },
  };
}

describe("file editor draft", () => {
  it.each([true, false])("keeps a successful save while its follow-up read is pending, then succeeds=%s", async (success) => {
    const { textarea, setWriter, setReader } = await openEditor();
    let finishRead!: (response: Response) => void;
    setReader(() => new Promise((resolve) => { finishRead = resolve; }));
    setWriter(async () => Response.json({ newMtime: "v2", newContentHash: "v2", byteCountDelta: 7 }));
    fireEvent.change(textarea, { target: { value: "submitted draft" } });
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await screen.findByTestId("files-editor-saved");
    expect(textarea.value).toBe("submitted draft");
    expect(screen.getByTestId("files-editor-save").hasAttribute("disabled")).toBe(true);
    await act(async () => { finishRead(success ? Response.json(read("submitted draft", "v2")) : new Response("failed", { status: 500 })); });
    if (!success) await screen.findByTestId("files-read-error");
    expect(textarea.value).toBe("submitted draft");
  });

  it("keeps unsaved text and its original write precondition after a background read", async () => {
    const { client, textarea, writes, update } = await openEditor();
    fireEvent.change(textarea, { target: { value: "my unsaved draft" } });
    update("external edit", "v2");
    await act(async () => { await client.refetchQueries({ queryKey: ["files", "read", "ws", "notes.txt"] }); });
    expect(textarea.value).toBe("my unsaved draft");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await screen.findByTestId("files-editor-conflict");
    expect(writes[0]).toMatchObject({ content: "my unsaved draft", expectedMtime: "v1", expectedContentHash: "v1" });
    expect(textarea.value).toBe("my unsaved draft");
    fireEvent.click(screen.getByTestId("files-editor-refresh"));
    await waitFor(() => expect(textarea.value).toBe("external edit"));
    expect(screen.queryByTestId("files-editor-conflict")).toBeNull();
  });

  it("adopts a background revision when clean, and Cancel discards a draft explicitly", async () => {
    const { client, textarea, writes, update } = await openEditor();
    update("external edit", "v2");
    await act(async () => { await client.refetchQueries({ queryKey: ["files", "read", "ws", "notes.txt"] }); });
    await waitFor(() => expect(textarea.value).toBe("external edit"));
    fireEvent.change(textarea, { target: { value: "draft" } });
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await screen.findByTestId("files-editor-conflict");
    expect(writes[0]).toMatchObject({ expectedContentHash: "v2" });
    fireEvent.click(screen.getByTestId("files-editor-cancel"));
    expect(textarea.value).toBe("external edit");
    expect(screen.getByTestId("files-editor-save").hasAttribute("disabled")).toBe(true);
  });

  it.each(["newer unsaved text", "original", ""])("keeps text %j typed during a save and advances its precondition", async (newText) => {
    const { client, textarea, writes, update, setWriter } = await openEditor();
    let finish!: (response: Response) => void;
    setWriter(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(textarea, { target: { value: "submitted draft" } });
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.change(textarea, { target: { value: newText } });
    update("submitted draft", "v2");
    await act(async () => { await client.refetchQueries({ queryKey: ["files", "read", "ws", "notes.txt"] }); });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(textarea.value).toBe(newText);
    await act(async () => { finish(Response.json({ newMtime: "v2", newContentHash: "v2", byteCountDelta: 7 })); });
    await screen.findByTestId("files-editor-saved");
    expect(textarea.value).toBe(newText);
    setWriter(async () => Response.json({ currentMtime: "v3", currentContentHash: "v3" }, { status: 409 }));
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await screen.findByTestId("files-editor-conflict");
    expect(writes[1]).toMatchObject({ content: newText, expectedMtime: "v2", expectedContentHash: "v2" });
  });
});
