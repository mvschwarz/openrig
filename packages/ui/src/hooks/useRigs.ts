import { useState, useEffect } from "react";

interface Rig {
  id: string;
  name: string;
}

type FetchStatus = "loading" | "success" | "error";

export interface UseRigsResult {
  rigs: Rig[];
  loading: boolean;
  error: string | null;
}

export function useRigs(): UseRigsResult {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/rigs")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Rig[]) => {
        if (!cancelled) {
          setRigs(data);
          setStatus("success");
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    rigs,
    loading: status === "loading",
    error,
  };
}
