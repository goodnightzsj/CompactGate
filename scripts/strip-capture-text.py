#!/usr/bin/env python3
"""Drop the redundant `text` field from already-written capture bodies.

Captures now store bodies as base64 only; the text copy was the same bytes
UTF-8-decoded, which for a compressed body is both larger and unrecoverable.
This rewrites existing files in place, atomically, keeping base64 untouched.

Usage:
  strip-capture-text.py <capture-dir> [--apply] [--limit N]

Without --apply it reports what would change and writes nothing.
"""
import json
import os
import sys

BODY_SECTIONS = ("incoming_request", "upstream_request", "upstream_response", "client_response")


def strip_record(record):
    """Remove body.text in place. Returns how many fields were dropped."""
    dropped = 0
    for name in BODY_SECTIONS:
        section = record.get(name)
        if not isinstance(section, dict):
            continue
        body = section.get("body")
        if isinstance(body, dict) and "text" in body:
            if not isinstance(body.get("base64"), str):
                # No recoverable copy: leave this one alone.
                continue
            del body["text"]
            dropped += 1
    return dropped


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply_changes = "--apply" in sys.argv
    limit = None
    for arg in sys.argv[1:]:
        if arg.startswith("--limit"):
            limit = int(arg.split("=", 1)[1]) if "=" in arg else None
    if not args:
        print(__doc__)
        return 2

    capture_dir = args[0]
    names = sorted(
        n for n in os.listdir(capture_dir)
        if n.startswith("compactgate-capture-") and n.endswith(".json")
    )
    if limit:
        names = names[:limit]

    seen = changed = skipped = failed = 0
    bytes_before = bytes_after = 0
    for index, name in enumerate(names, 1):
        path = os.path.join(capture_dir, name)
        seen += 1
        try:
            stat = os.stat(path)
            with open(path, encoding="utf8") as handle:
                record = json.load(handle)
        except Exception as error:  # unreadable or not JSON: leave it
            failed += 1
            print(f"  skip (unreadable): {name}: {error}", flush=True)
            continue

        if not isinstance(record, dict) or strip_record(record) == 0:
            skipped += 1
            continue

        payload = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
        bytes_before += stat.st_size
        bytes_after += len(payload.encode("utf8"))
        changed += 1

        if apply_changes:
            tmp = f"{path}.strip-tmp"
            with open(tmp, "w", encoding="utf8") as handle:
                handle.write(payload)
            os.replace(tmp, path)
            # Retention prunes by file age, so keep the original timestamps.
            os.utime(path, (stat.st_atime, stat.st_mtime))

        if index % 500 == 0:
            print(f"  {index}/{len(names)} scanned, {changed} rewritten", flush=True)

    saved = bytes_before - bytes_after
    print(f"\nscanned {seen} | rewritten {changed} | already clean {skipped} | unreadable {failed}")
    print(f"bytes before {bytes_before:,} -> after {bytes_after:,} | reclaimed {saved:,}"
          f" ({saved / 1e9:.2f} GB)")
    if not apply_changes:
        print("dry run: nothing written. re-run with --apply")
    return 0


if __name__ == "__main__":
    sys.exit(main())
