import React, { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { PROVIDER_LABELS, routeLabel, routeProvider } from "../shared/route-meta.js";
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
  | "reordering"
  | "reordered"
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
type ProfileDropPosition = "before" | "after";
type ClaudeModelsResponse = { models: string[]; upstream_host: string; error: string | null };

const DEFAULT_BODY = JSON.stringify({ model: "gpt-5.5", stream: true }, null, 2);
const ALL_HOSTS_FILTER = "__all_hosts__";
const DEFAULT_LOG_PAGE_LIMIT = 200;
const LOG_LAZY_LOAD_THRESHOLD_PX = 220;
const LOG_STICKY_TOP_THRESHOLD_PX = 24;
const TOKEN_TOOLTIP_WIDTH = 350;
const TOKEN_TOOLTIP_ESTIMATED_HEIGHT = 216;
const LOG_TEXT_TOOLTIP_WIDTH = 420;
const LOG_TEXT_TOOLTIP_ESTIMATED_HEIGHT = 120;
const TOOLTIP_VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 10;
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
  const isLoadingMoreLogsRef = useRef(false);
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

  async function reorderProfiles(scope: ConfigProfileScope, profileIds: string[]) {
    const accessors = scopedProfileAccessors(scope);
    if (!config) {
      accessors.setState("error");
      accessors.setError("配置还没有加载完成。");
      return;
    }

    const currentIds = profileScopeState(config, scope).profiles.map((profile) => profile.id);
    if (
      profileIds.length !== currentIds.length ||
      profileIds.some((profileId) => !currentIds.includes(profileId)) ||
      new Set(profileIds).size !== profileIds.length
    ) {
      accessors.setState("error");
      accessors.setError("档案排序列表和当前配置不一致，请刷新后重试。");
      return;
    }

    if (profileIds.every((profileId, index) => profileId === currentIds[index])) {
      return;
    }

    accessors.setState("reordering");
    accessors.setError(null);

    try {
      const nextConfig = await api<PublicConfig>("/api/config/profiles/reorder", {
        method: "POST",
        body: JSON.stringify({
          scope,
          profile_ids: profileIds
        })
      });

      setConfig(nextConfig);
      const nextScope = profileScopeState(nextConfig, scope);
      const nextSelectedProfileId = accessors.selectedId && nextScope.profiles.some((profile) => profile.id === accessors.selectedId)
        ? accessors.selectedId
        : nextScope.active_profile_id ?? nextScope.profiles[0]?.id ?? "";
      accessors.setSelectedId(nextSelectedProfileId);
      accessors.setName(nextScope.profiles.find((profile) => profile.id === nextSelectedProfileId)?.name ?? "");
      accessors.setState("reordered");
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
    if (isLoadingMoreLogsRef.current || !logPage.has_more) {
      return;
    }

    isLoadingMoreLogsRef.current = true;
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
      isLoadingMoreLogsRef.current = false;
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
            onReorderProfiles={reorderProfiles}
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
          <div className="log-table log-table-summary">
            <div className="log-table-body" style={{ maxHeight: "300px" }}>
              <table className="log-table-grid">
                <tbody>
                  {logs.slice(0, 8).map((entry, i) => (
                    <tr key={`${entry.request_id}-${i}`} className="log-row">
                      <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)} /></td>
                      <td><LogTextTooltip className="log-cell-model" value={entry.source_model ?? "-"} /></td>
                      <td><span className={`log-status ${entry.status < 400 ? "is-ok" : "is-err"}`}>{entry.status}</span></td>
                      <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host} /></td>
                      <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
                      <td><span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span></td>
                      <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
                      <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.duration_ms)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
  onSaveProfile, onApplyProfile, onUpdateProfile, onReorderProfiles, onDuplicateProfile, onDeleteProfile,
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
  onReorderProfiles: (s: ConfigProfileScope, ids: string[]) => void | Promise<void>;
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
                onUpdateProfile={onUpdateProfile} onReorderProfiles={onReorderProfiles}
                onDuplicateProfile={onDuplicateProfile}
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
                onUpdateProfile={onUpdateProfile} onReorderProfiles={onReorderProfiles}
                onDuplicateProfile={onDuplicateProfile}
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
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const tableBodyRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef({
    firstLogId: null as string | null,
    scrollHeight: 0,
    scrollTop: 0
  });
  const autoLoadPendingRef = useRef(false);

  useEffect(() => {
    if (!isLoadingMoreLogs) {
      autoLoadPendingRef.current = false;
    }
  }, [isLoadingMoreLogs, logs.length]);

  useLayoutEffect(() => {
    const body = tableBodyRef.current;
    if (!body) {
      return;
    }

    const previous = scrollSnapshotRef.current;
    const firstLogId = logs[0]?.request_id ?? null;
    const previousFirstIndex = previous.firstLogId
      ? logs.findIndex((entry) => entry.request_id === previous.firstLogId)
      : -1;
    const liveLogsWerePrepended = previousFirstIndex > 0 && firstLogId !== previous.firstLogId;

    if (liveLogsWerePrepended && previous.scrollTop > LOG_STICKY_TOP_THRESHOLD_PX) {
      const delta = body.scrollHeight - previous.scrollHeight;
      if (delta > 0) {
        body.scrollTop = previous.scrollTop + delta;
      }
    }

    scrollSnapshotRef.current = {
      firstLogId,
      scrollHeight: body.scrollHeight,
      scrollTop: body.scrollTop
    };
  }, [logs]);

  function handleLogScroll(event: React.UIEvent<HTMLDivElement>) {
    const body = event.currentTarget;
    scrollSnapshotRef.current = {
      ...scrollSnapshotRef.current,
      scrollHeight: body.scrollHeight,
      scrollTop: body.scrollTop
    };

    const remainingScroll = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (
      remainingScroll <= LOG_LAZY_LOAD_THRESHOLD_PX &&
      hasMoreLogs &&
      !isLoadingLogs &&
      !isLoadingMoreLogs &&
      !autoLoadPendingRef.current
    ) {
      autoLoadPendingRef.current = true;
      onLoadMore();
    }
  }

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
        <div className="log-table log-table-full">
          <div
            ref={tableBodyRef}
            className="log-table-body"
            onScroll={handleLogScroll}
            aria-busy={isLoadingLogs || isLoadingMoreLogs}
          >
            <table className="log-table-grid">
              <thead>
                <tr className="log-table-header">
                  <th scope="col">时间</th>
                  <th scope="col">模型 / 通道</th>
                  <th scope="col">状态</th>
                  <th scope="col">模型 / 思考</th>
                  <th scope="col">上游 Host</th>
                  <th scope="col">端点</th>
                  <th scope="col">类型</th>
                  <th scope="col">Token</th>
                  <th scope="col">首 Token</th>
                  <th scope="col">耗时</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => {
                  const modelMapping = `${entry.source_model ?? "-"} -> ${entry.target_model ?? entry.source_model ?? "-"}`;
                  const hasRewrite = Boolean(entry.source_model && entry.target_model && entry.source_model !== entry.target_model);
                  const hasError = Boolean(entry.error_summary) || entry.status >= 400;
                  return (
                    <React.Fragment key={entry.request_id}>
                      <tr
                        className={`log-row is-clickable ${hasError ? "has-error" : ""}`}
                        onClick={() =>
                          setExpandedRequestId((currentId) => currentId === entry.request_id ? null : entry.request_id)
                        }
                      >
                        <td><LogTextTooltip className="log-cell-time" value={formatDateTime(entry.time)} /></td>
                        <td>
                          <LogTextTooltip className="log-model-cell" value={modelMapping}>
                            <span className={`route-chip ${entry.route}`}>{routeLabel(entry.route)}</span>
                            <strong>{entry.source_model ?? "-"}</strong>
                            {hasRewrite && <small>→ {entry.target_model}</small>}
                          </LogTextTooltip>
                        </td>
                        <td><span className={`log-status ${entry.status < 400 ? "is-ok" : "is-err"}`}>{entry.status}</span></td>
                        <td><LogTextTooltip className="log-cell-code" value={modelReasoningLabel(entry)} /></td>
                        <td><LogTextTooltip className="log-cell-code" value={entry.upstream_host} /></td>
                        <td><LogTextTooltip className="log-cell-code" value={entry.endpoint} /></td>
                        <td><span className={`log-transport ${entry.request_type}`}>{entry.request_type}</span></td>
                        <td><TokenTooltip entry={entry} /></td>
                        <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.first_token_ms)} /></td>
                        <td><LogTextTooltip className="log-cell-time" value={formatDurationMs(entry.duration_ms)} /></td>
                      </tr>
                      {expandedRequestId === entry.request_id && (
                        <tr className="log-detail-row">
                          <td colSpan={10}>
                            <div className="log-detail-panel">
                              <div className="log-detail-item is-wide">
                                <span className="log-detail-label">请求</span>
                                <span className="log-detail-value">{entry.method} {entry.path}</span>
                              </div>
                              <div className="log-detail-item is-wide">
                                <span className="log-detail-label">请求 ID</span>
                                <span className="log-detail-value is-small">{entry.request_id}</span>
                              </div>
                              <div className="log-detail-item is-wide">
                                <span className="log-detail-label">模型映射</span>
                                <span className="log-detail-value is-medium">{modelMapping}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">源模型</span>
                                <span className="log-detail-value is-medium">{entry.source_model ?? "-"}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">目标模型</span>
                                <span className="log-detail-value is-medium">{entry.target_model ?? entry.source_model ?? "-"}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">通道</span>
                                <span className="log-detail-value">{routeLabel(entry.route)} / {entry.route}</span>
                              </div>
                              <div className="log-detail-item is-wide">
                                <span className="log-detail-label">上游 / 端点</span>
                                <span className="log-detail-value">{entry.upstream_host}{entry.endpoint}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">上游 Host</span>
                                <span className="log-detail-value">{entry.upstream_host}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">端点</span>
                                <span className="log-detail-value">{entry.endpoint}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">状态 / 类型</span>
                                <span className="log-detail-value">{entry.status} / {entry.request_type}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">首 Token / 耗时</span>
                                <span className="log-detail-value">{formatDurationMs(entry.first_token_ms)} / {formatDurationMs(entry.duration_ms)}</span>
                              </div>
                              <div className="log-detail-item is-wide">
                                <span className="log-detail-label">请求摘要</span>
                                <span className="log-detail-value is-small">{entry.request_summary ?? "无"}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">推理强度</span>
                                <span className="log-detail-value is-small">{entry.reasoning_effort ?? "无"}</span>
                              </div>
                              <div className="log-detail-item is-full">
                                <span className="log-detail-label">User Agent</span>
                                <span className="log-detail-value is-tiny">{entry.user_agent ?? "-"}</span>
                              </div>
                              <div className="log-detail-item is-full">
                                <span className="log-detail-label">错误信息</span>
                                <span className="log-detail-value">{entry.error_summary ?? "无"}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">输入 Token</span>
                                <span className="log-detail-value">{formatMetricNumber(displayInputTokens(entry))}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">输出 Token</span>
                                <span className="log-detail-value">{formatMetricNumber(entry.output_tokens)}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">{hasAdditiveCachedInput(entry) ? "缓存读取 Token" : "缓存输入 Token"}</span>
                                <span className="log-detail-value">{formatMetricNumber(cacheReadInputTokens(entry))}</span>
                              </div>
                              {hasAdditiveCachedInput(entry) && (
                                <div className="log-detail-item">
                                  <span className="log-detail-label">缓存写入 Token</span>
                                  <span className="log-detail-value">{formatMetricNumber(cacheCreationInputTokens(entry))}</span>
                                </div>
                              )}
                              {hasAdditiveCachedInput(entry) && (
                                <div className="log-detail-item">
                                  <span className="log-detail-label">缓存合计 Token</span>
                                  <span className="log-detail-value">{formatMetricNumber(cachedInputTotalTokens(entry))}</span>
                                </div>
                              )}
                              <div className="log-detail-item">
                                <span className="log-detail-label">总输入 Token</span>
                                <span className="log-detail-value">{formatMetricNumber(totalInputTokens(entry))}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">缓存输出 Token</span>
                                <span className="log-detail-value">{formatMetricNumber(entry.cached_output_tokens)}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">推理 Token</span>
                                <span className="log-detail-value">{formatMetricNumber(entry.reasoning_tokens)}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">缓存命中率</span>
                                <span className="log-detail-value">{formatCacheHitRate(entry)}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">原始总 Token</span>
                                <span className="log-detail-value">{formatMetricNumber(entry.total_tokens)}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">展示总 Token</span>
                                <span className="log-detail-value">{formatMetricNumber(displayTotalTokens(entry))}</span>
                              </div>
                              <div className="log-detail-item">
                                <span className="log-detail-label">采样时间</span>
                                <span className="log-detail-value is-medium">{entry.time}</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hasMoreLogs && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button className="btn" onClick={onLoadMore} disabled={isLoadingMoreLogs}>
            {isLoadingMoreLogs ? "加载中..." : `加载更早日志 (${logs.length}/${totalLogCount})`}
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

type ConfigTab = "profiles" | "routes" | "model" | "preview";

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
  const claudePrimaryStatus = upstreamHealthBadge(health?.claude.primary);
  const claudeCompactStatus = upstreamHealthBadge(health?.claude.compact);
  const overallStatus = overallHealthBadge(health);
  const routeStatuses = [
    { label: "Codex 主路由", status: primaryStatus },
    { label: "Codex 压缩", status: compactStatus },
    { label: "Claude 主路由", status: claudePrimaryStatus },
    { label: "Claude 压缩", status: claudeCompactStatus }
  ];
  const readyRoutes = routeStatuses.filter((item) => item.status.tone === "good").length;
  const attentionRoutes = routeStatuses.filter((item) => item.status.tone === "warn").length;
  const failedRoutes = routeStatuses.filter((item) => item.status.tone === "bad").length;
  const listenUrl = health ? `http://${health.listen}` : "读取中...";
  const openAiEndpoint = health ? `http://${health.listen}/v1` : "等待健康数据";
  const claudeEndpoint = health ? `http://${health.listen}/anthropic` : "等待健康数据";

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
          <StatusPill label="Claude" status={claudePrimaryStatus} />
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

      <section className={`health-hero tone-${overallStatus.tone}`} aria-labelledby="health-title" aria-live="polite">
        <div className="health-hero-copy">
          <p className="eyebrow">实时健康</p>
          <h2 id="health-title">代理链路状态</h2>
          <p>
            聚合监听入口、上游地址和密钥来源，优先回答现在是否可以把 Codex 或 Claude 请求交给 CompactGate。
          </p>
        </div>

        <div className="health-status-board">
          <span className={`health-state-badge is-${overallStatus.tone}`}>总体</span>
          <strong>{overallStatus.label}</strong>
          <small>{health ? `刷新于 ${formatDateTime(health.time)}` : "等待首次健康采样"}</small>
        </div>

        <div className="health-hero-readout">
          <div className="health-mini-card">
            <span>可用上游</span>
            <strong>{readyRoutes}/4</strong>
            <small>{failedRoutes > 0 ? `${failedRoutes} 条异常` : attentionRoutes > 0 ? `${attentionRoutes} 条需要补全` : "所有路由已就绪"}</small>
          </div>
          <div className="health-mini-card">
            <span>监听地址</span>
            <strong>{listenUrl}</strong>
            <small>本地代理绑定入口</small>
          </div>
          <div className="health-mini-card">
            <span>最近刷新</span>
            <strong>{health ? formatDateTime(health.time) : "读取中..."}</strong>
            <small>{isRefreshing ? "正在重新采样" : "自动轮询中"}</small>
          </div>
        </div>
      </section>

      <section className="health-entry-grid" aria-label="代理入口">
        <div className="health-entry-card">
          <span>OpenAI 兼容入口</span>
          <code>{openAiEndpoint}</code>
          <small>Codex 普通请求和 compact 请求都从这里进入。</small>
        </div>
        <div className="health-entry-card is-claude">
          <span>Anthropic 兼容入口</span>
          <code>{claudeEndpoint}</code>
          <small>Claude Messages 与下一次手动 compact 使用这个入口。</small>
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
            route="claude"
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
            <div className={`health-check-row is-${health ? "good" : "warn"}`}>
              <span>01</span>
              <p>监听地址可见，说明代理进程已经启动并绑定到本地端口。</p>
            </div>
            <div className={`health-check-row is-${failedRoutes > 0 ? "bad" : "good"}`}>
              <span>02</span>
              <p>上游状态显示“已配置”，说明基础地址格式合法。</p>
            </div>
            <div className={`health-check-row is-${attentionRoutes > 0 ? "warn" : "good"}`}>
              <span>03</span>
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
    <section className={`panel health-card route-${route} tone-${status.tone}`} aria-label={`${title} 状态`}>
      <div className="health-card-head">
        <div>
          <p className="eyebrow">{summary}</p>
          <h2>{title}</h2>
        </div>
        <span className={`route-chip ${route}`}>{badgeLabel}</span>
      </div>

      <div className="health-card-status">
        <span className={`health-card-led is-${status.tone}`} aria-hidden="true" />
        <strong>{status.label}</strong>
        <small>{upstream?.host ?? "等待健康数据"}</small>
      </div>

      <div className="health-kv-grid">
        <div className="health-kv">
          <span>Base URL</span>
          <strong>{upstream?.base_url ?? "读取中..."}</strong>
        </div>
        <div className="health-kv">
          <span>Host</span>
          <strong>{upstream?.host ?? "无"}</strong>
        </div>
        <div className="health-kv">
          <span>密钥来源</span>
          <strong>{credentialSourceLabel(upstream?.api_key_source)}</strong>
        </div>
        <div className="health-kv">
          <span>直填密钥</span>
          <strong>{upstream?.stored_api_key ? "已保存" : "未保存"}</strong>
        </div>
      </div>

      <div className="health-kv is-wide">
        <span>当前读取</span>
        <strong>{activeCredentialLabel(credentialScope, upstream)}</strong>
      </div>

      <div className={`health-flag ${upstream?.api_key_configured ? "is-good" : "is-warn"}`}>
        <span className="health-led" aria-hidden="true" />
        {credentialFlagCopy(credentialScope, upstream)}
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
  onReorderProfiles,
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
  onReorderProfiles: (scope: ConfigProfileScope, profileIds: string[]) => void | Promise<void>;
  onDuplicateProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
  onDeleteProfile: (scope: ConfigProfileScope, profileId?: string) => void | Promise<void>;
}) {
  const titleId = `${scope}-profile-card-title`;
  const scopeState = config ? profileScopeState(config, scope) : { profiles: [], active_profile_id: null };
  const profiles = scopeState.profiles;
  const activeProfile = profiles.find((profile) => profile.id === scopeState.active_profile_id) ?? null;
  const profileBusy = isProfileActionBusy(profileState);
  const scopeLabel = scope === "codex" ? "Codex" : "Claude";
  const profileListRef = useRef<HTMLDivElement | null>(null);
  const profileAutoScrollRef = useRef<{ frame: number | null; speed: number }>({
    frame: null,
    speed: 0
  });
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ profileId: string; position: ProfileDropPosition } | null>(null);
  const canReorderProfiles = profiles.length > 1 && !profileBusy;

  useEffect(() => () => stopProfileAutoScroll(), []);

  function nextProfileOrder(
    draggedId: string,
    targetId: string,
    position: ProfileDropPosition
  ): string[] | null {
    if (draggedId === targetId) {
      return null;
    }

    const currentIds = profiles.map((profile) => profile.id);
    if (!currentIds.includes(draggedId) || !currentIds.includes(targetId)) {
      return null;
    }

    const withoutDragged = currentIds.filter((profileId) => profileId !== draggedId);
    const targetIndex = withoutDragged.indexOf(targetId);
    if (targetIndex < 0) {
      return null;
    }

    const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
    const nextIds = [...withoutDragged];
    nextIds.splice(insertIndex, 0, draggedId);

    return nextIds.every((profileId, index) => profileId === currentIds[index]) ? null : nextIds;
  }

  function dropPositionForEvent(event: React.DragEvent<HTMLElement>): ProfileDropPosition {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
  }

  function stopProfileAutoScroll() {
    const frame = profileAutoScrollRef.current.frame;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      profileAutoScrollRef.current.frame = null;
    }
    profileAutoScrollRef.current.speed = 0;
  }

  function runProfileAutoScroll() {
    const list = profileListRef.current;
    const speed = profileAutoScrollRef.current.speed;
    if (!list || speed === 0) {
      stopProfileAutoScroll();
      return;
    }

    const previousScrollTop = list.scrollTop;
    list.scrollTop += speed;
    if (list.scrollTop === previousScrollTop) {
      stopProfileAutoScroll();
      return;
    }

    profileAutoScrollRef.current.frame = window.requestAnimationFrame(runProfileAutoScroll);
  }

  function startProfileAutoScroll(speed: number) {
    profileAutoScrollRef.current.speed = speed;
    if (profileAutoScrollRef.current.frame === null) {
      profileAutoScrollRef.current.frame = window.requestAnimationFrame(runProfileAutoScroll);
    }
  }

  function updateProfileAutoScroll(event: React.DragEvent<HTMLElement>) {
    const list = profileListRef.current;
    if (!list || list.scrollHeight <= list.clientHeight) {
      stopProfileAutoScroll();
      return;
    }

    const bounds = list.getBoundingClientRect();
    const edgeSize = Math.min(112, Math.max(56, bounds.height * 0.42));
    const distanceFromTop = event.clientY - bounds.top;
    const distanceFromBottom = bounds.bottom - event.clientY;
    const maxSpeed = 8;

    if (distanceFromTop < edgeSize) {
      const intensity = 1 - Math.max(0, distanceFromTop) / edgeSize;
      startProfileAutoScroll(-Math.max(2, Math.round(maxSpeed * intensity * intensity)));
      return;
    }

    if (distanceFromBottom < edgeSize) {
      const intensity = 1 - Math.max(0, distanceFromBottom) / edgeSize;
      startProfileAutoScroll(Math.max(2, Math.round(maxSpeed * intensity * intensity)));
      return;
    }

    stopProfileAutoScroll();
  }

  function resetDragState() {
    stopProfileAutoScroll();
    setDraggedProfileId(null);
    setDropTarget(null);
  }

  function handleProfileDragStart(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (!canReorderProfiles) {
      event.preventDefault();
      return;
    }

    const card = event.currentTarget.closest(".profile-item") as HTMLElement | null;
    if (card) {
      const bounds = card.getBoundingClientRect();
      event.dataTransfer.setDragImage(card, event.clientX - bounds.left, event.clientY - bounds.top);
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", profileId);
    setDraggedProfileId(profileId);
    setDropTarget(null);
  }

  function handleProfileListDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!draggedProfileId || !canReorderProfiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateProfileAutoScroll(event);
  }

  function handleProfileListDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    stopProfileAutoScroll();
  }

  function handleProfileDragOver(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (!draggedProfileId || !canReorderProfiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateProfileAutoScroll(event);
    if (draggedProfileId === profileId) {
      setDropTarget(null);
      return;
    }

    setDropTarget({
      profileId,
      position: dropPositionForEvent(event)
    });
  }

  function handleProfileDragLeave(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setDropTarget((current) => current?.profileId === profileId ? null : current);
  }

  function handleProfileDrop(event: React.DragEvent<HTMLElement>, profileId: string) {
    event.preventDefault();

    const draggedId = draggedProfileId ?? event.dataTransfer.getData("text/plain");
    const position = dropTarget?.profileId === profileId
      ? dropTarget.position
      : dropPositionForEvent(event);
    const nextIds = nextProfileOrder(draggedId, profileId, position);

    resetDragState();
    if (nextIds) {
      void onReorderProfiles(scope, nextIds);
    }
  }

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
        <div
          ref={profileListRef}
          className={`profile-list${draggedProfileId ? " is-reordering" : ""}`}
          aria-label={`已保存 ${scopeLabel} 配置档案`}
          onDragOver={handleProfileListDragOver}
          onDragLeave={handleProfileListDragLeave}
        >
          {profiles.map((profile) => {
            const isActive = profile.id === scopeState.active_profile_id;
            const isSelected = profile.id === selectedProfileId;
            const updateLabel = isActive ? "保存并应用" : "保存档案";
            const busyUpdateLabel = isActive ? "应用中..." : "保存中...";
            const cardClassName = [
              "profile-item",
              isActive ? "is-active" : "",
              isSelected ? "is-selected" : "",
              draggedProfileId === profile.id ? "is-dragging" : "",
              dropTarget?.profileId === profile.id ? `is-drop-${dropTarget.position}` : ""
            ].filter(Boolean).join(" ");

            return (
	              <article
	                key={profile.id}
	                className={cardClassName}
	                onDragOver={(event) => handleProfileDragOver(event, profile.id)}
	                onDragLeave={(event) => handleProfileDragLeave(event, profile.id)}
	                onDrop={(event) => handleProfileDrop(event, profile.id)}
	              >
	                <button
	                  className="profile-item-handle"
	                  type="button"
	                  draggable={canReorderProfiles}
	                  disabled={!canReorderProfiles}
	                  aria-label={`拖动排序 ${profile.name}`}
	                  tabIndex={-1}
	                  title="拖动排序"
	                  onDragStart={(event) => handleProfileDragStart(event, profile.id)}
	                  onDragEnd={resetDragState}
	                >
                  <span aria-hidden="true">≡</span>
                </button>
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

    setPlacement(getTooltipPlacement(anchor, {
      align: "end",
      estimatedHeight: TOKEN_TOOLTIP_ESTIMATED_HEIGHT,
      fixedWidth: true,
      width: TOKEN_TOOLTIP_WIDTH
    }));
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
            className="portal-tooltip-panel token-tooltip-panel"
            id={tooltipId}
            role="tooltip"
            style={placement}
          >
            <strong className="token-tooltip-title">Token 明细</strong>
            <span className="token-tooltip-row">
              <em>输入 Token</em>
              <b>{formatMetricNumber(displayInputTokens(entry))}</b>
            </span>
            <span className="token-tooltip-row">
              <em>输出 Token</em>
              <b>{formatMetricNumber(entry.output_tokens)}</b>
            </span>
            <span className="token-tooltip-row">
              <em>推理 Token</em>
              <b>{formatMetricNumber(entry.reasoning_tokens)}</b>
            </span>
            <span className="token-tooltip-row">
              <em>{hasAdditiveCachedInput(entry) ? "缓存读取" : "缓存输入 Token"}</em>
              <b>{formatMetricNumber(cacheReadInputTokens(entry))}</b>
            </span>
            {hasAdditiveCachedInput(entry) && (
              <span className="token-tooltip-row">
                <em>缓存写入</em>
                <b>{formatMetricNumber(cacheCreationInputTokens(entry))}</b>
              </span>
            )}
            <span className="token-tooltip-row">
              <em>总输入 Token</em>
              <b>{formatMetricNumber(totalInputTokens(entry))}</b>
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

function LogTextTooltip({
  value,
  tooltip,
  className,
  children
}: {
  value: string;
  tooltip?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const [placement, setPlacement] = useState<React.CSSProperties | null>(null);
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipText = tooltip ?? value;

  function showTooltip() {
    const anchor = anchorRef.current;
    if (!anchor || !tooltipText || tooltipText === "-") {
      return;
    }

    setPlacement(getTooltipPlacement(anchor, {
      align: "start",
      estimatedHeight: LOG_TEXT_TOOLTIP_ESTIMATED_HEIGHT,
      fixedWidth: false,
      width: estimateLogTextTooltipWidth(tooltipText)
    }));
  }

  function hideTooltip() {
    setPlacement(null);
  }

  return (
    <>
      <span
        ref={anchorRef}
        className={className}
        aria-describedby={placement ? tooltipId : undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {children ?? value}
      </span>
      {placement &&
        createPortal(
          <span
            className="portal-tooltip-panel log-text-tooltip-panel"
            id={tooltipId}
            role="tooltip"
            style={placement}
          >
            {tooltipText}
          </span>,
          document.body
        )}
    </>
  );
}

function getTooltipPlacement(
  anchor: HTMLElement,
  {
    align,
    estimatedHeight,
    fixedWidth,
    width
  }: {
    align: "start" | "end";
    estimatedHeight: number;
    fixedWidth: boolean;
    width: number;
  }
): React.CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const maxWidth = Math.max(160, window.innerWidth - TOOLTIP_VIEWPORT_PADDING * 2);
  const tooltipWidth = Math.min(width, maxWidth);
  const targetLeft = align === "end" ? rect.right - tooltipWidth : rect.left;
  const left = clamp(
    targetLeft,
    TOOLTIP_VIEWPORT_PADDING,
    window.innerWidth - tooltipWidth - TOOLTIP_VIEWPORT_PADDING
  );
  const availableBelow = window.innerHeight - rect.bottom - TOOLTIP_VIEWPORT_PADDING;
  const availableAbove = rect.top - TOOLTIP_VIEWPORT_PADDING;
  const showBelow = availableBelow >= estimatedHeight || availableBelow >= availableAbove;
  const availableHeight = Math.max(
    96,
    showBelow ? availableBelow - TOOLTIP_GAP : availableAbove - TOOLTIP_GAP
  );
  const top = showBelow
    ? rect.bottom + TOOLTIP_GAP
    : Math.max(TOOLTIP_VIEWPORT_PADDING, rect.top - Math.min(estimatedHeight, availableHeight) - TOOLTIP_GAP);

  const placement: React.CSSProperties = {
    left,
    top,
    maxHeight: availableHeight
  };

  if (fixedWidth) {
    placement.width = tooltipWidth;
  } else {
    placement.maxWidth = tooltipWidth;
  }

  return placement;
}

function estimateLogTextTooltipWidth(text: string): number {
  const estimatedCharacterWidth = 8;
  const horizontalPadding = 28;
  const contentWidth = text.length * estimatedCharacterWidth + horizontalPadding;
  return clamp(contentWidth, 96, LOG_TEXT_TOOLTIP_WIDTH);
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

function modelReasoningLabel(entry: RequestLogEntry): string {
  const model = entry.target_model ?? entry.source_model ?? (entry.route === "claude" ? "Claude" : "model");
  const reasoning = entry.reasoning_effort ?? "standard";
  return `${model}\u2009·\u2009${reasoning}`;
}

function logStatusKind(entry: RequestLogEntry): LogStatusKind {
  return entry.status >= 400 || Boolean(entry.error_summary) ? "error" : "normal";
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

function displayInputTokens(entry: RequestLogEntry): number | null {
  if (entry.input_tokens === null && entry.cache_creation_input_tokens === null) {
    return null;
  }

  return hasAdditiveCachedInput(entry)
    ? (entry.input_tokens ?? 0) + (entry.cache_creation_input_tokens ?? 0)
    : entry.input_tokens;
}

function cacheReadInputTokens(entry: RequestLogEntry): number | null {
  if (entry.cache_read_input_tokens !== null) {
    return entry.cache_read_input_tokens;
  }

  if (entry.cached_input_tokens === null) {
    return null;
  }

  if (!hasAdditiveCachedInput(entry)) {
    return entry.cached_input_tokens;
  }

  return Math.max(0, entry.cached_input_tokens - (entry.cache_creation_input_tokens ?? 0));
}

function cacheCreationInputTokens(entry: RequestLogEntry): number | null {
  return hasAdditiveCachedInput(entry) ? entry.cache_creation_input_tokens : null;
}

function cachedInputTotalTokens(entry: RequestLogEntry): number | null {
  if (entry.cached_input_tokens !== null) {
    return entry.cached_input_tokens;
  }

  const cacheReadTokens = entry.cache_read_input_tokens;
  const cacheCreationTokens = entry.cache_creation_input_tokens;
  if (cacheReadTokens === null && cacheCreationTokens === null) {
    return null;
  }

  return (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);
}

function totalInputTokens(entry: RequestLogEntry): number | null {
  if (
    entry.input_tokens === null &&
    entry.cached_input_tokens === null &&
    entry.cache_read_input_tokens === null &&
    entry.cache_creation_input_tokens === null
  ) {
    return null;
  }

  return hasAdditiveCachedInput(entry)
    ? (entry.input_tokens ?? 0) + (cacheReadInputTokens(entry) ?? 0) + (entry.cache_creation_input_tokens ?? 0)
    : entry.input_tokens;
}

function formatCacheHitRate(entry: RequestLogEntry): string {
  const cachedInputTokens = hasAdditiveCachedInput(entry)
    ? cacheReadInputTokens(entry)
    : entry.cached_input_tokens;
  if (cachedInputTokens === null) {
    return "-";
  }

  const denominator = hasAdditiveCachedInput(entry)
    ? totalInputTokens(entry)
    : entry.input_tokens;
  if (!denominator) {
    return "-";
  }

  const rate = Math.min(100, (cachedInputTokens / denominator) * 100);
  return `${formatPercentRate(rate)}%`;
}

function formatPercentRate(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value >= 99 ? value.toFixed(2) : value.toFixed(1);
}

function displayTotalTokens(entry: RequestLogEntry): number | null {
  const inputTokens = entry.input_tokens ?? 0;
  const outputTokens = entry.output_tokens ?? 0;
  const cachedInputTokens = cachedInputTotalTokens(entry) ?? 0;
  const cachedOutputTokens = entry.cached_output_tokens ?? 0;
  const hasAnyToken =
    entry.input_tokens !== null ||
    entry.output_tokens !== null ||
    entry.cached_input_tokens !== null ||
    entry.cache_read_input_tokens !== null ||
    entry.cache_creation_input_tokens !== null ||
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
  return entry.additive_cached_input_tokens ||
    (
      entry.cached_input_tokens !== null &&
      entry.input_tokens !== null &&
      entry.cached_input_tokens > entry.input_tokens
    );
}

function hasAdditiveCachedOutput(entry: RequestLogEntry): boolean {
  return entry.additive_cached_output_tokens;
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
    case "reordering":
      return "正在保存排序";
    case "reordered":
      return "档案排序已保存";
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
    state === "reordering" ||
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
