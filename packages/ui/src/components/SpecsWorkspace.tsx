import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouterState } from "@tanstack/react-router";

export interface SpecsDraft {
  id: string;
  kind: "rig" | "agent";
  label: string;
  yaml: string;
  updatedAt: number;
}

export interface SpecsTask {
  id: "import" | "bootstrap" | "validate-agent";
  label: string;
  route: "/import" | "/bootstrap" | "/agents/validate";
  summary: string;
}

interface SpecsWorkspaceValue {
  activeTask: SpecsTask | null;
  currentRigDraft: SpecsDraft | null;
  currentAgentDraft: SpecsDraft | null;
  recentRigDrafts: SpecsDraft[];
  recentAgentDrafts: SpecsDraft[];
  selectedRigDraft: SpecsDraft | null;
  selectedAgentDraft: SpecsDraft | null;
  bootstrapSourceRef: string;
  saveRigDraft: (yaml: string, label?: string) => void;
  rememberRigDraft: (yaml: string, label?: string) => void;
  selectRigDraft: (draftId: string) => void;
  clearSelectedRigDraft: () => void;
  saveAgentDraft: (yaml: string, label?: string) => void;
  rememberAgentDraft: (yaml: string, label?: string) => void;
  selectAgentDraft: (draftId: string) => void;
  clearSelectedAgentDraft: () => void;
  setBootstrapSourceRef: (sourceRef: string) => void;
}

export const SPECS_WORKSPACE_STORAGE_KEYS = {
  currentRigDraft: "rigged.specs.current-rig-draft",
  currentAgentDraft: "rigged.specs.current-agent-draft",
  recentRigDrafts: "rigged.specs.recent-rig-drafts",
  recentAgentDrafts: "rigged.specs.recent-agent-drafts",
  bootstrapSourceRef: "rigged.specs.bootstrap-source-ref",
} as const;

const DEFAULT_SPECS_WORKSPACE: SpecsWorkspaceValue = {
  activeTask: null,
  currentRigDraft: null,
  currentAgentDraft: null,
  recentRigDrafts: [],
  recentAgentDrafts: [],
  selectedRigDraft: null,
  selectedAgentDraft: null,
  bootstrapSourceRef: "",
  saveRigDraft: () => {},
  rememberRigDraft: () => {},
  selectRigDraft: () => {},
  clearSelectedRigDraft: () => {},
  saveAgentDraft: () => {},
  rememberAgentDraft: () => {},
  selectAgentDraft: () => {},
  clearSelectedAgentDraft: () => {},
  setBootstrapSourceRef: () => {},
};

const SpecsWorkspaceContext = createContext<SpecsWorkspaceValue>(DEFAULT_SPECS_WORKSPACE);

function loadStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function persistStoredValue(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    if (value === "" || value === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort only for local working state.
  }
}

function createDraft(kind: "rig" | "agent", yaml: string, label?: string): SpecsDraft {
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    label: label ?? (kind === "rig" ? "Untitled RigSpec" : "Untitled AgentSpec"),
    yaml,
    updatedAt: Date.now(),
  };
}

function extractSpecLabel(yaml: string, fallback: string): string {
  const match = yaml.match(/^\s*name:\s*["']?([^"'\n#]+)["']?/m);
  return match?.[1]?.trim() || fallback;
}

function upsertRecentDrafts(list: SpecsDraft[], draft: SpecsDraft): SpecsDraft[] {
  return [draft, ...list.filter((item) => item.id !== draft.id && item.yaml !== draft.yaml)].slice(0, 5);
}

function buildActiveTask(
  pathname: string,
  currentRigDraft: SpecsDraft | null,
  currentAgentDraft: SpecsDraft | null,
  bootstrapSourceRef: string,
): SpecsTask | null {
  if (pathname === "/import") {
    if (!currentRigDraft) return null;
    return {
      id: "import",
      label: "Import RigSpec",
      route: "/import",
      summary: currentRigDraft.label,
    };
  }

  if (pathname === "/bootstrap") {
    const trimmedSourceRef = bootstrapSourceRef.trim();
    if (!trimmedSourceRef) return null;
    return {
      id: "bootstrap",
      label: "Bootstrap",
      route: "/bootstrap",
      summary: trimmedSourceRef,
    };
  }

  if (pathname === "/agents/validate") {
    if (!currentAgentDraft) return null;
    return {
      id: "validate-agent",
      label: "Validate AgentSpec",
      route: "/agents/validate",
      summary: currentAgentDraft.label,
    };
  }

  return null;
}

