/** Hover-toolbar button that copies a seat's full session name ("role@rig") for use in `rig` commands. */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../lib/copy-text.js";

const COPIED_FEEDBACK_MS = 1500;

export function CopySessionNameButton({
  sessionName,
  className,
  testId,
}: {
  sessionName: string;
  className?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      data-testid={testId}
      className={className}
      aria-label={copied ? `Copied ${sessionName}` : `Copy ${sessionName}`}
      title={copied ? "Copied" : `Copy ${sessionName}`}
      onClick={async (event) => {
        // The card itself navigates on click; copying must not.
        event.stopPropagation();
        if (await copyText(sessionName)) setCopied(true);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
