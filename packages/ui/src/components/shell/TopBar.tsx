// ui-redesign C07: top bar content — mobile hamburger stays in AppShell,
// breadcrumbs + HostIndicator + ThemeSelector live here.

import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { breadcrumbsFor, type Crumb } from "../../lib/breadcrumbs.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { HostIndicator } from "../HostIndicator.js";
import { ThemeSelector } from "../ThemeSelector.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip.js";

function BreadcrumbItem({ crumb, isLast }: { crumb: Crumb; isLast: boolean }) {
  const itemContent = crumb.to && !isLast ? (
    <Link
      to={crumb.to}
      title={crumb.label}
      className="text-on-surface-variant hover:text-on-surface min-w-0 max-w-[120px] sm:max-w-[180px] md:max-w-[240px] truncate inline-block"
    >
      {crumb.label}
    </Link>
  ) : (
    <span
      aria-current={isLast ? "page" : undefined}
      title={crumb.label}
      className="text-on-surface font-medium min-w-0 max-w-[140px] sm:max-w-[220px] md:max-w-[320px] truncate inline-block"
    >
      {crumb.label}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{itemContent}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-xs break-words">
        {crumb.label}
      </TooltipContent>
    </Tooltip>
  );
}

export function TopBar() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const { data } = useRigSummary();
  const crumbs = breadcrumbsFor(pathname, {
    rigName: (id) => data?.find((r) => r.id === id)?.name,
  });

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* Mobile-only wordmark; desktop wordmark lives in the sidebar header (C06). */}
        <Link
          to="/"
          data-testid="brand-home-link"
          className="shrink-0 text-sm font-semibold text-on-surface lg:hidden"
        >
          OpenRig
        </Link>
        <TooltipProvider delayDuration={300}>
          <div
            role="navigation"
            aria-label="Breadcrumb"
            data-testid="breadcrumbs"
            className="flex min-w-0 items-center gap-1 text-sm overflow-hidden"
          >
            {crumbs.map((crumb, i) => {
              const isLast = i === crumbs.length - 1;
              return (
                <Fragment key={`${crumb.label}-${i}`}>
                  {i > 0 ? (
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-on-surface-variant"
                      aria-hidden="true"
                    />
                  ) : null}
                  <BreadcrumbItem crumb={crumb} isLast={isLast} />
                </Fragment>
              );
            })}
          </div>
        </TooltipProvider>
      </div>
      <div data-testid="topbar-right-slot" className="flex shrink-0 items-center gap-3">
        <HostIndicator />
        <ThemeSelector />
      </div>
    </>
  );
}
