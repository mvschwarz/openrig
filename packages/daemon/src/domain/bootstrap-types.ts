/** Bootstrap run status lifecycle */
export type BootstrapStatus = "planned" | "running" | "completed" | "failed" | "partial";

/** Bootstrap action kinds */
export type ActionKind =
  | "runtime_check"
  | "requirement_check"
  | "external_install"
  | "package_install"
  | "rig_import"
  | "launch";

/** Bootstrap action status lifecycle */
export type ActionStatus = "planned" | "approved" | "skipped" | "running" | "completed" | "failed";

/** Runtime verification status */
export type RuntimeStatus = "verified" | "not_found" | "degraded" | "error";

/** A bootstrap run — one execution of `rig bootstrap <spec>` */
export interface BootstrapRun {
  id: string;
  sourceKind: string;
  sourceRef: string;
  status: BootstrapStatus;
  rigId: string | null;
  createdAt: string;
  appliedAt: string | null;
}

/** A single action within a bootstrap run */
export interface BootstrapAction {
  id: string;
  bootstrapId: string;
  seq: number;
  actionKind: ActionKind;
  subjectType: string | null;
  subjectName: string | null;
  provider: string | null;
  commandPreview: string | null;
  status: ActionStatus;
  detailJson: string | null;
  createdAt: string;
}

/** A runtime verification record */
export interface RuntimeVerification {
  id: string;
  runtime: string;
  version: string | null;
  capabilitiesJson: string | null;
  verifiedAt: string;
  status: RuntimeStatus;
  error: string | null;
}
