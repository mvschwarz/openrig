import { PiResumeAdapter } from "./pi-resume.js";

/** Restores an exact OMP session file through the shared runner. */
export class OmpResumeAdapter extends PiResumeAdapter {
  protected override readonly runtime = "omp" as const;
}
