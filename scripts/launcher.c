/*
 * Generic exec shim for launchd-supervised services.
 *
 * Why this exists: launchd's Background Task Management (BTM) — the database
 * behind System Settings > General > Login Items & Extensions — takes an
 * entry's display name from the executable's filename, not from the plist's
 * Label. Launching `~/.nvm/.../bin/node` directly therefore files the service
 * under "node" with developer "Node.js Foundation", where it is easy to
 * mistake for an unrelated process and disable.
 *
 * Compiling this to a file named `compactgate`, signing it ad-hoc, and having
 * the plist point at it gives the entry the right name and developer "(null)" —
 * the same shape the Homebrew cliproxyapi agent and the PyInstaller
 * multi-site-sign-in agents already have on this machine.
 *
 * The target is taken from argv rather than baked in, so upgrading node is a
 * plist edit and does not require recompiling (and therefore re-signing) this.
 *
 * Build:
 *   cc -O2 -o compactgate scripts/launcher.c
 *   codesign --force --sign - --identifier com.compactgate.launcher compactgate
 */
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
    return 2;
  }

  /* execv, not fork: this process is replaced, so the supervised PID never
   * changes and launchd keeps managing the real server. */
  execv(argv[1], &argv[1]);

  /* Only reached when execv fails (bad path, no execute permission). */
  perror(argv[1]);
  return 1;
}
