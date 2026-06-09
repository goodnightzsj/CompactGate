import { useEffect } from "react";
import type { PageMode } from "../app-types.js";

export function useDocumentTitle(pageMode: PageMode) {
  useEffect(() => {
    document.title = pageMode === "health" ? "CompactGate 健康检查" : "CompactGate 控制台";
  }, [pageMode]);
}
