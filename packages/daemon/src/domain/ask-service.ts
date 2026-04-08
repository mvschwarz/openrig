import type { PsEntry } from "./ps-projection.js";
import type { Rig } from "./types.js";
import type { SearchResult, ChatSearchResult } from "./history-query.js";
import type { RigWithRelations } from "./types.js";
import type { WhoamiResult } from "./whoami-service.js";

export type { ChatSearchResult };

export interface AskDeps {
  psProjectionService: { getEntries(): PsEntry[] };
  rigRepo: { findRigsByName(name: string): Rig[]; getRig(rigId: string): RigWithRelations | null };
  historyQuery: {
    search(rigName: string, question: string): Promise<SearchResult>;
    searchChat(rigId: string, question: string): ChatSearchResult[];
  };
  transcriptsEnabled: boolean;
  whoamiService?: { resolve(query: { nodeId?: string; sessionName?: string }): WhoamiResult | null };
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

interface StructuredAnswer {
  excerpts: string[];
  insufficient: boolean;
  guidance?: string;
}

export class AskService {
  private readonly deps: AskDeps;

  constructor(deps: AskDeps) {
    this.deps = deps;
  }

  async ask(rigName: string, question: string, context?: { nodeId?: string; sessionName?: string }): Promise<AskResult> {
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

    const structured = this.answerStructuredQuestion(rigs[0]!.id, rigName, question, context);
    if (structured) {
      return {
        question,
        rig: rigInfo,
        evidence: {
          backend: "structured",
          excerpts: structured.excerpts,
        },
        insufficient: structured.insufficient,
        guidance: structured.guidance,
      };
    }

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

  private answerStructuredQuestion(
    rigId: string,
    rigName: string,
    question: string,
    context?: { nodeId?: string; sessionName?: string },
  ): StructuredAnswer | null {
    const normalized = question.trim().toLowerCase();
    if (!normalized) return null;

    if (this.looksLikePeerQuestion(normalized)) {
      const identity = this.resolveIdentity(context);
      if (identity && identity.identity.rigId === rigId) {
        return {
          excerpts: identity.peers.map((peer) => this.formatPeerLine(peer.logicalId, peer.sessionName, peer.runtime, peer.podNamespace)),
          insufficient: false,
        };
      }
      return {
        excerpts: [],
        insufficient: true,
        guidance: "Cannot determine the current node identity for a peer-relative question. Run rig whoami --json from the target session or retry from an attached managed node.",
      };
    }

    return null;
  }

  private resolveIdentity(context?: { nodeId?: string; sessionName?: string }): WhoamiResult | null {
    if (!context?.nodeId && !context?.sessionName) return null;
    return this.deps.whoamiService?.resolve(context) ?? null;
  }

  private looksLikePeerQuestion(question: string): boolean {
    return /(^|\b)(who are my peers|who are the peers|list peers|show peers|who is in (this|the) rig|list nodes|show nodes)(\b|$)/.test(question);
  }

  private formatPeerLine(
    logicalId: string,
    sessionName: string | null,
    runtime: string,
    podNamespace: string | null,
  ): string {
    return `${logicalId}  session=${sessionName ?? "unbound"}  runtime=${runtime}  pod=${podNamespace ?? "—"}`;
  }
}
