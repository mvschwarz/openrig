// ui-redesign C08: ⌘K command palette + g-then-key navigation shortcuts.

import { useCallback, useEffect, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "@tanstack/react-router";
import { allNavItems } from "../../lib/nav.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useTheme } from "../ThemeProvider.js";
import { StatusDot } from "../ui/status-badge.js";
import { useRigStatusResolver } from "../../hooks/useRigStatusResolver.js";
import { DialogTitle } from "../ui/dialog.js";

const SEARCH_PLACEHOLDER = "Search pages, rigs, actions…";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return target.closest("[contenteditable]") !== null;
}

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const navigate = useNavigate();
  const rigsQuery = useRigSummary();
  const rigStatus = useRigStatusResolver();
  const { resolved, setTheme } = useTheme();

  const go = useCallback(
    (to: string, params?: Record<string, string>) => {
      setOpen(false);
      void navigate({ to, params } as never);
    },
    [navigate],
  );

  useEffect(() => {
    const onCmdK = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onCmdK);
    window.addEventListener("openrig:open-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onCmdK);
      window.removeEventListener("openrig:open-palette", onOpenEvent);
    };
  }, []);

  const toggleDarkMode = useCallback(() => {
    setTheme(resolved === "dark" ? "light" : "dark");
    setOpen(false);
  }, [resolved, setTheme]);

  const navItems = allNavItems();
  const rigs = rigsQuery.data ?? [];

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Command palette"
      >
        <div data-testid="command-palette">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <Command.Input placeholder={SEARCH_PLACEHOLDER} />
          <Command.List>
            <Command.Empty>No results found.</Command.Empty>
            <Command.Group heading="Go to">
              {navItems.map((item) => (
                <Command.Item
                  key={item.id}
                  value={`${item.label} ${(item.keywords ?? []).join(" ")}`}
                  onSelect={() => go(item.to)}
                >
                  {item.label}
                </Command.Item>
              ))}
            </Command.Group>
            {rigs.length > 0 ? (
              <Command.Group heading="Rigs">
                {rigs.map((rig) => (
                  <Command.Item
                    key={rig.id}
                    value={rig.name}
                    onSelect={() => go("/topology/rig/$rigId", { rigId: rig.id })}
                  >
                    <span data-testid={`palette-rig-${rig.id}`}>
                      <StatusDot status={rigStatus(rig.id, rig.lifecycleState)} />
                      {rig.name}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            <Command.Group heading="Actions">
              <Command.Item value="New rig" onSelect={() => go("/specs/rig")}>
                New rig
              </Command.Item>
              <Command.Item value="Import a rig" onSelect={() => go("/import")}>
                Import a rig
              </Command.Item>
              <Command.Item value="Bootstrap a host" onSelect={() => go("/bootstrap")}>
                Bootstrap a host
              </Command.Item>
              <Command.Item value="Toggle dark mode" onSelect={toggleDarkMode}>
                Toggle dark mode
              </Command.Item>
              <Command.Item
                value="Keyboard shortcuts"
                onSelect={() => {
                  setOpen(false);
                  setShortcutsOpen(true);
                }}
              >
                Keyboard shortcuts
              </Command.Item>
            </Command.Group>
          </Command.List>
        </div>
      </Command.Dialog>
      {/* Shortcuts dialog: only the 4 implemented shortcuts. */}
      <Command.Dialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        label="Keyboard shortcuts"
      >
        <div data-testid="keyboard-shortcuts">
          <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
          <h2 aria-hidden="true">Keyboard shortcuts</h2>
          <ul>
            <li>
              <kbd>⌘K</kbd> Search
            </li>
            <li>
              <kbd>g d</kbd> Dashboard
            </li>
            <li>
              <kbd>g i</kbd> Inbox
            </li>
            <li>
              <kbd>g r</kbd> Rigs
            </li>
          </ul>
        </div>
      </Command.Dialog>
    </>
  );
}

/**
 * g-then-key shortcuts: after `g`, the next key within 1000 ms navigates:
 * d → `/`, i → `/for-you`, r → `/topology`. Ignores keypresses that start
 * in an editable element (input, textarea, select, [contenteditable]).
 * Mounted once by AppShellInner alongside <CommandPalette />.
 */
export function PaletteShortcuts(): React.JSX.Element {
  const navigate = useNavigate();

  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      pending = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) {
        clear();
        return;
      }
      if (pending) {
        const key = e.key.toLowerCase();
        if (key === "d") {
          clear();
          void navigate({ to: "/" });
          return;
        }
        if (key === "i") {
          clear();
          void navigate({ to: "/for-you" });
          return;
        }
        if (key === "r") {
          clear();
          void navigate({ to: "/topology" });
          return;
        }
        clear();
        if (e.key.toLowerCase() === "g") {
          pending = true;
          timer = setTimeout(clear, 1000);
        }
        return;
      }
      if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        pending = true;
        timer = setTimeout(clear, 1000);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (timer !== null) clearTimeout(timer);
    };
  }, [navigate]);

  return <></>;
}
