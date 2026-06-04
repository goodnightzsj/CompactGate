import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { PROVIDER_LABELS, ROUTE_META, routeLabel, routeProvider } from "../shared/route-meta.js";
import type {
  ClaudeModelMap,
  ClaudeModelMapRole,
  CompactGateConfig,
  ConfigProfileScope,
  CredentialScope,
  CredentialSource,
  HostLogCount,
  HealthResponse,
  LogStatusKind,
  ProviderLogCounts,
  PublicConfig,
  RequestLogEntry,
  RequestLogPage,
  RouteKind,
  RoutePreviewResponse,
  StudioLogEvent,
  StudioSnapshotEvent,
  StatusLogCounts
} from "../shared/types.js";
import "./styles.css";

type SaveState = "idle" | "saving" | "saved" | "error";
type ThemeMode = "auto" | "light" | "dark";
type ProfileActionState =
  | "idle"
  | "saving"
  | "saved"
  | "updating"
  | "updated"
  | "duplicating"
  | "duplicated"
  | "deleting"
  | "deleted"
  | "applying"
  | "applied"
  | "error";

type ConfigFormState = {
  codexPrimaryBaseUrl: string;
  codexPrimaryApiKey: string;
  clearCodexPrimaryApiKey: boolean;
  codexCompactBaseUrl: string;
  codexCompactApiKey: string;
  clearCodexCompactApiKey: boolean;
  claudePrimaryBaseUrl: string;
  claudePrimaryApiKey: string;
  clearClaudePrimaryApiKey: boolean;
  claudeModelMap: ClaudeModelMap;
  claudeCompactBaseUrl: string;
  claudeCompactApiKey: string;
  clearClaudeCompactApiKey: boolean;
  claudeCompactModelOverride: string;
  claudeCompactUpstreamMode: "split" | "primary";
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
  count?: number;
  meta?: string;
  tone?: string;
}

type PublicRouteCredentialConfig =
  | PublicConfig["primary"]
  | PublicConfig["compact"]
  | PublicConfig["claude"]["primary"]
  | PublicConfig["claude"]["compact"];

type HealthRouteCredentialConfig =
  | HealthResponse["primary"]
  | HealthResponse["compact"]
  | HealthResponse["claude"]["primary"]
  | HealthResponse["claude"]["compact"];

type PublicConfigProfile = PublicConfig["profiles"][number];
type ProfileDeleteCandidate = { scope: ConfigProfileScope; profile: PublicConfigProfile };
type ClaudeModelsResponse = { models: string[]; upstream_host: string; error: string | null };

const DEFAULT_BODY = JSON.stringify({ model: "gpt-5.5", stream: true }, null, 2);
const ALL_HOSTS_FILTER = "__all_hosts__";
const ALL_STATUS_FILTER = "__all_status__";
const DEFAULT_LOG_PAGE_LIMIT = 200;
const TOKEN_TOOLTIP_WIDTH = 350;
const TOKEN_TOOLTIP_ESTIMATED_HEIGHT = 216;
const CLAUDE_MODEL_MAP_ROLES: ClaudeModelMapRole[] = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "reasoning",
  "subagent"
];
const CLAUDE_MODEL_MAP_META: Record<
  ClaudeModelMapRole,
  { label: string; source: string; hint: string; official: boolean }
> = {
  default: {
    label: "默认",
    source: "ANTHROPIC_MODEL / default / best",
    hint: "普通 Claude Code 会话和无法识别具体角色的请求都会落到这里。",
    official: true
  },
  opus: {
    label: "Opus 高能力",
    source: "ANTHROPIC_DEFAULT_OPUS_MODEL / opus / opusplan",
    hint: "用于高能力模型槽位，Plan Mode 的 Opus 路径也会优先匹配这里。",
    official: true
  },
  sonnet: {
    label: "Sonnet 均衡",
    source: "ANTHROPIC_DEFAULT_SONNET_MODEL / sonnet",
    hint: "用于 Claude Code 的均衡主力模型槽位。",
    official: true
  },
  haiku: {
    label: "Haiku 快速",
    source: "ANTHROPIC_DEFAULT_HAIKU_MODEL / haiku",
    hint: "用于小模型、快速任务和部分后台功能。",
    official: true
  },
  reasoning: {
    label: "推理",
    source: "ANTHROPIC_REASONING_MODEL",
    hint: "cc-switch 兼容槽位；官方 Claude Code 文档未把它列为标准环境变量。",
    official: false
  },
  subagent: {
    label: "子代理",
    source: "CLAUDE_CODE_SUBAGENT_MODEL / subagent",
    hint: "用于子代理和 agent teams；设置为 inherit 的场景建议留空。",
    official: true
  }
};

type StudioPage = "dashboard" | "routes" | "config" | "logs";

function detectPage(): "health" | StudioPage {
  if (window.location.pathname === "/health") return "health";
  const hash = window.location.hash.slice(1);
  if (hash === "routes" || hash === "config" || hash === "logs") return hash;
  return "dashboard";
}

