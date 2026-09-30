import { promises as fs } from "node:fs";
import path from "node:path";
import { vi } from "vitest";

type FileCommitFault = "file-chmod" | "file-sync" | "directory-open" | "directory-sync" | "directory-close";

/** Inject once for this fixture's main file (or its version backup), using real I/O elsewhere. */
export function injectFileCommitFault(filePath: string, stage: FileCommitFault, backup = false): Error {
  const error = new Error(`synthetic ${stage} failure`);
  const open = fs.open;
  const rename = fs.rename;
  let committed = false;
  let injected = false;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    committed = typeof to === "string" && (backup ? to.startsWith(`${filePath}.backup.`) : to === filePath);
  });
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const isDirectory = committed && file === path.dirname(filePath) && flags === "r";
    if (!injected && isDirectory && stage === "directory-open") {
      injected = true;
      throw error;
    }
    const handle = await open(file, flags, mode);
    const isTemporary = typeof file === "string" && flags === "wx" &&
      path.dirname(file) === path.dirname(filePath) &&
      path.basename(file).startsWith(`.${path.basename(filePath)}.${process.pid}.`);
    if (!injected && isTemporary && (stage === "file-chmod" || stage === "file-sync")) {
      injected = true;
      vi.spyOn(handle, stage === "file-chmod" ? "chmod" : "sync").mockRejectedValueOnce(error);
    }
    if (!injected && isDirectory && stage === "directory-sync") {
      injected = true;
      vi.spyOn(handle, "sync").mockRejectedValueOnce(error);
    }
    if (!injected && isDirectory && stage === "directory-close") {
      injected = true;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        throw error;
      });
    }
    return handle;
  });
  return error;
}
