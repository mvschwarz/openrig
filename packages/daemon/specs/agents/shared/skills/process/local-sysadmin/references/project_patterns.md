# Project Patterns (Observed)

## Two-Tier Documentation System

**Global Knowledge Base:** `~/code/workflow/_dev/` (git-tracked, shared across projects)

**Per-Project Documentation:** `~/code/workflow/_dev/workspace/<project>/`

### Rationale

Every VS Code/Cursor workspace includes the `_dev/` folder, making documentation accessible from any project without switching contexts.

## Workspace Structure Pattern

**Example from `_dev.code-workspace`:**
```json
{
  "folders": [
    { "path": "_dev" },                           // Global docs (always accessible)
    { "path": "../projects/clients/srw/.claude" },// Project-specific Claude configs
    { "path": "../omt/example-app-1/.claude" },            // Project-specific Claude configs
    { "path": "../.." }                           // ~/code/ (for file operations)
  ],
  "settings": {
    "files.exclude": {
      // Aggressively hide personal folders
      "**/Library/**": true,
      "**/Downloads/**": true,
      "**/Desktop/**": true,
      // etc.
    }
  }
}
```

**Pattern:** Every workspace gets `_dev/` + project-specific paths

## Project Documentation Structure (Converging)

**Template observed in:** `~/code/workflow/_dev/workspace/template/`

```
workspace/<project>/
├── design/              # Design documents
├── docs/                # Project documentation
├── env/                 # Environment configurations
├── implement/           # Implementation tracking
│   └── phase1/
│       └── session-1.x/
│           ├── session-1.x-handoff.md
│           ├── session-1.x-developer-log.md
│           └── session-1.x-task-xyz.md
├── planning/            # Planning documents
└── testing/             # Test plans, results
```

**Active projects using similar patterns:**
- `workspace/example-app-1/` - context/, docs/, env/, projects/, temp/
- `workspace/srw/` - backups/, design/, docs/, env/, implement/, planning/, team/, testing/
- `workspace/agilitas/` - design/, docs/, env/, implement/, planning/, research/, testing/

**Observed variation:** Not all projects have identical structure, but common elements emerge:
- `docs/` - Always present
- `env/` - Environment/config info
- `implement/` or `projects/` - Active work
- `planning/` - Planning docs

## Global Documentation Organization

`~/code/workflow/_dev/docs/`
```
docs/
├── ai/        # AI-related documentation (10 items)
├── infra/     # Infrastructure docs (5 items)
└── process/   # Process documentation (3 items)
```

**Pattern:** Topic-based organization at global level

## Workspace Configuration Exclusions

**Consistently excluded across workspaces:**
- Personal folders (Library, Downloads, Desktop, Documents, Pictures, Music, Movies)
- Cache directories (.cache, .npm, .pnpm-store, .pyenv, .cargo)
- Dependencies (node_modules)
- Trash

**Rationale:** Keep workspace explorer clean, focused on code/docs only

## Directory Naming Conventions

**Observed:**
- Lowercase with hyphens: `bigbluecloud-analytics`, `session-1.x`
- Descriptive: `implement/`, `planning/`, not `impl/`, `plan/`
- Categorical at top level: `docs/`, `workspace/`, `agents/`

## Code Project Organization

`~/code/` structure:
```
code/
├── infra/             # Self-managed global functionality
│   ├── services/      # Long-running servers (MCP, databases)
│   └── tools/         # Run-once utilities (scripts, CLIs)
├── omt/
│   └── example-app-1/          # Multi-repo project (8 repos)
├── lab/               # Experiments
├── projects/
│   └── clients/
│       ├── srw/
│       └── agilitas/
└── workflow/
    └── _dev/          # Global knowledge base
```

**Pattern:** Organization by client/purpose, not by technology

**Infra Distinction:**
- `infra/services/` - Source code for servers you manage (MCP servers, local databases)
- `infra/tools/` - Source code for utilities you run (scripts, automation, CLIs)
- System tools (Homebrew) - Not source code you manage (ripgrep, docker, uv)
- Project repos - Application code, not global infrastructure

## Session/Phase Organization

**Observed in srw and template:**
```
implement/
└── phase1/
    └── session-1.x/
        ├── handoff.md
        ├── developer-log.md
        └── task-xyz.md
```

**Purpose:** Track implementation work in discrete sessions within phases
