import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "RIGS" },
  { to: "/import", label: "IMPORT" },
] as const;

export function Sidebar() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <nav
      data-testid="sidebar"
      className="w-[240px] bg-surface-low bg-noise flex flex-col py-spacing-6"
    >
      {NAV_ITEMS.map((item) => {
        const isActive = item.to === "/"
          ? currentPath === "/"
          : currentPath.startsWith(item.to);

        return (
          <Link
            key={item.to}
            to={item.to}
            data-testid={`nav-${item.label.toLowerCase()}`}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "px-spacing-6 py-spacing-3 text-label-lg uppercase tracking-[0.02em] transition-colors duration-150 ease-tactical",
              isActive
                ? "text-primary border-l-2 border-l-primary bg-surface"
                : "text-foreground-muted hover:text-foreground hover:bg-surface"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
