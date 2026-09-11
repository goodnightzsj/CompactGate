import { useCallback, useEffect, useState } from "react";
import type { OAuthAccountStatus, OAuthAccountView } from "../../shared/oauth.js";
import { api, errorSummary } from "../shared/api.js";

export const oauthStatusLabel: Record<OAuthAccountStatus, string> = {
  connected: "已授权", expired: "令牌已过期", needs_reauth: "需要重新授权",
  disconnected: "已断开", missing: "连接缺失"
};

export function useOAuthAccounts() {
  const [accounts, setAccounts] = useState<OAuthAccountView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api<{ accounts: OAuthAccountView[] }>("/api/oauth/accounts", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setAccounts(result.accounts); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorSummary(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [version]);
  return { accounts, loading, error, reload };
}
