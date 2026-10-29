/* Synthetic interactive provider: no provider network calls; credentials are compared only to fixture constants.
 * A real executable lets native process/binding checks run without mocking their observations. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>

static char removeKeyFlag[4096], apiKeyFile[4096];
/* Deterministic post-precheck failure: lose only this fixture key at real cutover. */
static void stopped(int signalNumber) {
  (void)signalNumber;
  if (access(removeKeyFlag, F_OK) == 0) { unlink(apiKeyFile); unlink(removeKeyFlag); }
  _exit(0);
}

static const char *flag(int argc, char **argv, const char *name, const char *fallback) {
  for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], name)) return argv[i + 1];
  return fallback;
}
static int matches(const char *name, const char *value) {
  const char *v = getenv(name); return v && !strcmp(v, value);
}
int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("2.1.139 (Claude Code)"); return 0; }
  if (argc > 1 && !strcmp(argv[1], "--help")) {
    puts("Usage: claude [options]\n--permission-mode <mode> (choices: \"acceptEdits\", \"default\", \"auto\")"); return 0;
  }
  const char *id = flag(argc, argv, "--resume", flag(argc, argv, "--session-id", "missing"));
  const char *model = flag(argc, argv, "--model", "default");
  const char *permission = flag(argc, argv, "--permission-mode", "default");
  const char *home = getenv("CLAUDE_CONFIG_DIR"), *rig = getenv("OPENRIG_HOME");
  if (!home || !rig || strchr(id, '/') || strlen(id) > 64) return 2;
  snprintf(removeKeyFlag, sizeof(removeKeyFlag), "%s/remove-key-on-stop-%d", rig, getpid());
  snprintf(apiKeyFile, sizeof(apiKeyFile), "%s/../api-key", rig);
  signal(SIGTERM, stopped);
  signal(SIGHUP, stopped);
  const char *auth = matches("ANTHROPIC_API_KEY", "synthetic-api") ? "api"
    : matches("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-plan") ? "plan" : "other";
  char journal[4096], memoryFile[4096], memory[512] = "", line[4096];
  snprintf(journal, sizeof(journal), "%s/provider-launches.jsonl", rig);
  snprintf(memoryFile, sizeof(memoryFile), "%s/fixture-conversation-%s", home, id);
  FILE *f = fopen(memoryFile, "r"); if (f) { fgets(memory, sizeof(memory), f); fclose(f); }
  f = fopen(journal, "a"); if (!f) return 3;
  fprintf(f, "{\"pid\":%d,\"conversation\":\"%s\",\"model\":\"%s\",\"permission\":\"%s\",\"auth\":\"%s\",\"remembered\":%s}\n",
    getpid(), id, model, permission, auth, memory[0] ? "true" : "false"); fclose(f);
  /* Model the provider's SessionStart event through the shipped relay, not a DB write. */
  char hook[8192];
  snprintf(hook, sizeof(hook), "'%s' '%s' >/dev/null 2>&1", FIXTURE_NODE, FIXTURE_RELAY);
  f = popen(hook, "w");
  if (!f) return 5;
  fprintf(f, "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"%s\",\"source\":\"resume\"}", id);
  if (pclose(f) != 0) return 6;
  puts("Claude Code v2.1.139\nSynthetic provider fixture\n❯ ");
  while (fgets(line, sizeof(line), stdin)) {
    line[strcspn(line, "\r\n")] = 0;
    if (!strcmp(line, "/exit")) return 0;
    if (!strncmp(line, "remember:", 9)) {
      snprintf(memory, sizeof(memory), "%s", line + 9);
      f = fopen(memoryFile, "w"); if (!f) return 4; fputs(memory, f); fclose(f);
    }
    if (!strcmp(line, "probe")) printf("MEMORY:%s AUTH:%s\n", memory, auth);
    puts("❯ ");
  }
  return 0;
}
