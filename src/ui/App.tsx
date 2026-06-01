import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
  CompactGateConfig,
  CredentialSource,
  HostLogCount,
  HealthResponse,
  PublicConfig,
  RequestLogEntry,
  RequestLogPage,
  RouteKind,
  RoutePreviewResponse,
  StudioLogEvent,
  StudioSnapshotEvent
} from "../shared/types.js";
import "./styles.css";

type SaveState = "idle" | "saving" | "saved" | "error";

type ConfigFormState = {
  primaryBaseUrl: string;
  primaryApiKey: string;
  clearPrimaryApiKey: boolean;
  compactBaseUrl: string;
  compactApiKey: string;
  clearCompactApiKey: boolean;
  upstreamMode: "split" | "primary";
  modelMode: "linked" | "custom";
  modelTemplate: string;
  modelOverride: string;
};

type HealthTone = "good" | "warn" | "bad";

type HealthBadge = {
  label: string;
  tone: HealthTone;
};

type HostFilterOption = HostLogCount;

interface SelectOption {
  value: string;
  label: string;
  count: number;
  meta?: string;
  tone?: RouteKind;
}

const DEFAULT_BODY = JSON.stringify({ model: "gpt-5.5", stream: true }, null, 2);
const ALL_HOSTS_FILTER = "__all_hosts__";
const DEFAULT_LOG_PAGE_LIMIT = 200;
const TOKEN_TOOLTIP_WIDTH = 350;
const TOKEN_TOOLTIP_ESTIMATED_HEIGHT = 216;

function App() {
  const pageMode = window.location.pathname === "/health" ? "health" : "studio";
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [logPage, setLogPage] = useState<RequestLogPage>(() => emptyLogPage(DEFAULT_LOG_PAGE_LIMIT));
  const [routeFilter, setRouteFilter] = useState<"all" | RouteKind>("all");
  const [hostFilter, setHostFilter] = useState(ALL_HOSTS_FILTER);
  const [form, setForm] = useState<ConfigFormState>(emptyForm());
  const [currentModel, setCurrentModel] = useState("gpt-5.5");
  const [previewPath, setPreviewPath] = useState("/v1/responses/compact");
  const [previewBody, setPreviewBody] = useState(DEFAULT_BODY);
  const [preview, setPreview] = useState<RoutePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [pageError, setPageError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [isLoadingMoreLogs, setIsLoadingMoreLogs] = useState(false);
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);

  const deferredFilter = useDeferredValue(routeFilter);
  const deferredHostFilter = useDeferredValue(hostFilter);
  const logs = logPage.logs;
  const latestLog = logs[0] ?? null;
  const hasConfig = config !== null;
  const logPageLimit = config?.logging.keep_recent ?? DEFAULT_LOG_PAGE_LIMIT;
  const linkedCompactModel = renderLinkedModel(currentModel, form.modelTemplate);
  const effectiveCompactModel =
    form.modelMode === "linked" ? linkedCompactModel : form.modelOverride || "手动模型";
  const activeRoute = preview?.route ?? latestLog?.route ?? "compact";
  const hasPendingChanges = useMemo(() => {
    return config ? isFormDirty(config, form) : false;
  }, [config, form]);
  const logCounts = logPage.counts;
  const hostOptions = useMemo(
    () => buildHostFilterOptions(logPage.host_counts, hostFilter),
    [logPage.host_counts, hostFilter]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        if (pageMode === "health") {
          const nextHealth = await api<HealthResponse>("/api/health");

          if (cancelled) {
            return;
          }

          setHealth(nextHealth);
          setPageError(null);
          return;
        }

        const [nextConfig, nextHealth] = await Promise.all([
          api<PublicConfig>("/api/config"),
          api<HealthResponse>("/api/health")
        ]);

        if (cancelled) {
          return;
        }

        setConfig(nextConfig);
        setHealth(nextHealth);
        setForm(formFromConfig(nextConfig));
        setPageError(null);
      } catch (error) {
        if (!cancelled) {
          setPageError(errorSummary(error));
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [pageMode]);

  useEffect(() => {
    if (pageMode !== "studio" || !hasConfig) {
      return;
    }

    let cancelled = false;

    async function loadLogs() {
      setIsLoadingLogs(true);

      try {
        const nextPage = await fetchLogPage({
          route: deferredFilter,
          host: deferredHostFilter,
          limit: logPageLimit,
          offset: 0
        });

        if (!cancelled) {
          setLogPage(nextPage);
          setLogError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLogError(errorSummary(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingLogs(false);
        }
      }
    }

    void loadLogs();

    return () => {
      cancelled = true;
    };
  }, [deferredFilter, deferredHostFilter, hasConfig, logPageLimit, pageMode]);

  useEffect(() => {
    if (pageMode !== "studio") {
      return;
    }

    if (typeof window.EventSource !== "function") {
      setLogError("当前浏览器不支持 SSE，已回退为轮询刷新。");
      const interval = window.setInterval(async () => {
        try {
          const nextPage = await fetchLogPage({
            route: deferredFilter,
            host: deferredHostFilter,
            limit: logPageLimit,
            offset: 0
          });
          setLogPage(nextPage);
        } catch (error) {
          setLogError(errorSummary(error));
        }
      }, 2500);

      return () => window.clearInterval(interval);
    }

    const stream = new EventSource("/api/events");
    const handleOpen = () => {
      setLogError(null);
    };
    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as StudioSnapshotEvent;
        setConfig(snapshot.config);
        setHealth(snapshot.health);
        if (routeFilter === "all" && hostFilter === ALL_HOSTS_FILTER) {
          setLogPage((previous) => mergeSnapshotLogPage(previous, snapshot.log_page));
        }
        setLogError(null);
      } catch (error) {
        setLogError(errorSummary(error));
      }
    };
    const handleLog = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as StudioLogEvent;
        setLogPage((previous) =>
          mergeLiveLogPage(previous, payload.entry, routeFilter, hostFilter)
        );
        setLogError(null);
      } catch (error) {
        setLogError(errorSummary(error));
      }
    };
    const handleError = () => {
      setLogError("实时日志流暂时断开，浏览器正在重连。");
    };

    stream.addEventListener("open", handleOpen);
    stream.addEventListener("snapshot", handleSnapshot as EventListener);
    stream.addEventListener("log", handleLog as EventListener);
    stream.addEventListener("error", handleError as EventListener);

    return () => {
      stream.removeEventListener("open", handleOpen);
      stream.removeEventListener("snapshot", handleSnapshot as EventListener);
      stream.removeEventListener("log", handleLog as EventListener);
      stream.removeEventListener("error", handleError as EventListener);
      stream.close();
    };
  }, [deferredFilter, deferredHostFilter, logPageLimit, routeFilter, hostFilter, pageMode]);

  useEffect(() => {
    if (pageMode !== "health" && pageMode !== "studio") {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const nextHealth = await api<HealthResponse>("/api/health");
        setHealth(nextHealth);
        setPageError(null);
      } catch (error) {
        setPageError(errorSummary(error));
      }
    }, pageMode === "health" ? 4000 : 10000);

    return () => window.clearInterval(interval);
  }, [pageMode]);

  useEffect(() => {
    if (latestLog?.source_model) {
      setCurrentModel(latestLog.source_model);
    }
  }, [latestLog?.source_model]);

  useEffect(() => {
    document.title = pageMode === "health" ? "CompactGate Health" : "CompactGate Studio";
  }, [pageMode]);

  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    setSaveState("saving");
    setSaveError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config", {
        method: "PATCH",
        body: JSON.stringify(formToPatch(form))
      });
      const nextHealth = await api<HealthResponse>("/api/health", {
        method: "GET"
      });
      setConfig(nextConfig);
      setHealth(nextHealth);
      setForm(formFromConfig(nextConfig));
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1400);
    } catch (error) {
      setSaveState("error");
      setSaveError(errorSummary(error));
    }
  }

  async function previewRoute(event: React.FormEvent) {
    event.preventDefault();
    setPreviewError(null);

    try {
      const parsedBody = previewBody.trim().length > 0 ? JSON.parse(previewBody) : {};
      const nextPreview = await api<RoutePreviewResponse>("/api/test-route", {
        method: "POST",
        body: JSON.stringify({
          method: "POST",
          path: previewPath,
          body: parsedBody
        })
      });
      setPreview(nextPreview);
    } catch (error) {
      setPreview(null);
      setPreviewError(errorSummary(error));
    }
  }

  function unlockCompactModel() {
    setForm((previous) => ({
      ...previous,
      modelMode: "custom",
      modelOverride: previous.modelOverride || linkedCompactModel
    }));
  }

  function restoreLinkedMode() {
    setForm((previous) => ({
      ...previous,
      modelMode: "linked",
      modelOverride: ""
    }));
  }

  async function exportConfig() {
    if (!config) {
      return;
    }

    try {
      const savedConfig = await api<CompactGateConfig>("/api/config/export");
      const payload = applyDraftToConfigExport(savedConfig, form);
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "compactgate.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setPageError(errorSummary(error));
    }
  }

  async function refreshHealth() {
    setIsRefreshingHealth(true);

    try {
      const nextHealth = await api<HealthResponse>("/api/health");
      setHealth(nextHealth);
      setPageError(null);
    } catch (error) {
      setPageError(errorSummary(error));
    } finally {
      setIsRefreshingHealth(false);
    }
  }

  async function loadMoreLogs() {
    setIsLoadingMoreLogs(true);

    try {
      const nextPage = await fetchLogPage({
        route: routeFilter,
        host: hostFilter,
        limit: logPageLimit,
        offset: logPage.logs.length
      });
      setLogPage((previous) => appendLogPage(previous, nextPage));
      setLogError(null);
    } catch (error) {
      setLogError(errorSummary(error));
    } finally {
      setIsLoadingMoreLogs(false);
    }
  }

  if (pageMode === "health") {
    return (
      <HealthPage
        health={health}
        error={pageError}
        isRefreshing={isRefreshingHealth}
        onRefresh={refreshHealth}
      />
    );
  }

  return (
    <main className="shell">
      <TopBar
        config={config}
        health={health}
        saveState={saveState}
        hasPendingChanges={hasPendingChanges}
        onExport={exportConfig}
      />

      {pageError && <p className="error-banner">{pageError}</p>}

      <CommandDeck
        config={config}
        health={health}
        currentModel={currentModel}
        compactModel={effectiveCompactModel}
        compactMode={form.upstreamMode}
        activeRoute={activeRoute}
        latestLog={latestLog}
        logs={logs}
      />

      <section className="studio-grid">
        <RouteBoard
          config={config}
          currentModel={currentModel}
          compactModel={effectiveCompactModel}
          compactMode={form.upstreamMode}
          activeRoute={activeRoute}
          latestLog={latestLog}
        />

        <section className="operator-stage" aria-labelledby="operator-stage-title">
          <div className="operator-stage-head">
            <p className="eyebrow">Advanced Controls</p>
            <h2 id="operator-stage-title">设置分流，再预览结果。</h2>
            <p>先调整 Compact 目标，再用预览面板确认这条请求会怎么命中。</p>
          </div>

          <div className="operator-grid">
            <ConfigPanel
              config={config}
              form={form}
              currentModel={currentModel}
              linkedCompactModel={linkedCompactModel}
              saveState={saveState}
              saveError={saveError}
              hasPendingChanges={hasPendingChanges}
              onCurrentModelChange={setCurrentModel}
              onFormChange={setForm}
              onUnlockCompactModel={unlockCompactModel}
              onRestoreLinkedMode={restoreLinkedMode}
              onSubmit={saveConfig}
            />

            <InspectorPanel
              path={previewPath}
              body={previewBody}
              preview={preview}
              error={previewError}
              onPathChange={setPreviewPath}
              onBodyChange={setPreviewBody}
              onSubmit={previewRoute}
            />
          </div>
        </section>

        <LogsPanel
          logs={logs}
          logCounts={logCounts}
          totalLogCount={logPage.total}
          allLogCount={logPage.all_total}
          hostOptions={hostOptions}
          hasMoreLogs={logPage.has_more}
          isLoadingLogs={isLoadingLogs}
          isLoadingMoreLogs={isLoadingMoreLogs}
          routeFilter={routeFilter}
          hostFilter={hostFilter}
          onRouteFilterChange={setRouteFilter}
          onHostFilterChange={setHostFilter}
          onLoadMore={loadMoreLogs}
          error={logError}
        />
      </section>
    </main>
  );
}

