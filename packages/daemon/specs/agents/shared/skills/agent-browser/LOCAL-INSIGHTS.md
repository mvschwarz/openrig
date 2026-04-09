# agent-browser: Local Dev Insights

> Companion to the official SKILL.md. These are gotchas, corrections, and best practices
> discovered through hands-on testing that the upstream skill doesn't cover.
> Last updated: 2026-02-20 | Tested against: v0.13.0

---

## Command Compatibility Matrix

**Not all `get` subcommands accept @refs.** This is the #1 source of confusion.

| Command | @refs | CSS selectors | Notes |
|---------|-------|---------------|-------|
| `get text @e1` | YES | YES | Works with both |
| `get html` | NO | YES | Fails silently with refs |
| `get box` | NO | YES | Returns `{x, y, width, height}` JSON |
| `get styles` | NO | YES | Returns compact summary (font, color, bg, border-radius) |
| `get value` | NO | YES | For form inputs |
| `get attr` | NO | YES | Any HTML attribute |
| `get count` | N/A | YES | Returns element count |
| `get url` | N/A | N/A | No selector needed |
| `get title` | N/A | N/A | No selector needed |
| `click` | YES | YES | Works with both |
| `fill` | YES | YES | Works with both |
| `highlight` | NO | YES | Skill shows `highlight @e1` but this fails |

**Rule of thumb:** Interaction commands (click, fill, type, check, select) work with @refs.
Inspection commands (get html/box/styles, highlight) need CSS selectors.

## CSS Selectors: Strict Mode

Playwright strict mode means CSS selectors must match **exactly one element**. If multiple match, you get an error listing all matches (which is actually helpful for debugging).

**Strategies for unique selectors:**
- Use IDs: `#fork-button`
- Use unique attributes: `[data-testid="submit"]`
- Combine: `.header > a:first-child`
- Use `nth`: `.item:nth-child(3)`

## Ref Lifecycle: The Golden Rule

Refs are invalidated by **any page state change**. This includes:
- Navigation (click links, `open`, `back`, `forward`)
- Scoped snapshots (`snapshot -s`)  <-- easy to forget this one
- Form submissions
- Dynamic content (modals, dropdowns, AJAX loads)
- Even `snapshot` itself replaces all previous refs

**Pattern:** Always snapshot immediately before interacting. Never cache refs across multiple actions that change the page.

## Snapshot Mode Comparison

| Flag | What it returns | When to use |
|------|----------------|-------------|
| `-i` | Interactive elements only | **Default choice** - best token efficiency |
| `-i -C` | Interactive + cursor-interactive | When divs with onclick aren't showing up |
| `-c` | Compact (removes empty nodes) | Unreliable - can return "Empty page" on some sites |
| `-d N` | Depth-limited | When `-i` returns too much |
| `-s "#sel"` | Scoped to selector | Laser focus on one component |
| `--json` | JSON format | Programmatic parsing |

**Token efficiency example:** GitHub repo page with 4,574 DOM elements → `snapshot -i` returns ~25 lines.

## Annotated Screenshots

