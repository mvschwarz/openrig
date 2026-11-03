// ui-redesign C07: top bar content — mobile hamburger stays in AppShell,
// breadcrumbs + HostIndicator + ThemeSelector live here.

import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { useRouterState } from "@tanstack/react-router";
import { breadcrumbsFor } from "../../lib/breadcrumbs.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { HostIndicator } from "../HostIndicator.js";
import { ThemeSelector } from "../ThemeSelector.js";

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
        <div
          role="navigation"
          aria-label="Breadcrumb"
          data-testid="breadcrumbs"
          className="flex min-w-0 items-center gap-1 text-sm"
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
                {crumb.to && !isLast ? (
                  <Link
                    to={crumb.to}
                    className="shrink-0 text-on-surface-variant hover:text-on-surface"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? "page" : undefined}
                    className="text-on-surface font-medium truncate"
                  >
                    {crumb.label}
                  </span>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
      <div data-testid="topbar-right-slot" className="flex shrink-0 items-center gap-3">
        <HostIndicator />
        <ThemeSelector />
      </div>
    </>
  );
}