function CommandDeck({
  config,
  health,
  currentModel,
  compactModel,
  compactMode,
  activeRoute,
  latestLog,
  logs
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  activeRoute: RouteKind;
  latestLog: RequestLogEntry | null;
  logs: RequestLogEntry[];
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";
  const primaryHost = config?.primary.host ?? "primary.example";
  const compactHost = config?.compact.host ?? "compact.example";
  const compactTarget = compactMode === "split" ? compactHost : `${primaryHost} / 复用`;
  const primaryHealth = upstreamHealthBadge(health?.primary);
  const compactHealth = upstreamHealthBadge(health?.compact);
  const compactHits = logs.filter((entry) => entry.route === "compact").length;
  const primaryHits = logs.filter((entry) => entry.route === "primary").length;
  const latestSeen = latestLog ? formatClock(latestLog.time) : "等待首个采样";
  const latestPath = latestLog?.path ?? "/v1/responses/compact";
  const latestLatency = latestLog ? `${latestLog.duration_ms}ms` : "未采样";

  return (
    <section className={`command-deck route-${activeRoute}`} aria-labelledby="command-deck-title">
      <div className="deck-copy">
        <p className="eyebrow">Codex Compact Gate</p>
        <h2 id="command-deck-title">智能拦截 Compact 请求</h2>
        <p className="deck-lead">
          接入本地代理后，Compact 会自动分流到指定上游；其余请求继续直通，不改现有路径。
        </p>
        <div className="deck-story" aria-label="CompactGate 价值说明">
          <article className="deck-story-card">
            <span>边界</span>
            <strong>只拦 Compact。</strong>
            <small>普通请求继续直通，不打断现有工作流。</small>
          </article>
          <article className="deck-story-card">
            <span>机制</span>
            <strong>命中后改写目标模型。</strong>
            <small>分流、联动和热加载只发生在这条通道。</small>
          </article>
          <article className="deck-story-card">
            <span>证据</span>
            <strong>命中结果立即回显。</strong>
            <small>路径、模型、状态码和最近流量都会显示出来。</small>
          </article>
        </div>
        <div className="deck-actions">
          <a className="solid-button" href="#live-config-title">
            设置分流
          </a>
          <a className="ghost-button" href="#route-board-title">
            查看路由
          </a>
        </div>
        <div className="deck-subsystems" aria-label="Compact 请求处理链">
          <span>只拦 Compact</span>
          <span>普通请求继续直通</span>
          <span>模型与命中实时回显</span>
        </div>
      </div>

      <div className="deck-monitor" aria-label="CompactGate 运行信号面板">
        <div className="deck-monitor-head">
          <div>
            <p className="eyebrow">Signal Board</p>
            <h3>流量监控看板</h3>
          </div>
          <div className={`deck-monitor-badge route-${activeRoute}`}>
            <span>当前焦点</span>
            <strong>{routeLabel(activeRoute)}</strong>
          </div>
        </div>

        <div className="deck-lane" aria-label="CompactGate 当前路由概览">
          <div className="deck-endpoint">
            <span>Codex base_url</span>
            <code>http://{listen}/v1</code>
          </div>
          <div className="deck-pulse" aria-hidden="true">
            <span />
          </div>
          <div className="deck-endpoint is-active">
            <span>当前观察通道</span>
            <strong>{routeLabel(activeRoute)}</strong>
          </div>
        </div>

        <div className="deck-readouts">
          <DeckReadout
            label="主上游"
            value={primaryHost}
            state={primaryHealth.label}
            tone={primaryHealth.tone}
          />
          <DeckReadout
            label="Compact 目标"
            value={compactTarget}
            state={compactModeLabel(compactMode)}
            tone="compact"
          />
          <DeckReadout
            label="模型映射"
            value={`${currentModel} -> ${compactModel}`}
            state="运行时推导"
            tone="primary"
          />
          <DeckReadout
            label="最近请求"
            value={formatLatestLogStatus(latestLog, "等待 Codex 请求")}
            state={compactHealth.tone === "good" ? "健康检查正常" : `Compact ${compactHealth.label}`}
            tone={compactHealth.tone}
          />
        </div>

        <div className="deck-signal-grid">
          <article className="deck-signal-card tone-compact">
            <span>Compact 命中</span>
            <strong>{compactHits}</strong>
            <small>最近 {logs.length} 条请求里的独立接管次数</small>
          </article>
          <article className="deck-signal-card tone-primary">
            <span>普通直通</span>
            <strong>{primaryHits}</strong>
            <small>普通 /v1 继续走原路径，没有被 Compact 规则接管</small>
          </article>
          <article className="deck-signal-card tone-neutral">
            <span>最近路径</span>
            <strong title={latestPath}>{latestPath}</strong>
            <small>最近一次采样耗时 {latestLatency}</small>
          </article>
          <article className="deck-signal-card tone-neutral">
            <span>最近采样</span>
            <strong>{latestSeen}</strong>
            <small>{latestLog ? `状态 ${latestLog.status}` : "等待 Codex 发来第一条请求"}</small>
          </article>
        </div>
      </div>
    </section>
  );
}

function DeckReadout({
  label,
  value,
  state,
  tone
}: {
  label: string;
  value: string;
  state: string;
  tone: "primary" | "compact" | HealthTone;
}) {
  return (
    <div className={`deck-readout tone-${tone}`}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      <small>{state}</small>
    </div>
  );
}

function TopBar({
  config,
  health,
  saveState,
  hasPendingChanges,
  onExport
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  saveState: SaveState;
  hasPendingChanges: boolean;
  onExport: () => void | Promise<void>;
}) {
  const primaryStatus = upstreamHealthBadge(health?.primary);
  const compactStatus = upstreamHealthBadge(health?.compact);

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="mark" aria-hidden="true">
          CG
        </div>
        <div>
          <p className="eyebrow">CompactGate Studio</p>
          <h1>Codex Compact 控制台</h1>
        </div>
      </div>

      <div className="status-strip" aria-label="CompactGate 状态">
        <StatusPill label="主上游" status={primaryStatus} />
        <StatusPill label="压缩上游" status={compactStatus} />
        <span className={`save-meter ${hasPendingChanges ? "is-dirty" : ""}`}>
          {saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}
        </span>
      </div>

      <div className="toolbar">
        <a className="ghost-button" href="/health">
          健康检查
        </a>
        <button className="ghost-button" type="button" onClick={() => void onExport()}>
          导出配置
        </button>
        <a className="ghost-button" href="#logs-title">
          查看日志
        </a>
      </div>
    </header>
  );
}

