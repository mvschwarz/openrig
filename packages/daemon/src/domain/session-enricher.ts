/** Result of enriching a discovered session with config context */
export interface EnrichmentResult {
  skills: string[];
  claudeSkills: string[];
  agentsSkills: string[];
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  hasPackageYaml: boolean;
  raw: Record<string, unknown>;
}

interface EnricherDeps {
  fsExists: (path: string) => boolean;
  fsReaddir: (path: string) => string[];
}

const EMPTY_RESULT: EnrichmentResult = {
  skills: [],
  claudeSkills: [],
  agentsSkills: [],
  hasClaudeMd: false,
  hasAgentsMd: false,
  hasPackageYaml: false,
  raw: {},
};

/**
 * Config sniffing from a session's cwd. Checks for agent config
 * directories, guidance files, skills, and package manifests.
 * Pure filesystem reads — no exec, no adapters.
 */
export class SessionEnricher {
  private fsExists: (path: string) => boolean;
  private fsReaddir: (path: string) => string[];

  constructor(deps: EnricherDeps) {
    this.fsExists = deps.fsExists;
    this.fsReaddir = deps.fsReaddir;
  }

  /** Enrich a session by sniffing config from its cwd. */
  enrich(cwd: string | null): EnrichmentResult {
    if (!cwd || !this.fsExists(cwd)) {
      return { ...EMPTY_RESULT, raw: {} };
    }

    const hasClaudeMd = this.fsExists(`${cwd}/CLAUDE.md`);
    const hasAgentsMd = this.fsExists(`${cwd}/AGENTS.md`);
    const hasPackageYaml = this.fsExists(`${cwd}/package.yaml`);

    const claudeSkills = this.safeReaddir(`${cwd}/.claude/skills`);
    const agentsSkills = this.safeReaddir(`${cwd}/.agents/skills`);
    const skills = [...claudeSkills, ...agentsSkills];

    const raw: Record<string, unknown> = {
      hasClaudeMd,
      hasAgentsMd,
      hasPackageYaml,
      claudeSkills,
      agentsSkills,
      skills,
    };

    return { skills, claudeSkills, agentsSkills, hasClaudeMd, hasAgentsMd, hasPackageYaml, raw };
  }

  private safeReaddir(path: string): string[] {
    if (!this.fsExists(path)) return [];
    try {
      return this.fsReaddir(path);
    } catch {
      return [];
    }
  }
}
