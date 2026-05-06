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
  primary: "bg-white border border-stone-900",
  ghost: "bg-transparent border border-stone-300",
};

const elevationShadow: Record<VellumCardElevation, string> = {
  elevated: "hard-shadow",
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
  ...rest
}: VellumCardProps) {
  const containerClass = cn(
    variantSurface[variant],
    elevationShadow[elevation],
    "flex flex-col relative",
    accentClass,
    className,
  );

  const inner = (
    <>
      {header ? (
        <div className="bg-stone-900 text-white px-4 py-1.5 font-mono text-[10px]">
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
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {inner}
      </a>
    );
  }

  if (as === "article") {
    return (
      <article className={containerClass} data-testid={testId} {...rest}>
        {inner}
      </article>
    );
  }
  if (as === "section") {
    return (
      <section className={containerClass} data-testid={testId} {...rest}>
        {inner}
      </section>
    );
  }
  return (
    <div className={containerClass} data-testid={testId} {...rest}>
      {inner}
    </div>
  );
}
