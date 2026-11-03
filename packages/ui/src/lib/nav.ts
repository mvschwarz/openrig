import type { ComponentType } from "react";
import { LayoutDashboard, Inbox, Network, Users, Globe, FolderKanban, Workflow, FileText, Library, Settings, Brain, Wrench } from "lucide-react";

export interface NavItem {
  id: string;                 // stable id
  label: string;              // sentence case, shown in sidebar + palette
  to: string;                 // URL (unchanged routes)
  icon: ComponentType<{ className?: string; strokeWidth?: number | string }>;
  testId: string;             // data-testid on the sidebar link
  activeWhen: (pathname: string) => boolean;
  keywords?: string[];        // extra palette search terms (old names!)
}
export interface NavSection { id: string; label: string | null; items: NavItem[] }

export const NAV_SECTIONS: NavSection[] = [
  { id: "top", label: null, items: [
    { id: "dashboard", label: "Dashboard", to: "/", icon: LayoutDashboard, testId: "rail-dashboard", activeWhen: (p) => p === "/", keywords: ["home"] },
    { id: "inbox", label: "Inbox", to: "/for-you", icon: Inbox, testId: "rail-for-you", activeWhen: (p) => p.startsWith("/for-you"), keywords: ["for you", "attention", "approvals", "needs you"] },
  ]},
  { id: "fleet", label: "Fleet", items: [
    { id: "rigs", label: "Rigs", to: "/topology", icon: Network, testId: "rail-topology", activeWhen: (p) => p.startsWith("/topology") || p.startsWith("/rigs/"), keywords: ["topology", "graph"] },
    { id: "agents", label: "Agents", to: "/agents", icon: Users, testId: "rail-agents", activeWhen: (p) => p === "/agents", keywords: ["seats"] },
    { id: "fleet", label: "Hosts", to: "/fleet", icon: Globe, testId: "rail-fleet", activeWhen: (p) => p.startsWith("/fleet"), keywords: ["fleet", "machines"] },
  ]},
  { id: "work", label: "Work", items: [
    { id: "projects", label: "Projects", to: "/project", icon: FolderKanban, testId: "rail-project", activeWhen: (p) => p.startsWith("/project"), keywords: ["missions", "slices", "workspace"] },
    { id: "workflows", label: "Workflows", to: "/workflows", icon: Workflow, testId: "rail-workflows", activeWhen: (p) => p.startsWith("/workflow"), keywords: [] },
    { id: "files", label: "Files", to: "/files", icon: FileText, testId: "rail-files", activeWhen: (p) => p.startsWith("/files"), keywords: [] },
  ]},
  { id: "build", label: "Build", items: [
    { id: "library", label: "Library", to: "/specs", icon: Library, testId: "rail-specs", activeWhen: (p) => p.startsWith("/specs") || p.startsWith("/plugins"), keywords: ["specs", "skills", "plugins", "context packs"] },
  ]},
];

export const NAV_FOOTER: NavItem[] = [
  { id: "settings", label: "Settings", to: "/settings", icon: Settings, testId: "rail-settings", activeWhen: (p) => p.startsWith("/settings"), keywords: ["preferences", "policies", "log", "status"] },
];

/** Advisor/Operator: `to` is resolved at render time with resolveChatTo(). */
export const NAV_CHAT: Array<Omit<NavItem, "to" | "activeWhen"> & { role: "advisor" | "operator" }> = [
  { id: "advisor", role: "advisor", label: "Advisor", icon: Brain, testId: "rail-advisor" },
  { id: "operator", role: "operator", label: "Operator", icon: Wrench, testId: "rail-operator" },
];

export function allNavItems(): NavItem[] { return [...NAV_SECTIONS.flatMap((s) => s.items), ...NAV_FOOTER]; }