function HealthPage({
  health,
  error,
  isRefreshing,
  onRefresh
}: {
  health: HealthResponse | null;
  error: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const primaryStatus = upstreamHealthBadge(health?.primary);
  const compactStatus = upstreamHealthBadge(health?.compact);
  const overallStatus = overallHealthBadge(health);

  return (
    <main className="shell shell-health">
      <header className="topbar health-topbar">
        <div className="brand-lockup">
          <div className="mark" aria-hidden="true">
            CG
          </div>
          <div>
            <p className="eyebrow">CompactGate Health</p>
            <h1>健康检查与上游装配状态</h1>
          </div>
        </div>

        <div className="status-strip" aria-label="CompactGate 健康状态">
          <StatusPill label="总体状态" status={overallStatus} />
          <StatusPill label="主上游" status={primaryStatus} />
          <StatusPill label="压缩上游" status={compactStatus} />
        </div>

        <div className="toolbar">
          <a className="ghost-button" href="/">
            返回控制台
          </a>
          <a className="ghost-button" href="/api/health" target="_blank" rel="noreferrer">
            原始 JSON
          </a>
          <button className="solid-button" type="button" onClick={onRefresh} disabled={isRefreshing}>
            {isRefreshing ? "刷新中..." : "刷新状态"}
          </button>
        </div>
      </header>

      {error && <p className="error-banner">{error}</p>}

      <section className={`health-hero tone-${overallStatus.tone}`} aria-labelledby="health-title">
        <div className="health-hero-copy">
          <p className="eyebrow">Live Monitor</p>
          <h2 id="health-title">一页看清 CompactGate 是否已经准备好接流量。</h2>
          <p>
            这个页面专门显示监听地址、上游 URL 合法性和 API Key 注入状态，适合本地联调或快速排障。
          </p>
          <div className="health-hero-actions">
            <a className="ghost-button" href="/api/health" target="_blank" rel="noreferrer">
              查看原始响应
            </a>
            <a className="ghost-button" href="/">
              进入 Studio
            </a>
          </div>
        </div>

        <div className="health-hero-readout">
          <div className="health-mini-card">
            <span>监听地址</span>
            <strong>{health ? `http://${health.listen}` : "读取中..."}</strong>
            <small>OpenAI 兼容入口：{health ? `http://${health.listen}/v1` : "等待健康数据"}</small>
          </div>
          <div className="health-mini-card">
            <span>最近刷新</span>
            <strong>{health ? formatDateTime(health.time) : "等待首次采样"}</strong>
            <small>{overallStatus.label}</small>
          </div>
        </div>
      </section>

      <section className="health-grid">
        <HealthEndpointCard
          title="主上游 API"
          route="primary"
          summary="处理普通 /v1 请求"
          upstream={health?.primary}
        />
        <HealthEndpointCard
          title="Compact 目标"
          route="compact"
          summary="处理 /v1/responses/compact"
          upstream={health?.compact}
        />
      </section>

      <section className="health-detail-grid">
        <section className="panel health-notes" aria-labelledby="health-notes-title">
          <div className="section-heading">
            <p className="eyebrow">Checklist</p>
            <h2 id="health-notes-title">如何判断现在能不能接请求</h2>
          </div>

          <div className="health-checklist">
            <div className="health-check-row">
              <span>1</span>
              <p>监听地址可见，说明代理进程已经启动并绑定到本地端口。</p>
            </div>
            <div className="health-check-row">
              <span>2</span>
              <p>上游状态显示“已配置”，说明 Base URL 格式合法。</p>
            </div>
            <div className="health-check-row">
              <span>3</span>
              <p>如果显示“缺密钥”，代理仍能启动，但转发前需要先在 Studio 里直接保存 API Key，或依赖旧配置里的环境变量回退。</p>
            </div>
          </div>
        </section>

        <section className="panel health-json-panel" aria-labelledby="health-json-title">
          <div className="section-heading">
            <p className="eyebrow">Payload</p>
            <h2 id="health-json-title">原始健康响应</h2>
          </div>

          <pre className="health-json">
            {health ? JSON.stringify(health, null, 2) : '{\n  "status": "loading"\n}'}
          </pre>
        </section>
      </section>
    </main>
  );
}

function HealthEndpointCard({
  title,
  route,
  summary,
  upstream
}: {
  title: string;
  route: RouteKind;
  summary: string;
  upstream: HealthResponse["primary"] | HealthResponse["compact"] | null | undefined;
}) {
  const status = upstreamHealthBadge(upstream);

  return (
    <section className={`panel health-card route-${route}`} aria-label={`${title} 状态`}>
      <div className="health-card-head">
        <div>
          <p className="eyebrow">{title}</p>
          <h2>{upstream?.host ?? "等待健康数据"}</h2>
        </div>
        <span className={`route-chip ${route}`}>{routeLabel(route)}</span>
      </div>

      <p className="health-card-copy">{summary}</p>

      <div className="health-kv-grid">
        <div className="health-kv">
          <span>状态</span>
          <strong>{status.label}</strong>
        </div>
        <div className="health-kv">
          <span>Base URL</span>
          <strong>{upstream?.base_url ?? "读取中..."}</strong>
        </div>
        <div className="health-kv">
          <span>Host</span>
          <strong>{upstream?.host ?? "无"}</strong>
        </div>
        <div className="health-kv">
          <span>直填密钥</span>
          <strong>{upstream?.stored_api_key ? "已保存" : "未保存"}</strong>
        </div>
        <div className="health-kv">
          <span>当前来源</span>
          <strong>{credentialSourceLabel(upstream?.api_key_source)}</strong>
        </div>
        <div className="health-kv">
          <span>当前读取</span>
          <strong>{activeCredentialLabel(route, upstream)}</strong>
        </div>
      </div>

      <div className={`health-flag ${upstream?.api_key_configured ? "is-good" : "is-warn"}`}>
        <span className="health-led" aria-hidden="true" />
        {credentialFlagCopy(route, upstream)}
      </div>
    </section>
  );
}

function RouteBoard({
  config,
  currentModel,
  compactModel,
  compactMode,
  activeRoute,
  latestLog
}: {
  config: PublicConfig | null;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  activeRoute: RouteKind;
  latestLog: RequestLogEntry | null;
}) {
  const primaryHost = config?.primary.host ?? "primary.example";
  const compactHost = config?.compact.host ?? "compact.example";
  const compactTarget = compactMode === "split" ? compactHost : primaryHost;

  return (
    <section className={`route-board is-${activeRoute}`} aria-labelledby="route-board-title">
      <div className="section-heading">
        <p className="eyebrow">Route Board</p>
        <h2 id="route-board-title">一眼确认 Codex 的 Compact 请求会被送去哪里。</h2>
      </div>

      <div className="route-canvas">
        <div className="node codex-node">
          <span className="node-label">Codex CLI</span>
          <strong>{currentModel}</strong>
          <small>base_url 指向 /v1</small>
          <em>source</em>
        </div>

        <div className="gate-tower">
          <span>CompactGate</span>
          <strong>{config?.listen ?? "127.0.0.1:7865"}</strong>
          <small>本地代理入口</small>
          <i aria-hidden="true" />
        </div>

        <div className="route-mobile-branch" aria-hidden="true">
          <span>Gate 在这里分流</span>
          <b className="branch-primary">普通</b>
          <b className="branch-compact">压缩</b>
        </div>

        <div className="node upstream-node primary-node">
          <span className="node-label">主上游 API</span>
          <strong>{primaryHost}</strong>
          <small>普通 /v1 请求</small>
          <em>/responses</em>
        </div>

        <div className="node upstream-node compact-node">
          <span className="node-label">Compact 目标</span>
          <strong>{compactTarget}</strong>
          <small>{compactModel}</small>
          <em>/responses/compact</em>
        </div>

        <div
          className={`route-line primary-line ${activeRoute === "primary" ? "is-active" : ""}`}
          aria-hidden="true"
        />
        <div
          className={`route-line compact-line ${activeRoute === "compact" ? "is-active" : ""}`}
          aria-hidden="true"
        />
      </div>

      <div className="route-foot">
        <div>
          <span>最近命中</span>
          <strong>{formatLatestLogStatus(latestLog, "等待请求")}</strong>
        </div>
        <div>
          <span>模型映射</span>
          <strong title={`${currentModel} -> ${compactModel}`}>
            <code>{currentModel}</code> {"->"} <code>{compactModel}</code>
          </strong>
        </div>
        <div>
          <span>Compact 上游模式</span>
          <strong>{compactModeLabel(compactMode)}</strong>
        </div>
      </div>
    </section>
  );
}

function ConfigPanel({
  config,
  form,
  currentModel,
  linkedCompactModel,
  saveState,
  saveError,
  hasPendingChanges,
  onCurrentModelChange,
  onFormChange,
  onUnlockCompactModel,
  onRestoreLinkedMode,
  onSubmit
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  currentModel: string;
  linkedCompactModel: string;
  saveState: SaveState;
  saveError: string | null;
  hasPendingChanges: boolean;
  onCurrentModelChange: (model: string) => void;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onUnlockCompactModel: () => void;
  onRestoreLinkedMode: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <section className="panel live-config" aria-labelledby="live-config-title">
      <div className="section-heading">
        <p className="eyebrow">Live Config</p>
        <h2 id="live-config-title">运行时配置，无需重启代理。</h2>
      </div>

      <form className="control-stack" onSubmit={onSubmit}>
        <Field label="主上游 Base URL" hint="普通 /v1 请求会转发到这里。">
          <input
            aria-label="主上游 Base URL"
            value={form.primaryBaseUrl}
            onChange={(event) =>
              onFormChange((previous) => ({
                ...previous,
                primaryBaseUrl: event.target.value
              }))
            }
            spellCheck={false}
          />
        </Field>

        <Field
          label="主上游 API Key"
          hint={
            form.clearPrimaryApiKey
              ? "保存后会删除当前已保存的主上游密钥。"
              : directApiKeyHint("primary", config?.primary ?? null)
          }
        >
          <input
            aria-label="主上游 API Key"
            type="password"
            autoComplete="off"
            value={form.primaryApiKey}
            placeholder={config?.primary.stored_api_key ? "输入新值以覆盖已保存密钥" : "sk-..."}
            onChange={(event) =>
              onFormChange((previous) => ({
                ...previous,
                primaryApiKey: event.target.value,
                clearPrimaryApiKey: false
              }))
            }
            spellCheck={false}
          />
          {(config?.primary.stored_api_key || form.clearPrimaryApiKey) && (
            <div className="field-action-row">
              <button
                className={`field-inline-button ${form.clearPrimaryApiKey ? "is-danger" : ""}`}
                type="button"
                onClick={() =>
                  onFormChange((previous) => ({
                    ...previous,
                    primaryApiKey: "",
                    clearPrimaryApiKey: !previous.clearPrimaryApiKey
                  }))
                }
              >
                {form.clearPrimaryApiKey ? "取消清空" : "清空已保存密钥"}
              </button>
            </div>
          )}
        </Field>

        <Field
          label="Compact Base URL"
          hint={
            form.upstreamMode === "split"
              ? "压缩请求会转发到这里。"
              : "当前复用主上游，这个地址暂不参与转发。"
          }
        >
          <input
            aria-label="Compact Base URL"
            value={form.compactBaseUrl}
            onChange={(event) =>
              onFormChange((previous) => ({
                ...previous,
                compactBaseUrl: event.target.value
              }))
            }
            spellCheck={false}
          />
        </Field>

        <Field
          label="Compact API Key"
          hint={
            form.clearCompactApiKey
              ? "保存后会删除当前已保存的 Compact 密钥。"
              : form.upstreamMode === "split"
              ? directApiKeyHint("compact", config?.compact ?? null)
              : "当前 Compact 请求复用主上游认证；这里的密钥会在切回独立分流后生效。留空表示保持现状。"
          }
        >
          <input
            aria-label="Compact API Key"
            type="password"
            autoComplete="off"
            value={form.compactApiKey}
            placeholder={config?.compact.stored_api_key ? "输入新值以覆盖已保存密钥" : "sk-..."}
            onChange={(event) =>
              onFormChange((previous) => ({
                ...previous,
                compactApiKey: event.target.value,
                clearCompactApiKey: false
              }))
            }
            spellCheck={false}
          />
          {(config?.compact.stored_api_key || form.clearCompactApiKey) && (
            <div className="field-action-row">
              <button
                className={`field-inline-button ${form.clearCompactApiKey ? "is-danger" : ""}`}
                type="button"
                onClick={() =>
                  onFormChange((previous) => ({
                    ...previous,
                    compactApiKey: "",
                    clearCompactApiKey: !previous.clearCompactApiKey
                  }))
                }
              >
                {form.clearCompactApiKey ? "取消清空" : "清空已保存密钥"}
              </button>
            </div>
          )}
        </Field>

        <div className="mode-card">
          <div>
            <span className="mode-card-title">Compact 上游模式</span>
            <p>
              {form.upstreamMode === "split" ? "独立分流：" : "复用主上游："}
              <code>/v1/responses/compact</code>
              {form.upstreamMode === "split"
                ? " 使用 Compact Base URL 与 Compact API Key。"
                : " 直接发送到主上游，并复用主上游密钥。"}
            </p>
          </div>
          <div className="mode-switch" role="group" aria-label="Compact 上游模式">
            <button
              className={form.upstreamMode === "split" ? "is-selected" : ""}
              type="button"
              aria-pressed={form.upstreamMode === "split"}
              onClick={() =>
                onFormChange((previous) => ({
                  ...previous,
                  upstreamMode: "split"
                }))
              }
            >
              独立分流
            </button>
            <button
              className={form.upstreamMode === "primary" ? "is-selected" : ""}
              type="button"
              aria-pressed={form.upstreamMode === "primary"}
              onClick={() =>
                onFormChange((previous) => ({
                  ...previous,
                  upstreamMode: "primary"
                }))
              }
            >
              复用主上游
            </button>
          </div>
        </div>

        <Field label="当前 Codex 模型" hint="可手动输入，也会从最近一次请求 body 里自动学习。">
          <input
            aria-label="当前 Codex 模型"
            value={currentModel}
            onChange={(event) => onCurrentModelChange(event.target.value)}
            spellCheck={false}
          />
        </Field>

        <div className="mode-card compact-model-card">
          <div>
            <span className="mode-card-title">Compact 模型模式</span>
            <p>
              {form.modelMode === "linked"
                ? "自动联动当前模型，并套用模板生成 compact 模型。"
                : "手动覆盖 compact 模型，当前模型变化时不会自动同步。"}
            </p>
          </div>
          <div className="mode-switch" role="group" aria-label="Compact 模型模式">
            <button
              className={form.modelMode === "linked" ? "is-selected" : ""}
              type="button"
              aria-pressed={form.modelMode === "linked"}
              onClick={onRestoreLinkedMode}
            >
              自动联动
            </button>
            <button
              className={form.modelMode === "custom" ? "is-selected" : ""}
              type="button"
              aria-pressed={form.modelMode === "custom"}
              onClick={onUnlockCompactModel}
            >
              手动指定
            </button>
          </div>
        </div>

        <Field label="Compact 模型" hint="自动联动时这里是只读预览。">
          <div className="compound-input">
            <input
              aria-label="Compact 模型"
              value={form.modelMode === "linked" ? linkedCompactModel : form.modelOverride}
              readOnly={form.modelMode === "linked"}
              onChange={(event) =>
                onFormChange((previous) => ({
                  ...previous,
                  modelOverride: event.target.value
                }))
              }
              spellCheck={false}
            />
            {form.modelMode === "linked" ? (
              <button type="button" onClick={onUnlockCompactModel}>
                解锁
              </button>
            ) : (
              <button type="button" onClick={onRestoreLinkedMode}>
                恢复联动
              </button>
            )}
          </div>
        </Field>

        {form.modelMode === "custom" && (
          <p className="inline-warning">
            Compact 模型已手动覆盖。如果 Codex 切换模型后希望自动推导，请恢复自动联动。
          </p>
        )}

        <Field label="联动模板" hint="{model} 会被替换为请求里的原始模型名。">
          <input
            aria-label="联动模板"
            value={form.modelTemplate}
            onChange={(event) =>
              onFormChange((previous) => ({
                ...previous,
                modelTemplate: event.target.value
              }))
            }
            spellCheck={false}
          />
        </Field>

        {saveError && <p className="error-note">{saveError}</p>}

        <button className="apply-button" type="submit" disabled={saveState === "saving"}>
          {saveButtonLabel(saveState, hasPendingChanges)}
        </button>
      </form>
    </section>
  );
}

function InspectorPanel({
  path,
  body,
  preview,
  error,
  onPathChange,
  onBodyChange,
  onSubmit
}: {
  path: string;
  body: string;
  preview: RoutePreviewResponse | null;
  error: string | null;
  onPathChange: (path: string) => void;
  onBodyChange: (body: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <section className="panel inspector" aria-labelledby="inspector-title">
      <div className="section-heading">
        <p className="eyebrow">Inspector</p>
        <h2 id="inspector-title">先预览，再交给 Codex。</h2>
      </div>

      <form className="control-stack" onSubmit={onSubmit}>
        <Field label="请求路径" hint="选择常用路径，或直接编辑。">
          <div className="path-presets">
            <button type="button" onClick={() => onPathChange("/v1/responses")}>
              普通响应
            </button>
            <button type="button" onClick={() => onPathChange("/v1/responses/compact")}>
              Compact
            </button>
          </div>
          <input
            aria-label="请求路径"
            value={path}
            onChange={(event) => onPathChange(event.target.value)}
          />
        </Field>

        <Field label="JSON Body" hint="排障只需要 model 和 stream，不需要填 prompt 内容。">
          <textarea
            aria-label="JSON Body"
            value={body}
            onChange={(event) => onBodyChange(event.target.value)}
            rows={7}
            spellCheck={false}
          />
        </Field>

        {error && <p className="error-note">{error}</p>}

        <button className="preview-button" type="submit">
          预览路由
        </button>
      </form>

      <div className={`preview-readout ${preview ? `route-${preview.route}` : ""}`} aria-live="polite">
        {preview ? (
          <>
            <dl>
              <div>
                <dt>命中通道</dt>
                <dd>
                  <span className={`route-chip ${preview.route}`}>{routeLabel(preview.route)}</span>
                </dd>
              </div>
              <div>
                <dt>目标上游</dt>
                <dd>{preview.upstream_host}</dd>
              </div>
              <div>
            <dt>来源模型</dt>
                <dd>
                  <code>{preview.source_model ?? "无"}</code>
                </dd>
              </div>
              <div>
                <dt>最终模型</dt>
                <dd>
                  <code>{preview.target_model ?? "无"}</code>
                </dd>
              </div>
            </dl>
            <p>
              Body 改写：{preview.body_rewritten ? "是" : "否"} · 移除 stream：
              {preview.stream_removed ? "是" : "否"}
            </p>
          </>
        ) : (
          <p>预览结果会显示命中通道、上游地址、模型改写和 stream 处理。</p>
        )}
      </div>
    </section>
  );
}

function LogsPanel({
  logs,
  logCounts,
  totalLogCount,
  allLogCount,
  hostOptions,
  hasMoreLogs,
  isLoadingLogs,
  isLoadingMoreLogs,
  routeFilter,
  hostFilter,
  onRouteFilterChange,
  onHostFilterChange,
  onLoadMore,
  error
}: {
  logs: RequestLogEntry[];
  logCounts: Record<"all" | RouteKind, number>;
  totalLogCount: number;
  allLogCount: number;
  hostOptions: HostFilterOption[];
  hasMoreLogs: boolean;
  isLoadingLogs: boolean;
  isLoadingMoreLogs: boolean;
  routeFilter: "all" | RouteKind;
  hostFilter: string;
  onRouteFilterChange: (route: "all" | RouteKind) => void;
  onHostFilterChange: (host: string) => void;
  onLoadMore: () => void;
  error: string | null;
}) {
  const routeOptions = buildRouteSelectOptions(logCounts);
  const hostSelectOptions = buildHostSelectOptions(hostOptions, allLogCount);
  const visibleLogCount = logs.length;

  return (
    <section className="logs-panel" aria-labelledby="logs-title">
      <div className="logs-head">
        <div className="section-heading">
          <p className="eyebrow">Logs</p>
          <h2 id="logs-title">最近请求，不记录 prompt/body。</h2>
        </div>
        <div className="log-filter-stack">
          <div className="log-select-row">
            <CustomSelect
              label="通道"
              value={routeFilter}
              options={routeOptions}
              onChange={(value) => onRouteFilterChange(readRouteFilterValue(value))}
            />
            <CustomSelect
              label="上游 Host"
              value={hostFilter}
              options={hostSelectOptions}
              onChange={onHostFilterChange}
              wide
            />
          </div>
          <p className="log-filter-summary" aria-live="polite">
            当前加载 {visibleLogCount} / {totalLogCount} 条匹配日志；日志库共 {allLogCount} 条。
            展示分批加载，不会删除历史日志。
          </p>
        </div>
      </div>

      {error && <p className="error-note">{error}</p>}

      {logs.length > 0 && (
        <div className="log-usage-head" aria-hidden="true">
          <span>模型</span>
          <span>推理强度</span>
          <span>端点</span>
          <span>上游 Host</span>
          <span>类型</span>
          <span>Token</span>
          <span>首 Token</span>
          <span>耗时</span>
        </div>
      )}

      <div className="log-list" aria-busy={isLoadingLogs}>
        {isLoadingLogs && logs.length === 0 ? (
          <div className="empty-log">
            <strong>正在加载日志。</strong>
            <span>先读取最新一页，较早的日志可以继续懒加载。</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-log">
            <strong>{emptyLogTitle(routeFilter, hostFilter, logCounts.all)}</strong>
            <span>{emptyLogHint(routeFilter, hostFilter, logCounts.all)}</span>
          </div>
        ) : (
          logs.map((entry, index) => (
            <LogRow
              key={`${entry.request_id}-${entry.time}-${entry.route}-${entry.status}-${index}`}
              entry={entry}
            />
          ))
        )}
      </div>

      {logs.length > 0 && (
        <div className="log-load-more">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={!hasMoreLogs || isLoadingMoreLogs}
          >
            {hasMoreLogs
              ? isLoadingMoreLogs
                ? "正在加载更早日志..."
                : "加载更早日志"
              : "已加载全部匹配日志"}
          </button>
          <span>
            已加载 {visibleLogCount} / {totalLogCount} 条匹配日志
          </span>
        </div>
      )}
    </section>
  );
}

function LogRow({ entry }: { entry: RequestLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = Boolean(entry.error_summary) || entry.status >= 400;
  const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
  const requestLine = `${entry.method} ${entry.path}`;
  const targetModel = entry.target_model ?? entry.source_model;
  const hasModelRewrite = Boolean(entry.source_model && targetModel && entry.source_model !== targetModel);

  return (
    <article className={`log-row ${hasError ? "has-error" : ""}`}>
      <button
        className="log-row-main"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="log-model-cell">
          <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
          <strong>{entry.source_model ?? "-"}</strong>
          {hasModelRewrite && <small>{"->"} {targetModel}</small>}
        </span>
        <span className="log-reasoning">{entry.reasoning_effort ?? "-"}</span>
        <code className="log-endpoint">{entry.endpoint}</code>
        <code className="log-host">{entry.upstream_host}</code>
        <span className={`transport-pill is-${entry.request_type}`}>
          {requestTypeLabel(entry.request_type)}
        </span>
        <TokenTooltip entry={entry} />
        <span className="metric-time">{formatDurationMs(entry.first_token_ms)}</span>
        <span className="metric-time">{formatDurationMs(entry.duration_ms)}</span>
      </button>

      {expanded && (
        <div className="log-detail">
          <p>{entry.error_summary ?? "请求已完成，上游未返回代理层错误。"}</p>
          <div className="token-detail-card" aria-label="Token 明细">
            <div>
              <span>输入 Token</span>
              <strong>{formatMetricNumber(entry.input_tokens)}</strong>
            </div>
            <div>
              <span>输出 Token</span>
              <strong>{formatMetricNumber(entry.output_tokens)}</strong>
            </div>
            <div>
              <span>缓存读取 Token</span>
              <strong>{formatMetricNumber(entry.cached_input_tokens)}</strong>
            </div>
            <div>
              <span>缓存输出 Token</span>
              <strong>{formatMetricNumber(entry.cached_output_tokens)}</strong>
            </div>
            <div>
              <span>未缓存输入</span>
              <strong>{formatMetricNumber(uncachedInputTokens(entry))}</strong>
            </div>
            <div>
              <span>缓存命中率</span>
              <strong>{formatCacheHitRate(entry)}</strong>
            </div>
            <div>
              <span>总 Token</span>
              <strong>{formatMetricNumber(entry.total_tokens)}</strong>
            </div>
          </div>
          <dl className="log-detail-grid">
            <div>
              <dt>请求</dt>
              <dd>
                <code>{requestLine}</code>
              </dd>
            </div>
            <div>
              <dt>模型映射</dt>
              <dd>
                <code>{modelMapping}</code>
              </dd>
            </div>
            <div>
              <dt>上游 / 端点</dt>
              <dd>
                <code>{entry.upstream_host}{entry.endpoint}</code>
              </dd>
            </div>
            <div>
              <dt>状态 / 类型</dt>
              <dd>
                {entry.status} / {requestTypeLabel(entry.request_type)}
              </dd>
            </div>
            <div>
              <dt>首 Token / 总耗时</dt>
              <dd>
                {formatDurationMs(entry.first_token_ms)} / {formatDurationMs(entry.duration_ms)}
              </dd>
            </div>
            <div>
              <dt>推理强度</dt>
              <dd>
                <code>{entry.reasoning_effort ?? "无"}</code>
              </dd>
            </div>
            <div>
              <dt>采样时间</dt>
              <dd>
                <time>{formatDateTime(entry.time)}</time>
              </dd>
            </div>
          </dl>
          <small>Request ID: {entry.request_id}</small>
        </div>
      )}
    </article>
  );
}

function CustomSelect({
  label,
  value,
  options,
  onChange,
  wide = false
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selected.value)
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) {
      return;
    }

    window.requestAnimationFrame(() => {
      optionRefs.current[selectedIndex]?.focus();
    });
  }, [open, selectedIndex]);

  function closeAndFocusTrigger() {
    setOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }

  function focusOption(index: number) {
    optionRefs.current[index]?.focus();
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeAndFocusTrigger();
    }
  }

  function handleOptionKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    optionIndex: number
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption((optionIndex + 1) % options.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption((optionIndex - 1 + options.length) % options.length);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1);
    }
  }

  return (
    <div
      className={`custom-select ${wide ? "is-wide" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <span className="custom-select-label">{label}</span>
      <button
        ref={triggerRef}
        className="custom-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="custom-select-copy">
          <strong>{selected.label}</strong>
          {selected.meta && <small>{selected.meta}</small>}
        </span>
        <span className="custom-select-count">{selected.count}</span>
        <span className="custom-select-caret" aria-hidden="true">v</span>
      </button>

      {open && (
        <div id={listId} className="custom-select-menu" role="listbox">
          {options.map((option, optionIndex) => (
            <button
              key={option.value}
              ref={(node) => {
                optionRefs.current[optionIndex] = node;
              }}
              className={`custom-select-option ${option.value === value ? "is-selected" : ""} ${
                option.tone ? `is-${option.tone}` : ""
              }`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              onKeyDown={(event) => handleOptionKeyDown(event, optionIndex)}
            >
              <span className="custom-select-copy">
                <strong>{option.label}</strong>
                {option.meta && <small>{option.meta}</small>}
              </span>
              <span className="custom-select-count">{option.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenTooltip({ entry }: { entry: RequestLogEntry }) {
  const [placement, setPlacement] = useState<React.CSSProperties | null>(null);
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  function showTooltip() {
    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const width = Math.min(TOKEN_TOOLTIP_WIDTH, window.innerWidth - 24);
    const left = clamp(rect.right - width, 12, window.innerWidth - width - 12);
    const canShowAbove = rect.top > TOKEN_TOOLTIP_ESTIMATED_HEIGHT + 18;
    const top = canShowAbove
      ? rect.top - TOKEN_TOOLTIP_ESTIMATED_HEIGHT - 10
      : rect.bottom + 10;

    setPlacement({
      left,
      top,
      width
    });
  }

  function hideTooltip() {
    setPlacement(null);
  }

  return (
    <span
      ref={anchorRef}
      className="token-tooltip"
      aria-describedby={tooltipId}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
    >
      <span className="token-total-pill">总 {formatMetricNumber(entry.total_tokens)}</span>
      {placement &&
        createPortal(
          <span
            className="token-tooltip-panel"
            id={tooltipId}
            role="tooltip"
            style={placement}
          >
            <strong className="token-tooltip-title">Token 明细</strong>
            <span className="token-tooltip-row">
              <em>输入 Token</em>
              <b>{formatMetricNumber(entry.input_tokens)}</b>
            </span>
            <span className="token-tooltip-row">
              <em>输出 Token</em>
              <b>{formatMetricNumber(entry.output_tokens)}</b>
            </span>
            <span className="token-tooltip-row">
              <em>缓存输入 Token</em>
              <b>{formatMetricNumber(entry.cached_input_tokens)}</b>
            </span>
            <span className="token-tooltip-row">
              <em>缓存输出 Token</em>
              <b>{formatMetricNumber(entry.cached_output_tokens)}</b>
            </span>
            <span className="token-tooltip-row">
              <em>未缓存输入</em>
              <b>{formatMetricNumber(uncachedInputTokens(entry))}</b>
            </span>
            <span className="token-tooltip-row">
              <em>缓存命中率</em>
              <b>{formatCacheHitRate(entry)}</b>
            </span>
            <span className="token-tooltip-total">
              <em>总 Token</em>
              <b>{formatMetricNumber(entry.total_tokens)}</b>
            </span>
          </span>,
          document.body
        )}
    </span>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      <small>{hint}</small>
    </div>
  );
}

function credentialSourceLabel(source?: CredentialSource | null): string {
  if (source === "config") {
    return "直填密钥";
  }

  if (source === "env") {
    return "环境变量";
  }

  return "未找到";
}

function activeCredentialLabel(
  route: RouteKind,
  upstream?: PublicConfig["primary"] | PublicConfig["compact"] | HealthResponse["primary"] | HealthResponse["compact"] | null
): string {
  if (!upstream) {
    return "读取中...";
  }

  if (upstream.api_key_source === "config") {
    return upstream.active_credential_scope === route ? "已保存直连密钥" : "复用主上游直连密钥";
  }

  return upstream.active_api_key_env ?? "无";
}

function credentialFlagCopy(
  route: RouteKind,
  upstream?: HealthResponse["primary"] | HealthResponse["compact"] | null
): string {
  if (!upstream?.api_key_configured) {
    return "当前没有可用密钥。";
  }

  if (upstream.api_key_source === "config") {
    return upstream.active_credential_scope === route
      ? "当前由已保存的直连密钥注入 Authorization。"
      : "当前复用主上游里保存的直连密钥。";
  }

  return upstream.active_credential_scope === route
    ? `当前读取环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。`
    : `当前复用主上游环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。`;
}

function directApiKeyHint(
  route: RouteKind,
  upstream?: PublicConfig["primary"] | PublicConfig["compact"] | null
): string {
  if (!upstream) {
    return "保存后会直接写入 compactgate.json。";
  }

  if (upstream.stored_api_key) {
    return "这个槽位已经保存过直填密钥。留空保持现状，输入新值后会直接覆盖。";
  }

  if (upstream.api_key_source === "env") {
    return `当前仍在回退环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。留空保持回退，输入新值后会改为直填密钥。`;
  }

  return route === "primary"
    ? "当前还没有主上游密钥；保存后会直接写入 compactgate.json。"
    : "当前还没有 Compact 密钥；保存后会直接写入 compactgate.json。";
}

function StatusPill({ label, status }: { label: string; status: HealthBadge }) {
  return (
    <span className={`status-pill is-${status.tone}`}>
      {label}: {status.label}
    </span>
  );
}

function emptyForm(): ConfigFormState {
  return {
    primaryBaseUrl: "",
    primaryApiKey: "",
    clearPrimaryApiKey: false,
    compactBaseUrl: "",
    compactApiKey: "",
    clearCompactApiKey: false,
    upstreamMode: "split",
    modelMode: "linked",
    modelTemplate: "{model}-openai-compact",
    modelOverride: ""
  };
}

function formFromConfig(config: PublicConfig): ConfigFormState {
  return {
    primaryBaseUrl: config.primary.base_url,
    primaryApiKey: "",
    clearPrimaryApiKey: false,
    compactBaseUrl: config.compact.base_url,
    compactApiKey: "",
    clearCompactApiKey: false,
    upstreamMode: config.compact.upstream_mode,
    modelMode: config.compact.model_mode,
    modelTemplate: config.compact.model_template,
    modelOverride: config.compact.model_override
  };
}

function formToPatch(form: ConfigFormState) {
  const primary = {
    base_url: form.primaryBaseUrl,
    ...apiKeyPatch(form.primaryApiKey, form.clearPrimaryApiKey)
  };
  const compact = {
    base_url: form.compactBaseUrl,
    ...apiKeyPatch(form.compactApiKey, form.clearCompactApiKey),
    upstream_mode: form.upstreamMode,
    model_mode: form.modelMode,
    model_template: form.modelTemplate,
    model_override: form.modelOverride
  };

  return {
    primary,
    compact
  };
}

function isFormDirty(config: PublicConfig, form: ConfigFormState): boolean {
  const current = draftComparisonState(formFromConfig(config));
  const draft = draftComparisonState(form);
  return JSON.stringify(current) !== JSON.stringify(draft);
}

function applyDraftToConfigExport(
  config: CompactGateConfig,
  form: ConfigFormState
): CompactGateConfig {
  const next: CompactGateConfig = {
    listen: config.listen,
    primary: {
      ...config.primary,
      base_url: form.primaryBaseUrl
    },
    compact: {
      ...config.compact,
      base_url: form.compactBaseUrl,
      upstream_mode: form.upstreamMode,
      model_mode: form.modelMode,
      model_template: form.modelTemplate,
      model_override: form.modelOverride
    },
    timeouts: { ...config.timeouts },
    logging: { ...config.logging }
  };

  applyApiKeyDraft(next.primary, form.primaryApiKey, form.clearPrimaryApiKey);
  applyApiKeyDraft(next.compact, form.compactApiKey, form.clearCompactApiKey);

  return next;
}

function draftComparisonState(form: ConfigFormState) {
  return {
    primaryBaseUrl: form.primaryBaseUrl,
    primaryApiKey: normalizedApiKey(form.primaryApiKey),
    clearPrimaryApiKey: form.clearPrimaryApiKey,
    compactBaseUrl: form.compactBaseUrl,
    compactApiKey: normalizedApiKey(form.compactApiKey),
    clearCompactApiKey: form.clearCompactApiKey,
    upstreamMode: form.upstreamMode,
    modelMode: form.modelMode,
    modelTemplate: form.modelTemplate,
    modelOverride: form.modelOverride
  };
}

function apiKeyPatch(value: string, shouldClear: boolean): { api_key?: string } {
  if (shouldClear) {
    return { api_key: "" };
  }

  const apiKey = normalizedApiKey(value);
  return apiKey.length > 0 ? { api_key: apiKey } : {};
}

function applyApiKeyDraft(
  target: CompactGateConfig["primary"] | CompactGateConfig["compact"],
  value: string,
  shouldClear: boolean
): void {
  if (shouldClear) {
    target.api_key = "";
    return;
  }

  const apiKey = normalizedApiKey(value);
  if (apiKey.length > 0) {
    target.api_key = apiKey;
  }
}

function normalizedApiKey(value: string): string {
  return value.trim();
}

function renderLinkedModel(model: string, template: string): string {
  return template.replaceAll("{model}", model || "model");
}

function routeLabel(route: RouteKind): string {
  return route === "primary" ? "普通" : "压缩";
}

function formatLatestLogStatus(entry: RequestLogEntry | null, fallback: string): string {
  return entry ? `${routeLabel(entry.route)} · 状态 ${entry.status}` : fallback;
}

function requestTypeLabel(type: RequestLogEntry["request_type"]): string {
  return type === "stream" ? "Stream" : "HTTP";
}

function buildRouteSelectOptions(logCounts: Record<"all" | RouteKind, number>): SelectOption[] {
  return [
    {
      value: "all",
      label: "全部",
      count: logCounts.all,
      meta: "所有通道"
    },
    {
      value: "primary",
      label: "普通",
      count: logCounts.primary,
      meta: "主上游",
      tone: "primary"
    },
    {
      value: "compact",
      label: "压缩",
      count: logCounts.compact,
      meta: "Compact",
      tone: "compact"
    }
  ];
}

function buildHostSelectOptions(
  hostOptions: HostFilterOption[],
  totalLogCount: number
): SelectOption[] {
  return [
    {
      value: ALL_HOSTS_FILTER,
      label: "全部上游",
      count: totalLogCount,
      meta: "所有 Host"
    },
    ...hostOptions
      .filter((option) => option.host !== ALL_HOSTS_FILTER)
      .map((option) => ({
        value: option.host,
        label: option.host,
        count: option.total,
        meta: `普 ${option.primary} / 压 ${option.compact}` as string
      }))
  ];
}

function readRouteFilterValue(value: string): "all" | RouteKind {
  return value === "primary" || value === "compact" ? value : "all";
}

function buildHostFilterOptions(
  hostCounts: HostLogCount[],
  selectedHost: string
): HostFilterOption[] {
  const options = hostCounts.map((option) => ({ ...option }));

  if (selectedHost !== ALL_HOSTS_FILTER && !options.some((option) => option.host === selectedHost)) {
    options.push({
      host: selectedHost,
      total: 0,
      primary: 0,
      compact: 0
    });
  }

  return options.sort((left, right) => {
    if (right.total !== left.total) {
      return right.total - left.total;
    }

    return left.host.localeCompare(right.host);
  });
}

function formatMetricNumber(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return new Intl.NumberFormat("en-US").format(value);
}

function uncachedInputTokens(entry: RequestLogEntry): number | null {
  if (entry.input_tokens === null && entry.cached_input_tokens === null) {
    return null;
  }

  return Math.max(0, (entry.input_tokens ?? 0) - (entry.cached_input_tokens ?? 0));
}

function formatCacheHitRate(entry: RequestLogEntry): string {
  if (!entry.input_tokens || entry.cached_input_tokens === null) {
    return "-";
  }

  return `${Math.round((entry.cached_input_tokens / entry.input_tokens) * 100)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatDurationMs(value: number | null): string {
  if (value === null) {
    return "-";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  return `${(value / 1000).toFixed(2)}s`;
}

function emptyLogTitle(route: "all" | RouteKind, hostFilter: string, totalLogs: number): string {
  if (totalLogs === 0) {
    return "还没有请求经过。";
  }

  if (hostFilter !== ALL_HOSTS_FILTER) {
    return "当前 Host 没有匹配日志。";
  }

  return route === "primary" ? "最近没有普通请求。" : "最近没有压缩请求。";
}

function emptyLogHint(route: "all" | RouteKind, hostFilter: string, totalLogs: number): string {
  if (totalLogs === 0) {
    return "把 Codex 的 base_url 指到 http://127.0.0.1:7865/v1 后，这里会实时出现路由记录。";
  }

  if (hostFilter !== ALL_HOSTS_FILTER) {
    return route === "all"
      ? "这个上游 host 不在当前最近日志里，清除 Host 可以回到全部上游。"
      : "这个上游 host 在当前通道下没有命中，切换通道或清除 Host 可以查看其它记录。";
  }

  return route === "primary"
    ? "当前筛选条件下只有压缩请求，切回“全部”可以查看完整记录。"
    : "当前筛选条件下只有普通请求，切回“全部”可以查看完整记录。";
}

function compactModeLabel(mode: "split" | "primary"): string {
  return mode === "split" ? "独立分流" : "复用主上游";
}

function emptyLogPage(limit: number): RequestLogPage {
  return {
    logs: [],
    limit,
    offset: 0,
    total: 0,
    all_total: 0,
    has_more: false,
    counts: {
      all: 0,
      primary: 0,
      compact: 0
    },
    host_counts: []
  };
}

async function fetchLogPage({
  route,
  host,
  limit,
  offset
}: {
  route: "all" | RouteKind;
  host: string;
  limit: number;
  offset: number;
}): Promise<RequestLogPage> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset)
  });

  if (route !== "all") {
    params.set("route", route);
  }

  if (host !== ALL_HOSTS_FILTER) {
    params.set("host", host);
  }

  return api<RequestLogPage>(`/api/logs/recent?${params.toString()}`);
}

