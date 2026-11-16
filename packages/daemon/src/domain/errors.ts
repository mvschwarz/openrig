export class RigNotFoundError extends Error {
  constructor(rigId: string) {
    super(`Rig ${rigId} not found`);
    this.name = "RigNotFoundError";
  }
}

/** An export that would drop or alter what a seat stores, refused with the seat named and the way out (#3253). */
export class ExportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRefusedError";
  }
}