`screenshot --annotate` is powerful but **can hang on complex pages** (known issue #509). If it hangs:
1. Kill with Ctrl-C or timeout
2. Fall back to regular `screenshot` + separate `snapshot -i`
3. Works best on simpler pages

The annotated screenshot also **caches refs**, so you can interact with elements immediately after without a separate snapshot.

## Network Monitoring

```bash
# See all requests (captured since page was opened)
agent-browser network requests

# Filter to just API calls (huge noise reduction)
agent-browser network requests --filter "/api/"

# Mock an API response
agent-browser network route "https://api.example.com/data" --body '{"mocked": true}'

# Block a request (e.g., analytics)
agent-browser network route "https://www.google-analytics.com/*" --abort
```

Requests are captured from session start. The `--filter` flag is essential on real sites - without it you get dozens of CSS/image/analytics requests.

## JavaScript Eval Patterns

```bash
# Quick one-liner (single quotes, no nesting)
agent-browser eval 'document.title'

# Complex JS (ALWAYS use --stdin for anything with quotes/arrows/template literals)
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("a"))
    .map(a => ({ text: a.textContent.trim(), href: a.href }))
    .filter(a => a.text.length > 0)
    .slice(0, 10)
)
EVALEOF

# Fetch API from browser context (uses page cookies/auth)
agent-browser eval --stdin <<'EVALEOF'
(async () => {
  const res = await fetch('/api/data');
  return JSON.stringify(await res.json());
})()
EVALEOF
```

## Session Management

- **Always close when done:** `agent-browser close` prevents leaked daemon processes
- **Headed mode for debugging:** `agent-browser --headed open <url>`
- **Persistent headed config:** Add `{"headed": true}` to `~/.agent-browser/config.json`
- **Named sessions for parallel work:** `agent-browser --session name open <url>`

## Authentication: What Actually Works

**`--session-name` (state save/restore) does NOT work for all apps.** It saves cookies and localStorage, but apps using HTTP-only cookies, server-side sessions, or complex auth flows may not persist. Tested and failed on: tbbc (The Big Blue Cloud / localhost:8083).

**`--profile` (persistent Chrome profile) is the reliable approach.** It preserves everything - cookies, localStorage, IndexedDB, cache, service workers. This is what actually works for real apps.

### Saved Profiles

| Profile | Service | URL | Command |
|---------|---------|-----|---------|
| `tbbc` | The Big Blue Cloud | `http://localhost:8083` | `agent-browser --profile ~/.agent-browser/profiles/tbbc open http://localhost:8083` |
| `localhost-3000` | Specright Formulate (Clerk auth) | `http://localhost:3000` | `agent-browser --profile ~/.agent-browser/profiles/localhost-3000 open http://localhost:3000` |
| `localhost-3010-email` | Smart Report Writer (email login) | `http://localhost:3010` | `agent-browser --profile ~/.agent-browser/profiles/localhost-3010-email open http://localhost:3010` |
| `localhost-3010-google` | Smart Report Writer (Google auth) | `http://localhost:3010` | See Google OAuth note below |

### Google OAuth Profiles

Google blocks sign-in from the bundled Chromium ("This browser or app may not be secure"). The workaround is to use the **real Chrome binary** with automation detection disabled:

```bash
agent-browser \
  --profile ~/.agent-browser/profiles/localhost-3010-google \
  --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --args "--disable-blink-features=AutomationControlled" \
  open http://localhost:3010
```

**This applies to ANY profile that needs Google OAuth.** Always use `--executable-path` + `--args` for Google sign-in flows.

### Auth Setup Pattern

```bash
# First time: login in headed mode (user enters password)
agent-browser --profile ~/.agent-browser/profiles/<name> --headed true open <login-url>
# ... user logs in manually ...
agent-browser close

# Every future run: headless, already authenticated
agent-browser --profile ~/.agent-browser/profiles/<name> open <app-url>
```

### Encryption

Session state files in `~/.agent-browser/sessions/` are encrypted with AES-256-GCM.
Key stored at `~/.agent-browser/.encryption-key` (chmod 600).
Loaded via `AGENT_BROWSER_ENCRYPTION_KEY` env var in `~/.zshrc`.

Note: `--profile` directories are NOT encrypted (they're standard Chromium profile dirs).
Keep `~/.agent-browser/profiles/` permissions locked down.

## Updating the Official Skill

To sync SKILL.md with upstream while preserving local insights:

```bash
# Download latest official SKILL.md
curl -sL https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skills/agent-browser/SKILL.md \
  -o ~/.claude/skills/agent-browser/SKILL.md

# Re-append the local insights reference (3 lines at end of SKILL.md)
cat >> ~/.claude/skills/agent-browser/SKILL.md << 'EOF'

## Local Dev Insights
**IMPORTANT:** Read `LOCAL-INSIGHTS.md` in this skill directory for gotchas, corrections, and tested workflows discovered through hands-on use that this upstream skill doesn't cover.
EOF
```