function appendLogPage(previous: RequestLogPage, nextPage: RequestLogPage): RequestLogPage {
  return {
    ...nextPage,
    offset: 0,
    logs: mergeUniqueLogs([...previous.logs, ...nextPage.logs])
  };
}

function mergeSnapshotLogPage(
  previous: RequestLogPage,
  snapshotPage: RequestLogPage
): RequestLogPage {
  const logs = mergeUniqueLogs([...snapshotPage.logs, ...previous.logs]);

  return {
    ...snapshotPage,
    offset: 0,
    logs,
    has_more: logs.length < snapshotPage.total
  };
}

function mergeLiveLogPage(
  previous: RequestLogPage,
  nextEntry: RequestLogEntry,
  routeFilter: "all" | RouteKind,
  hostFilter: string
): RequestLogPage {
  const duplicate = previous.logs.some((entry) => entry.request_id === nextEntry.request_id);
  const matchesFilter = logEntryMatchesFilter(nextEntry, routeFilter, hostFilter);
  const nextLogs = matchesFilter
    ? [nextEntry, ...previous.logs.filter((entry) => entry.request_id !== nextEntry.request_id)]
    : previous.logs;

  return {
    ...previous,
    logs: nextLogs,
    total: previous.total + (matchesFilter && !duplicate ? 1 : 0),
    all_total: previous.all_total + (duplicate ? 0 : 1),
    counts: incrementRouteCounts(previous.counts, nextEntry.route, duplicate),
    host_counts: incrementHostCounts(previous.host_counts, nextEntry, duplicate)
  };
}

