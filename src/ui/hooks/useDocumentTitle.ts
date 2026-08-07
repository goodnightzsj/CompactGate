import { useEffect } from "react";
import type { PageMode } from "../app-types.js";

export function useDocumentTitle(pageMode: PageMode) {
  useEffect(() => {
    const pageTitle: Record<PageMode, string> = {
      dashboard: "总览",
      analytics: "仪表盘",
      usage: "用量",
      routes: "路由",
      config: "配置",
      logs: "日志",
      health: "健康"
    };

    document.title = `${pageTitle[pageMode]} · CompactGate`;
  }, [pageMode]);
}
