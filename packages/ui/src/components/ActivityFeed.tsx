import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  type ActivityEvent,
  formatRelativeTime,
  eventColor,
  eventSummary,
  eventRoute,
} from "../hooks/useActivityFeed.js";

interface ActivityFeedProps {
  events: ActivityEvent[];
  open: boolean;
  onClose: () => void;
}

export function ActivityFeed({ events, open, onClose }: ActivityFeedProps) {
  const navigate = useNavigate();

  if (!open) return null;

  return (
    <div
      data-testid="activity-feed"
      className={cn(
        "fixed bottom-7 right-0 z-20 w-80 max-w-full max-h-[50vh]",
        "bg-surface-dark text-foreground-on-dark",
        "flex flex-col shadow-[0_-2px_12px_-4px_rgba(0,0,0,0.4)]",
        "border-l border-t border-white/6"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-spacing-3 py-spacing-2 border-b border-white/8 shrink-0">
        <span className="text-label-sm uppercase tracking-[0.06em] text-foreground-muted-on-dark">
          ACTIVITY
        </span>
        <button
          data-testid="feed-close"
          onClick={onClose}
          className="text-label-sm text-foreground-muted-on-dark hover:text-foreground-on-dark transition-colors duration-150 ease-tactical px-spacing-1"
          aria-label="Close activity feed"
        >
          &times;
        </button>
      </div>

      {/* Event list */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {events.length === 0 ? (
          <div data-testid="feed-empty" className="px-spacing-3 py-spacing-4 text-label-sm text-foreground-muted-on-dark text-center">
            No recent activity
          </div>
        ) : (
          events.map((event) => {
            const route = eventRoute(event);
            const isNavigable = route !== null;

            return (
              <div
                key={event.seq}
                data-testid="feed-entry"
                data-event-type={event.type}
                role={isNavigable ? "link" : undefined}
                tabIndex={isNavigable ? 0 : undefined}
                onClick={isNavigable ? () => navigate({ to: route }) : undefined}
                onKeyDown={isNavigable ? (e) => { if (e.key === "Enter") navigate({ to: route }); } : undefined}
                className={cn(
                  "flex items-start gap-spacing-2 px-spacing-3 py-spacing-2 border-b border-white/4 transition-colors duration-150 ease-tactical",
                  isNavigable && "cursor-pointer hover:bg-white/6"
                )}
              >
                {/* Status dot */}
                <span
                  data-testid="feed-dot"
                  className={cn("inline-block w-[6px] h-[6px] mt-[5px] shrink-0", eventColor(event.type))}
                />

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <span data-testid="feed-summary" className="text-label-sm text-foreground-on-dark block truncate">
                    {eventSummary(event)}
                  </span>
                  <span data-testid="feed-time" className="text-label-sm font-mono text-foreground-muted-on-dark">
                    {formatRelativeTime(new Date(event.createdAt).getTime())}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