function mergeUniqueLogs(logs: RequestLogEntry[]): RequestLogEntry[] {
  const seen = new Set<string>();
  const next: RequestLogEntry[] = [];

  for (const entry of logs) {
    if (seen.has(entry.request_id)) {
      continue;
    }

    seen.add(entry.request_id);
    next.push(entry);
  }

  return next;
}

function logEntryMatchesFilter(
  entry: RequestLogEntry,
  routeFilter: "all" | RouteKind,
  hostFilter: string
): boolean {
  const routeMatches = routeFilter === "all" || entry.route === routeFilter;
  const hostMatches = hostFilter === ALL_HOSTS_FILTER || entry.upstream_host === hostFilter;
  return routeMatches && hostMatches;
}

function incrementRouteCounts(
  counts: Record<"all" | RouteKind, number>,
  route: RouteKind,
  duplicate: boolean
): Record<"all" | RouteKind, number> {
  if (duplicate) {
    return counts;
  }

  return {
    ...counts,
    all: counts.all + 1,
    [route]: counts[route] + 1
  };
}

function incrementHostCounts(
  hostCounts: HostLogCount[],
  entry: RequestLogEntry,
  duplicate: boolean
): HostLogCount[] {
  if (duplicate) {
    return hostCounts;
  }

  const next = hostCounts.map((option) => ({ ...option }));
  const existing = next.find((option) => option.host === entry.upstream_host);

  if (existing) {
    existing.total += 1;
    existing[entry.route] += 1;
  } else {
    next.push({
      host: entry.upstream_host,
      total: 1,
      primary: entry.route === "primary" ? 1 : 0,
      compact: entry.route === "compact" ? 1 : 0
    });
  }

  return next.sort((left, right) => {
    if (right.total !== left.total) {
      return right.total - left.total;
    }

    return left.host.localeCompare(right.host);
  });
}

