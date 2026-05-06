import * as React from "react";
import { cn } from "@/lib/utils";

export interface RegistrationMarksProps {
  testIdPrefix?: string;
  className?: string;
}

export function RegistrationMarks({ testIdPrefix, className }: RegistrationMarksProps) {
  const tid = (corner: "tl" | "tr" | "bl" | "br") =>
    testIdPrefix ? `${testIdPrefix}-reg-${corner}` : undefined;
  return (
    <>
      <span className={cn("reg-tl", className)} data-testid={tid("tl")} aria-hidden="true" />
      <span className={cn("reg-tr", className)} data-testid={tid("tr")} aria-hidden="true" />
      <span className={cn("reg-bl", className)} data-testid={tid("bl")} aria-hidden="true" />
      <span className={cn("reg-br", className)} data-testid={tid("br")} aria-hidden="true" />
    </>
  );
}
