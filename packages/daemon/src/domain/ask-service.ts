import type { PsEntry } from "./ps-projection.js";
import type { Rig } from "./types.js";
import type { SearchResult, ChatSearchResult } from "./history-query.js";

export type { ChatSearchResult };

export interface AskDeps {
  psProjectionService: { getEntries(): PsEntry[] };
  rigRepo: { findRigsByName(name: string): Rig[] };
  historyQuery: {
    search(rigName: string, question: string): Promise<SearchResult>;
    searchChat(rigId: string, question: string): ChatSearchResult[];
  };
  transcriptsEnabled: boolean;
}

export interface AskRigInfo {
  name: string;
  status: string;
  nodeCount: number;
  runningCount: number;
  uptime: string | null;
}

export interface AskResult {
  question: string;
  rig: AskRigInfo | null;
  evidence: {
    backend: string;
    excerpts: string[];
    chatExcerpts?: string[];
  };
  insufficient: boolean;
  guidance?: string;
}

export class AskService {
  private readonly deps: AskDeps;

  constructor(deps: AskDeps) {
    this.deps = deps;
  }

  async ask(rigName: string, question: string): Promise<AskResult> {
    // Resolve rig
    const rigs = this.deps.rigRepo.findRigsByName(rigName);

    if (rigs.length === 0) {
      return {
        question,
        rig: null,
        evidence: { backend: "rg", excerpts: [] },
        insufficient: true,
        guidance: `Rig '${rigName}' not found. List rigs with: rig ps`,
      };
    }

    if (rigs.length > 1) {
      return {
        question,
        rig: null,
        evidence: { backend: "rg", excerpts: [] },
        insufficient: true,
        guidance: `Rig '${rigName}' is ambiguous — ${rigs.length} rigs share that name. Remove duplicates or use a unique name.`,
      };
    }

    // Get topology info
    const entries = this.deps.psProjectionService.getEntries();
    const psEntry = entries.find((e) => e.name === rigName);
    const rigInfo: AskRigInfo = psEntry
      ? { name: psEntry.name, status: psEntry.status, nodeCount: psEntry.nodeCount, runningCount: psEntry.runningCount, uptime: psEntry.uptime }
      : { name: rigName, status: "unknown", nodeCount: 0, runningCount: 0, uptime: null };

    // Check transcripts enabled
    if (!this.deps.transcriptsEnabled) {
      return {
        question,
        rig: rigInfo,
        evidence: { backend: "rg", excerpts: [] },
        insufficient: true,
        guidance: "Transcripts are disabled. Enable with: rig config set transcripts.enabled true",
      };
    }

    // Search transcripts
    const searchResult = await this.deps.historyQuery.search(rigName, question);

    // Search chat messages via the shared history-query seam
    let chatExcerpts: string[] | undefined;
    const rig = rigs[0]!;
    const chatResults = this.deps.historyQuery.searchChat(rig.id, question);
    if (chatResults.length > 0) {
      chatExcerpts = chatResults.map((r) => `[${r.sender}] ${r.body}`);
    }

    let guidance: string | undefined;
    const hasChatEvidence = chatExcerpts && chatExcerpts.length > 0;
    const isInsufficient = searchResult.insufficient && !hasChatEvidence;

    if (isInsufficient) {
      if (searchResult.noTranscriptDir) {
        guidance = `No transcript directory for rig '${rigName}'. Transcripts start automatically on next rig up.`;
      } else if (searchResult.error) {
        // Backend failure
        guidance = searchResult.error;
      } else if (searchResult.backend === "none") {
        // No backend was used (empty keywords)
        guidance = "No useful keywords could be extracted from the question. Try a more specific question.";
      } else {
        // Search ran but found no matches
        guidance = "No matching transcript evidence found. Try different search terms.";
      }
    }

    return {
      question,
      rig: rigInfo,
      evidence: {
        backend: searchResult.backend,
        excerpts: searchResult.excerpts,
        chatExcerpts,
      },
      insufficient: isInsufficient,
      guidance,
    };
  }
}