function upstreamHealthBadge(
  upstream?: HealthResponse["primary"] | HealthResponse["compact"] | null
): HealthBadge {
  if (!upstream) {
    return { label: "读取中", tone: "warn" };
  }

  if (!upstream || upstream.status !== "configured") {
    return { label: "异常", tone: "bad" };
  }

  if (!upstream.api_key_configured) {
    return { label: "缺密钥", tone: "warn" };
  }

  return { label: "已配置", tone: "good" };
}

function overallHealthBadge(health: HealthResponse | null): HealthBadge {
  if (!health) {
    return { label: "等待健康数据", tone: "warn" };
  }

  const statuses = [upstreamHealthBadge(health.primary), upstreamHealthBadge(health.compact)];

  if (statuses.some((item) => item.tone === "bad")) {
    return { label: "存在异常", tone: "bad" };
  }

  if (statuses.some((item) => item.tone === "warn")) {
    return { label: "需要补全", tone: "warn" };
  }

  return { label: "状态良好", tone: "good" };
}

function saveLabel(state: SaveState, hasPendingChanges: boolean, savedAt?: string | null): string {
  if (state === "saving") {
    return "正在保存";
  }

  if (state === "saved") {
    return "刚刚保存";
  }

  if (state === "error") {
    return "保存失败";
  }

  if (hasPendingChanges) {
    return "有未保存更改";
  }

  return savedAt ? `已保存 ${formatClock(savedAt)}` : "使用默认配置";
}

function saveButtonLabel(state: SaveState, hasPendingChanges: boolean): string {
  if (state === "saving") {
    return "正在应用配置...";
  }

  if (state === "saved") {
    return "已应用";
  }

  return hasPendingChanges ? "应用更改" : "重新应用配置";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  const payload = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    throw new Error(readApiError(payload) ?? response.statusText);
  }

  return payload as T;
}

function readApiError(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }

  return null;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}

createRoot(document.getElementById("root")!).render(<App />);
