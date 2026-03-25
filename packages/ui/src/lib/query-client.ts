import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,    // 5s — local daemon is low latency
      gcTime: 5 * 60_000,  // 5min — keep unused cache briefly
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
