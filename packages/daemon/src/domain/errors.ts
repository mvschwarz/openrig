export class RigNotFoundError extends Error {
  constructor(rigId: string) {
    super(`Rig ${rigId} not found`);
    this.name = "RigNotFoundError";
  }
}
