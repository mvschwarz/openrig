import { toast } from "sonner";

export function notifySuccess(title: string, description?: string): void {
  toast.success(title, { description });
}

export function notifyError(title: string, error: unknown): void {
  const description =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  toast.error(title, { description });
}
