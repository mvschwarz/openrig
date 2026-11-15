/* Synthetic interactive provider: no provider network calls; credentials are compared only to fixture constants.
 * A real executable lets native process/binding checks run without mocking their observations. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
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
  size_t len = strlen(name);
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], name) && i + 1 < argc) return argv[i + 1];
    if (!strncmp(argv[i], name, len) && argv[i][len] == '=') return argv[i] + len + 1;
  }
  return fallback;
}
static int matches(const char *name, const char *value) {
  const char *v = getenv(name); return v && !strcmp(v, value);
}
static int valid_session_id(const char *s) {
  size_t len = s ? strlen(s) : 0;
  if (len == 0 || len > 64) return 0;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
      || c == '.' || c == '_' || c == '-')) return 0;
  }
  return 1;
}
static int fput_json_string(FILE *out, const char *s) {
  if (fputc('"', out) == EOF) return -1;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') {
      if (fprintf(out, "\\%c", *p) < 0) return -1;
    } else if (*p < 0x20) {
      if (fprintf(out, "\\u%04x", (unsigned int)*p) < 0) return -1;
    } else if (fputc(*p, out) == EOF) {
      return -1;
    }
  }
  return fputc('"', out) == EOF ? -1 : 0;
}
static int write_session_record(const char *home, pid_t pid, const char *seatName, const char *sessionId) {
  char sessionsDir[4096], tmpPath[4096], finalPath[4096];
  int n1 = snprintf(sessionsDir, sizeof(sessionsDir), "%s/sessions", home);
  int n2 = snprintf(tmpPath, sizeof(tmpPath), "%s/sessions/.%d.json.tmp", home, (int)pid);
  int n3 = snprintf(finalPath, sizeof(finalPath), "%s/sessions/%d.json", home, (int)pid);
  if (n1 < 0 || (size_t)n1 >= sizeof(sessionsDir)
    || n2 < 0 || (size_t)n2 >= sizeof(tmpPath)
    || n3 < 0 || (size_t)n3 >= sizeof(finalPath)) return -1;
  if (mkdir(sessionsDir, 0700) != 0 && errno != EEXIST) return -1;
  FILE *out = fopen(tmpPath, "w");
  if (!out) return -1;
  int ok = fputs("{\"name\":", out) != EOF
    && fput_json_string(out, seatName) == 0
    && fputs(",\"sessionId\":", out) != EOF
    && fput_json_string(out, sessionId) == 0
    && fputs("}\n", out) != EOF
    && fflush(out) == 0;
  if (fclose(out) != 0 || !ok) { unlink(tmpPath); return -1; }
  if (rename(tmpPath, finalPath) != 0) { unlink(tmpPath); return -1; }
  return 0;
}
int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("2.1.139 (Claude Code)"); return 0; }
  if (argc > 1 && !strcmp(argv[1], "--help")) {
    puts("Usage: claude [options]\n--permission-mode <mode> (choices: \"acceptEdits\", \"default\", \"auto\")"); return 0;
  }
  const char *explicitId = flag(argc, argv, "--resume", flag(argc, argv, "--session-id", NULL));
  const char *id = explicitId ? explicitId : "missing";
  const char *argName = flag(argc, argv, "--name", NULL);
  const char *seatName = (argName && argName[0]) ? argName : NULL;
  const char *model = flag(argc, argv, "--model", "default");
  const char *permission = flag(argc, argv, "--permission-mode", "default");
  const char *home = getenv("CLAUDE_CONFIG_DIR"), *rig = getenv("OPENRIG_HOME");
  if (!home || home[0] != '/' || !rig || rig[0] != '/' || strchr(id, '/') || strlen(id) > 64) return 2;
  int r1 = snprintf(removeKeyFlag, sizeof(removeKeyFlag), "%s/remove-key-on-stop-%d", rig, getpid());
  int r2 = snprintf(apiKeyFile, sizeof(apiKeyFile), "%s/../api-key", rig);
  if (r1 < 0 || (size_t)r1 >= sizeof(removeKeyFlag) || r2 < 0 || (size_t)r2 >= sizeof(apiKeyFile)) return 2;
  signal(SIGTERM, stopped);
  signal(SIGHUP, stopped);
  const char *auth = matches("ANTHROPIC_API_KEY", "synthetic-api") ? "api"
    : matches("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-plan") ? "plan" : "other";
  char journal[4096], memoryFile[4096], memory[512] = "", line[4096];
  int j1 = snprintf(journal, sizeof(journal), "%s/provider-launches.jsonl", rig);
  int m1 = snprintf(memoryFile, sizeof(memoryFile), "%s/fixture-conversation-%s", home, id);
  if (j1 < 0 || (size_t)j1 >= sizeof(journal) || m1 < 0 || (size_t)m1 >= sizeof(memoryFile)) return 2;
  if (seatName && valid_session_id(explicitId)) {
    if (strlen(seatName) > 512 || write_session_record(home, getpid(), seatName, explicitId) != 0) return 7;
  }
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