export function SpecsWorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [currentRigDraft, setCurrentRigDraft] = useState<SpecsDraft | null>(() =>
    loadStoredValue<SpecsDraft | null>(SPECS_WORKSPACE_STORAGE_KEYS.currentRigDraft, null)
  );
  const [currentAgentDraft, setCurrentAgentDraft] = useState<SpecsDraft | null>(() =>
    loadStoredValue<SpecsDraft | null>(SPECS_WORKSPACE_STORAGE_KEYS.currentAgentDraft, null)
  );
  const [recentRigDrafts, setRecentRigDrafts] = useState<SpecsDraft[]>(() =>
    loadStoredValue<SpecsDraft[]>(SPECS_WORKSPACE_STORAGE_KEYS.recentRigDrafts, [])
  );
  const [recentAgentDrafts, setRecentAgentDrafts] = useState<SpecsDraft[]>(() =>
    loadStoredValue<SpecsDraft[]>(SPECS_WORKSPACE_STORAGE_KEYS.recentAgentDrafts, [])
  );
  const [selectedRigDraftId, setSelectedRigDraftId] = useState<string | null>(null);
  const [selectedAgentDraftId, setSelectedAgentDraftId] = useState<string | null>(null);
  const [bootstrapSourceRef, setBootstrapSourceRefState] = useState(() =>
    loadStoredValue<string>(SPECS_WORKSPACE_STORAGE_KEYS.bootstrapSourceRef, "")
  );

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.currentRigDraft, currentRigDraft);
  }, [currentRigDraft]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.currentAgentDraft, currentAgentDraft);
  }, [currentAgentDraft]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.recentRigDrafts, recentRigDrafts);
  }, [recentRigDrafts]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.recentAgentDrafts, recentAgentDrafts);
  }, [recentAgentDrafts]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.bootstrapSourceRef, bootstrapSourceRef.trim());
  }, [bootstrapSourceRef]);

  const selectedRigDraft = useMemo(
    () =>
      recentRigDrafts.find((draft) => draft.id === selectedRigDraftId)
      ?? (currentRigDraft?.id === selectedRigDraftId ? currentRigDraft : null),
    [currentRigDraft, recentRigDrafts, selectedRigDraftId],
  );

  const selectedAgentDraft = useMemo(
    () =>
      recentAgentDrafts.find((draft) => draft.id === selectedAgentDraftId)
      ?? (currentAgentDraft?.id === selectedAgentDraftId ? currentAgentDraft : null),
    [currentAgentDraft, recentAgentDrafts, selectedAgentDraftId],
  );

  const saveRigDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) {
      setCurrentRigDraft(null);
      return;
    }

    setCurrentRigDraft((existing) => ({
      id: existing?.id ?? createDraft("rig", yaml, label).id,
      kind: "rig",
      label: label ?? extractSpecLabel(yaml, existing?.label ?? "Untitled RigSpec"),
      yaml,
      updatedAt: Date.now(),
    }));
  }, []);

  const rememberRigDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) return;
    const draft = createDraft("rig", yaml, label ?? extractSpecLabel(yaml, "Untitled RigSpec"));
    setCurrentRigDraft(draft);
    setRecentRigDrafts((existing) => upsertRecentDrafts(existing, draft));
    setSelectedRigDraftId(draft.id);
  }, []);

  const saveAgentDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) {
      setCurrentAgentDraft(null);
      return;
    }

    setCurrentAgentDraft((existing) => ({
      id: existing?.id ?? createDraft("agent", yaml, label).id,
      kind: "agent",
      label: label ?? extractSpecLabel(yaml, existing?.label ?? "Untitled AgentSpec"),
      yaml,
      updatedAt: Date.now(),
    }));
  }, []);

  const rememberAgentDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) return;
    const draft = createDraft("agent", yaml, label ?? extractSpecLabel(yaml, "Untitled AgentSpec"));
    setCurrentAgentDraft(draft);
    setRecentAgentDrafts((existing) => upsertRecentDrafts(existing, draft));
    setSelectedAgentDraftId(draft.id);
  }, []);

  const selectRigDraft = useCallback((draftId: string) => {
    setSelectedRigDraftId(draftId);
    const draft = recentRigDrafts.find((item) => item.id === draftId)
      ?? (currentRigDraft?.id === draftId ? currentRigDraft : null);
    if (draft) {
      setCurrentRigDraft(draft);
    }
  }, [currentRigDraft, recentRigDrafts]);

  const selectAgentDraft = useCallback((draftId: string) => {
    setSelectedAgentDraftId(draftId);
    const draft = recentAgentDrafts.find((item) => item.id === draftId)
      ?? (currentAgentDraft?.id === draftId ? currentAgentDraft : null);
    if (draft) {
      setCurrentAgentDraft(draft);
    }
  }, [currentAgentDraft, recentAgentDrafts]);

  const value = useMemo<SpecsWorkspaceValue>(() => ({
    activeTask: buildActiveTask(pathname, currentRigDraft, currentAgentDraft, bootstrapSourceRef),
    currentRigDraft,
    currentAgentDraft,
    recentRigDrafts,
    recentAgentDrafts,
    selectedRigDraft,
    selectedAgentDraft,
    bootstrapSourceRef,
    saveRigDraft,
    rememberRigDraft,
    selectRigDraft,
    clearSelectedRigDraft: () => setSelectedRigDraftId(null),
    saveAgentDraft,
    rememberAgentDraft,
    selectAgentDraft,
    clearSelectedAgentDraft: () => setSelectedAgentDraftId(null),
    setBootstrapSourceRef: setBootstrapSourceRefState,
  }), [
    pathname,
    currentRigDraft,
    currentAgentDraft,
    recentRigDrafts,
    recentAgentDrafts,
    selectedRigDraft,
    selectedAgentDraft,
    bootstrapSourceRef,
    saveRigDraft,
    rememberRigDraft,
    selectRigDraft,
    saveAgentDraft,
    rememberAgentDraft,
    selectAgentDraft,
  ]);

  return (
    <SpecsWorkspaceContext.Provider value={value}>
      {children}
    </SpecsWorkspaceContext.Provider>
  );
}

export function useSpecsWorkspace() {
  return useContext(SpecsWorkspaceContext);
}
