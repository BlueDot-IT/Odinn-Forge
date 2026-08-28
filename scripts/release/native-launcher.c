#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

extern char **environ;

static const char shell_path[] = "/bin/sh";
static const char boundary_environment[] = "ODINN_NATIVE_BOUNDARY=1";
static const char companion_suffix[] = ".runtime.sh";

static void fail(void) {
  static const char message[] = "Odinn native runtime boundary failed\n";
  const ssize_t ignored = write(STDERR_FILENO, message, sizeof(message) - 1U);
  (void)ignored;
  _exit(126);
}

static bool name_equals(const char *entry, size_t name_length, const char *expected) {
  const size_t expected_length = strlen(expected);
  return name_length == expected_length && memcmp(entry, expected, expected_length) == 0;
}

static bool hostile_environment(const char *entry) {
  const char *equals = strchr(entry, '=');
  if (equals == NULL) return true;
  const size_t length = (size_t)(equals - entry);
  if ((length >= 3U && memcmp(entry, "LD_", 3U) == 0)
      || (length >= 5U && memcmp(entry, "DYLD_", 5U) == 0)
      || (length >= 5U && memcmp(entry, "NODE_", 5U) == 0)) {
    return true;
  }
  static const char *const exact[] = {
    "BASH_ENV",
    "ENV",
    "GCONV_PATH",
    "GLIBC_TUNABLES",
    "LOCPATH",
    "NLSPATH",
    "ODINN_NATIVE_BOUNDARY",
    "OPENSSL_CONF",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE"
  };
  for (size_t index = 0; index < sizeof(exact) / sizeof(exact[0]); index += 1U) {
    if (name_equals(entry, length, exact[index])) return true;
  }
  return false;
}

static char *executable_path(void) {
#ifdef __APPLE__
  uint32_t size = 0;
  if (_NSGetExecutablePath(NULL, &size) != -1 || size == 0U) fail();
  char *unresolved = calloc((size_t)size + 1U, 1U);
  if (unresolved == NULL || _NSGetExecutablePath(unresolved, &size) != 0) fail();
  char *resolved = realpath(unresolved, NULL);
  free(unresolved);
  if (resolved == NULL) fail();
  return resolved;
#elif defined(__linux__)
  size_t capacity = 256U;
  for (;;) {
    if (capacity > 1024U * 1024U) fail();
    char *path = malloc(capacity);
    if (path == NULL) fail();
    const ssize_t length = readlink("/proc/self/exe", path, capacity - 1U);
    if (length < 0) {
      free(path);
      fail();
    }
    if ((size_t)length < capacity - 1U) {
      path[length] = '\0';
      return path;
    }
    free(path);
    capacity *= 2U;
  }
#else
#error Unsupported native launcher platform
#endif
}

int main(int argc, char **argv) {
  if (argc < 1 || argv == NULL) fail();
  char *launcher = executable_path();
  const size_t launcher_length = strlen(launcher);
  const size_t suffix_length = sizeof(companion_suffix) - 1U;
  if (launcher_length > SIZE_MAX - suffix_length - 1U) fail();
  char *companion = malloc(launcher_length + suffix_length + 1U);
  if (companion == NULL) fail();
  memcpy(companion, launcher, launcher_length);
  memcpy(companion + launcher_length, companion_suffix, suffix_length + 1U);

  struct stat companion_status;
  if (lstat(companion, &companion_status) != 0
      || !S_ISREG(companion_status.st_mode)
      || companion_status.st_nlink != 1) {
    fail();
  }

  size_t environment_count = 0U;
  while (environ[environment_count] != NULL) environment_count += 1U;
  char **clean_environment = calloc(environment_count + 2U, sizeof(char *));
  if (clean_environment == NULL) fail();
  size_t clean_count = 0U;
  for (size_t index = 0; index < environment_count; index += 1U) {
    if (!hostile_environment(environ[index])) clean_environment[clean_count++] = environ[index];
  }
  clean_environment[clean_count++] = (char *)boundary_environment;
  clean_environment[clean_count] = NULL;

  if ((size_t)argc > (SIZE_MAX / sizeof(char *)) - 2U) fail();
  char **shell_arguments = calloc((size_t)argc + 2U, sizeof(char *));
  if (shell_arguments == NULL) fail();
  shell_arguments[0] = (char *)shell_path;
  shell_arguments[1] = companion;
  for (int index = 1; index < argc; index += 1) shell_arguments[index + 1] = argv[index];
  shell_arguments[argc + 1] = NULL;

  execve(shell_path, shell_arguments, clean_environment);
  fail();
}
