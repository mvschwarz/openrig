// Slice 18 §1.5 — reusable Library navigation primitive.
//
// Renders a top-level Library page index: title header + folder-grouped
// flat list. Each item triggers onItemClick (consumer supplies routing).
//
// emptyState semantics: when an isUserDefined predicate is provided,
// emptyState renders whenever NO item satisfies it (so the user-facing
// guidance copy still surfaces when only built-ins are present). The
// folder list always renders alongside emptyState when items.length > 0,
// so built-ins remain browsable. Without the predicate the legacy
// items.length === 0 fallback applies.
//
// Two applications in this slice: Skills + Plugins. Future Library
// surfaces (specs, applications, context-packs) can adopt the same
// primitive — folderField is keyof T so the consumer chooses the
// grouping field per data shape.

import type { ReactNode } from "react";
import { useMemo } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { cn } from "../../lib/utils.js";

export interface LibraryItem {
  id: string;
  name: string;
}

export interface LibraryTopLevelEntryProps<T extends LibraryItem> {
  slug: string;
  displayName: string;
  iconKind: string;
  items: T[];
  folderField: keyof T;
  emptyState: ReactNode;
  onItemClick: (item: T) => void;
  formatFolderLabel?: (folder: unknown) => string;
  isLoading?: boolean;
  /**
   * Predicate identifying user-defined items (vs. built-ins). When
   * provided, emptyState renders whenever NO item satisfies the
   * predicate — surfacing guidance for adding user content even
   * when built-ins are present. Without the predicate, emptyState
   * renders only when items is empty (back-compat for consumers
   * that don't care about the user/built-in distinction).
   */
  isUserDefined?: (item: T) => boolean;
}

interface FolderGroup<T extends LibraryItem> {
  key: string;
  rawKey: unknown;
  items: T[];
}

function groupItems<T extends LibraryItem>(items: T[], folderField: keyof T): FolderGroup<T>[] {
  const buckets = new Map<string, FolderGroup<T>>();
  for (const item of items) {
    const rawKey = item[folderField];
    const key = String(rawKey ?? "");
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, rawKey, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
  }
  return Array.from(buckets.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export function LibraryTopLevelEntry<T extends LibraryItem>({
  slug,
  displayName,
  iconKind,
  items,
  folderField,
  emptyState,
  onItemClick,
  formatFolderLabel,
  isLoading,
  isUserDefined,
}: LibraryTopLevelEntryProps<T>) {
  const folders = useMemo(() => groupItems(items, folderField), [items, folderField]);
  const userDefinedCount = useMemo(() => {
    if (!isUserDefined) return items.length;
    let count = 0;
    for (const item of items) {
      if (isUserDefined(item)) count += 1;
    }
    return count;
  }, [items, isUserDefined]);
  const showEmptyState = userDefinedCount === 0;
  const showFolders = items.length > 0;

  return (
    <div
      data-testid={`library-top-level-${slug}`}
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Library</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1">
          {displayName}
        </h1>
      </header>

      {showEmptyState ? (
        <div data-testid={`library-top-level-${slug}-empty`} className="mb-4">
          {emptyState}
        </div>
      ) : null}
      {showFolders ? (
        <div className="space-y-4">
          {folders.map((folder) => {
            const label = formatFolderLabel
              ? formatFolderLabel(folder.rawKey)
              : folder.key;
            return (
              <section
                key={folder.key}
                data-testid={`library-folder-${folder.key}`}
                className="border border-outline-variant bg-white/25 hard-shadow"
              >
                <header className="flex items-baseline justify-between border-b border-outline-variant bg-white/30 px-3 py-2">
                  <SectionHeader tone="default">{label}</SectionHeader>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
                    {isLoading ? "loading" : `${folder.items.length}`}
                  </span>
                </header>
                <ul className="divide-y divide-outline-variant">
                  {folder.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        data-testid={`library-item-${item.id}`}
                        onClick={() => onItemClick(item)}
                        className={cn(
                          "w-full flex items-center justify-between gap-3 px-3 py-2 font-mono text-left",
                          "hover:bg-stone-100/50 focus:outline-none focus:bg-stone-100/70",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ToolMark tool={iconKind} title={`${item.name} ${iconKind}`} size="xs" decorative />
                          <span className="truncate text-xs font-bold text-stone-900">{item.name}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
