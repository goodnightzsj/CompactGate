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

export function mergeCodexStatusIntoHealth(
  health: HealthResponse | null,
  event: StudioLogEvent
): HealthResponse | null {
  return health && event.codex_status
    ? { ...health, codex: event.codex_status }
    : health;
}

interface PendingLogLoad {
  generation: number;
  query: LogPageQuery;
  liveEvents: StudioLogEvent[];
  snapshot: RequestLogPage | null;
}

interface LogRequestError {
  message: string;
  queryKey: string;
  operation: "first-page" | "refresh" | "more";
}

function isUnfilteredQuery(query: LogPageQuery): boolean {
  return query.route === "all" && query.status === "all" &&
    query.host === ALL_HOSTS_FILTER && query.search === "";
}

function resolvePendingLogPage(page: RequestLogPage, pending: PendingLogLoad): RequestLogPage {
  const { query } = pending;
  return replayLiveLogEvents(
    pending.snapshot ? mergeSnapshotLogPage(page, pending.snapshot) : page,
    pending.liveEvents,
    query.route,
    query.status,
    query.host,
    query.search
  );
}

interface LogPresentationState {
  page: RequestLogPage;
  syncVersion: number;
  liveInsertIds: string[];
}

export function useLogFeed({
  enabled,
  hasConfig,
  logPageLimit,
  applyRemoteConfig,
  onServerRecovered,
  setHealth
}: {
  enabled: boolean;
  hasConfig: boolean;
  logPageLimit: number;
  applyRemoteConfig: (config: PublicConfig) => void;
  /** A page that answers proves the proxy is back, not just the log feed. */
  onServerRecovered: () => void;
  setHealth: React.Dispatch<React.SetStateAction<HealthResponse | null>>;
}) {
  const [logState, setLogState] = useState<LogPresentationState>(() => ({
    page: emptyLogPage(DEFAULT_LOG_PAGE_LIMIT),
    syncVersion: 0,
    liveInsertIds: []
  }));
  const [routeFilter, setRouteFilter] = useState<"all" | RouteKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | LogStatusKind>("all");
  const [hostFilter, setHostFilter] = useState(ALL_HOSTS_FILTER);
  const [searchFilter, setSearchFilter] = useState("");
  const [requestError, setRequestError] = useState<LogRequestError | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
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
    search: "",
    limit: DEFAULT_LOG_PAGE_LIMIT
  });
  const [pageQueryKey, setPageQueryKey] = useState(() => logPageQueryKey(appliedQueryRef.current));
  const hasStaleLogs = pageQueryKey !== logPageQueryKey({
    route: routeFilter, status: statusFilter, host: hostFilter, search: searchFilter, limit: logPageLimit
  });

  const logPage = logState.page;

  const deferredFilter = useDeferredValue(routeFilter);
  const deferredStatusFilter = useDeferredValue(statusFilter);
  const deferredHostFilter = useDeferredValue(hostFilter);
  const deferredSearchFilter = useDeferredValue(searchFilter);
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
      search: deferredSearchFilter,
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
            resolvedPage = resolvePendingLogPage(nextPage, pendingLoad);
            pendingLogLoadRef.current = null;
          }
          appliedQueryRef.current = query;
          setLogState((previous) => ({
            page: resolvedPage,
            syncVersion: previous.syncVersion + 1,
            liveInsertIds: []
          }));
          setPageQueryKey(logPageQueryKey(query));
          setRequestError(null);
        }
      } catch (error) {
        if (!cancelled && isCurrentLogRequest(generation, generationRef.current)) {
          pendingLogLoadRef.current = null;
          setRequestError({ message: errorSummary(error), queryKey: logPageQueryKey(query), operation: "first-page" });
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
  }, [deferredFilter, deferredStatusFilter, deferredHostFilter, deferredSearchFilter, enabled, hasConfig, logPageLimit, reloadToken]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let closed = false;
    let refreshRequestId = 0;
    let pendingRefresh: PendingLogLoad | null = null;

    async function refreshAppliedLogPage(isStillRelevant: () => boolean): Promise<boolean> {
      const generation = generationRef.current;
      const query = appliedQueryRef.current;
      const requestId = refreshRequestId + 1;
      refreshRequestId = requestId;
      const pendingLoad: PendingLogLoad = { generation, query, liveEvents: [], snapshot: null };
      pendingRefresh = pendingLoad;
      try {
        // ponytail: recovery starts from one bounded first page. Preserving a
        // paged scroll position would require refreshing its contiguous range;
        // merging disconnected windows could silently skip missed records.
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
          // A matching query does not make an old offset valid for a new window.
          loadMoreRequestIdRef.current += 1;
          isLoadingMoreLogsRef.current = false;
          setIsLoadingMoreLogs(false);
          setLogState((previous) => ({
            page: resolvePendingLogPage(nextPage, pendingLoad),
            syncVersion: previous.syncVersion + 1,
            liveInsertIds: []
          }));
          setRequestError((previous) => previous?.queryKey === logPageQueryKey(query) ? null : previous);
          setStreamError(null);
          onServerRecovered();
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
          setRequestError((previous) => previous?.operation === "first-page" ? previous : {
            message: errorSummary(error), queryKey: logPageQueryKey(query), operation: "refresh"
          });
        }
      } finally {
        if (pendingRefresh === pendingLoad) pendingRefresh = null;
      }
      return false;
    }

    if (typeof window.EventSource !== "function") {
      setStreamError("当前浏览器不支持 SSE，已回退为轮询刷新。");
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
      const wasInterrupted = streamInterrupted;
      streamInterrupted = false;
      pollingFallbackActive = false;
      setStreamError(null);
      // A reconnect snapshot may not overlap the loaded window. Re-query even
      // unfiltered pages so subsequent offsets start from a contiguous page.
      if (wasInterrupted) {
        void refreshAppliedLogPage(() => !streamInterrupted);
      }
    }

    const handleOpen = () => {
      markStreamConnected();
    };
    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as StudioSnapshotEvent;
        applyRemoteConfig(snapshot.config);
        setHealth(snapshot.health);
        for (const pendingLoad of [pendingLogLoadRef.current, pendingRefresh]) {
          if (pendingLoad?.generation === generationRef.current && isUnfilteredQuery(pendingLoad.query)) {
            pendingLoad.snapshot = snapshot.log_page;
          }
        }
        if (isUnfilteredQuery(appliedQueryRef.current)) {
          setLogState((previous) => ({
            page: mergeSnapshotLogPage(previous.page, snapshot.log_page),
            syncVersion: previous.syncVersion + 1,
            liveInsertIds: []
          }));
        }
        markStreamConnected();
      } catch (error) {
        setStreamError(errorSummary(error));
      }
    };
    const handleLog = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as StudioLogEvent;
        setHealth((previous) => mergeCodexStatusIntoHealth(previous, payload));
        for (const pendingLoad of [pendingLogLoadRef.current, pendingRefresh]) {
          if (pendingLoad?.generation === generationRef.current) {
            pendingLoad.liveEvents.push(payload);
          }
        }
        const appliedQuery = appliedQueryRef.current;
        setLogState((previous) => {
          const operation = payload.operation ?? "insert";
          const nextPage = mergeLiveLogPage(
            previous.page,
            payload.entry,
            appliedQuery.route,
            appliedQuery.status,
            appliedQuery.host,
            appliedQuery.search,
            operation
          );
          const existing = previous.page.logs.some(
            (entry) => entry.request_id === payload.entry.request_id
          );
          const nextIds = new Set(nextPage.logs.map((entry) => entry.request_id));
          const retainedLiveIds = previous.liveInsertIds.filter(
            (requestId) => requestId !== payload.entry.request_id && nextIds.has(requestId)
          );
          const isVisibleNewInsert = (
            operation === "insert" &&
            !existing &&
            nextIds.has(payload.entry.request_id)
          );

          return {
            page: nextPage,
            syncVersion: previous.syncVersion,
            liveInsertIds: isVisibleNewInsert
              ? [payload.entry.request_id, ...retainedLiveIds].slice(
                  0,
                  Math.max(nextPage.limit, nextPage.logs.length)
                )
              : retainedLiveIds
          };
        });
        markStreamConnected();
      } catch (error) {
        setStreamError(errorSummary(error));
      }
    };
    const handleError = () => {
      streamInterrupted = true;
      if (!pollingFallbackActive) {
        setStreamError(STREAM_RECONNECTING_MESSAGE);
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
    onServerRecovered,
    setHealth
  ]);

  function retryLogs() {
    if (!isLoadingLogsRef.current) setReloadToken((previous) => previous + 1);
  }

  async function loadMoreLogs() {
    if (hasStaleLogs || isLoadingLogsRef.current || isLoadingMoreLogsRef.current || !logPage.has_more) {
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
        setLogState((previous) => ({
          ...previous,
          page: appendLogPage(previous.page, nextPage)
        }));
        setRequestError((previous) => previous?.operation === "more" && previous.queryKey === logPageQueryKey(query) ? null : previous);
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
        setRequestError((previous) => previous?.operation === "first-page" ? previous : {
          message: errorSummary(error), queryKey: logPageQueryKey(query), operation: "more"
        });
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
    logSyncVersion: logState.syncVersion,
    liveInsertIds: logState.liveInsertIds,
    pageQueryKey,
    routeFilter,
    setRouteFilter,
    statusFilter,
    setStatusFilter,
    hostFilter,
    setHostFilter,
    searchFilter,
    setSearchFilter,
    hostOptions,
    logError: requestError?.message ?? streamError,
    hasStaleLogs,
    retryLogs,
    isLoadingLogs,
    isLoadingMoreLogs,
    loadMoreLogs
  };
}
