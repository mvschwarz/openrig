// V0.3.1 slice 15 walk-items 6 + 11 — universal file-link primitive.
//
// Wraps any file reference in the UI so a click opens the
// SharedDetailDrawer with the appropriate viewer. Thin layer over the
// existing FileReferenceTrigger: simpler API (just `path` + `root`
// instead of a fully-constructed FileViewerData) so callsites adopt
// it without ceremony.
//
// FileViewer infers the kind from extension at render time (see
// drawer-viewers/FileViewer.tsx :: inferKind), so FileLink doesn't
// run its own inference path — image extensions
// (.png/.jpg/.jpeg/.gif/.webp/.svg) automatically render as `<img>`
// via the drawer. Walk-item 6 ("images show as binary") is therefore
// resolved by routing image-typed file references through this
// primitive instead of rendering filename text inertly.

import type { ReactNode, CSSProperties } from "react";
import { FileReferenceTrigger } from "../drawer-triggers/FileReferenceTrigger.js";
import type { FileKind, FileViewerData } from "../drawer-viewers/FileViewer.js";

export interface FileLinkProps {
  /** Display path. Also the relative read path under `root` when
   *  `readPath` is omitted. */
  path: string;
  /** Allowlist root name to read from. Optional when `absolutePath` is
   *  provided (the FileViewer's resolver picks the matching root). */
  root?: string;
  /** Explicit relative path under `root`; defaults to `path` when
   *  omitted. Useful when `path` is a display label distinct from the
   *  on-disk relative path. */
  readPath?: string;
  /** Absolute filesystem path; resolved against /api/files/roots by
   *  FileViewer when `root` isn't provided. */
  absolutePath?: string | null;
  /** Optional explicit kind override. When omitted, FileViewer infers
   *  from `path` extension at render time. */
  kind?: FileKind;
  /** Children rendered inside the clickable wrapper. Defaults to the
   *  raw `path` string when omitted. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function FileLink({
  path,
  root,
  readPath,
  absolutePath,
  kind,
  children,
  className,
  style,
  testId,
}: FileLinkProps) {
  const data: FileViewerData = {
    path,
    ...(root !== undefined ? { root } : {}),
    ...(readPath !== undefined ? { readPath } : {}),
    ...(absolutePath !== undefined ? { absolutePath } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  return (
    <FileReferenceTrigger
      data={data}
      className={className}
      style={style}
      testId={testId ?? "file-link"}
    >
      {children ?? path}
    </FileReferenceTrigger>
  );
}
