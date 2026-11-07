import * as React from "react";
import { cn } from "@/lib/utils";
import { RegistrationMarks } from "./registration-marks";

export type VellumCardElevation = "elevated" | "flat";
export type VellumCardVariant = "primary" | "ghost";

type PolymorphicAs = "div" | "article" | "section";

export interface VellumCardProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  header?: React.ReactNode;
  registrationMarks?: boolean;
  elevation?: VellumCardElevation;
  variant?: VellumCardVariant;
  accentClass?: string;
  href?: string;
  as?: PolymorphicAs;
  testId?: string;
}

const variantSurface: Record<VellumCardVariant, string> = {
  primary: "rounded-lg border bg-surface-lowest shadow-sm",
  ghost: "rounded-lg border bg-surface-lowest shadow-sm",
};

const elevationShadow: Record<VellumCardElevation, string> = {
  // Clean theme (ui-redesign C03): no vellum hard offset shadows; the card
  // surface in variantSurface already carries shadow-sm.
  elevated: "",
  flat: "",
};

export function VellumCard({
  children,
  header,
  registrationMarks = true,
  elevation = "elevated",
  variant = "primary",
  accentClass,
  href,
  as = "div",
  className,
  testId,
  onClick,
  ...rest
}: VellumCardProps) {
  const isInteractive = Boolean(href || onClick);
  const containerClass = cn(
    variantSurface[variant],
    elevationShadow[elevation],
    "flex flex-col relative",
    isInteractive &&
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface focus-visible:outline-offset-2",
    accentClass,
    className,
  );

  const inner = (
    <>
      {header ? (
        <div className="px-4 py-1.5 text-sm font-semibold text-on-surface">
          {header}
        </div>
      ) : null}
      <div className="flex flex-col flex-1">{children}</div>
      {registrationMarks ? <RegistrationMarks testIdPrefix={testId} /> : null}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={containerClass}
        data-testid={testId}
        onClick={onClick}
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {inner}
      </a>
    );
  }

  if (as === "article") {
    return (
      <article className={containerClass} data-testid={testId} onClick={onClick} {...rest}>
        {inner}
      </article>
    );
  }
  if (as === "section") {
    return (
      <section className={containerClass} data-testid={testId} onClick={onClick} {...rest}>
        {inner}
      </section>
    );
  }
  return (
    <div className={containerClass} data-testid={testId} onClick={onClick} {...rest}>
      {inner}
    </div>
  );
}
