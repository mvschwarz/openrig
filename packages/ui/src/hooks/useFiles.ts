// UI Enhancement Pack v0 — files browser + write hooks.
//
// Wraps:
//   - GET /api/files/roots → useFilesRoots
//   - GET /api/files/list?root=&path= → useFilesList
//   - GET /api/files/read?root=&path= → useFilesRead
//   - POST /api/files/write → useFilesWrite (mutation)
//
// All read hooks surface daemon 503 / 4xx as structured errors via
// the `unavailable` shape so the UI renders a setup hint when no
// allowlist is configured.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface FilesUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

export interface AllowlistRoot {
  name: string;
  path: string;
}

export interface FilesRootsResponse {
  roots: AllowlistRoot[];
  hint?: string;
}

async function fetchRoots(): Promise<FilesRootsResponse | FilesUnavailable> {
  const res = await fetch("/api/files/roots");
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as Partial<FilesUnavailable> & { error?: string; hint?: string };
    return { unavailable: true, error: body.error ?? "files_routes_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as FilesRootsResponse;
}

export function useFilesRoots() {
  return useQuery({
    queryKey: ["files", "roots"],
    queryFn: fetchRoots,
    staleTime: 60_000,
  });
}

// --- list ---

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number | null;
  mtime: string | null;
}

export interface FilesListResponse {
  root: string;
  path: string;
  entries: FileEntry[];
}

async function fetchList(root: string, path: string): Promise<FilesListResponse> {
  const res = await fetch(`/api/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as FilesListResponse;
}

export function useFilesList(root: string | null, path: string | null) {
  return useQuery({
    queryKey: ["files", "list", root, path],
    queryFn: () => fetchList(root!, path ?? ""),
    enabled: !!root,
    staleTime: 15_000,
  });
}

// --- read ---

export interface FilesReadResponse {
  root: string;
  path: string;
  absolutePath: string;
  content: string;
  mtime: string;
  contentHash: string;
  size: number;
  /** Operator Surface Reconciliation v0 item 5: present when the
   *  daemon truncated the returned content (file > 1 MB cap). */
  truncated?: boolean;
  truncatedAtBytes?: number | null;
  totalBytes?: number;
}

async function fetchRead(root: string, path: string): Promise<FilesReadResponse> {
  const res = await fetch(`/api/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as FilesReadResponse;
}

export function useFilesRead(root: string | null, path: string | null) {
  return useQuery({
    queryKey: ["files", "read", root, path],
    queryFn: () => fetchRead(root!, path!),
    enabled: !!root && !!path,
    staleTime: 0, // always re-read for edit-mode mtime/contentHash freshness
  });
}

// --- write (item 4) ---

export interface FileWriteRequest {
  root: string;
  path: string;
  content: string;
  expectedMtime: string;
  expectedContentHash: string;
  actor: string;
}

export interface FileWriteSuccess {
  root: string;
  path: string;
  absolutePath: string;
  newMtime: string;
  newContentHash: string;
  byteCountDelta: number;
}

export interface FileWriteConflict {
  conflict: true;
  currentMtime: string;
  currentContentHash: string;
  message: string;
}

export type FileWriteResult = FileWriteSuccess | FileWriteConflict;

async function postWrite(req: FileWriteRequest): Promise<FileWriteResult> {
  const res = await fetch("/api/files/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { currentMtime: string; currentContentHash: string; message?: string };
    return {
      conflict: true,
      currentMtime: body.currentMtime,
      currentContentHash: body.currentContentHash,
      message: body.message ?? "file changed externally",
    };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as FileWriteSuccess;
}

export function useFilesWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postWrite,
    onSuccess: (result, vars) => {
      // Only invalidate when the write actually landed. On a 409
      // conflict we MUST keep the read query stable so the editor's
      // last-known mtime/contentHash + the operator's draft survive
      // long enough for the conflict banner to render. Invalidating
      // here would refetch the read, the editor's useEffect would
      // fire on the new read, and both the draft and the conflict
      // banner would get wiped silently — losing the operator's
      // edits and the conflict signal.
      if ("conflict" in result) return;
      qc.invalidateQueries({ queryKey: ["files", "read", vars.root, vars.path] });
      qc.invalidateQueries({ queryKey: ["files", "list", vars.root] });
    },
  });
}

export function fileAssetUrl(root: string, path: string): string {
  return `/api/files/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}