function App() {
  const pageMode = detectPage();
  const healthMode = pageMode === "health";
  const [currentPage, setCurrentPage] = useState<StudioPage>(
    healthMode ? "dashboard" : pageMode as StudioPage
  );
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [logPage, setLogPage] = useState<RequestLogPage>(() => emptyLogPage(DEFAULT_LOG_PAGE_LIMIT));
  const [routeFilter, setRouteFilter] = useState<"all" | RouteKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | LogStatusKind>("all");
  const [hostFilter, setHostFilter] = useState(ALL_HOSTS_FILTER);
  const [form, setForm] = useState<ConfigFormState>(emptyForm());
  const [currentModel, setCurrentModel] = useState("gpt-5.5");
  const [previewPath, setPreviewPath] = useState("/v1/responses/compact");
  const [previewBody, setPreviewBody] = useState(DEFAULT_BODY);
  const [preview, setPreview] = useState<RoutePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [profileName, setProfileName] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileState, setProfileState] = useState<ProfileActionState>("idle");
  const [claudeProfileName, setClaudeProfileName] = useState("");
  const [selectedClaudeProfileId, setSelectedClaudeProfileId] = useState("");
  const [claudeProfileState, setClaudeProfileState] = useState<ProfileActionState>("idle");
  const [pageError, setPageError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [claudeProfileError, setClaudeProfileError] = useState<string | null>(null);
  const [profileDeleteCandidate, setProfileDeleteCandidate] = useState<ProfileDeleteCandidate | null>(null);
  const profileNameHydratedRef = useRef(false);
  const claudeProfileNameHydratedRef = useRef(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [isLoadingMoreLogs, setIsLoadingMoreLogs] = useState(false);
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [configTab, setConfigTab] = useState<"profiles" | "routes" | "model" | "preview">("profiles");

  const deferredFilter = useDeferredValue(routeFilter);
  const deferredStatusFilter = useDeferredValue(statusFilter);
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
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme() {
      const resolvedTheme = themeMode === "auto" ? (media.matches ? "dark" : "light") : themeMode;
      root.dataset.themeMode = themeMode;
      root.dataset.theme = resolvedTheme;
      root.style.colorScheme = resolvedTheme;
      window.localStorage.setItem("compactgate-theme-mode", themeMode);
    }

    applyTheme();

    if (themeMode !== "auto") {
      return undefined;
    }

    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode]);

  useEffect(() => {
    if (!config) {
      return;
    }

    const codexProfiles = profileScopeState(config, "codex").profiles;
    const claudeProfiles = profileScopeState(config, "claude").profiles;
    const activeCodexProfileId = profileScopeState(config, "codex").active_profile_id;
    const activeClaudeProfileId = profileScopeState(config, "claude").active_profile_id;

    setSelectedProfileId((previous) => {
      if (previous && codexProfiles.some((profile) => profile.id === previous)) {
        return previous;
      }

      return activeCodexProfileId ?? codexProfiles[0]?.id ?? "";
    });

    setSelectedClaudeProfileId((previous) => {
      if (previous && claudeProfiles.some((profile) => profile.id === previous)) {
        return previous;
      }

      return activeClaudeProfileId ?? claudeProfiles[0]?.id ?? "";
    });
  }, [config]);

  useEffect(() => {
    if (!config || profileNameHydratedRef.current) {
      return;
    }

    const scope = profileScopeState(config, "codex");
    const initialProfileId = scope.active_profile_id ?? scope.profiles[0]?.id ?? "";
    const initialProfile = scope.profiles.find((profile) => profile.id === initialProfileId);
    if (!initialProfile) {
      return;
    }

    profileNameHydratedRef.current = true;
    setSelectedProfileId(initialProfile.id);
    setProfileName(initialProfile.name);
  }, [config]);

  useEffect(() => {
    if (!config || claudeProfileNameHydratedRef.current) {
      return;
    }

    const scope = profileScopeState(config, "claude");
    const initialProfileId = scope.active_profile_id ?? scope.profiles[0]?.id ?? "";
    const initialProfile = scope.profiles.find((profile) => profile.id === initialProfileId);
    if (!initialProfile) {
      return;
    }

    claudeProfileNameHydratedRef.current = true;
    setSelectedClaudeProfileId(initialProfile.id);
    setClaudeProfileName(initialProfile.name);
  }, [config]);

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
    if (healthMode || !hasConfig) {
      return;
    }

    let cancelled = false;

    async function loadLogs() {
      setIsLoadingLogs(true);

      try {
        const nextPage = await fetchLogPage({
          route: deferredFilter,
          status: deferredStatusFilter,
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
  }, [deferredFilter, deferredStatusFilter, deferredHostFilter, hasConfig, logPageLimit, pageMode]);

  useEffect(() => {
    if (healthMode) {
      return;
    }

    if (typeof window.EventSource !== "function") {
      setLogError("当前浏览器不支持 SSE，已回退为轮询刷新。");
      const interval = window.setInterval(async () => {
        try {
          const nextPage = await fetchLogPage({
            route: deferredFilter,
            status: deferredStatusFilter,
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
        if (
          routeFilter === "all" &&
          statusFilter === "all" &&
          hostFilter === ALL_HOSTS_FILTER
        ) {
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
          mergeLiveLogPage(previous, payload.entry, routeFilter, statusFilter, hostFilter)
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
  }, [
    deferredFilter,
    deferredStatusFilter,
    deferredHostFilter,
    logPageLimit,
    routeFilter,
    statusFilter,
    hostFilter,
    pageMode
  ]);

  useEffect(() => {
    if (pageMode !== "health") {
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
    document.title = pageMode === "health" ? "CompactGate 健康检查" : "CompactGate 控制台";
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

  function scopedProfileAccessors(scope: ConfigProfileScope) {
    return scope === "codex"
      ? {
          name: profileName,
          selectedId: selectedProfileId,
          setName: setProfileName,
          setSelectedId: setSelectedProfileId,
          state: profileState,
          setState: setProfileState,
          setError: setProfileError
        }
      : {
          name: claudeProfileName,
          selectedId: selectedClaudeProfileId,
          setName: setClaudeProfileName,
          setSelectedId: setSelectedClaudeProfileId,
          state: claudeProfileState,
          setState: setClaudeProfileState,
          setError: setClaudeProfileError
        };
  }

  async function saveConfigProfile(scope: ConfigProfileScope = "codex") {
    const accessors = scopedProfileAccessors(scope);
    const trimmedName = accessors.name.trim();
    if (!trimmedName) {
      accessors.setState("error");
      accessors.setError("请先填写配置档案名称。");
      return;
    }

    accessors.setState("saving");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "POST",
        body: JSON.stringify({
          scope,
          name: trimmedName,
          config: formToPatch(form)
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const savedProfile = [...nextScope.profiles]
        .reverse()
        .find((profile) => profile.name === trimmedName);

      setConfig(nextConfig);
      accessors.setSelectedId(savedProfile?.id ?? nextScope.active_profile_id ?? "");
      accessors.setName(savedProfile?.name ?? trimmedName);
      accessors.setState("saved");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  async function applySelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    if (!targetProfileId) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    accessors.setState("applying");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles/apply", {
        method: "POST",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId
        })
      });
      const nextHealth = await api<HealthResponse>("/api/health", {
        method: "GET"
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const nextActiveProfileId = nextScope.active_profile_id ?? targetProfileId;

      setConfig(nextConfig);
      setHealth(nextHealth);
      setForm(formFromConfig(nextConfig));
      accessors.setSelectedId(nextActiveProfileId);
      accessors.setName(nextScope.profiles.find((profile) => profile.id === nextActiveProfileId)?.name ?? "");
      setSaveError(null);
      setSaveState("saved");
      accessors.setState("applied");
      window.setTimeout(() => {
        setSaveState("idle");
        accessors.setState("idle");
      }, 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  async function updateSelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    if (!targetProfileId) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    const scopeState = config ? profileScopeState(config, scope) : null;
    const currentProfile = scopeState?.profiles.find((profile) => profile.id === targetProfileId) ?? null;
    const trimmedName = targetProfileId === accessors.selectedId ? accessors.name.trim() : currentProfile?.name ?? "";
    accessors.setState("updating");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "PATCH",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId,
          ...(trimmedName ? { name: trimmedName } : {}),
          config: formToPatch(form)
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);

      setConfig(nextConfig);
      accessors.setSelectedId(targetProfileId);
      accessors.setName(nextScope.profiles.find((profile) => profile.id === targetProfileId)?.name ?? trimmedName);
      accessors.setState("updated");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  async function duplicateSelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    const scopeState = config ? profileScopeState(config, scope) : null;
    const sourceProfile = scopeState?.profiles.find((profile) => profile.id === targetProfileId) ?? null;
    if (!sourceProfile) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    const copyName = targetProfileId === accessors.selectedId && accessors.name.trim()
      ? accessors.name.trim()
      : `${sourceProfile.name} copy`;
    accessors.setState("duplicating");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles/duplicate", {
        method: "POST",
        body: JSON.stringify({
          scope,
          profile_id: targetProfileId,
          name: copyName
        })
      });
      const nextScope = profileScopeState(nextConfig, scope);
      const copiedProfile = [...nextScope.profiles]
        .reverse()
        .find((profile) => profile.name === copyName);

      setConfig(nextConfig);
      accessors.setSelectedId(copiedProfile?.id ?? targetProfileId);
      accessors.setName(copiedProfile?.name ?? copyName);
      accessors.setState("duplicated");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  function requestDeleteSelectedProfile(scope: ConfigProfileScope = "codex", profileId?: string) {
    const accessors = scopedProfileAccessors(scope);
    const targetProfileId = profileId ?? accessors.selectedId;
    if (!targetProfileId) {
      accessors.setState("error");
      accessors.setError("请先选择一个已保存的配置档案。");
      return;
    }

    const profile = config ? profileScopeState(config, scope).profiles.find((item) => item.id === targetProfileId) : null;
    if (!profile) {
      accessors.setState("error");
      accessors.setError("没有找到要删除的配置档案。");
      return;
    }

    accessors.setSelectedId(profile.id);
    accessors.setError(null);
    setProfileDeleteCandidate({ scope, profile });
  }

  async function confirmDeleteSelectedProfile() {
    const candidate = profileDeleteCandidate;
    if (!candidate) {
      return;
    }

    const accessors = scopedProfileAccessors(candidate.scope);
    accessors.setState("deleting");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles", {
        method: "DELETE",
        body: JSON.stringify({
          scope: candidate.scope,
          profile_id: candidate.profile.id
        })
      });
      const nextScope = profileScopeState(nextConfig, candidate.scope);

      setConfig(nextConfig);
      const nextSelectedProfileId = nextScope.active_profile_id ?? nextScope.profiles[0]?.id ?? "";
      accessors.setSelectedId(nextSelectedProfileId);
      accessors.setName(nextScope.profiles.find((item) => item.id === nextSelectedProfileId)?.name ?? "");
      setProfileDeleteCandidate(null);
      accessors.setState("deleted");
      window.setTimeout(() => accessors.setState("idle"), 1600);
    } catch (error) {
      accessors.setState("error");
      accessors.setError(errorSummary(error));
    }
  }

  function selectConfigProfile(scope: ConfigProfileScope, profileId: string) {
    const accessors = scopedProfileAccessors(scope);
    const profile = config ? profileScopeState(config, scope).profiles.find((item) => item.id === profileId) : null;
    accessors.setSelectedId(profileId);
    accessors.setError(null);

    if (profile && profileId !== accessors.selectedId) {
      accessors.setName(profile.name);
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
        status: statusFilter,
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

  function navigateTo(page: StudioPage) {
    setCurrentPage(page);
    window.history.replaceState(null, "", page === "dashboard" ? "/" : `/#${page}`);
  }

  if (healthMode) {
    return (
      <div className="app-shell">
        <StudioSidebar currentPage="dashboard" onNavigate={navigateTo} health={health} themeMode={themeMode} onThemeModeChange={setThemeMode} />
        <main className="main-content">
          <HealthPage health={health} error={pageError} isRefreshing={isRefreshingHealth} onRefresh={refreshHealth} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <StudioSidebar currentPage={currentPage} onNavigate={navigateTo} health={health} themeMode={themeMode} onThemeModeChange={setThemeMode} />

      <main className="main-content">
        {pageError && <div className="error-banner">{pageError}</div>}

        {currentPage === "dashboard" && (
          <DashboardPage
            config={config}
            health={health}
            logs={logs}
            logCounts={logCounts}
            providerCounts={logPage.provider_counts}
            saveState={saveState}
            hasPendingChanges={hasPendingChanges}
            onExport={exportConfig}
          />
        )}

        {currentPage === "routes" && (
          <RoutesPage
            config={config}
            currentModel={currentModel}
            compactModel={effectiveCompactModel}
            compactMode={form.upstreamMode}
            claudeCompactMode={form.claudeCompactUpstreamMode}
            activeRoute={activeRoute}
            latestLog={latestLog}
          />
        )}

        {currentPage === "config" && (
          <ConfigPage
            config={config}
            form={form}
            currentModel={currentModel}
            linkedCompactModel={linkedCompactModel}
            saveState={saveState}
            saveError={saveError}
            profileName={profileName}
            selectedProfileId={selectedProfileId}
            profileState={profileState}
            profileError={profileError}
            claudeProfileName={claudeProfileName}
            selectedClaudeProfileId={selectedClaudeProfileId}
            claudeProfileState={claudeProfileState}
            claudeProfileError={claudeProfileError}
            hasPendingChanges={hasPendingChanges}
            previewPath={previewPath}
            previewBody={previewBody}
            preview={preview}
            previewError={previewError}
            configTab={configTab}
            onConfigTabChange={setConfigTab}
            onCurrentModelChange={setCurrentModel}
            onFormChange={setForm}
            onProfileNameChange={setProfileName}
            onClaudeProfileNameChange={setClaudeProfileName}
            onSelectedProfileChange={selectConfigProfile}
            onSaveProfile={saveConfigProfile}
            onApplyProfile={applySelectedProfile}
            onUpdateProfile={updateSelectedProfile}
            onDuplicateProfile={duplicateSelectedProfile}
            onDeleteProfile={requestDeleteSelectedProfile}
            onUnlockCompactModel={unlockCompactModel}
            onRestoreLinkedMode={restoreLinkedMode}
            onPathChange={setPreviewPath}
            onBodyChange={setPreviewBody}
            onPreviewSubmit={previewRoute}
            onSaveConfig={saveConfig}
          />
        )}

        {currentPage === "logs" && (
          <LogsPage
            logs={logs}
            logCounts={logCounts}
            providerCounts={logPage.provider_counts}
            statusCounts={logPage.status_counts}
            totalLogCount={logPage.total}
            allLogCount={logPage.all_total}
            hostOptions={hostOptions}
            hasMoreLogs={logPage.has_more}
            isLoadingLogs={isLoadingLogs}
            isLoadingMoreLogs={isLoadingMoreLogs}
            routeFilter={routeFilter}
            statusFilter={statusFilter}
            hostFilter={hostFilter}
            onRouteFilterChange={setRouteFilter}
            onStatusFilterChange={setStatusFilter}
            onHostFilterChange={setHostFilter}
            onLoadMore={loadMoreLogs}
            error={logError}
          />
        )}
      </main>

      {profileDeleteCandidate && (
        <ConfirmProfileDeleteDialog
          profile={profileDeleteCandidate.profile}
          isDeleting={(profileDeleteCandidate.scope === "codex" ? profileState : claudeProfileState) === "deleting"}
          onCancel={() => setProfileDeleteCandidate(null)}
          onConfirm={confirmDeleteSelectedProfile}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Sidebar
   ═══════════════════════════════════════════════════ */
function StudioSidebar({
  currentPage,
  onNavigate,
  health,
  themeMode,
  onThemeModeChange
}: {
  currentPage: StudioPage;
  onNavigate: (page: StudioPage) => void;
  health: HealthResponse | null;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const primaryStatus = upstreamHealthBadge(health?.primary);
  const compactStatus = upstreamHealthBadge(health?.compact);
  const claudePrimaryStatus = upstreamHealthBadge(health?.claude?.primary);

  const navItems: Array<{ page: StudioPage; label: string; icon: string }> = [
    { page: "dashboard", label: "总览", icon: "◇" },
    { page: "routes", label: "路由", icon: "⇢" },
    { page: "config", label: "配置", icon: "⚙" },
    { page: "logs", label: "日志", icon: "☰" }
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-mark">CG</div>
        <h1>CompactGate</h1>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.page}
            className={`sidebar-nav-item ${currentPage === item.page ? "is-active" : ""}`}
            onClick={() => onNavigate(item.page)}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-health">
          <div className="sidebar-health-row">
            <span className={`sidebar-health-dot is-${primaryStatus.tone}`} />
            Codex 主路由
          </div>
          <div className="sidebar-health-row">
            <span className={`sidebar-health-dot is-${compactStatus.tone}`} />
            Codex 压缩
          </div>
          <div className="sidebar-health-row">
            <span className={`sidebar-health-dot is-${claudePrimaryStatus.tone}`} />
            Claude 主路由
          </div>
        </div>

        <div className="theme-switch">
          {(["auto", "light", "dark"] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              className={themeMode === mode ? "is-active" : ""}
              onClick={() => onThemeModeChange(mode)}
            >
              {mode === "auto" ? "自动" : mode === "light" ? "浅色" : "深色"}
            </button>
          ))}
        </div>

        <a className="btn btn-sm btn-ghost" href="/health" style={{ width: "100%", justifyContent: "center" }}>
          健康检查
        </a>
      </div>
    </aside>
  );
}

/* ═══════════════════════════════════════════════════
   Dashboard Page
   ═══════════════════════════════════════════════════ */
function DashboardPage({
  config,
  health,
  logs,
  logCounts,
  providerCounts,
  saveState,
  hasPendingChanges,
  onExport
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  logs: RequestLogEntry[];
  logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts;
  saveState: SaveState;
  hasPendingChanges: boolean;
  onExport: () => void | Promise<void>;
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";
  const primaryHost = config?.primary.host ?? "-";
  const compactHost = config?.compact.host ?? "-";
  const claudeHost = config?.claude.primary.host ?? "-";
  const codexPrimaryOk = upstreamHealthBadge(health?.primary).tone === "good";
  const codexCompactOk = upstreamHealthBadge(health?.compact).tone === "good";
  const claudeOk = upstreamHealthBadge(health?.claude?.primary).tone === "good";

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">总览</p>
          <h2>CompactGate 控制台</h2>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span className="status-pill is-good">监听 {listen}</span>
          <span className="status-pill">
            {saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}
          </span>
          <button className="btn btn-sm" onClick={() => void onExport()}>导出配置</button>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="stat-card">
          <div className="stat-card-label">服务端点</div>
          <div className="endpoint-display">
            <span className="route-chip codex">OpenAI</span>
            <code>http://{listen}/v1</code>
          </div>
          <div className="endpoint-display">
            <span className="route-chip claude">Claude</span>
            <code>http://{listen}/anthropic</code>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-label">最近流量</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginTop: 12 }}>
            <div>
              <div className="stat-card-value">{logCounts.primary}</div>
              <div className="stat-card-meta">Codex 主路由</div>
            </div>
            <div>
              <div className="stat-card-value">{logCounts.compact}</div>
              <div className="stat-card-meta">Compact 压缩</div>
            </div>
            <div>
              <div className="stat-card-value">{logCounts.claude}</div>
              <div className="stat-card-meta">Claude 路由</div>
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-label">上游状态</div>
          <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--ink)" }}>Codex 主路由</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", color: "var(--muted)" }}>{primaryHost}</span>
              <span className={`status-pill ${codexPrimaryOk ? "is-good" : "is-warn"}`}>{codexPrimaryOk ? "正常" : "异常"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--ink)" }}>Codex 压缩</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", color: "var(--muted)" }}>{compactHost}</span>
              <span className={`status-pill ${codexCompactOk ? "is-good" : "is-warn"}`}>{codexCompactOk ? "正常" : "异常"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--ink)" }}>Claude 主路由</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", color: "var(--muted)" }}>{claudeHost}</span>
              <span className={`status-pill ${claudeOk ? "is-good" : "is-warn"}`}>{claudeOk ? "正常" : "异常"}</span>
            </div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-label">Provider 汇总</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
            <div>
              <div className="stat-card-value">{providerCounts.openai}</div>
              <div className="stat-card-meta">Codex / OpenAI</div>
            </div>
            <div>
              <div className="stat-card-value">{providerCounts.claude}</div>
              <div className="stat-card-meta">Claude</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>最近请求</h3>
          <span className="status-pill">{logs.length} 条</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty-state">
            <strong>暂无请求记录</strong>
            <span>将 Codex 的 base_url 设置为 http://{listen}/v1 即可看到实时流量。</span>
          </div>
        ) : (
          <div className="log-table">
            <div className="log-table-body" style={{ maxHeight: "300px" }}>
              {logs.slice(0, 8).map((entry, i) => (
                <div key={i} className="log-row">
                  <span className="log-cell-time">{formatDateTime(entry.time)}</span>
                  <span className="log-cell-model">{entry.source_model ?? "-"}</span>
                  <span className={`log-status ${entry.status < 400 ? "is-ok" : "is-err"}`}>{entry.status}</span>
                  <span className="log-cell-code">{entry.upstream_host}</span>
                  <span className="log-cell-code">{entry.endpoint}</span>
                  <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                  <span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span>
                  <span className="log-cell-time">{formatDurationMs(entry.duration_ms)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════
   Routes Page
   ═══════════════════════════════════════════════════ */
function RoutesPage({
  config,
  currentModel,
  compactModel,
  compactMode,
  claudeCompactMode,
  activeRoute,
  latestLog
}: {
  config: PublicConfig | null;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  claudeCompactMode: "split" | "primary";
  activeRoute: RouteKind;
  latestLog: RequestLogEntry | null;
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";
  const primaryHost = config?.primary.host ?? "primary.example";
  const compactHost = config?.compact.host ?? "compact.example";
  const claudePrimaryHost = config?.claude.primary.host ?? "api.anthropic.com";
  const claudeCompactHost = config?.claude.compact.host ?? "api.anthropic.com";
  const compactTarget = compactMode === "split" ? compactHost : primaryHost;
  const claudeCompactTarget = claudeCompactMode === "split" ? claudeCompactHost : claudePrimaryHost;

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">路由规则</p>
          <h2>分流逻辑</h2>
        </div>
        <span className="status-pill">
          最近命中: {formatLatestLogStatus(latestLog, "等待请求")}
        </span>
      </div>

      <div className="routes-layout">
        <div className="route-rule codex">
          <span className="route-chip codex" style={{ marginBottom: 8 }}>Codex 通道</span>
          <h3>OpenAI 兼容入口</h3>
          <p>请求目标：<code>http://{listen}/v1</code></p>

          <div className="route-mapping">
            <div className={`route-mapping-row ${activeRoute === "compact" ? "is-active" : ""}`}>
              <code>/v1/responses/compact</code>
              <span className="tag">命中</span>
              <span className="route-chip compact">压缩上游</span>
            </div>
            <div className={`route-mapping-row ${activeRoute === "primary" ? "is-active" : ""}`}>
              <code>其它 /v1/*</code>
              <span className="tag">默认</span>
              <span className="route-chip codex">主上游</span>
            </div>
          </div>

          <div className="route-slot-info">
            <div className="route-slot">
              <div className="route-slot-label">主路由</div>
              <div className="route-slot-host">{primaryHost}</div>
              <div className="route-slot-hint">普通请求直通</div>
            </div>
            <div className="route-slot">
              <div className="route-slot-label">压缩路由</div>
              <div className="route-slot-host">{compactTarget}</div>
              <div className="route-slot-hint">{compactMode === "split" ? "独立基础地址与密钥" : "复用主路由"}</div>
            </div>
          </div>

          <div className="route-model-strip" style={{ marginTop: 14, padding: "8px 12px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--ink)" }}>
            模型映射：{currentModel} → {compactModel}
          </div>
        </div>

        <div className="route-rule claude">
          <span className="route-chip claude" style={{ marginBottom: 8 }}>Claude 通道</span>
          <h3>Anthropic 兼容入口</h3>
          <p>请求目标：<code>http://{listen}/anthropic</code></p>

          <div className="route-mapping">
            <div className={`route-mapping-row ${activeRoute === "claude" ? "is-active" : ""}`}>
              <code>普通 /messages</code>
              <span className="tag">默认</span>
              <span className="route-chip claude">主上游</span>
            </div>
            <div className="route-mapping-row">
              <code>手动 compact</code>
              <span className="tag">授权后</span>
              <span className="route-chip compact">压缩上游</span>
            </div>
          </div>

          <div className="route-slot-info">
            <div className="route-slot">
              <div className="route-slot-label">主路由</div>
              <div className="route-slot-host">{claudePrimaryHost}</div>
              <div className="route-slot-hint">Messages 与未授权 compact</div>
            </div>
            <div className="route-slot">
              <div className="route-slot-label">压缩路由</div>
              <div className="route-slot-host">{claudeCompactTarget}</div>
              <div className="route-slot-hint">{claudeCompactMode === "split" ? "独立手动 compact 上游" : "复用主路由"}</div>
            </div>
          </div>

          <div style={{ marginTop: 14, padding: "10px 12px", background: "var(--jade-soft)", borderRadius: "var(--radius-sm)", fontSize: "0.76rem", color: "var(--muted)", lineHeight: 1.6 }}>
            仅在 AnyRouter reconnect_count ≥ 3 时授权下一次手动 compact 走压缩路由。授权消费后回到主路由。
          </div>
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════
   Config Page
   ═══════════════════════════════════════════════════ */
function ConfigPage({
  config, form, currentModel, linkedCompactModel, saveState, saveError,
  profileName, selectedProfileId, profileState, profileError,
  claudeProfileName, selectedClaudeProfileId, claudeProfileState, claudeProfileError,
  hasPendingChanges, previewPath, previewBody, preview, previewError, configTab,
  onConfigTabChange, onCurrentModelChange, onFormChange,
  onProfileNameChange, onClaudeProfileNameChange, onSelectedProfileChange,
  onSaveProfile, onApplyProfile, onUpdateProfile, onDuplicateProfile, onDeleteProfile,
  onUnlockCompactModel, onRestoreLinkedMode,
  onPathChange, onBodyChange, onPreviewSubmit, onSaveConfig
}: {
  config: PublicConfig | null; form: ConfigFormState; currentModel: string;
  linkedCompactModel: string; saveState: SaveState; saveError: string | null;
  profileName: string; selectedProfileId: string; profileState: ProfileActionState;
  profileError: string | null; claudeProfileName: string; selectedClaudeProfileId: string;
  claudeProfileState: ProfileActionState; claudeProfileError: string | null;
  hasPendingChanges: boolean; previewPath: string; previewBody: string;
  preview: RoutePreviewResponse | null; previewError: string | null; configTab: ConfigTab;
  onConfigTabChange: (tab: ConfigTab) => void;
  onCurrentModelChange: (m: string) => void;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onProfileNameChange: (n: string) => void;
  onClaudeProfileNameChange: (n: string) => void;
  onSelectedProfileChange: (s: ConfigProfileScope, id: string) => void;
  onSaveProfile: (s: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (s: ConfigProfileScope, id?: string) => void | Promise<void>;
  onUpdateProfile: (s: ConfigProfileScope, id?: string) => void | Promise<void>;
  onDuplicateProfile: (s: ConfigProfileScope, id?: string) => void | Promise<void>;
  onDeleteProfile: (s: ConfigProfileScope, id?: string) => void | Promise<void>;
  onUnlockCompactModel: () => void; onRestoreLinkedMode: () => void;
  onPathChange: (p: string) => void; onBodyChange: (b: string) => void;
  onPreviewSubmit: (e: React.FormEvent) => void;
  onSaveConfig: (e: React.FormEvent) => void;
}) {
  const CONFIG_TABS: Array<{ id: ConfigTab; label: string }> = [
    { id: "profiles", label: "档案" },
    { id: "routes", label: "路由" },
    { id: "model", label: "模型" },
    { id: "preview", label: "预览" }
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">配置管理</p>
          <h2>配置管理</h2>
        </div>
        <span className={`status-pill ${hasPendingChanges ? "is-warn" : ""}`}>
          {saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}
        </span>
      </div>

      <div className="config-layout">
        <div className="config-section">
          <div className="tab-bar">
            {CONFIG_TABS.map((tab) => (
              <button
                key={tab.id}
                className={configTab === tab.id ? "is-active" : ""}
                onClick={() => onConfigTabChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {configTab === "profiles" && (
            <div style={{ display: "grid", gap: 16 }}>
              <ProfileScopeCard
                scope="codex" title="Codex 配置档案" eyebrow="Codex"
                description="保存、复制或应用 Codex 主路由与 compact 草稿，不会改动 Claude 档案。"
                emptyTitle="还没有保存的 Codex 档案"
                emptyDescription="填写名称后保存当前 Codex 草稿，就会在这里出现可应用的档案卡片。"
                config={config}
                profileName={profileName} selectedProfileId={selectedProfileId}
                profileState={profileState} profileError={profileError}
                onProfileNameChange={onProfileNameChange}
                onSelectedProfileChange={onSelectedProfileChange}
                onSaveProfile={onSaveProfile} onApplyProfile={onApplyProfile}
                onUpdateProfile={onUpdateProfile} onDuplicateProfile={onDuplicateProfile}
                onDeleteProfile={onDeleteProfile}
              />
              <ProfileScopeCard
                scope="claude" title="Claude 配置档案" eyebrow="Claude"
                description="保存、复制或应用 Claude 主路由 / 压缩路由草稿，不会改动 Codex 档案。"
                emptyTitle="还没有保存的 Claude 档案"
                emptyDescription="填写名称后保存当前 Claude 草稿，就会在这里出现可应用的档案卡片。"
                config={config}
                profileName={claudeProfileName} selectedProfileId={selectedClaudeProfileId}
                profileState={claudeProfileState} profileError={claudeProfileError}
                onProfileNameChange={onClaudeProfileNameChange}
                onSelectedProfileChange={onSelectedProfileChange}
                onSaveProfile={onSaveProfile} onApplyProfile={onApplyProfile}
                onUpdateProfile={onUpdateProfile} onDuplicateProfile={onDuplicateProfile}
                onDeleteProfile={onDeleteProfile}
              />
            </div>
          )}

          {configTab === "routes" && (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="config-row">
                <RouteCredentialFields
                  title="Codex 主路由" badge="Codex" tone="primary"
                  baseUrlLabel="基础地址" baseUrlHint="普通 /v1 请求会转发到这里。"
                  apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 主路由", config?.primary ?? null)}
                  baseUrl={form.codexPrimaryBaseUrl} apiKey={form.codexPrimaryApiKey}
                  storedApiKey={config?.primary.stored_api_key ?? false}
                  clearApiKey={form.clearCodexPrimaryApiKey}
                  onBaseUrlChange={(v) => onFormChange((p) => ({ ...p, codexPrimaryBaseUrl: v }))}
                  onApiKeyChange={(v) => onFormChange((p) => ({ ...p, codexPrimaryApiKey: v, clearCodexPrimaryApiKey: false }))}
                  onToggleClearApiKey={() => onFormChange((p) => ({ ...p, codexPrimaryApiKey: "", clearCodexPrimaryApiKey: !p.clearCodexPrimaryApiKey }))}
                />
                <RouteCredentialFields
                  title="Codex 压缩路由" badge="压缩" tone="compact"
                  baseUrlLabel="基础地址" baseUrlHint={form.upstreamMode === "split" ? "Codex 压缩请求会转发到这里。" : "当前复用 Codex 主路由。"}
                  apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Codex 压缩路由", config?.compact ?? null)}
                  baseUrl={form.codexCompactBaseUrl} apiKey={form.codexCompactApiKey}
                  storedApiKey={config?.compact.stored_api_key ?? false}
                  clearApiKey={form.clearCodexCompactApiKey}
                  onBaseUrlChange={(v) => onFormChange((p) => ({ ...p, codexCompactBaseUrl: v }))}
                  onApiKeyChange={(v) => onFormChange((p) => ({ ...p, codexCompactApiKey: v, clearCodexCompactApiKey: false }))}
                  onToggleClearApiKey={() => onFormChange((p) => ({ ...p, codexCompactApiKey: "", clearCodexCompactApiKey: !p.clearCodexCompactApiKey }))}
                />
              </div>
              <div className="config-row">
                <RouteCredentialFields
                  title="Claude 主路由" badge="Claude" tone="claude"
                  baseUrlLabel="基础地址" baseUrlHint="普通 Claude Code Messages 请求会转发到这里。"
                  apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Claude 主路由", config?.claude.primary ?? null)}
                  baseUrl={form.claudePrimaryBaseUrl} apiKey={form.claudePrimaryApiKey}
                  storedApiKey={config?.claude.primary.stored_api_key ?? false}
                  clearApiKey={form.clearClaudePrimaryApiKey}
                  onBaseUrlChange={(v) => onFormChange((p) => ({ ...p, claudePrimaryBaseUrl: v }))}
                  onApiKeyChange={(v) => onFormChange((p) => ({ ...p, claudePrimaryApiKey: v, clearClaudePrimaryApiKey: false }))}
                  onToggleClearApiKey={() => onFormChange((p) => ({ ...p, claudePrimaryApiKey: "", clearClaudePrimaryApiKey: !p.clearClaudePrimaryApiKey }))}
                />
                <RouteCredentialFields
                  title="Claude 压缩路由" badge="压缩" tone="compact"
                  baseUrlLabel="基础地址" baseUrlHint="仅在 AnyRouter 大 reconnect 请求授权后使用。"
                  apiKeyLabel="访问密钥" apiKeyHint={directApiKeyHint("Claude 压缩路由", config?.claude.compact ?? null)}
                  baseUrl={form.claudeCompactBaseUrl} apiKey={form.claudeCompactApiKey}
                  storedApiKey={config?.claude.compact.stored_api_key ?? false}
                  clearApiKey={form.clearClaudeCompactApiKey}
                  onBaseUrlChange={(v) => onFormChange((p) => ({ ...p, claudeCompactBaseUrl: v }))}
                  onApiKeyChange={(v) => onFormChange((p) => ({ ...p, claudeCompactApiKey: v, clearClaudeCompactApiKey: false }))}
                  onToggleClearApiKey={() => onFormChange((p) => ({ ...p, claudeCompactApiKey: "", clearClaudeCompactApiKey: !p.clearClaudeCompactApiKey }))}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>Codex 压缩上游模式</div>
                  <div className="toggle-group">
                    <button className={form.upstreamMode === "split" ? "is-active" : ""} onClick={() => onFormChange((p) => ({ ...p, upstreamMode: "split" }))}>独立分流</button>
                    <button className={form.upstreamMode === "primary" ? "is-active" : ""} onClick={() => onFormChange((p) => ({ ...p, upstreamMode: "primary" }))}>复用主路由</button>
                  </div>
                </div>
                <div>
                  <div className="field-label" style={{ marginBottom: 4 }}>Claude 压缩上游模式</div>
                  <div className="toggle-group">
                    <button className={form.claudeCompactUpstreamMode === "split" ? "is-active" : ""} onClick={() => onFormChange((p) => ({ ...p, claudeCompactUpstreamMode: "split" }))}>独立分流</button>
                    <button className={form.claudeCompactUpstreamMode === "primary" ? "is-active" : ""} onClick={() => onFormChange((p) => ({ ...p, claudeCompactUpstreamMode: "primary" }))}>复用主路由</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {configTab === "model" && (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="field">
                <span className="field-label">当前 Codex 模型</span>
                <input className="input" value={currentModel} onChange={(e) => onCurrentModelChange(e.target.value)} spellCheck={false} />
                <span className="field-hint">可手动输入，也会从最近一次请求体自动学习。</span>
              </div>
              <ClaudeModelMapEditor
                modelMap={form.claudeModelMap}
                onModelMapChange={(role, value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudeModelMap: {
                      ...previous.claudeModelMap,
                      [role]: value
                    }
                  }))
                }
              />
              <div>
                <div className="field-label" style={{ marginBottom: 4 }}>压缩模型模式</div>
                <div className="toggle-group" style={{ marginBottom: 8 }}>
                  <button type="button" className={form.modelMode === "linked" ? "is-active" : ""} onClick={onRestoreLinkedMode}>自动联动</button>
                  <button type="button" className={form.modelMode === "custom" ? "is-active" : ""} onClick={onUnlockCompactModel}>手动指定</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                  <input
                    className="input"
                    value={form.modelMode === "linked" ? linkedCompactModel : form.modelOverride}
                    readOnly={form.modelMode === "linked"}
                    onChange={(e) => onFormChange((p) => ({ ...p, modelOverride: e.target.value }))}
                    spellCheck={false}
                  />
                  <button type="button" className="btn btn-sm" onClick={form.modelMode === "linked" ? onUnlockCompactModel : onRestoreLinkedMode}>
                    {form.modelMode === "linked" ? "解锁" : "恢复联动"}
                  </button>
                </div>
              </div>
              <div className="field">
                <span className="field-label">压缩模型联动模板</span>
                <input className="input" value={form.modelTemplate} onChange={(e) => onFormChange((p) => ({ ...p, modelTemplate: e.target.value }))} spellCheck={false} />
                <span className="field-hint">{`{model}`} 会被替换为请求中的原始模型名。</span>
              </div>
            </div>
          )}

          {configTab === "preview" && (
            <div style={{ display: "grid", gap: 12 }}>
              <div className="field">
                <span className="field-label">请求路径</span>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses")}>普通响应</button>
                  <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses/compact")}>压缩响应</button>
                </div>
                <input className="input" value={previewPath} onChange={(e) => onPathChange(e.target.value)} />
              </div>
              <div className="field">
                <span className="field-label">JSON 请求体</span>
                <textarea className="textarea" value={previewBody} onChange={(e) => onBodyChange(e.target.value)} rows={4} spellCheck={false} style={{ resize: "vertical" }} />
              </div>
              {previewError && <div className="error-banner">{previewError}</div>}
              <button className="btn btn-primary" onClick={onPreviewSubmit}>预览路由</button>
              {preview && (
                <div style={{ padding: "12px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: "0.8rem" }}>
                  <div><span className="field-hint">路由</span><div><span className={`route-chip ${preview.route}`}>{routeLabel(preview.route)}</span></div></div>
                  <div><span className="field-hint">上游</span><div style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>{preview.upstream_host}</div></div>
                  <div><span className="field-hint">原始模型</span><div><code>{preview.source_model ?? "-"}</code></div></div>
                  <div><span className="field-hint">目标模型</span><div><code>{preview.target_model ?? "-"}</code></div></div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          {saveError && <div className="error-banner" style={{ flex: 1 }}>{saveError}</div>}
          <button className="btn btn-primary" disabled={saveState === "saving"} onClick={onSaveConfig}>
            {saveButtonLabel(saveState, hasPendingChanges)}
          </button>
        </div>
      </div>
    </>
  );
}

function ClaudeModelMapEditor({
  modelMap,
  onModelMapChange
}: {
  modelMap: ClaudeModelMap;
  onModelMapChange: (role: ClaudeModelMapRole, value: string) => void;
}) {
  const inputIdPrefix = useId();
  const [models, setModels] = useState<string[]>([]);
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [fetchMeta, setFetchMeta] = useState<string | null>(null);

  async function fetchModels() {
    setFetchState("loading");
    setFetchMeta(null);

    try {
      const payload = await api<ClaudeModelsResponse>("/api/claude/models");
      setModels(payload.models);
      setFetchState(payload.error ? "error" : "loaded");
      setFetchMeta(
        payload.error
          ? `${payload.upstream_host}: ${payload.error}`
          : payload.models.length > 0
            ? `已从 ${payload.upstream_host} 读取 ${payload.models.length} 个模型。`
            : `${payload.upstream_host} 没有返回可用模型。`
      );
    } catch (error) {
      setFetchState("error");
      const message = errorSummary(error);
      setFetchMeta(
        message === "API endpoint not found."
          ? "后端模型接口尚未加载，请重启 CompactGate 服务后重试。"
          : message
      );
    }
  }

  const normalizedModelMap = normalizeClaudeModelMap(modelMap);
  const filledCount = CLAUDE_MODEL_MAP_ROLES.filter((role) => normalizedModelMap[role].trim().length > 0).length;
  const fallbackModel = normalizedModelMap.default.trim();
  const modelOptions = buildClaudeModelOptions(models);

  return (
    <section className="claude-model-map-card" aria-labelledby="claude-model-map-title">
      <div className="claude-model-map-head">
        <div>
          <p className="eyebrow">Claude 模型映射</p>
          <h3 id="claude-model-map-title">Claude 角色模型映射</h3>
          <p>
            切换 Claude 配置档案时，这里会覆盖普通会话、Opus、Sonnet、Haiku、推理和子代理的目标模型。
            未识别的请求会回退到默认槽位。
          </p>
        </div>
        <div className="claude-model-map-actions">
          <span className="map-counter">{filledCount}/6 已设置</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={fetchState === "loading"}
            onClick={() => void fetchModels()}
          >
            {fetchState === "loading" ? "读取中..." : "拉取模型"}
          </button>
        </div>
      </div>

      {fetchMeta && (
        <p className={`model-fetch-note ${fetchState === "error" ? "is-error" : ""}`}>{fetchMeta}</p>
      )}

      <div className="claude-model-map-grid">
        {CLAUDE_MODEL_MAP_ROLES.map((role) => {
          const meta = CLAUDE_MODEL_MAP_META[role];
          const value = normalizedModelMap[role];
          const inheritsDefault = role !== "default" && value.trim().length === 0 && fallbackModel.length > 0;
          const selectValue = models.includes(value) ? value : CUSTOM_MODEL_OPTION_VALUE;
          const inputId = `${inputIdPrefix}-${role}`;

          return (
            <div key={role} className={`claude-model-map-row ${role === "default" ? "is-default" : ""}`}>
              <span className="model-role-cell">
                <label htmlFor={inputId}>{meta.label}</label>
                <small>{meta.source}</small>
              </span>
              <span className="model-kind-cell">
                <span className={`tag ${meta.official ? "" : "is-compat"}`}>
                  {meta.official ? "官方" : "兼容"}
                </span>
                {inheritsDefault && <span className="tag is-fallback">回退默认</span>}
              </span>
              <div className="model-control-cell">
                <input
                  id={inputId}
                  aria-label={`Claude ${meta.label} 模型`}
                  className="input"
                  value={value}
                  placeholder={role === "default" ? "例如 claude-sonnet-4-6" : fallbackModel || "留空则使用默认槽位"}
                  onChange={(event) => onModelMapChange(role, event.target.value)}
                  spellCheck={false}
                />
                <CustomSelect
                  label="候选模型"
                  value={selectValue}
                  options={modelOptions}
                  onChange={(nextModel) => {
                    if (nextModel !== CUSTOM_MODEL_OPTION_VALUE) {
                      onModelMapChange(role, nextModel);
                    }
                  }}
                  disabled={models.length === 0}
                  compact
                  wide
                />
              </div>
              <small className="model-row-hint">{meta.hint}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const CUSTOM_MODEL_OPTION_VALUE = "__custom_model__";

function buildClaudeModelOptions(models: string[]): SelectOption[] {
  return [
    {
      value: CUSTOM_MODEL_OPTION_VALUE,
      label: models.length > 0 ? "手动输入" : "拉取后选择",
      meta: models.length > 0 ? "保留当前手动填写值" : "先点击上方“拉取模型”"
    },
    ...models.map((model) => ({
      value: model,
      label: model,
      meta: "来自当前 Claude 上游"
    }))
  ];
}

/* ═══════════════════════════════════════════════════
   Logs Page
   ═══════════════════════════════════════════════════ */
function LogsPage({
  logs, logCounts, providerCounts, statusCounts, totalLogCount, allLogCount,
  hostOptions, hasMoreLogs, isLoadingLogs, isLoadingMoreLogs,
  routeFilter, statusFilter, hostFilter,
  onRouteFilterChange, onStatusFilterChange, onHostFilterChange, onLoadMore, error
}: {
  logs: RequestLogEntry[]; logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts; statusCounts: StatusLogCounts;
  totalLogCount: number; allLogCount: number; hostOptions: HostFilterOption[];
  hasMoreLogs: boolean; isLoadingLogs: boolean; isLoadingMoreLogs: boolean;
  routeFilter: "all" | RouteKind; statusFilter: "all" | LogStatusKind; hostFilter: string;
  onRouteFilterChange: (r: "all" | RouteKind) => void;
  onStatusFilterChange: (s: "all" | LogStatusKind) => void;
  onHostFilterChange: (h: string) => void;
  onLoadMore: () => void; error: string | null;
}) {
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">流量日志</p>
          <h2>请求日志</h2>
        </div>
        <span className="status-pill">
          显示 {logs.length} / 共 {totalLogCount} 条 · 已存储 {allLogCount} 条
        </span>
      </div>

      <div className="logs-toolbar">
        <CustomSelect
          label="通道"
          value={routeFilter}
          options={[
            { value: "all", label: "全部通道", count: logCounts.all },
            { value: "primary", label: "Codex 主路由", count: logCounts.primary, meta: "primary", tone: "codex" },
            { value: "compact", label: "Compact 压缩", count: logCounts.compact, meta: "compact", tone: "compact" },
            { value: "claude", label: "Claude 路由", count: logCounts.claude, meta: "claude", tone: "claude" }
          ]}
          onChange={(v) => onRouteFilterChange(v as "all" | RouteKind)}
        />
        <CustomSelect
          label="状态"
          value={statusFilter}
          options={[
            { value: "all", label: "全部", count: statusCounts.all },
            { value: "normal", label: "正常", count: statusCounts.normal, tone: "is-ok" },
            { value: "error", label: "错误", count: statusCounts.error, tone: "is-err" }
          ]}
          onChange={(v) => onStatusFilterChange(v as "all" | LogStatusKind)}
        />
        <CustomSelect
          label="上游 Host"
          value={hostFilter}
          options={[
            { value: "__all_hosts__", label: "全部上游", count: allLogCount },
            ...hostOptions.map((h) => ({ value: h.host, label: h.host, count: h.total }))
          ]}
          onChange={onHostFilterChange}
        />
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
          <span className="route-chip codex">{PROVIDER_LABELS.openai}: {providerCounts.openai}</span>
          <span className="route-chip claude">{PROVIDER_LABELS.claude}: {providerCounts.claude}</span>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {isLoadingLogs && logs.length === 0 ? (
        <div className="empty-state"><strong>正在加载日志...</strong></div>
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <strong>暂无请求记录</strong>
          <span>将 Codex base_url 指向代理地址后，这里会实时出现路由记录。</span>
        </div>
      ) : (
        <div className="log-table">
          <div className="log-table-header">
            <span>时间</span><span>模型 / 通道</span><span>状态</span>
            <span>模型 / 思考</span><span>上游 Host</span><span>端点</span>
            <span>类型</span><span>User Agent</span><span>Token</span>
            <span>首 Token</span><span>耗时</span>
          </div>
          <div className="log-table-body">
            {logs.map((entry, i) => {
              const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
              const hasRewrite = Boolean(entry.source_model && entry.target_model && entry.source_model !== entry.target_model);
              const hasError = Boolean(entry.error_summary) || entry.status >= 400;
              return (
              <React.Fragment key={`${entry.request_id}-${i}`}>
                <div
                  className={`log-row ${hasHiddenLogDetails(entry) ? "is-clickable" : ""} ${hasError ? "has-error" : ""}`}
                  onClick={() => hasHiddenLogDetails(entry) && setExpandedRow(expandedRow === i ? null : i)}
                >
                  <span className="log-cell-time">{formatDateTime(entry.time)}</span>
                  <span className="log-model-cell" title={modelMapping}>
                    <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                    <strong>{entry.source_model ?? "-"}</strong>
                    {hasRewrite && <small>→ {entry.target_model}</small>}
                  </span>
                  <span className={`log-status ${entry.status < 400 ? "is-ok" : "is-err"}`}>{entry.status}</span>
                  <span className="log-cell-code" title={modelReasoningLabel(entry)}>{modelReasoningLabel(entry)}</span>
                  <span className="log-cell-code">{entry.upstream_host}</span>
                  <span className="log-cell-code">{entry.endpoint}</span>
                  <span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span>
                  <span className="log-cell-code" title={entry.user_agent ?? ""} style={{ fontSize: "0.68rem" }}>{(entry.user_agent ?? "-").slice(0, 20)}</span>
                  <TokenTooltip entry={entry} />
                  <span className="log-cell-time">{formatDurationMs(entry.first_token_ms)}</span>
                  <span className="log-cell-time">{formatDurationMs(entry.duration_ms)}</span>
                </div>
                {expandedRow === i && (
                  <div className="log-detail-panel">
                    <div className="log-detail-item">
                      <span className="log-detail-label">请求</span>
                      <span className="log-detail-value">{entry.method} {entry.path}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">请求 ID</span>
                      <span className="log-detail-value" style={{ fontSize: "0.7rem" }}>{entry.request_id}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">模型映射</span>
                      <span className="log-detail-value" style={{ fontSize: "0.74rem" }}>{modelMapping}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">上游 / 端点</span>
                      <span className="log-detail-value">{entry.upstream_host}{entry.endpoint}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">状态 / 类型</span>
                      <span className="log-detail-value">{entry.status} / {entry.request_type}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">首 Token / 耗时</span>
                      <span className="log-detail-value">{formatDurationMs(entry.first_token_ms)} / {formatDurationMs(entry.duration_ms)}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">请求摘要</span>
                      <span className="log-detail-value" style={{ fontSize: "0.72rem" }}>{entry.request_summary ?? "无"}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">推理强度</span>
                      <span className="log-detail-value" style={{ fontSize: "0.72rem" }}>{entry.reasoning_effort ?? "无"}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">User Agent</span>
                      <span className="log-detail-value" style={{ fontSize: "0.68rem" }}>{entry.user_agent ?? "-"}</span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">错误信息</span>
                      <span className="log-detail-value">{entry.error_summary ?? "无"}</span>
                    </div>
                    <div className="log-detail-item" style={{ gridColumn: "span 2" }}>
                      <span className="log-detail-label">Token 明细</span>
                      <span className="log-detail-value">
                        输入 {formatMetricNumber(entry.input_tokens)} · 输出 {formatMetricNumber(entry.output_tokens)} · 缓存 {formatMetricNumber(entry.cached_input_tokens)} · 总计 {formatMetricNumber(displayTotalTokens(entry))}
                      </span>
                    </div>
                    <div className="log-detail-item">
                      <span className="log-detail-label">采样时间</span>
                      <span className="log-detail-value" style={{ fontSize: "0.74rem" }}>{entry.time}</span>
                    </div>
                  </div>
                )}
              </React.Fragment>
            )})}
          </div>
        </div>
      )}

      {hasMoreLogs && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button className="btn" onClick={onLoadMore} disabled={isLoadingMoreLogs}>
            {isLoadingMoreLogs ? "加载中..." : `加载更多 (${logs.length}/${totalLogCount})`}
          </button>
        </div>
      )}
    </>
  );
}

function ConfirmProfileDeleteDialog({
  profile,
  isDeleting,
  onCancel,
  onConfirm
}: {
  profile: PublicConfigProfile;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return createPortal(
    <div className="confirm-overlay" role="presentation">
      <section
        className="confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-profile-delete-title"
        aria-describedby="confirm-profile-delete-desc"
      >
        <span className="confirm-icon" aria-hidden="true">!</span>
        <div className="confirm-copy">
          <p className="eyebrow">Delete Profile</p>
          <h2 id="confirm-profile-delete-title">删除配置档案“{profile.name}”？</h2>
          <p id="confirm-profile-delete-desc">
            这个操作只会删除 CompactGate 内保存的档案，不会删除当前运行时配置，也不会改动全局 Claude 或 Codex 配置文件。
          </p>
        </div>
        <div className="confirm-actions">
          <button className="ghost-button" type="button" disabled={isDeleting} onClick={onCancel}>
            取消
          </button>
          <button
            className="solid-button danger-solid-button"
            type="button"
            disabled={isDeleting}
            onClick={() => void onConfirm()}
          >
            {isDeleting ? "删除中..." : "确认删除"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

function CommandDeck({
  config,
  activeRoute,
  logs
}: {
  config: PublicConfig | null;
  activeRoute: RouteKind;
  logs: RequestLogEntry[];
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";
  const compactHits = logs.filter((entry) => entry.route === "compact").length;
  const primaryHits = logs.filter((entry) => entry.route === "primary").length;
  const claudeHits = logs.filter((entry) => entry.route === "claude").length;

  return (
    <section className={`command-deck operator-ribbon route-${activeRoute}`} aria-labelledby="command-deck-title">
      <div className="ribbon-title">
        <p className="eyebrow">Operator Workspace</p>
        <h2 id="command-deck-title">CompactGate</h2>
      </div>

      <div className="ribbon-endpoints" aria-label="Local proxy endpoints">
        <div className="endpoint-tile">
          <span>OpenAI</span>
          <code>http://{listen}/v1</code>
        </div>
        <div className="endpoint-tile is-claude">
          <span>Claude</span>
          <code>http://{listen}/anthropic</code>
        </div>
      </div>

      <div className="ribbon-traffic" aria-label="Recent traffic counters">
        <div className="traffic-chip tone-primary">
          <span>codex</span>
          <strong>{primaryHits}</strong>
        </div>
        <div className="traffic-chip tone-compact">
          <span>compact</span>
          <strong>{compactHits}</strong>
        </div>
        <div className="traffic-chip tone-claude">
          <span>claude</span>
          <strong>{claudeHits}</strong>
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
  tone: "primary" | "compact" | "claude" | HealthTone;
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
  themeMode,
  onThemeModeChange,
  onExport,
  activeRoute,
  logs
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  saveState: SaveState;
  hasPendingChanges: boolean;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  onExport: () => void | Promise<void>;
  activeRoute: RouteKind;
  logs: RequestLogEntry[];
}) {
  const primaryStatus = upstreamHealthBadge(health?.primary);
  const compactStatus = upstreamHealthBadge(health?.compact);
  const listen = config?.listen ?? "127.0.0.1:7865";
  const compactHits = logs.filter((entry) => entry.route === "compact").length;
  const primaryHits = logs.filter((entry) => entry.route === "primary").length;
  const claudeHits = logs.filter((entry) => entry.route === "claude").length;

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="mark" aria-hidden="true">CG</div>
        <div>
          <p className="eyebrow">CompactGate Studio</p>
          <h1>Codex Compact 控制台</h1>
        </div>
      </div>

      <div className="topbar-endpoints" aria-label="Local proxy endpoints">
        <div className="endpoint-chip">
          <span>OpenAI</span>
          <code>http://{listen}/v1</code>
        </div>
        <div className="endpoint-chip is-claude">
          <span>Claude</span>
          <code>http://{listen}/anthropic</code>
        </div>
      </div>

      <div className="topbar-traffic" aria-label="Recent traffic">
        <span className="traffic-dot tone-primary">{primaryHits}</span>
        <span className="traffic-dot tone-compact">{compactHits}</span>
        <span className="traffic-dot tone-claude">{claudeHits}</span>
      </div>

      <div className="status-strip" aria-label="CompactGate 状态">
        <StatusPill label="Codex 主" status={primaryStatus} />
        <StatusPill label="Codex 压缩" status={compactStatus} />
        <span className={`save-meter ${hasPendingChanges ? "is-dirty" : ""}`}>
          {saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}
        </span>
      </div>

      <div className="toolbar">
        <ThemeModeSwitch value={themeMode} onChange={onThemeModeChange} />
        <a className="ghost-button" href="/health">健康检查</a>
        <button className="ghost-button" type="button" onClick={() => void onExport()}>导出配置</button>
        <a className="ghost-button" href="#logs-title">查看日志</a>
      </div>
    </header>
  );
}

function ThemeModeSwitch({
  value,
  onChange
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  const options: Array<{ value: ThemeMode; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" }
  ];

  return (
    <div className="theme-switch" role="group" aria-label="主题模式">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "is-selected" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type ConfigTab = "profiles" | "routes" | "model" | "preview";

const CONFIG_TABS: Array<{ id: ConfigTab; label: string }> = [
  { id: "profiles", label: "Profiles" },
  { id: "routes", label: "Routes" },
  { id: "model", label: "Model" },
  { id: "preview", label: "Preview" }
];

function ConfigDashboard({
  configTab,
  onConfigTabChange,
  config,
  form,
  currentModel,
  linkedCompactModel,
  saveState,
  saveError,
  profileName,
  selectedProfileId,
  profileState,
  profileError,
  claudeProfileName,
  selectedClaudeProfileId,
  claudeProfileState,
  claudeProfileError,
  hasPendingChanges,
  previewPath,
  previewBody,
  preview,
  previewError,
  onCurrentModelChange,
  onFormChange,
  onProfileNameChange,
  onClaudeProfileNameChange,
  onSelectedProfileChange,
  onSaveProfile,
  onApplyProfile,
  onUpdateProfile,
  onDuplicateProfile,
  onDeleteProfile,
  onUnlockCompactModel,
  onRestoreLinkedMode,
  onPathChange,
  onBodyChange,
  onPreviewSubmit,
  onSaveConfig
}: {
  configTab: ConfigTab;
  onConfigTabChange: (tab: ConfigTab) => void;
  config: PublicConfig | null;
  form: ConfigFormState;
  currentModel: string;
  linkedCompactModel: string;
  saveState: SaveState;
  saveError: string | null;
  profileName: string;
  selectedProfileId: string;
  profileState: ProfileActionState;
  profileError: string | null;
  claudeProfileName: string;
  selectedClaudeProfileId: string;
  claudeProfileState: ProfileActionState;
  claudeProfileError: string | null;
  hasPendingChanges: boolean;
  previewPath: string;
  previewBody: string;
  preview: RoutePreviewResponse | null;
  previewError: string | null;
  onCurrentModelChange: (model: string) => void;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onProfileNameChange: (name: string) => void;
  onClaudeProfileNameChange: (name: string) => void;
  onSelectedProfileChange: (scope: ConfigProfileScope, profileId: string) => void;
  onSaveProfile: (scope: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUnlockCompactModel: () => void;
  onRestoreLinkedMode: () => void;
  onPathChange: (path: string) => void;
  onBodyChange: (body: string) => void;
  onPreviewSubmit: (event: React.FormEvent) => void;
  onSaveConfig: (event: React.FormEvent) => void;
}) {
  return (
    <section className="panel config-dashboard" aria-labelledby="config-dashboard-title">
      <div className="section-heading">
        <p className="eyebrow">Live Config</p>
        <h2 id="config-dashboard-title">Configuration</h2>
      </div>

      <div className="config-tab-bar" role="tablist" aria-label="Config sections">
        {CONFIG_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={configTab === tab.id}
            className={`config-tab ${configTab === tab.id ? "is-active" : ""}`}
            onClick={() => onConfigTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="config-tab-content">
        {configTab === "profiles" && (
          <div className="control-stack">
            <ProfileScopeCard
              scope="codex"
              title="Codex 配置档案"
              eyebrow="Codex Profiles"
              description="保存、复制或应用 Codex 主路由与 compact 草稿；不会改动 Claude 档案。"
              emptyTitle="还没有保存的 Codex 档案"
              emptyDescription="填写名称后保存当前 Codex 草稿，就会在这里出现可应用的档案卡片。"
              config={config}
              profileName={profileName}
              selectedProfileId={selectedProfileId}
              profileState={profileState}
              profileError={profileError}
              onProfileNameChange={onProfileNameChange}
              onSelectedProfileChange={onSelectedProfileChange}
              onSaveProfile={onSaveProfile}
              onApplyProfile={onApplyProfile}
              onUpdateProfile={onUpdateProfile}
              onDuplicateProfile={onDuplicateProfile}
              onDeleteProfile={onDeleteProfile}
            />
            <ProfileScopeCard
              scope="claude"
              title="Claude 配置档案"
              eyebrow="Claude Profiles"
              description="保存、复制或应用 Claude primary / compact 草稿；不会改动 Codex 档案。"
              emptyTitle="还没有保存的 Claude 档案"
              emptyDescription="填写名称后保存当前 Claude 草稿，就会在这里出现可应用的档案卡片。"
              config={config}
              profileName={claudeProfileName}
              selectedProfileId={selectedClaudeProfileId}
              profileState={claudeProfileState}
              profileError={claudeProfileError}
              onProfileNameChange={onClaudeProfileNameChange}
              onSelectedProfileChange={onSelectedProfileChange}
              onSaveProfile={onSaveProfile}
              onApplyProfile={onApplyProfile}
              onUpdateProfile={onUpdateProfile}
              onDuplicateProfile={onDuplicateProfile}
              onDeleteProfile={onDeleteProfile}
            />
          </div>
        )}

        {configTab === "routes" && (
          <div className="control-stack">
            <div className="route-config-grid">
              <section className="route-config-group" aria-labelledby="codex-route-config-title">
                <div className="route-config-group-head">
                  <span className="route-chip primary">Codex</span>
                  <div>
                    <h3 id="codex-route-config-title">Codex 路由</h3>
                    <p>普通请求走主路由；compact 路径按模式分流。</p>
                  </div>
                </div>
                <div className="route-config-cards">
                  <RouteCredentialFields
                    title="Codex 主路由" badge="主" tone="primary"
                    baseUrlLabel="Codex 主路由 Base URL"
                    baseUrlHint="普通 /v1 请求会转发到这里。"
                    apiKeyLabel="Codex 主路由 API Key"
                    apiKeyHint={form.clearCodexPrimaryApiKey ? "保存后会删除当前已保存的 Codex 主路由密钥。" : directApiKeyHint("Codex 主路由", config?.primary ?? null)}
                    baseUrl={form.codexPrimaryBaseUrl} apiKey={form.codexPrimaryApiKey}
                    storedApiKey={config?.primary.stored_api_key ?? false}
                    clearApiKey={form.clearCodexPrimaryApiKey}
                    onBaseUrlChange={(value) => onFormChange((p) => ({ ...p, codexPrimaryBaseUrl: value }))}
                    onApiKeyChange={(value) => onFormChange((p) => ({ ...p, codexPrimaryApiKey: value, clearCodexPrimaryApiKey: false }))}
                    onToggleClearApiKey={() => onFormChange((p) => ({ ...p, codexPrimaryApiKey: "", clearCodexPrimaryApiKey: !p.clearCodexPrimaryApiKey }))}
                  />
                  <RouteCredentialFields
                    title="Codex 压缩路由" badge="压缩" tone="compact"
                    baseUrlLabel="Codex 压缩路由 Base URL"
                    baseUrlHint={form.upstreamMode === "split" ? "Codex compact 请求会转发到这里。" : "当前复用 Codex 主路由，这个地址会保留但暂不参与转发。"}
                    apiKeyLabel="Codex 压缩路由 API Key"
                    apiKeyHint={form.clearCodexCompactApiKey ? "保存后会删除当前已保存的 Codex 压缩路由密钥。" : form.upstreamMode === "split" ? directApiKeyHint("Codex 压缩路由", config?.compact ?? null) : "当前 Codex compact 请求复用主路由认证；这里的密钥会在切回独立分流后生效。"}
                    baseUrl={form.codexCompactBaseUrl} apiKey={form.codexCompactApiKey}
                    storedApiKey={config?.compact.stored_api_key ?? false}
                    clearApiKey={form.clearCodexCompactApiKey}
                    onBaseUrlChange={(value) => onFormChange((p) => ({ ...p, codexCompactBaseUrl: value }))}
                    onApiKeyChange={(value) => onFormChange((p) => ({ ...p, codexCompactApiKey: value, clearCodexCompactApiKey: false }))}
                    onToggleClearApiKey={() => onFormChange((p) => ({ ...p, codexCompactApiKey: "", clearCodexCompactApiKey: !p.clearCodexCompactApiKey }))}
                  />
                </div>
              </section>

              <section className="route-config-group" aria-labelledby="claude-route-config-title">
                <div className="route-config-group-head">
                  <span className="route-chip claude">Claude</span>
                  <div>
                    <h3 id="claude-route-config-title">Claude 路由</h3>
                    <p>Messages 走主路由；只有已授权的下一次手动 compact 才使用压缩路由。</p>
                  </div>
                </div>
                <div className="route-config-cards">
                  <RouteCredentialFields
                    title="Claude 主路由" badge="主" tone="claude"
                    baseUrlLabel="Claude 主路由 Base URL"
                    baseUrlHint="普通 Claude Code Messages 请求会转发到这里。"
                    apiKeyLabel="Claude 主路由 API Key"
                    apiKeyHint={form.clearClaudePrimaryApiKey ? "保存后会删除当前已保存的 Claude 主路由密钥。" : directApiKeyHint("Claude 主路由", config?.claude.primary ?? null)}
                    baseUrl={form.claudePrimaryBaseUrl} apiKey={form.claudePrimaryApiKey}
                    storedApiKey={config?.claude.primary.stored_api_key ?? false}
                    clearApiKey={form.clearClaudePrimaryApiKey}
                    onBaseUrlChange={(value) => onFormChange((p) => ({ ...p, claudePrimaryBaseUrl: value }))}
                    onApiKeyChange={(value) => onFormChange((p) => ({ ...p, claudePrimaryApiKey: value, clearClaudePrimaryApiKey: false }))}
                    onToggleClearApiKey={() => onFormChange((p) => ({ ...p, claudePrimaryApiKey: "", clearClaudePrimaryApiKey: !p.clearClaudePrimaryApiKey }))}
                  />
                  <RouteCredentialFields
                    title="Claude 压缩路由" badge="压缩" tone="compact"
                    baseUrlLabel="Claude 压缩路由 Base URL"
                    baseUrlHint={form.claudeCompactUpstreamMode === "split" ? "仅在 AnyRouter 大 reconnect 请求授权后，用于下一次手动 compact。" : "当前复用 Claude 主路由，这个地址会保留但暂不参与手动 compact 分流。"}
                    apiKeyLabel="Claude 压缩路由 API Key"
                    apiKeyHint={form.clearClaudeCompactApiKey ? "保存后会删除当前已保存的 Claude 压缩路由密钥。" : form.claudeCompactUpstreamMode === "split" ? directApiKeyHint("Claude 压缩路由", config?.claude.compact ?? null) : "当前 Claude compact 分流复用主路由认证；这里的密钥会在切回独立分流后生效。"}
                    baseUrl={form.claudeCompactBaseUrl} apiKey={form.claudeCompactApiKey}
                    storedApiKey={config?.claude.compact.stored_api_key ?? false}
                    clearApiKey={form.clearClaudeCompactApiKey}
                    onBaseUrlChange={(value) => onFormChange((p) => ({ ...p, claudeCompactBaseUrl: value }))}
                    onApiKeyChange={(value) => onFormChange((p) => ({ ...p, claudeCompactApiKey: value, clearClaudeCompactApiKey: false }))}
                    onToggleClearApiKey={() => onFormChange((p) => ({ ...p, claudeCompactApiKey: "", clearClaudeCompactApiKey: !p.clearClaudeCompactApiKey }))}
                  />
                  <section className="route-config-card tone-compact" aria-label="Claude 手动 compact 模型">
                    <div className="route-config-card-head">
                      <h4>Claude 手动 compact 模型</h4>
                      <span className="route-chip compact">可选</span>
                    </div>
                    <Field label="Claude 手动 compact 模型" hint="留空会把原请求模型透传给 compact 上游；填写后只改被授权的手动 compact 请求。">
                      <input aria-label="Claude 手动 compact 模型" value={form.claudeCompactModelOverride} placeholder={config?.claude.compact.model_override || "例如 claude-sonnet-4-6"} onChange={(e) => onFormChange((p) => ({ ...p, claudeCompactModelOverride: e.target.value }))} spellCheck={false} />
                    </Field>
                  </section>
                </div>
              </section>
            </div>

            <div className="mode-card">
              <div>
                <span className="mode-card-title">Codex Compact 上游模式</span>
                <p>{form.upstreamMode === "split" ? "独立分流：" : "复用主上游："}<code>/v1/responses/compact</code>{form.upstreamMode === "split" ? " 使用 Codex 压缩路由 Base URL 与 API Key。" : " 直接发送到 Codex 主路由，并复用 Codex 主路由密钥。"}</p>
              </div>
              <div className="mode-switch" role="group" aria-label="Codex Compact 上游模式">
                <button className={form.upstreamMode === "split" ? "is-selected" : ""} type="button" aria-pressed={form.upstreamMode === "split"} onClick={() => onFormChange((p) => ({ ...p, upstreamMode: "split" }))}>独立分流</button>
                <button className={form.upstreamMode === "primary" ? "is-selected" : ""} type="button" aria-pressed={form.upstreamMode === "primary"} onClick={() => onFormChange((p) => ({ ...p, upstreamMode: "primary" }))}>复用主上游</button>
              </div>
            </div>

            <div className="mode-card">
              <div>
                <span className="mode-card-title">Claude Compact 上游模式</span>
                <p>{form.claudeCompactUpstreamMode === "split" ? "独立分流：" : "复用主上游："}已授权的手动 compact 请求{form.claudeCompactUpstreamMode === "split" ? " 使用 Claude 压缩路由 Base URL 与 API Key。" : " 发送到 Claude 主路由，并复用 Claude 主路由密钥。"}</p>
              </div>
              <div className="mode-switch" role="group" aria-label="Claude Compact 上游模式">
                <button type="button" className={form.claudeCompactUpstreamMode === "split" ? "is-selected" : ""} aria-pressed={form.claudeCompactUpstreamMode === "split"} onClick={() => onFormChange((p) => ({ ...p, claudeCompactUpstreamMode: "split" }))}>独立分流</button>
                <button type="button" className={form.claudeCompactUpstreamMode === "primary" ? "is-selected" : ""} aria-pressed={form.claudeCompactUpstreamMode === "primary"} onClick={() => onFormChange((p) => ({ ...p, claudeCompactUpstreamMode: "primary" }))}>复用主上游</button>
              </div>
            </div>
          </div>
        )}

        {configTab === "model" && (
          <div className="control-stack">
            <Field label="当前 Codex 模型" hint="可手动输入，也会从最近一次请求 body 里自动学习。">
              <input aria-label="当前 Codex 模型" value={currentModel} onChange={(e) => onCurrentModelChange(e.target.value)} spellCheck={false} />
            </Field>

            <div className="mode-card compact-model-card">
              <div>
                <span className="mode-card-title">Compact 模型模式</span>
                <p>{form.modelMode === "linked" ? "自动联动当前模型，并套用模板生成 compact 模型。" : "手动覆盖 compact 模型，当前模型变化时不会自动同步。"}</p>
              </div>
              <div className="mode-switch" role="group" aria-label="Compact 模型模式">
                <button className={form.modelMode === "linked" ? "is-selected" : ""} type="button" aria-pressed={form.modelMode === "linked"} onClick={onRestoreLinkedMode}>自动联动</button>
                <button className={form.modelMode === "custom" ? "is-selected" : ""} type="button" aria-pressed={form.modelMode === "custom"} onClick={onUnlockCompactModel}>手动指定</button>
              </div>
            </div>

            <Field label="Compact 模型" hint="自动联动时这里是只读预览。">
              <div className="compound-input">
                <input aria-label="Compact 模型" value={form.modelMode === "linked" ? linkedCompactModel : form.modelOverride} readOnly={form.modelMode === "linked"} onChange={(e) => onFormChange((p) => ({ ...p, modelOverride: e.target.value }))} spellCheck={false} />
                {form.modelMode === "linked" ? <button type="button" onClick={onUnlockCompactModel}>解锁</button> : <button type="button" onClick={onRestoreLinkedMode}>恢复联动</button>}
              </div>
            </Field>

            {form.modelMode === "custom" && <p className="inline-warning">Compact 模型已手动覆盖。如果 Codex 切换模型后希望自动推导，请恢复自动联动。</p>}

            <Field label="联动模板" hint="{model} 会被替换为请求里的原始模型名。">
              <input aria-label="联动模板" value={form.modelTemplate} onChange={(e) => onFormChange((p) => ({ ...p, modelTemplate: e.target.value }))} spellCheck={false} />
            </Field>
          </div>
        )}

        {configTab === "preview" && (
          <div className="control-stack">
            <Field label="请求路径" hint="常用路径或手动输入。">
              <div className="path-presets">
                <button type="button" onClick={() => onPathChange("/v1/responses")}>普通响应</button>
                <button type="button" onClick={() => onPathChange("/v1/responses/compact")}>Compact</button>
              </div>
              <input aria-label="请求路径" value={previewPath} onChange={(e) => onPathChange(e.target.value)} />
            </Field>
            <Field label="JSON Body" hint="只填 model / stream 即可。">
              <textarea aria-label="JSON Body" value={previewBody} onChange={(e) => onBodyChange(e.target.value)} rows={4} spellCheck={false} />
            </Field>
            {previewError && <p className="error-note">{previewError}</p>}
            <button className="preview-button" type="button" onClick={onPreviewSubmit}>预览路由</button>

            <div className={`preview-readout ${preview ? `route-${preview.route}` : ""}`} aria-live="polite">
              {preview ? (
                <>
                  <dl>
                    <div><dt>命中通道</dt><dd><span className={`route-chip ${preview.route}`}>{routeLabel(preview.route)}</span></dd></div>
                    <div><dt>目标上游</dt><dd>{preview.upstream_host}</dd></div>
                    <div><dt>来源模型</dt><dd><code>{preview.source_model ?? "无"}</code></dd></div>
                    <div><dt>最终模型</dt><dd><code>{preview.target_model ?? "无"}</code></dd></div>
                  </dl>
                  <p>Body 改写：{preview.body_rewritten ? "是" : "否"} · 移除 stream：{preview.stream_removed ? "是" : "否"}</p>
                </>
              ) : (
                <p>预览会显示通道、上游、模型与 stream 处理。</p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="config-dashboard-footer">
        {saveError && <p className="error-note">{saveError}</p>}
        <button className="apply-button" type="button" disabled={saveState === "saving"} onClick={onSaveConfig}>
          {saveButtonLabel(saveState, hasPendingChanges)}
        </button>
      </div>
    </section>
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
            <p className="eyebrow">CompactGate 健康检查</p>
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
          <p className="eyebrow">实时监控</p>
          <h2 id="health-title">一页看清 CompactGate 是否已经准备好接流量。</h2>
          <p>
            这个页面专门显示监听地址、上游地址合法性和密钥注入状态，适合本地联调或快速排障。
          </p>
          <div className="health-hero-actions">
            <a className="ghost-button" href="/api/health" target="_blank" rel="noreferrer">
              查看原始响应
            </a>
            <a className="ghost-button" href="/">
              进入控制台
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
          title="Codex 主路由"
          route="primary"
          credentialScope="primary"
          badgeLabel="Codex 主"
          summary="处理普通 OpenAI 兼容 /v1 请求"
          upstream={health?.primary}
        />
        <HealthEndpointCard
          title="Codex 压缩路由"
          route="compact"
          credentialScope="compact"
          badgeLabel="Codex 压缩"
          summary="处理 /v1/responses/compact"
          upstream={health?.compact}
        />
        <HealthEndpointCard
          title="Claude 主路由"
          route="claude"
          credentialScope="claude_primary"
          badgeLabel="Claude 主"
          summary="处理普通 Anthropic Messages 请求"
          upstream={health?.claude.primary}
        />
          <HealthEndpointCard
            title="Claude 压缩路由"
            route="compact"
            credentialScope="claude_compact"
            badgeLabel="Claude 压缩"
            summary="仅用于已授权的下一次手动 compact"
            upstream={health?.claude.compact}
          />
      </section>

      <section className="health-detail-grid">
        <section className="panel health-notes" aria-labelledby="health-notes-title">
          <div className="section-heading">
            <p className="eyebrow">检查清单</p>
            <h2 id="health-notes-title">如何判断现在能不能接请求</h2>
          </div>

          <div className="health-checklist">
            <div className="health-check-row">
              <span>1</span>
              <p>监听地址可见，说明代理进程已经启动并绑定到本地端口。</p>
            </div>
            <div className="health-check-row">
              <span>2</span>
              <p>上游状态显示“已配置”，说明基础地址格式合法。</p>
            </div>
            <div className="health-check-row">
              <span>3</span>
              <p>如果显示“缺密钥”，代理仍能启动，但转发前需要先在控制台里直接保存访问密钥，或依赖旧配置里的环境变量回退。</p>
            </div>
          </div>
        </section>

        <section className="panel health-json-panel" aria-labelledby="health-json-title">
          <div className="section-heading">
            <p className="eyebrow">响应内容</p>
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
  credentialScope,
  badgeLabel,
  summary,
  upstream
}: {
  title: string;
  route: RouteKind;
  credentialScope: CredentialScope;
  badgeLabel: string;
  summary: string;
  upstream: HealthRouteCredentialConfig | null | undefined;
}) {
  const status = upstreamHealthBadge(upstream);

  return (
    <section className={`panel health-card route-${route}`} aria-label={`${title} 状态`}>
      <div className="health-card-head">
        <div>
          <p className="eyebrow">{title}</p>
          <h2>{upstream?.host ?? "等待健康数据"}</h2>
        </div>
        <span className={`route-chip ${route}`}>{badgeLabel}</span>
      </div>

      <p className="health-card-copy">{summary}</p>

      <div className="health-kv-grid">
        <div className="health-kv">
          <span>状态</span>
          <strong>{status.label}</strong>
        </div>
        <div className="health-kv">
          <span>基础地址</span>
          <strong>{upstream?.base_url ?? "读取中..."}</strong>
        </div>
        <div className="health-kv">
          <span>主机</span>
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
          <strong>{activeCredentialLabel(credentialScope, upstream)}</strong>
        </div>
      </div>

      <div className={`health-flag ${upstream?.api_key_configured ? "is-good" : "is-warn"}`}>
        <span className="health-led" aria-hidden="true" />
        {credentialFlagCopy(credentialScope, upstream)}
      </div>
    </section>
  );
}

function RouteBoard({
  config,
  currentModel,
  compactModel,
  compactMode,
  claudeCompactMode,
  activeRoute,
  latestLog
}: {
  config: PublicConfig | null;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  claudeCompactMode: "split" | "primary";
  activeRoute: RouteKind;
  latestLog: RequestLogEntry | null;
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";
  const primaryHost = config?.primary.host ?? "primary.example";
  const compactHost = config?.compact.host ?? "compact.example";
  const compactTarget = compactMode === "split" ? compactHost : primaryHost;
  const claudePrimaryHost = config?.claude.primary.host ?? "api.anthropic.com";
  const claudeCompactHost = config?.claude.compact.host ?? "api.anthropic.com";
  const claudeCompactTarget = claudeCompactMode === "split" ? claudeCompactHost : claudePrimaryHost;

  return (
    <section className={`route-board is-${activeRoute}`} aria-labelledby="route-board-title">
      <div className="section-heading">
        <p className="eyebrow">Route Board</p>
        <h2 id="route-board-title">运行时分流规则，而不是页面筛选器。</h2>
      </div>

      <div className="route-switchboard" aria-label="CompactGate 分流规则">
        <article className="route-rule-card codex-rule">
          <div className="route-rule-card-head">
            <span className="route-chip primary">Codex</span>
            <div>
              <h3>Codex / OpenAI 兼容入口</h3>
              <p>
                客户端指向 <code>http://{listen}/v1</code>。代理只根据路径判断，不读取页面筛选器状态。
              </p>
            </div>
          </div>

          <div className="route-rule-list">
            <div className={`route-rule-row ${activeRoute === "compact" ? "is-active" : ""}`}>
              <code>/v1/responses/compact</code>
              <span>命中</span>
              <strong>Codex 压缩槽位</strong>
            </div>
            <div className={`route-rule-row ${activeRoute === "primary" ? "is-active" : ""}`}>
              <code>其它 /v1/*</code>
              <span>命中</span>
              <strong>Codex 主槽位</strong>
            </div>
          </div>

          <div className="route-slot-grid">
            <div className="route-slot primary-slot">
              <span>Codex primary</span>
              <strong>{primaryHost}</strong>
              <small>普通请求直通主上游</small>
            </div>
            <div className="route-slot compact-slot">
              <span>Codex compact</span>
              <strong>{compactTarget}</strong>
              <small>{compactMode === "split" ? "独立 Base URL 与密钥" : "复用主上游与主密钥"}</small>
            </div>
          </div>

          <div className="route-model-strip">
            <span>模型映射</span>
            <strong title={`${currentModel} -> ${compactModel}`}>
              <code>{currentModel}</code> {"->"} <code>{compactModel}</code>
            </strong>
          </div>
        </article>

        <article className="route-rule-card claude-rule">
          <div className="route-rule-card-head">
            <span className="route-chip claude">Claude</span>
            <div>
              <h3>Claude / Anthropic 兼容入口</h3>
              <p>
                流量进入 <code>/anthropic</code> 后剥离前缀。手动 <code>/compact</code> 默认仍走主槽位；只有
                AnyRouter 大请求在结构化 reconnect 计数达到 3 后，才授权下一次手动 compact 走压缩槽位。
              </p>
            </div>
          </div>

          <div className="route-rule-list">
            <div className={`route-rule-row ${activeRoute === "claude" ? "is-active" : ""}`}>
              <code>普通 /messages</code>
              <span>默认</span>
              <strong>Claude 主槽位</strong>
            </div>
            <div className="route-rule-row">
              <code>AnyRouter + reconnect_count &gt;= 3</code>
              <span>授权</span>
              <strong>下一次手动 compact</strong>
            </div>
          </div>

          <div className="route-slot-grid">
            <div className="route-slot claude-slot">
              <span>Claude primary</span>
              <strong>{claudePrimaryHost}</strong>
              <small>普通 Messages 与未授权手动 compact 都走这里</small>
            </div>
            <div className="route-slot compact-slot">
              <span>Claude compact</span>
              <strong>{claudeCompactTarget}</strong>
              <small>{claudeCompactMode === "split" ? "独立手动 compact 上游与密钥" : "复用 Claude 主上游与主密钥"}</small>
            </div>
          </div>

          <div className="auto-compact-loop" aria-label="Claude 手动 compact 授权流程">
            <div>
              <span>触发</span>
              <p>
                仅当 Claude 主路由指向 AnyRouter、Messages 请求体足够大，并且结构化 reconnect 计数达到
                <code>3</code> 或更高时授权。普通大请求体、非 AnyRouter 上游和 primary 错误不会自动切到压缩槽位。
              </p>
            </div>
            <ol>
              <li>满足条件的 reconnect 请求仍发送到 Claude primary。</li>
              <li>代理只记录一次性授权，不生成 summary，也不重试当前请求。</li>
              <li>下一次识别到 Claude Code 手动 compact prompt 时发送到 Claude compact。</li>
              <li>授权被消费后，后续手动 compact 继续回到 Claude primary。</li>
            </ol>
          </div>
        </article>
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
        <div>
          <span>日志下拉框</span>
          <strong>只筛选表格，不改变分流</strong>
        </div>
      </div>
    </section>
  );
}


function ProfileScopeCard({
  scope,
  title,
  eyebrow,
  description,
  emptyTitle,
  emptyDescription,
  config,
  profileName,
  selectedProfileId,
  profileState,
  profileError,
  onProfileNameChange,
  onSelectedProfileChange,
  onSaveProfile,
  onApplyProfile,
  onUpdateProfile,
  onDuplicateProfile,
  onDeleteProfile
}: {
  scope: ConfigProfileScope;
  title: string;
  eyebrow: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  config: PublicConfig | null;
  profileName: string;
  selectedProfileId: string;
  profileState: ProfileActionState;
  profileError: string | null;
  onProfileNameChange: (name: string) => void;
  onSelectedProfileChange: (scope: ConfigProfileScope, profileId: string) => void;
  onSaveProfile: (scope: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
}) {
  const titleId = `${scope}-profile-card-title`;
  const scopeState = config ? profileScopeState(config, scope) : { profiles: [], active_profile_id: null };
  const profiles = scopeState.profiles;
  const activeProfile = profiles.find((profile) => profile.id === scopeState.active_profile_id) ?? null;
  const profileBusy = isProfileActionBusy(profileState);
  const scopeLabel = scope === "codex" ? "Codex" : "Claude";

  return (
    <section className={`profile-card profile-card-${scope}`} aria-labelledby={titleId}>
      <div className="profile-card-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h3 id={titleId}>{title}</h3>
        <p>{description}</p>
      </div>

      <div className="profile-card-controls">
        <Field label={`${scopeLabel} 档案名称`} hint="选择档案后可改名并保存。">
          <input
            aria-label={`${scopeLabel} 档案名称`}
            value={profileName}
            onChange={(event) => onProfileNameChange(event.target.value)}
            placeholder="选择档案后可在这里改名"
          />
        </Field>

        <button
          className="ghost-button profile-save-button"
          type="button"
          disabled={profileBusy}
          onClick={() => void onSaveProfile(scope)}
        >
          {profileState === "saving" ? "正在保存档案..." : `保存当前 ${scopeLabel} 草稿为档案`}
        </button>
      </div>

      {profiles.length === 0 ? (
        <div className="profile-empty-card">
          <strong>{emptyTitle}</strong>
          <span>{emptyDescription}</span>
        </div>
      ) : (
        <div className="profile-list" aria-label={`已保存 ${scopeLabel} 配置档案`}>
          {profiles.map((profile) => {
            const isActive = profile.id === scopeState.active_profile_id;
            const isSelected = profile.id === selectedProfileId;
            const updateLabel = isActive ? "保存并应用" : "保存档案";
            const busyUpdateLabel = isActive ? "应用中..." : "保存中...";
            const cardClassName = [
              "profile-item",
              isActive ? "is-active" : "",
              isSelected ? "is-selected" : ""
            ].filter(Boolean).join(" ");

            return (
              <article key={profile.id} className={cardClassName}>
                <span className="profile-item-handle" aria-hidden="true">≡</span>
                <button
                  className="profile-item-main"
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectedProfileChange(scope, profile.id)}
                >
                  <span className="profile-item-icon" aria-hidden="true">
                    {profile.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="profile-item-copy">
                    <span className="profile-item-kicker">
                      {isActive ? "当前运行时" : isSelected ? "已选中" : "可选档案"}
                    </span>
                    <strong>{profile.name}</strong>
                    <small>{profileSummary(profile)}</small>
                    <span>更新于 {formatClock(profile.updated_at)}</span>
                  </span>
                </button>

                <div className="profile-item-actions">
                  <button
                    className="solid-button profile-apply-button"
                    type="button"
                    disabled={profileBusy || isActive}
                    data-active-disabled={isActive ? "true" : undefined}
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onApplyProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "applying" && isSelected ? "应用中..." : "应用"}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={profileBusy}
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onUpdateProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "updating" && isSelected ? busyUpdateLabel : updateLabel}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={profileBusy}
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onDuplicateProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "duplicating" && isSelected ? "复制中..." : "复制"}
                  </button>
                  <button
                    className="ghost-button profile-danger-button"
                    type="button"
                    disabled={profileBusy}
                    onClick={() => {
                      onSelectedProfileChange(scope, profile.id);
                      void onDeleteProfile(scope, profile.id);
                    }}
                  >
                    {profileState === "deleting" && isSelected ? "删除中..." : "删除"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="profile-card-status" aria-live="polite">
        <span>
          当前 {scopeLabel} 运行时档案：
          <strong>{activeProfile?.name ?? "未绑定档案"}</strong>
        </span>
        <span>
          已保存：
          <strong>{profiles.length}</strong>
        </span>
        <span>{profileActionLabel(profileState)}</span>
      </div>

      {profileError && <p className="error-note">{profileError}</p>}
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
  profileName,
  selectedProfileId,
  profileState,
  profileError,
  claudeProfileName,
  selectedClaudeProfileId,
  claudeProfileState,
  claudeProfileError,
  hasPendingChanges,
  onCurrentModelChange,
  onFormChange,
  onProfileNameChange,
  onClaudeProfileNameChange,
  onSelectedProfileChange,
  onSaveProfile,
  onApplyProfile,
  onUpdateProfile,
  onDuplicateProfile,
  onDeleteProfile,
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
  profileName: string;
  selectedProfileId: string;
  profileState: ProfileActionState;
  profileError: string | null;
  claudeProfileName: string;
  selectedClaudeProfileId: string;
  claudeProfileState: ProfileActionState;
  claudeProfileError: string | null;
  hasPendingChanges: boolean;
  onCurrentModelChange: (model: string) => void;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onProfileNameChange: (name: string) => void;
  onClaudeProfileNameChange: (name: string) => void;
  onSelectedProfileChange: (scope: ConfigProfileScope, profileId: string) => void;
  onSaveProfile: (scope: ConfigProfileScope) => void | Promise<void>;
  onApplyProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUpdateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onUnlockCompactModel: () => void;
  onRestoreLinkedMode: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <section className="panel live-config" aria-labelledby="live-config-title">
      <div className="section-heading">
        <p className="eyebrow">Live Config</p>
        <h2 id="live-config-title">Live Config</h2>
      </div>

      <form className="control-stack" onSubmit={onSubmit}>

        <ProfileScopeCard
          scope="codex"
          title="Codex 配置档案"
          eyebrow="Codex Profiles"
          description="保存、复制或应用 Codex 主路由与 compact 草稿；不会改动 Claude 档案。"
          emptyTitle="还没有保存的 Codex 档案"
          emptyDescription="填写名称后保存当前 Codex 草稿，就会在这里出现可应用的档案卡片。"
          config={config}
          profileName={profileName}
          selectedProfileId={selectedProfileId}
          profileState={profileState}
          profileError={profileError}
          onProfileNameChange={onProfileNameChange}
          onSelectedProfileChange={onSelectedProfileChange}
          onSaveProfile={onSaveProfile}
          onApplyProfile={onApplyProfile}
          onUpdateProfile={onUpdateProfile}
          onDuplicateProfile={onDuplicateProfile}
          onDeleteProfile={onDeleteProfile}
        />

        <ProfileScopeCard
          scope="claude"
          title="Claude 配置档案"
          eyebrow="Claude Profiles"
          description="保存、复制或应用 Claude primary / compact 草稿；不会改动 Codex 档案。"
          emptyTitle="还没有保存的 Claude 档案"
          emptyDescription="填写名称后保存当前 Claude 草稿，就会在这里出现可应用的档案卡片。"
          config={config}
          profileName={claudeProfileName}
          selectedProfileId={selectedClaudeProfileId}
          profileState={claudeProfileState}
          profileError={claudeProfileError}
          onProfileNameChange={onClaudeProfileNameChange}
          onSelectedProfileChange={onSelectedProfileChange}
          onSaveProfile={onSaveProfile}
          onApplyProfile={onApplyProfile}
          onUpdateProfile={onUpdateProfile}
          onDuplicateProfile={onDuplicateProfile}
          onDeleteProfile={onDeleteProfile}
        />

        <div className="route-config-grid">
          <section className="route-config-group" aria-labelledby="codex-route-config-title">
            <div className="route-config-group-head">
              <span className="route-chip primary">Codex</span>
              <div>
                <h3 id="codex-route-config-title">Codex 路由</h3>
                <p>普通请求走主路由；compact 路径按模式分流。</p>
              </div>
            </div>

            <div className="route-config-cards">
              <RouteCredentialFields
                title="Codex 主路由"
                badge="主"
                tone="primary"
                baseUrlLabel="Codex 主路由 Base URL"
                baseUrlHint="普通 /v1 请求会转发到这里。"
                apiKeyLabel="Codex 主路由 API Key"
                apiKeyHint={
                  form.clearCodexPrimaryApiKey
                    ? "保存后会删除当前已保存的 Codex 主路由密钥。"
                    : directApiKeyHint("Codex 主路由", config?.primary ?? null)
                }
                baseUrl={form.codexPrimaryBaseUrl}
                apiKey={form.codexPrimaryApiKey}
                storedApiKey={config?.primary.stored_api_key ?? false}
                clearApiKey={form.clearCodexPrimaryApiKey}
                onBaseUrlChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    codexPrimaryBaseUrl: value
                  }))
                }
                onApiKeyChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    codexPrimaryApiKey: value,
                    clearCodexPrimaryApiKey: false
                  }))
                }
                onToggleClearApiKey={() =>
                  onFormChange((previous) => ({
                    ...previous,
                    codexPrimaryApiKey: "",
                    clearCodexPrimaryApiKey: !previous.clearCodexPrimaryApiKey
                  }))
                }
              />

              <RouteCredentialFields
                title="Codex 压缩路由"
                badge="压缩"
                tone="compact"
                baseUrlLabel="Codex 压缩路由 Base URL"
                baseUrlHint={
                  form.upstreamMode === "split"
                    ? "Codex compact 请求会转发到这里。"
                    : "当前复用 Codex 主路由，这个地址会保留但暂不参与转发。"
                }
                apiKeyLabel="Codex 压缩路由 API Key"
                apiKeyHint={
                  form.clearCodexCompactApiKey
                    ? "保存后会删除当前已保存的 Codex 压缩路由密钥。"
                    : form.upstreamMode === "split"
                      ? directApiKeyHint("Codex 压缩路由", config?.compact ?? null)
                      : "当前 Codex compact 请求复用主路由认证；这里的密钥会在切回独立分流后生效。"
                }
                baseUrl={form.codexCompactBaseUrl}
                apiKey={form.codexCompactApiKey}
                storedApiKey={config?.compact.stored_api_key ?? false}
                clearApiKey={form.clearCodexCompactApiKey}
                onBaseUrlChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    codexCompactBaseUrl: value
                  }))
                }
                onApiKeyChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    codexCompactApiKey: value,
                    clearCodexCompactApiKey: false
                  }))
                }
                onToggleClearApiKey={() =>
                  onFormChange((previous) => ({
                    ...previous,
                    codexCompactApiKey: "",
                    clearCodexCompactApiKey: !previous.clearCodexCompactApiKey
                  }))
                }
              />
            </div>
          </section>

          <section className="route-config-group" aria-labelledby="claude-route-config-title">
            <div className="route-config-group-head">
              <span className="route-chip claude">Claude</span>
              <div>
                <h3 id="claude-route-config-title">Claude 路由</h3>
                <p>Messages 走主路由；只有已授权的下一次手动 compact 才使用压缩路由。</p>
              </div>
            </div>

            <div className="route-config-cards">
              <RouteCredentialFields
                title="Claude 主路由"
                badge="主"
                tone="claude"
                baseUrlLabel="Claude 主路由 Base URL"
                baseUrlHint="普通 Claude Code Messages 请求会转发到这里。"
                apiKeyLabel="Claude 主路由 API Key"
                apiKeyHint={
                  form.clearClaudePrimaryApiKey
                    ? "保存后会删除当前已保存的 Claude 主路由密钥。"
                    : directApiKeyHint("Claude 主路由", config?.claude.primary ?? null)
                }
                baseUrl={form.claudePrimaryBaseUrl}
                apiKey={form.claudePrimaryApiKey}
                storedApiKey={config?.claude.primary.stored_api_key ?? false}
                clearApiKey={form.clearClaudePrimaryApiKey}
                onBaseUrlChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudePrimaryBaseUrl: value
                  }))
                }
                onApiKeyChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudePrimaryApiKey: value,
                    clearClaudePrimaryApiKey: false
                  }))
                }
                onToggleClearApiKey={() =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudePrimaryApiKey: "",
                    clearClaudePrimaryApiKey: !previous.clearClaudePrimaryApiKey
                  }))
                }
              />

              <RouteCredentialFields
                title="Claude 压缩路由"
                badge="压缩"
                tone="compact"
                baseUrlLabel="Claude 压缩路由 Base URL"
                baseUrlHint={
                  form.claudeCompactUpstreamMode === "split"
                    ? "仅在 AnyRouter 大 reconnect 请求授权后，用于下一次手动 compact。"
                    : "当前复用 Claude 主路由，这个地址会保留但暂不参与手动 compact 分流。"
                }
                apiKeyLabel="Claude 压缩路由 API Key"
                apiKeyHint={
                  form.clearClaudeCompactApiKey
                    ? "保存后会删除当前已保存的 Claude 压缩路由密钥。"
                    : form.claudeCompactUpstreamMode === "split"
                      ? directApiKeyHint("Claude 压缩路由", config?.claude.compact ?? null)
                      : "当前 Claude compact 分流复用主路由认证；这里的密钥会在切回独立分流后生效。"
                }
                baseUrl={form.claudeCompactBaseUrl}
                apiKey={form.claudeCompactApiKey}
                storedApiKey={config?.claude.compact.stored_api_key ?? false}
                clearApiKey={form.clearClaudeCompactApiKey}
                onBaseUrlChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudeCompactBaseUrl: value
                  }))
                }
                onApiKeyChange={(value) =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudeCompactApiKey: value,
                    clearClaudeCompactApiKey: false
                  }))
                }
                onToggleClearApiKey={() =>
                  onFormChange((previous) => ({
                    ...previous,
                    claudeCompactApiKey: "",
                    clearClaudeCompactApiKey: !previous.clearClaudeCompactApiKey
                  }))
                }
              />

              <section className="route-config-card tone-compact" aria-label="Claude 手动 compact 模型">
                <div className="route-config-card-head">
                  <h4>Claude 手动 compact 模型</h4>
                  <span className="route-chip compact">可选</span>
                </div>
                <Field
                  label="Claude 手动 compact 模型"
                  hint="留空会把原请求模型透传给 compact 上游；填写后只改被授权的手动 compact 请求。"
                >
                  <input
                    aria-label="Claude 手动 compact 模型"
                    value={form.claudeCompactModelOverride}
                    placeholder={config?.claude.compact.model_override || "例如 claude-sonnet-4-6"}
                    onChange={(event) =>
                      onFormChange((previous) => ({
                        ...previous,
                        claudeCompactModelOverride: event.target.value
                      }))
                    }
                    spellCheck={false}
                  />
                </Field>
              </section>
            </div>
          </section>
        </div>

        <div className="mode-card">
          <div>
            <span className="mode-card-title">Codex Compact 上游模式</span>
            <p>
              {form.upstreamMode === "split" ? "独立分流：" : "复用主上游："}
              <code>/v1/responses/compact</code>
              {form.upstreamMode === "split"
                ? " 使用 Codex 压缩路由 Base URL 与 API Key。"
                : " 直接发送到 Codex 主路由，并复用 Codex 主路由密钥。"}
            </p>
          </div>
          <div className="mode-switch" role="group" aria-label="Codex Compact 上游模式">
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

        <div className="mode-card">
          <div>
            <span className="mode-card-title">Claude Compact 上游模式</span>
            <p>
              {form.claudeCompactUpstreamMode === "split" ? "独立分流：" : "复用主上游："}
              已授权的手动 compact 请求
              {form.claudeCompactUpstreamMode === "split"
                ? " 使用 Claude 压缩路由 Base URL 与 API Key。"
                : " 发送到 Claude 主路由，并复用 Claude 主路由密钥。"}
            </p>
          </div>
          <div className="mode-switch" role="group" aria-label="Claude Compact 上游模式">
            <button
              type="button"
              className={form.claudeCompactUpstreamMode === "split" ? "is-selected" : ""}
              aria-pressed={form.claudeCompactUpstreamMode === "split"}
              onClick={() =>
                onFormChange((previous) => ({
                  ...previous,
                  claudeCompactUpstreamMode: "split"
                }))
              }
            >
              独立分流
            </button>
            <button
              type="button"
              className={form.claudeCompactUpstreamMode === "primary" ? "is-selected" : ""}
              aria-pressed={form.claudeCompactUpstreamMode === "primary"}
              onClick={() =>
                onFormChange((previous) => ({
                  ...previous,
                  claudeCompactUpstreamMode: "primary"
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
        <h2 id="inspector-title">Route Preview</h2>
      </div>

      <form className="control-stack" onSubmit={onSubmit}>
        <Field label="请求路径" hint="常用路径或手动输入。">
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

        <Field label="JSON Body" hint="只填 model / stream 即可。">
          <textarea
            aria-label="JSON Body"
            value={body}
            onChange={(event) => onBodyChange(event.target.value)}
            rows={4}
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
          <p>预览会显示通道、上游、模型与 stream 处理。</p>
        )}
      </div>
    </section>
  );
}

function LogsPanel({
  logs,
  logCounts,
  providerCounts,
  statusCounts,
  totalLogCount,
  allLogCount,
  hostOptions,
  hasMoreLogs,
  isLoadingLogs,
  isLoadingMoreLogs,
  routeFilter,
  statusFilter,
  hostFilter,
  onRouteFilterChange,
  onStatusFilterChange,
  onHostFilterChange,
  onLoadMore,
  error
}: {
  logs: RequestLogEntry[];
  logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts;
  statusCounts: StatusLogCounts;
  totalLogCount: number;
  allLogCount: number;
  hostOptions: HostFilterOption[];
  hasMoreLogs: boolean;
  isLoadingLogs: boolean;
  isLoadingMoreLogs: boolean;
  routeFilter: "all" | RouteKind;
  statusFilter: "all" | LogStatusKind;
  hostFilter: string;
  onRouteFilterChange: (route: "all" | RouteKind) => void;
  onStatusFilterChange: (status: "all" | LogStatusKind) => void;
  onHostFilterChange: (host: string) => void;
  onLoadMore: () => void;
  error: string | null;
}) {
  const routeOptions = buildRouteSelectOptions(logCounts);
  const statusOptions = buildStatusSelectOptions(statusCounts);
  const hostSelectOptions = buildHostSelectOptions(hostOptions);
  const visibleLogCount = logs.length;

  return (
    <section className="logs-panel" aria-labelledby="logs-title">
      <div className="logs-head">
        <div className="section-heading">
          <p className="eyebrow">Traffic</p>
          <h2 id="logs-title">Request log</h2>
        </div>
        <div className="log-filter-stack">
          <div className="log-select-row">
            <CustomSelect
              label="显示通道"
              value={routeFilter}
              options={routeOptions}
              onChange={(value) => onRouteFilterChange(readRouteFilterValue(value))}
            />
            <CustomSelect
              label="显示状态"
              value={statusFilter}
              options={statusOptions}
              onChange={(value) => onStatusFilterChange(readStatusFilterValue(value))}
            />
            <CustomSelect
              label="显示上游 Host"
              value={hostFilter}
              options={hostSelectOptions}
              onChange={onHostFilterChange}
              wide
            />
          </div>
          <p className="log-filter-disclaimer">
            Filters only change this table. Routing stays controlled by request path and proxy config.
          </p>
          <p className="log-filter-summary" aria-live="polite">
            {visibleLogCount} / {totalLogCount} shown · {allLogCount} stored
          </p>
        </div>
      </div>

      <div className="provider-summary" aria-label="Provider 日志汇总">
        <ProviderCountCard
          label={PROVIDER_LABELS.openai}
          value={providerCounts.openai}
          detail={`primary ${logCounts.primary} · compact ${logCounts.compact}`}
          tone="primary"
        />
        <ProviderCountCard
          label={PROVIDER_LABELS.claude}
          value={providerCounts.claude}
          detail={`routed ${logCounts.claude}`}
          tone="claude"
        />
      </div>

      {error && <p className="error-note">{error}</p>}

      {logs.length > 0 && (
        <div className="log-usage-head" aria-hidden="true">
          <span>时间</span>
          <span>模型</span>
          <span>状态码</span>
          <span>模型 / 思考</span>
          <span>端点</span>
          <span>上游 Host</span>
          <span>类型</span>
          <span>User Agent</span>
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
            <strong>{emptyLogTitle(routeFilter, statusFilter, hostFilter, allLogCount)}</strong>
            <span>{emptyLogHint(routeFilter, statusFilter, hostFilter, allLogCount)}</span>
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

function ProviderCountCard({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: number;
  detail: string;
  tone: "primary" | "claude";
}) {
  return (
    <article className={`provider-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function LogRow({ entry }: { entry: RequestLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = Boolean(entry.error_summary) || entry.status >= 400;
  const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
  const requestLine = `${entry.method} ${entry.path}`;
  const targetModel = entry.target_model ?? entry.source_model;
  const hasModelRewrite = Boolean(entry.source_model && targetModel && entry.source_model !== targetModel);
  const userAgent = entry.user_agent ?? "-";
  const canExpand = hasHiddenLogDetails(entry);
  const errorCopy = hasError
    ? entry.error_summary ?? `HTTP ${entry.status} · 上游或代理未提供错误摘要。`
    : null;
  const mainContent = (
    <>
      <time className="log-time" dateTime={entry.time} data-label="时间">{formatDateTime(entry.time)}</time>
      <span className="log-model-cell" data-label="模型">
        <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
        <strong>{entry.source_model ?? "-"}</strong>
        {hasModelRewrite && <small>{"->"} {targetModel}</small>}
      </span>
      <span className={`log-status-code is-${logStatusKind(entry)}`} data-label="状态码">{entry.status}</span>
      <span className="log-request-info" title={modelReasoningLabel(entry)} data-label="模型 / 思考">
        {modelReasoningLabel(entry)}
      </span>
      <code className="log-endpoint" data-label="端点">{entry.endpoint}</code>
      <code className="log-host" data-label="上游 Host">{entry.upstream_host}</code>
      <span className={`transport-pill is-${entry.request_type}`} data-label="类型">
        {requestTypeLabel(entry.request_type)}
      </span>
      <code className="log-user-agent" title={userAgent} data-label="User Agent">{userAgent}</code>
      <TokenTooltip entry={entry} />
      <span className="metric-time" data-label="首 Token">{formatDurationMs(entry.first_token_ms)}</span>
      <span className="metric-time" data-label="耗时">{formatDurationMs(entry.duration_ms)}</span>
    </>
  );

  return (
    <article className={`log-row route-${entry.route} ${hasError ? "has-error" : ""} ${canExpand ? "can-expand" : "is-static"}`}>
      {canExpand ? (
        <button
          className="log-row-main"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {mainContent}
        </button>
      ) : (
        <div className="log-row-main is-static">{mainContent}</div>
      )}

      {errorCopy && <p className="log-row-error">{errorCopy}</p>}

      {expanded && canExpand && (
        <div className="log-detail">
          <p>{errorCopy ?? "请求已完成，上游未返回代理层错误。"}</p>
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
              <strong>{formatMetricNumber(displayTotalTokens(entry))}</strong>
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
              <dt>请求摘要</dt>
              <dd>
                <code>{entry.request_summary ?? "无"}</code>
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
                <time dateTime={entry.time}>{formatDateTime(entry.time)}</time>
              </dd>
            </div>
            <div>
              <dt>User Agent</dt>
              <dd>
                <code>{userAgent}</code>
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
  wide = false,
  disabled = false,
  compact = false
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  wide?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selected.value)
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    updateMenuPlacement();
    window.requestAnimationFrame(() => {
      optionRefs.current[selectedIndex]?.focus();
    });
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function handleReposition() {
      updateMenuPlacement();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }

  function focusOption(index: number) {
    optionRefs.current[index]?.focus();
  }

  function updateMenuPlacement() {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const width = wide ? Math.max(rect.width, Math.min(420, window.innerWidth - viewportPadding * 2)) : rect.width;
    const left = clamp(rect.left, viewportPadding, window.innerWidth - width - viewportPadding);
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const availableAbove = rect.top - viewportPadding;
    const maxHeight = Math.max(180, Math.min(320, Math.max(availableBelow, availableAbove)));
    const top = availableBelow >= 190 || availableBelow >= availableAbove
      ? rect.bottom + 8
      : Math.max(viewportPadding, rect.top - maxHeight - 8);

    setMenuStyle({
      left,
      top,
      width,
      maxHeight
    });
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

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
    <div className={`custom-select ${wide ? "is-wide" : ""} ${compact ? "is-compact" : ""}`}>
      <span className="custom-select-label">{label}</span>
      <button
        ref={triggerRef}
        className="custom-select-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => !disabled && setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="custom-select-copy">
          <strong>{selected.label}</strong>
          {selected.meta && <small>{selected.meta}</small>}
        </span>
        {typeof selected.count === "number" && <span className="custom-select-count">{selected.count}</span>}
      </button>

      {open && !disabled && menuStyle && createPortal(
        <div
          ref={menuRef}
          id={listId}
          className={`custom-select-menu ${wide ? "is-wide" : ""} ${compact ? "is-compact" : ""}`}
          role="listbox"
          style={menuStyle}
        >
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
              {typeof option.count === "number" && <span className="custom-select-count">{option.count}</span>}
            </button>
          ))}
        </div>,
        document.body
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
      data-label="Token"
      aria-describedby={tooltipId}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
    >
      <span className="token-total-pill">{formatMetricNumber(displayTotalTokens(entry))}</span>
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
              <em>未缓存输入</em>
              <b>{formatMetricNumber(uncachedInputTokens(entry))}</b>
            </span>
            <span className="token-tooltip-row">
              <em>缓存命中率</em>
              <b>{formatCacheHitRate(entry)}</b>
            </span>
            <span className="token-tooltip-total">
              <em>总 Token</em>
              <b>{formatMetricNumber(displayTotalTokens(entry))}</b>
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

function RouteCredentialFields({
  title,
  badge,
  tone,
  baseUrlLabel,
  baseUrlHint,
  apiKeyLabel,
  apiKeyHint,
  baseUrl,
  apiKey,
  storedApiKey,
  clearApiKey,
  onBaseUrlChange,
  onApiKeyChange,
  onToggleClearApiKey
}: {
  title: string;
  badge: string;
  tone: "primary" | "compact" | "claude";
  baseUrlLabel: string;
  baseUrlHint: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  baseUrl: string;
  apiKey: string;
  storedApiKey: boolean;
  clearApiKey: boolean;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onToggleClearApiKey: () => void;
}) {
  return (
    <section className={`route-config-card tone-${tone}`} aria-label={title}>
      <div className="route-config-card-head">
        <h4>{title}</h4>
        <span className={`route-chip ${tone}`}>{badge}</span>
      </div>

      <Field label={baseUrlLabel} hint={baseUrlHint}>
        <input
          aria-label={baseUrlLabel}
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          spellCheck={false}
        />
      </Field>

      <Field label={apiKeyLabel} hint={apiKeyHint}>
        <input
          aria-label={apiKeyLabel}
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={storedApiKey ? "输入新值以覆盖已保存密钥" : "sk-..."}
          onChange={(event) => onApiKeyChange(event.target.value)}
          spellCheck={false}
        />
        {(storedApiKey || clearApiKey) && (
          <div className="field-action-row">
            <button
              className={`field-inline-button ${clearApiKey ? "is-danger" : ""}`}
              type="button"
              onClick={onToggleClearApiKey}
            >
              {clearApiKey ? "取消清空" : "清空已保存密钥"}
            </button>
          </div>
        )}
      </Field>
    </section>
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
  scope: CredentialScope,
  upstream?: PublicRouteCredentialConfig | HealthRouteCredentialConfig | null
): string {
  if (!upstream) {
    return "读取中...";
  }

  if (upstream.api_key_source === "config") {
    return upstream.active_credential_scope === scope ? "已保存直连密钥" : "复用主路由直连密钥";
  }

  return upstream.active_api_key_env ?? "无";
}

function credentialFlagCopy(
  scope: CredentialScope,
  upstream?: HealthRouteCredentialConfig | null
): string {
  if (!upstream?.api_key_configured) {
    return "当前没有可用密钥。";
  }

  if (upstream.api_key_source === "config") {
    return upstream.active_credential_scope === scope
      ? "当前由已保存的直连密钥注入 Authorization。"
      : "当前复用主路由里保存的直连密钥。";
  }

  return upstream.active_credential_scope === scope
    ? `当前读取环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。`
    : `当前复用主路由环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。`;
}

function directApiKeyHint(
  routeLabelText: string,
  upstream?: PublicRouteCredentialConfig | null
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

  return `当前还没有 ${routeLabelText} 密钥；保存后会直接写入 compactgate.json。`;
}

function StatusPill({ label, status }: { label: string; status: HealthBadge }) {
  return (
    <span className={`status-pill is-${status.tone}`}>
      {label}: {status.label}
    </span>
  );
}

function readStoredThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem("compactgate-theme-mode");
    return value === "light" || value === "dark" || value === "auto" ? value : "auto";
  } catch {
    return "auto";
  }
}

function emptyForm(): ConfigFormState {
  return {
    codexPrimaryBaseUrl: "",
    codexPrimaryApiKey: "",
    clearCodexPrimaryApiKey: false,
    codexCompactBaseUrl: "",
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    claudePrimaryBaseUrl: "",
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudeModelMap: emptyClaudeModelMap(),
    claudeCompactBaseUrl: "",
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
    claudeCompactModelOverride: "",
    claudeCompactUpstreamMode: "primary",
    upstreamMode: "split",
    modelMode: "linked",
    modelTemplate: "{model}-openai-compact",
    modelOverride: ""
  };
}

function formFromConfig(config: PublicConfig): ConfigFormState {
  return {
    codexPrimaryBaseUrl: config.primary.base_url,
    codexPrimaryApiKey: "",
    clearCodexPrimaryApiKey: false,
    codexCompactBaseUrl: config.compact.base_url,
    codexCompactApiKey: "",
    clearCodexCompactApiKey: false,
    claudePrimaryBaseUrl: config.claude.primary.base_url,
    claudePrimaryApiKey: "",
    clearClaudePrimaryApiKey: false,
    claudeModelMap: normalizeClaudeModelMap(config.claude.model_map),
    claudeCompactBaseUrl: config.claude.compact.base_url,
    claudeCompactApiKey: "",
    clearClaudeCompactApiKey: false,
    claudeCompactModelOverride: config.claude.compact.model_override,
    claudeCompactUpstreamMode: readUpstreamMode(config.claude.compact.upstream_mode, "primary"),
    upstreamMode: readUpstreamMode(config.compact.upstream_mode, "split"),
    modelMode: config.compact.model_mode,
    modelTemplate: config.compact.model_template,
    modelOverride: config.compact.model_override
  };
}

function readUpstreamMode(value: unknown, fallback: "split" | "primary"): "split" | "primary" {
  return value === "split" || value === "primary" ? value : fallback;
}

function formToPatch(form: ConfigFormState) {
  const claudeModelMap = normalizeClaudeModelMap(form.claudeModelMap);
  const primary = {
    base_url: form.codexPrimaryBaseUrl,
    ...apiKeyPatch(form.codexPrimaryApiKey, form.clearCodexPrimaryApiKey)
  };
  const compact = {
    base_url: form.codexCompactBaseUrl,
    ...apiKeyPatch(form.codexCompactApiKey, form.clearCodexCompactApiKey),
    upstream_mode: form.upstreamMode,
    model_mode: form.modelMode,
    model_template: form.modelTemplate,
    model_override: form.modelOverride
  };
  const claude = {
    primary: {
      base_url: form.claudePrimaryBaseUrl,
      ...apiKeyPatch(form.claudePrimaryApiKey, form.clearClaudePrimaryApiKey),
      model_override: claudeModelMap.default
    },
    model_map: claudeModelMap,
    compact: {
      base_url: form.claudeCompactBaseUrl,
      ...apiKeyPatch(form.claudeCompactApiKey, form.clearClaudeCompactApiKey),
      upstream_mode: form.claudeCompactUpstreamMode,
      model_override: form.claudeCompactModelOverride
    }
  };

  return {
    primary,
    compact,
    claude
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
  const claudeModelMap = normalizeClaudeModelMap(form.claudeModelMap);
  const next: CompactGateConfig = {
    listen: config.listen,
    primary: {
      ...config.primary,
      base_url: form.codexPrimaryBaseUrl
    },
    compact: {
      ...config.compact,
      base_url: form.codexCompactBaseUrl,
      upstream_mode: form.upstreamMode,
      model_mode: form.modelMode,
      model_template: form.modelTemplate,
      model_override: form.modelOverride
    },
    claude: {
      primary: {
        ...config.claude.primary,
        base_url: form.claudePrimaryBaseUrl,
        model_override: claudeModelMap.default
      },
      compact: {
        ...config.claude.compact,
        base_url: form.claudeCompactBaseUrl,
        upstream_mode: form.claudeCompactUpstreamMode,
        model_override: form.claudeCompactModelOverride
      },
      model_map: claudeModelMap
    },
    timeouts: { ...config.timeouts },
    logging: { ...config.logging },
    profiles: config.profiles,
    active_profile_id: config.active_profile_id,
    profile_scopes: config.profile_scopes
  };

  applyApiKeyDraft(next.primary, form.codexPrimaryApiKey, form.clearCodexPrimaryApiKey);
  applyApiKeyDraft(next.compact, form.codexCompactApiKey, form.clearCodexCompactApiKey);
  applyApiKeyDraft(next.claude.primary, form.claudePrimaryApiKey, form.clearClaudePrimaryApiKey);
  applyApiKeyDraft(next.claude.compact, form.claudeCompactApiKey, form.clearClaudeCompactApiKey);

  return next;
}

function draftComparisonState(form: ConfigFormState) {
  return {
    codexPrimaryBaseUrl: form.codexPrimaryBaseUrl,
    codexPrimaryApiKey: normalizedApiKey(form.codexPrimaryApiKey),
    clearCodexPrimaryApiKey: form.clearCodexPrimaryApiKey,
    codexCompactBaseUrl: form.codexCompactBaseUrl,
    codexCompactApiKey: normalizedApiKey(form.codexCompactApiKey),
    clearCodexCompactApiKey: form.clearCodexCompactApiKey,
    claudePrimaryBaseUrl: form.claudePrimaryBaseUrl,
    claudePrimaryApiKey: normalizedApiKey(form.claudePrimaryApiKey),
    clearClaudePrimaryApiKey: form.clearClaudePrimaryApiKey,
    claudeModelMap: normalizeClaudeModelMap(form.claudeModelMap),
    claudeCompactBaseUrl: form.claudeCompactBaseUrl,
    claudeCompactApiKey: normalizedApiKey(form.claudeCompactApiKey),
    clearClaudeCompactApiKey: form.clearClaudeCompactApiKey,
    claudeCompactModelOverride: form.claudeCompactModelOverride,
    claudeCompactUpstreamMode: form.claudeCompactUpstreamMode,
    upstreamMode: form.upstreamMode,
    modelMode: form.modelMode,
    modelTemplate: form.modelTemplate,
    modelOverride: form.modelOverride
  };
}

function emptyClaudeModelMap(): ClaudeModelMap {
  return CLAUDE_MODEL_MAP_ROLES.reduce((modelMap, role) => {
    modelMap[role] = "";
    return modelMap;
  }, {} as ClaudeModelMap);
}

function normalizeClaudeModelMap(value: Partial<ClaudeModelMap> | null | undefined): ClaudeModelMap {
  const modelMap = emptyClaudeModelMap();
  if (!value || typeof value !== "object") {
    return modelMap;
  }

  for (const role of CLAUDE_MODEL_MAP_ROLES) {
    const model = value[role];
    modelMap[role] = typeof model === "string" ? model : "";
  }

  return modelMap;
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

function formatLatestLogStatus(entry: RequestLogEntry | null, fallback: string): string {
  return entry ? `${routeLabel(entry.route)} · 状态 ${entry.status}` : fallback;
}

function requestTypeLabel(type: RequestLogEntry["request_type"]): string {
  return type === "stream" ? "Stream" : "HTTP";
}

function requestInfoLabel(entry: RequestLogEntry): string {
  return entry.request_summary ?? "-";
}

function modelReasoningLabel(entry: RequestLogEntry): string {
  const model = entry.target_model ?? entry.source_model ?? (entry.route === "claude" ? "Claude" : "model");
  const reasoning = entry.reasoning_effort ?? "standard";
  return `${model} · ${reasoning}`;
}

function logStatusKind(entry: RequestLogEntry): LogStatusKind {
  return entry.status >= 400 || Boolean(entry.error_summary) ? "error" : "normal";
}

function hasHiddenLogDetails(entry: RequestLogEntry): boolean {
  if (logStatusKind(entry) === "normal") {
    return true;
  }

  const hasTokenBreakdown =
    entry.input_tokens !== null ||
    entry.output_tokens !== null ||
    entry.cached_input_tokens !== null ||
    entry.cached_output_tokens !== null;
  const hasModelRewrite = Boolean(
    entry.source_model && entry.target_model && entry.source_model !== entry.target_model
  );
  const hasRequestContext =
    Boolean(entry.request_summary) || Boolean(entry.reasoning_effort);

  return hasTokenBreakdown || hasModelRewrite || hasRequestContext;
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
      label: ROUTE_META.primary.label,
      count: logCounts.primary,
      meta: ROUTE_META.primary.summary,
      tone: "primary"
    },
    {
      value: "compact",
      label: ROUTE_META.compact.label,
      count: logCounts.compact,
      meta: ROUTE_META.compact.summary,
      tone: "compact"
    },
    {
      value: "claude",
      label: ROUTE_META.claude.label,
      count: logCounts.claude,
      meta: ROUTE_META.claude.summary,
      tone: "claude"
    }
  ];
}

function buildHostSelectOptions(
  hostOptions: HostFilterOption[]
): SelectOption[] {
  const totalLogCount = hostOptions.reduce((total, option) => total + option.total, 0);

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
        meta: `普 ${option.primary} / 压 ${option.compact} / Claude ${option.claude}` as string
      }))
  ];
}

function buildStatusSelectOptions(statusCounts: StatusLogCounts): SelectOption[] {
  return [
    {
      value: "all",
      label: "全部",
      count: statusCounts.all,
      meta: "正常和错误"
    },
    {
      value: "normal",
      label: "正常",
      count: statusCounts.normal,
      meta: "HTTP < 400",
      tone: "normal"
    },
    {
      value: "error",
      label: "错误",
      count: statusCounts.error,
      meta: "HTTP >= 400 或代理错误",
      tone: "error"
    }
  ];
}

function readRouteFilterValue(value: string): "all" | RouteKind {
  return value === "primary" || value === "compact" || value === "claude" ? value : "all";
}

function readStatusFilterValue(value: string): "all" | LogStatusKind {
  return value === "normal" || value === "error" ? value : "all";
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
      compact: 0,
      claude: 0
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

  if (hasAdditiveCachedInput(entry)) {
    return entry.input_tokens ?? 0;
  }

  return Math.max(0, (entry.input_tokens ?? 0) - (entry.cached_input_tokens ?? 0));
}

function formatCacheHitRate(entry: RequestLogEntry): string {
  if (entry.cached_input_tokens === null) {
    return "-";
  }

  const denominator = hasAdditiveCachedInput(entry)
    ? entry.cached_input_tokens + (entry.input_tokens ?? 0)
    : entry.input_tokens;
  if (!denominator) {
    return "-";
  }

  return `${Math.min(100, Math.round((entry.cached_input_tokens / denominator) * 100))}%`;
}

function displayTotalTokens(entry: RequestLogEntry): number | null {
  const inputTokens = entry.input_tokens ?? 0;
  const outputTokens = entry.output_tokens ?? 0;
  const cachedInputTokens = entry.cached_input_tokens ?? 0;
  const cachedOutputTokens = entry.cached_output_tokens ?? 0;
  const hasAnyToken =
    entry.input_tokens !== null ||
    entry.output_tokens !== null ||
    entry.cached_input_tokens !== null ||
    entry.cached_output_tokens !== null ||
    entry.total_tokens !== null;

  if (!hasAnyToken) {
    return null;
  }

  const floor = inputTokens +
    outputTokens +
    (hasAdditiveCachedInput(entry) ? cachedInputTokens : 0) +
    (hasAdditiveCachedOutput(entry) ? cachedOutputTokens : 0);
  return Math.max(entry.total_tokens ?? 0, floor);
}

function hasAdditiveCachedInput(entry: RequestLogEntry): boolean {
  return entry.cached_input_tokens !== null &&
    entry.input_tokens !== null &&
    entry.cached_input_tokens > entry.input_tokens;
}

function hasAdditiveCachedOutput(entry: RequestLogEntry): boolean {
  return entry.cached_output_tokens !== null &&
    entry.output_tokens !== null &&
    entry.cached_output_tokens > entry.output_tokens;
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

function emptyLogTitle(
  route: "all" | RouteKind,
  status: "all" | LogStatusKind,
  hostFilter: string,
  totalLogs: number
): string {
  if (totalLogs === 0) {
    return "还没有请求经过。";
  }

  if (status === "error") {
    return "当前筛选条件下没有错误请求。";
  }

  if (status === "normal") {
    return "当前筛选条件下没有正常请求。";
  }

  if (hostFilter !== ALL_HOSTS_FILTER) {
    return "当前 Host 没有匹配日志。";
  }

  if (route === "all") {
    return "当前筛选条件下没有匹配日志。";
  }

  return route === "primary" ? "最近没有普通请求。" : route === "compact" ? "最近没有压缩请求。" : "最近没有 Claude 请求。";
}

function emptyLogHint(
  route: "all" | RouteKind,
  status: "all" | LogStatusKind,
  hostFilter: string,
  totalLogs: number
): string {
  if (totalLogs === 0) {
    return "把 Codex 的 base_url 指到 http://127.0.0.1:7865/v1 后，这里会实时出现路由记录。";
  }

  if (status !== "all") {
    return "状态、通道和 Host 计数会随其它筛选条件联动；切回“全部状态”可以查看完整匹配集。";
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


function profileScopeState(config: PublicConfig, scope: ConfigProfileScope) {
  return config.profile_scopes?.[scope] ?? {
    profiles: scope === "codex" ? config.profiles : [],
    active_profile_id: scope === "codex" ? config.active_profile_id : null
  };
}

function profileSummary(profile: PublicConfig["profiles"][number]): string {
  const secretCopy =
    profile.stored_api_key_count > 0
      ? `含 ${profile.stored_api_key_count} 个直填密钥`
      : "仅保存 URL 和环境变量引用";

  if (profile.scope === "claude") {
    const primaryModel = profile.claude_primary_model_override?.trim();
    const compactModel = profile.claude_compact_model_override?.trim();
    return [
      `Claude ${profile.claude_primary_host ?? "未配置"} / ${profile.claude_compact_host ?? "未配置"}`,
      `主模型 ${primaryModel || "透传"}`,
      `compact 模型 ${compactModel || "透传"}`,
      `Claude compact ${compactModeLabel(profile.claude_compact_upstream_mode ?? "primary")}`,
      secretCopy
    ].join("；");
  }

  return [
    `Codex ${profile.primary_host ?? "未配置"} / ${profile.compact_host ?? "未配置"}`,
    `Codex compact ${compactModeLabel(profile.compact_upstream_mode ?? "primary")}`,
    secretCopy
  ].join("；");
}

function profileActionLabel(state: ProfileActionState): string {
  switch (state) {
    case "saving":
      return "正在保存档案";
    case "saved":
      return "档案已保存";
    case "updating":
      return "正在更新档案";
    case "updated":
      return "档案已更新";
    case "duplicating":
      return "正在复制档案";
    case "duplicated":
      return "档案已复制";
    case "deleting":
      return "正在删除档案";
    case "deleted":
      return "档案已删除";
    case "applying":
      return "正在应用档案";
    case "applied":
      return "档案已应用";
    case "error":
      return "档案操作失败";
    case "idle":
      return "档案操作就绪";
  }
}

function isProfileActionBusy(state: ProfileActionState): boolean {
  return (
    state === "saving" ||
    state === "updating" ||
    state === "duplicating" ||
    state === "deleting" ||
    state === "applying"
  );
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
      compact: 0,
      claude: 0
    },
    provider_counts: {
      all: 0,
      openai: 0,
      claude: 0
    },
    status_counts: {
      all: 0,
      normal: 0,
      error: 0
    },
    host_counts: []
  };
}

async function fetchLogPage({
  route,
  status,
  host,
  limit,
  offset
}: {
  route: "all" | RouteKind;
  status: "all" | LogStatusKind;
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

  if (status !== "all") {
    params.set("status", status);
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
  statusFilter: "all" | LogStatusKind,
  hostFilter: string
): RequestLogPage {
  const duplicate = previous.logs.some((entry) => entry.request_id === nextEntry.request_id);
  const matchesFilter = logEntryMatchesFilter(nextEntry, routeFilter, statusFilter, hostFilter);
  const matchesRouteCountScope = logEntryMatchesFilter(nextEntry, "all", statusFilter, hostFilter);
  const matchesStatusCountScope = logEntryMatchesFilter(nextEntry, routeFilter, "all", hostFilter);
  const matchesHostCountScope = logEntryMatchesFilter(nextEntry, routeFilter, statusFilter, ALL_HOSTS_FILTER);
  const nextLogs = matchesFilter
    ? [nextEntry, ...previous.logs.filter((entry) => entry.request_id !== nextEntry.request_id)]
    : previous.logs;
  const nextRouteCounts = incrementRouteCounts(
    previous.counts,
    nextEntry.route,
    duplicate || !matchesRouteCountScope
  );

  return {
    ...previous,
    logs: nextLogs,
    total: previous.total + (matchesFilter && !duplicate ? 1 : 0),
    all_total: previous.all_total + (duplicate ? 0 : 1),
    counts: nextRouteCounts,
    provider_counts: incrementProviderCounts(
      previous.provider_counts,
      nextEntry.route,
      duplicate || !matchesRouteCountScope
    ),
    status_counts: incrementStatusCounts(
      previous.status_counts,
      logStatusKind(nextEntry),
      duplicate || !matchesStatusCountScope
    ),
    host_counts: incrementHostCounts(previous.host_counts, nextEntry, duplicate || !matchesHostCountScope)
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
  statusFilter: "all" | LogStatusKind,
  hostFilter: string
): boolean {
  const routeMatches = routeFilter === "all" || entry.route === routeFilter;
  const statusMatches = statusFilter === "all" || logStatusKind(entry) === statusFilter;
  const hostMatches = hostFilter === ALL_HOSTS_FILTER || entry.upstream_host === hostFilter;
  return routeMatches && statusMatches && hostMatches;
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

function incrementProviderCounts(
  counts: ProviderLogCounts,
  route: RouteKind,
  duplicate: boolean
): ProviderLogCounts {
  if (duplicate) {
    return counts;
  }

  const provider = routeProvider(route);
  return {
    ...counts,
    all: counts.all + 1,
    [provider]: counts[provider] + 1
  };
}

function incrementStatusCounts(
  counts: StatusLogCounts,
  status: LogStatusKind,
  skip: boolean
): StatusLogCounts {
  if (skip) {
    return counts;
  }

  return {
    ...counts,
    all: counts.all + 1,
    [status]: counts[status] + 1
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
      compact: entry.route === "compact" ? 1 : 0,
      claude: entry.route === "claude" ? 1 : 0
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
  upstream?: HealthRouteCredentialConfig | null
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

  const statuses = [
    upstreamHealthBadge(health.primary),
    upstreamHealthBadge(health.compact),
    upstreamHealthBadge(health.claude.primary),
    upstreamHealthBadge(health.claude.compact)
  ];

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
