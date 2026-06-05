import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { routeLabel } from "../shared/route-meta.js";
import type {
  CompactGateConfig,
  ConfigProfileScope,
  CredentialScope,
  CredentialSource,
  HealthResponse,
  LogStatusKind,
  ProviderLogCounts,
  PublicConfig,
  RequestLogEntry,
  RequestLogPage,
  RouteKind,
  RoutePreviewResponse,
  StudioLogEvent,
  StudioSnapshotEvent
} from "../shared/types.js";
import { ConfigPage } from "./config/ConfigPage.js";
import { emptyClaudeModelMap, normalizeClaudeModelMap } from "./config/model-map.js";
import { profileScopeState } from "./config/profile-utils.js";
import { saveLabel } from "./config/save-state.js";
import type {
  ConfigFormState,
  ConfigTab,
  ProfileActionState,
  ProfileDeleteCandidate,
  PublicConfigProfile,
  SaveState
} from "./config/types.js";
import { LogsPage } from "./logs/LogsPage.js";
import {
  ALL_HOSTS_FILTER,
  appendLogPage,
  buildHostFilterOptions,
  DEFAULT_LOG_PAGE_LIMIT,
  emptyLogPage,
  fetchLogPage,
  mergeLiveLogPage,
  mergeSnapshotLogPage
} from "./logs/log-utils.js";
import { api, errorSummary } from "./shared/api.js";
import { formatDateTime, formatDurationMs } from "./shared/format.js";
import { LogTextTooltip } from "./logs/LogTooltips.js";
import "./styles.css";

type ThemeMode = "auto" | "light" | "dark";

type HealthTone = "good" | "warn" | "bad";

type HealthBadge = {
  label: string;
  tone: HealthTone;
};

type HealthRouteCredentialConfig =
  | HealthResponse["primary"]
  | HealthResponse["compact"]
  | HealthResponse["claude"]["primary"]
  | HealthResponse["claude"]["compact"];

const DEFAULT_BODY = JSON.stringify({ model: "gpt-5.5", stream: true }, null, 2);

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
  const [configTab, setConfigTab] = useState<ConfigTab>("profiles");

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
      const savedProfileIsActive = Boolean(
        savedProfile?.id && savedProfile.id === nextScope.active_profile_id
      );
      const nextHealth = savedProfileIsActive
        ? await api<HealthResponse>("/api/health", { method: "GET" })
        : null;

      setConfig(nextConfig);
      if (nextHealth) {
        setHealth(nextHealth);
        setForm(formFromConfig(nextConfig));
        setSaveError(null);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1600);
      }
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
      const profileIsActive = targetProfileId === nextScope.active_profile_id;
      const nextHealth = profileIsActive
        ? await api<HealthResponse>("/api/health", { method: "GET" })
        : null;

      setConfig(nextConfig);
      if (nextHealth) {
        setHealth(nextHealth);
        setForm(formFromConfig(nextConfig));
        setSaveError(null);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1600);
      }
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
  upstream?: HealthRouteCredentialConfig | null
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

createRoot(document.getElementById("root")!).render(<App />);
