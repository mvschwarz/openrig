import { PiResumeAdapter } from "./pi-resume.js";

/** Restores an exact OMP session file through the shared runner. */
export class OmpResumeAdapter extends PiResumeAdapter {
  protected override readonly runtime = "omp" as const;
  protected override get childRuntime(): "omp" { return "omp"; }

  override canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return (resumeType === "omp_session_file" || resumeType === "omp-tui_session_file") && !!resumeToken;
  }
}