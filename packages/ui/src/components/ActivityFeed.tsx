import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  type ActivityEvent,
  formatLogTime,
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
        "fixed bottom-7 right-4 z-20 w-80 max-w-[calc(100vw-1rem)] max-h-[50vh] overflow-hidden",
        "text-stone-900 rounded-sm",
        "bg-[rgba(250,249,245,0.035)] backdrop-blur-[14px] backdrop-saturate-75",
        "supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)]",
        "shadow-[-3px_-2px_8px_rgba(46,52,46,0.025)]",
        "border border-stone-300/16"
      )}
    >
      <div className="relative flex max-h-[50vh] flex-col">
        {/* Header */}
        <div className="relative z-10 flex items-center justify-between px-spacing-3 py-spacing-2 border-b border-stone-300/35 shrink-0">
          <span className="text-label-sm uppercase tracking-[0.06em] text-stone-700">
            ACTIVITY
          </span>
          <button
            data-testid="feed-close"
            onClick={onClose}
            className="text-label-sm text-stone-500 hover:text-stone-900 hover:bg-white/30 transition-colors duration-150 ease-tactical px-spacing-1"
            aria-label="Close activity feed"
          >
            &times;
          </button>
        </div>

        {/* Event list */}
        <div className="relative z-10 overflow-y-auto flex-1 min-h-0">
          {events.length === 0 ? (
            <div data-testid="feed-empty" className="px-spacing-3 py-spacing-4 font-mono text-[11px] text-stone-500 text-center">
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
                    "flex items-center gap-2 px-spacing-3 py-2 border-b border-stone-300/20 transition-colors duration-150 ease-tactical font-mono text-[11px] leading-5",
                    isNavigable && "cursor-pointer hover:bg-white/24"
                  )}
                >
                  {/* Status dot */}
                  <span
                    data-testid="feed-dot"
                    className={cn("inline-block h-[6px] w-[6px] shrink-0", eventColor(event.type))}
                  />

                  <span
                    data-testid="feed-time"
                    className="shrink-0 text-[10px] text-stone-500 tabular-nums"
                  >
                    {formatLogTime(event.createdAt)}
                  </span>
                  <span
                    data-testid="feed-summary"
                    className="min-w-0 flex-1 truncate text-stone-900"
                  >
                    {eventSummary(event)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
