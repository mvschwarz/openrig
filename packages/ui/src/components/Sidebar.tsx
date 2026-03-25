import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "RIGS", sublabel: "TOPOLOGY" },
  { to: "/import", label: "IMPORT", sublabel: "RIGSPEC" },
] as const;

export function Sidebar() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <nav
      data-testid="sidebar"
      className="w-[240px] bg-surface-low bg-noise flex flex-col shrink-0 relative"
    >
      {/* Navigation section */}
      <div className="flex flex-col pt-spacing-6 flex-1">
        {/* Section label */}
        <div className="px-spacing-6 mb-spacing-3">
          <span className="text-label-sm uppercase tracking-[0.08em] text-foreground-muted opacity-50">
            NAVIGATION
          </span>
        </div>

        {NAV_ITEMS.map((item) => {
          const isActive = item.to === "/"
            ? currentPath === "/" || currentPath.startsWith("/rigs")
            : currentPath.startsWith(item.to);

          return (
            <Link
              key={item.to}
              to={item.to}
              data-testid={`nav-${item.label.toLowerCase()}`}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex flex-col px-spacing-6 py-spacing-3 transition-colors duration-150 ease-tactical relative",
                isActive
                  ? "text-primary bg-surface"
                  : "text-foreground-muted hover:text-foreground hover:bg-surface/50"
              )}
            >
              {/* Active indicator — left accent bar */}
              {isActive && (
                <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-primary" />
              )}
              <span className="text-label-lg uppercase tracking-[0.03em]">
                {item.label}
              </span>
              <span className="text-label-sm text-foreground-muted opacity-50 mt-px">
                {item.sublabel}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Bottom section — system info */}
      <div className="p-spacing-6 border-t border-ghost-border">
        <div className="text-label-sm font-mono text-foreground-muted opacity-30 leading-relaxed">
          <div>PORT 7433</div>
          <div>LOCAL</div>
        </div>
      </div>

      {/* Right edge fade */}
      <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-ghost-border to-transparent" />
    </nav>
  );
}
