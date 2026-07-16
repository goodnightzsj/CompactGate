import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  HealthResponse,
  LogStatusKind,
  PublicConfig,
  RequestLogPage,
  RouteKind,
  StudioLogEvent,
  StudioSnapshotEvent
} from "../../shared/types.js";
import {
  ALL_HOSTS_FILTER,
  appendLogPage,
  buildHostFilterOptions,
  DEFAULT_LOG_PAGE_LIMIT,
  emptyLogPage,
  fetchLogPage,
  mergeLiveLogPage,
  mergeSnapshotLogPage,
  replayLiveLogEvents
} from "../logs/log-utils.js";
import {
  isCurrentLogPageRequest,
  isCurrentLogRequest,
  type LogPageQuery,
  logPageQueryKey
} from "../logs/log-feed-query.js";
import { errorSummary } from "../shared/api.js";

const STREAM_RECONNECTING_MESSAGE = "实时日志流暂时断开，浏览器正在重连。";

interface PendingLogLoad {
  generation: number;
  query: LogPageQuery;
  liveEvents: StudioLogEvent[];
  snapshot: RequestLogPage | null;
}

export function useLogFeed({
  enabled,
  hasConfig,
  logPageLimit,
  applyRemoteConfig,
  setHealth
}: {
  enabled: boolean;
  hasConfig: boolean;
  logPageLimit: number;
  applyRemoteConfig: (config: PublicConfig) => void;
  setHealth: React.Dispatch<React.SetStateAction<HealthResponse | null>>;
}) {
  const [logPage, setLogPage] = useState<RequestLogPage>(() => emptyLogPage(DEFAULT_LOG_PAGE_LIMIT));
  const [routeFilter, setRouteFilter] = useState<"all" | RouteKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | LogStatusKind>("all");
  const [hostFilter, setHostFilter] = useState(ALL_HOSTS_FILTER);
  const [logError, setLogError] = useState<string | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [isLoadingMoreLogs, setIsLoadingMoreLogs] = useState(false);
  const isLoadingLogsRef = useRef(false);
  const isLoadingMoreLogsRef = useRef(false);
  const generationRef = useRef(0);
  const loadMoreRequestIdRef = useRef(0);
  const pendingLogLoadRef = useRef<PendingLogLoad | null>(null);
  const appliedQueryRef = useRef<LogPageQuery>({
    route: "all",
    status: "all",
    host: ALL_HOSTS_FILTER,
    limit: DEFAULT_LOG_PAGE_LIMIT
  });
  const [pageQueryKey, setPageQueryKey] = useState(() => logPageQueryKey(appliedQueryRef.current));

  const deferredFilter = useDeferredValue(routeFilter);
  const deferredStatusFilter = useDeferredValue(statusFilter);
  const deferredHostFilter = useDeferredValue(hostFilter);
  const hostOptions = useMemo(
    () => buildHostFilterOptions(logPage.host_counts, hostFilter),
    [logPage.host_counts, hostFilter]
  );

  useEffect(() => {
    if (!enabled || !hasConfig) {
      isLoadingLogsRef.current = false;
      pendingLogLoadRef.current = null;
      setIsLoadingLogs(false);
      return;
    }

    let cancelled = false;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    loadMoreRequestIdRef.current += 1;
    isLoadingMoreLogsRef.current = false;
    setIsLoadingMoreLogs(false);
    const query: LogPageQuery = {
      route: deferredFilter,
      status: deferredStatusFilter,
      host: deferredHostFilter,
      limit: logPageLimit
    };
    isLoadingLogsRef.current = true;
    pendingLogLoadRef.current = {
      generation,
      query,
      liveEvents: [],
      snapshot: null
    };

    async function loadLogs() {
      setIsLoadingLogs(true);

      try {
        const nextPage = await fetchLogPage({
          ...query,
          offset: 0
        });

        if (!cancelled && isCurrentLogRequest(generation, generationRef.current)) {
          const pendingLoad = pendingLogLoadRef.current;
          let resolvedPage = nextPage;
          if (pendingLoad?.generation === generation) {
            if (pendingLoad.snapshot) {
              resolvedPage = mergeSnapshotLogPage(resolvedPage, pendingLoad.snapshot);
            }
            resolvedPage = replayLiveLogEvents(
              resolvedPage,
              pendingLoad.liveEvents,
              query.route,
              query.status,
              query.host
            );
            pendingLogLoadRef.current = null;
          }
          appliedQueryRef.current = query;
          setLogPage(resolvedPage);
          setPageQueryKey(logPageQueryKey(query));
          setLogError(null);
        }
      } catch (error) {
        if (!cancelled && isCurrentLogRequest(generation, generationRef.current)) {
          pendingLogLoadRef.current = null;
          setLogError(errorSummary(error));
        }
      } finally {
        if (!cancelled && isCurrentLogRequest(generation, generationRef.current)) {
          isLoadingLogsRef.current = false;
          setIsLoadingLogs(false);
        }
      }
    }

    void loadLogs();

    return () => {
      cancelled = true;
    };
  }, [deferredFilter, deferredStatusFilter, deferredHostFilter, enabled, hasConfig, logPageLimit]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let closed = false;
    let refreshRequestId = 0;

    async function refreshAppliedLogPage(isStillRelevant: () => boolean): Promise<boolean> {
      const generation = generationRef.current;
      const query = appliedQueryRef.current;
      const requestId = refreshRequestId + 1;
      refreshRequestId = requestId;
      try {
        const nextPage = await fetchLogPage({
          ...query,
          offset: 0
        });
        if (
          !closed &&
          isStillRelevant() &&
          isCurrentLogPageRequest(
            generation,
            generationRef.current,
            query,
            appliedQueryRef.current,
            requestId,
            refreshRequestId
          )
        ) {
          setLogPage(nextPage);
          setLogError(null);
          return true;
        }
      } catch (error) {
        if (
          !closed &&
          isStillRelevant() &&
          isCurrentLogPageRequest(
            generation,
            generationRef.current,
            query,
            appliedQueryRef.current,
            requestId,
            refreshRequestId
          )
        ) {
          setLogError(errorSummary(error));
        }
      }
      return false;
    }

    if (typeof window.EventSource !== "function") {
      setLogError("当前浏览器不支持 SSE，已回退为轮询刷新。");
      const interval = window.setInterval(() => {
        void refreshAppliedLogPage(() => true);
      }, 2500);

      return () => {
        closed = true;
        window.clearInterval(interval);
      };
    }

    const stream = new EventSource("/api/events");
    let streamInterrupted = false;
    let pollingFallbackActive = false;

    async function pollWhileStreamInterrupted() {
      if (!streamInterrupted || closed) {
        return;
      }

      if (await refreshAppliedLogPage(() => streamInterrupted)) {
        pollingFallbackActive = true;
      }
    }

    const recoveryPollTimer = window.setInterval(() => {
      void pollWhileStreamInterrupted();
    }, 2500);

    function markStreamConnected() {
      streamInterrupted = false;
      pollingFallbackActive = false;
      setLogError(null);
    }

    const handleOpen = () => {
      markStreamConnected();
    };
    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as StudioSnapshotEvent;
        applyRemoteConfig(snapshot.config);
        setHealth(snapshot.health);
        const pendingLoad = pendingLogLoadRef.current;
        if (
          pendingLoad?.generation === generationRef.current &&
          pendingLoad.query.route === "all" &&
          pendingLoad.query.status === "all" &&
          pendingLoad.query.host === ALL_HOSTS_FILTER
        ) {
          pendingLoad.snapshot = snapshot.log_page;
        }
        if (
          appliedQueryRef.current.route === "all" &&
          appliedQueryRef.current.status === "all" &&
          appliedQueryRef.current.host === ALL_HOSTS_FILTER
        ) {
          setLogPage((previous) => mergeSnapshotLogPage(previous, snapshot.log_page));
        }
        markStreamConnected();
      } catch (error) {
        setLogError(errorSummary(error));
      }
    };
    const handleLog = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as StudioLogEvent;
        const pendingLoad = pendingLogLoadRef.current;
        if (pendingLoad?.generation === generationRef.current) {
          pendingLoad.liveEvents.push(payload);
        }
        const appliedQuery = appliedQueryRef.current;
        setLogPage((previous) =>
          mergeLiveLogPage(
            previous,
            payload.entry,
            appliedQuery.route,
            appliedQuery.status,
            appliedQuery.host,
            payload.operation ?? "insert"
          )
        );
        markStreamConnected();
      } catch (error) {
        setLogError(errorSummary(error));
      }
    };
    const handleError = () => {
      streamInterrupted = true;
      if (!pollingFallbackActive) {
        setLogError(STREAM_RECONNECTING_MESSAGE);
      }
      void pollWhileStreamInterrupted();
    };

    stream.addEventListener("open", handleOpen);
    stream.addEventListener("snapshot", handleSnapshot as EventListener);
    stream.addEventListener("log", handleLog as EventListener);
    stream.addEventListener("error", handleError as EventListener);

    return () => {
      closed = true;
      window.clearInterval(recoveryPollTimer);
      stream.removeEventListener("open", handleOpen);
      stream.removeEventListener("snapshot", handleSnapshot as EventListener);
      stream.removeEventListener("log", handleLog as EventListener);
      stream.removeEventListener("error", handleError as EventListener);
      stream.close();
    };
  }, [
    enabled,
    applyRemoteConfig,
    setHealth
  ]);

  async function loadMoreLogs() {
    if (isLoadingLogsRef.current || isLoadingMoreLogsRef.current || !logPage.has_more) {
      return;
    }

    isLoadingMoreLogsRef.current = true;
    setIsLoadingMoreLogs(true);
    const generation = generationRef.current;
    const requestId = loadMoreRequestIdRef.current + 1;
    loadMoreRequestIdRef.current = requestId;
    const query = appliedQueryRef.current;

    try {
      const nextPage = await fetchLogPage({
        ...query,
        offset: logPage.logs.length
      });
      if (isCurrentLogPageRequest(
        generation,
        generationRef.current,
        query,
        appliedQueryRef.current,
        requestId,
        loadMoreRequestIdRef.current
      )) {
        setLogPage((previous) => appendLogPage(previous, nextPage));
        setLogError(null);
      }
    } catch (error) {
      if (isCurrentLogPageRequest(
        generation,
        generationRef.current,
        query,
        appliedQueryRef.current,
        requestId,
        loadMoreRequestIdRef.current
      )) {
        setLogError(errorSummary(error));
      }
    } finally {
      if (isCurrentLogPageRequest(
        generation,
        generationRef.current,
        query,
        appliedQueryRef.current,
        requestId,
        loadMoreRequestIdRef.current
      )) {
        isLoadingMoreLogsRef.current = false;
        setIsLoadingMoreLogs(false);
      }
    }
  }

  return {
    logPage,
    pageQueryKey,
    routeFilter,
    setRouteFilter,
    statusFilter,
    setStatusFilter,
    hostFilter,
    setHostFilter,
    hostOptions,
    logError,
    isLoadingLogs,
    isLoadingMoreLogs,
    loadMoreLogs
  };
}
