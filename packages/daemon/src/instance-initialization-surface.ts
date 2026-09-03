export {
  ensureOpenRigInstance,
  formatInstanceInitializationConflicts,
  type OpenRigInstanceInitializationOptions,
  type OpenRigInstanceInitializationResult,
} from "./domain/instance-initialization.js";
export {
  ensureDefaultWorkspace,
  nodeInitializationFs,
  workspaceScaffoldDirs,
  workspaceScaffoldFiles,
  type InitializationConflict,
  type InitializationFsOps,
  type InitWorkspaceResult,
  type ManagedPathKind,
} from "./domain/workspace/default-workspace-scaffold.js";
