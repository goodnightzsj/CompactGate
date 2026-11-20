import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HealthResponse,
  LogStatusKind,
  LogDrilldownFilter,
  PublicConfig,
  RequestLogPage,
  RouteKind,
  StudioKeyActivityEvent,
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
  isUnfilteredQuery,
  type LogPageQuery,
  logPageQueryKey,
  logQueryForView
} from "../logs/log-feed-query.js";
import { errorSummary } from "../shared/api.js";

const STREAM_RECONNECTING_MESSAGE = "实时日志流暂时断开，浏览器正在重连。";

interface PendingLogLoad {
  controller: AbortController;
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

export async function fetchPendingLogPage(
  pending: PendingLogLoad,
  isCurrent: () => boolean
): Promise<RequestLogPage> {
  const { query } = pending;
  let page: RequestLogPage;
  do {
    // Inserts share a SQLite sequence, but maintenance snapshots can remove
    // rows without an insert. Re-query their window rather than mixing totals.
    pending.snapshot = null;
    pending.liveEvents = [];
    page = await fetchLogPage({ ...query, offset: 0 }, pending.controller.signal);
  } while (pending.snapshot && isCurrent());
  return replayLiveLogEvents(
    page,
    pending.liveEvents,
    query.route,
    query.status,
    query.host,
    query.search,
    query.drilldown
  );
}

export async function fetchMoreLogPage(
  pending: PendingLogLoad,
  baseline: RequestLogPage,
  isCurrent: () => boolean
): Promise<RequestLogPage> {
  const { query } = pending;
  const next = await fetchLogPage({ ...query, offset: baseline.logs.length }, pending.controller.signal);
  if (pending.snapshot && isCurrent()) return fetchPendingLogPage(pending, isCurrent);
  // Live inserts may have cropped the displayed tail while this request was
  // pending. Start from its original window and grow it before replaying.
  const merged = replayLiveLogEvents({
    ...appendLogPage(baseline, next), limit: baseline.logs.length + query.limit
  }, pending.liveEvents, query.route, query.status, query.host, query.search, query.drilldown);
  return { ...merged, limit: query.limit };
}

interface LogPresentationState {
  page: RequestLogPage;
  syncVersion: number;
  liveInsertIds: string[];
}

export function useLogFeed({
  enabled,
  filterLogs,
  hasConfig,
  logPageLimit,
  applyRemoteConfig,
  onServerRecovered,
  setHealth,
  setCodexStatus
}: {
  enabled: boolean;
  filterLogs: boolean;
  hasConfig: boolean;
  logPageLimit: number;
  applyRemoteConfig: (config: PublicConfig) => void;
  /** A page that answers proves the proxy is back, not just the log feed. */
  onServerRecovered: (healthRecovered?: boolean) => void;
  setHealth: React.Dispatch<React.SetStateAction<HealthResponse | null>>;
  setCodexStatus: (codex: HealthResponse["codex"]) => void;
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
  const [drilldown, setDrilldown] = useState<LogDrilldownFilter>();
  const [requestError, setRequestError] = useState<LogRequestError | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [keyActivity, setKeyActivity] = useState<StudioKeyActivityEvent[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [isLoadingMoreLogs, setIsLoadingMoreLogs] = useState(false);
  const isLoadingLogsRef = useRef(false);
  const isLoadingMoreLogsRef = useRef(false);
  const generationRef = useRef(0);
  const loadMoreRequestIdRef = useRef(0);
  const pendingLogLoadRef = useRef<PendingLogLoad | null>(null);
  const pendingMoreLoadRef = useRef<PendingLogLoad | null>(null);
  const pendingRefreshRef = useRef<PendingLogLoad | null>(null);
  const lastRequestedQueryRef = useRef<LogPageQuery | null>(null);
  const appliedQueryRef = useRef<LogPageQuery>({
    route: "all",
    status: "all",
    host: ALL_HOSTS_FILTER,
    search: "",
    limit: DEFAULT_LOG_PAGE_LIMIT
  });
  const [pageQueryKey, setPageQueryKey] = useState(() => logPageQueryKey(appliedQueryRef.current));
  const requestedQuery = logQueryForView({
    route: routeFilter, status: statusFilter, host: hostFilter, search: searchFilter, drilldown, limit: logPageLimit
  }, filterLogs);
  const hasStaleLogs = (requestError !== null && requestError.operation !== "more") || pageQueryKey !== logPageQueryKey(requestedQuery);

  const logPage = logState.page;

  const hostOptions = useMemo(
    () => buildHostFilterOptions(logPage.host_counts, hostFilter),
    [logPage.host_counts, hostFilter]
  );

  useEffect(() => {
    if (!enabled || !hasConfig) {
      lastRequestedQueryRef.current = null;
      isLoadingLogsRef.current = false;
      pendingLogLoadRef.current = null;
      pendingMoreLoadRef.current = null;
      setIsLoadingLogs(false);
      isLoadingMoreLogsRef.current = false;
      setIsLoadingMoreLogs(false);
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    loadMoreRequestIdRef.current += 1;
    pendingMoreLoadRef.current?.controller.abort();
    pendingMoreLoadRef.current = null;
    isLoadingMoreLogsRef.current = false;
    setIsLoadingMoreLogs(false);
    const query: LogPageQuery = {
      route: requestedQuery.route,
      status: requestedQuery.status,
      host: requestedQuery.host,
      search: requestedQuery.search,
      drilldown: requestedQuery.drilldown,
      limit: logPageLimit
    };
    isLoadingLogsRef.current = true;
    const pendingLoad: PendingLogLoad = {
      controller: new AbortController(),
      generation,
      query,
      liveEvents: [],
      snapshot: null
    };
    pendingLogLoadRef.current = pendingLoad;
    const isCurrent = () => !pendingLoad.controller.signal.aborted &&
      isCurrentLogRequest(generation, generationRef.current);

    async function loadLogs() {
      setIsLoadingLogs(true);

      try {
        const nextPage = await fetchPendingLogPage(pendingLoad,
          isCurrent);

        if (isCurrent()) {
          pendingLogLoadRef.current = null;
          appliedQueryRef.current = query;
          setLogState((previous) => ({
            page: nextPage,
            syncVersion: previous.syncVersion + 1,
            liveInsertIds: []
          }));
          setPageQueryKey(logPageQueryKey(query));
          setRequestError(null);
        }
      } catch (error) {
        if (isCurrent()) {
          pendingLogLoadRef.current = null;
          setRequestError({ message: errorSummary(error), queryKey: logPageQueryKey(query), operation: "first-page" });
        }
      } finally {
        if (isCurrent()) {
          isLoadingLogsRef.current = false;
          setIsLoadingLogs(false);
        }
      }
    }

    const previousQuery = lastRequestedQueryRef.current;
    lastRequestedQueryRef.current = query;
    // Only typing waits; explicit filters, retries and clearing remain instant.
    const debounce = query.search !== "" && previousQuery && previousQuery.search !== query.search &&
      logPageQueryKey({ ...previousQuery, search: "" }) === logPageQueryKey({ ...query, search: "" });
    setIsLoadingLogs(true);
    const timer = debounce ? window.setTimeout(() => void loadLogs(), 250) : null;
    if (timer === null) void loadLogs();

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      pendingLoad.controller.abort();
      pendingMoreLoadRef.current?.controller.abort();
      pendingRefreshRef.current?.controller.abort();
      pendingRefreshRef.current = null;
    };
  }, [requestedQuery.route, requestedQuery.status, requestedQuery.host, requestedQuery.search, requestedQuery.drilldown, enabled, hasConfig, logPageLimit, reloadToken]);

  useEffect(() => {
    setKeyActivity([]);
    if (!enabled) {
      return;
    }

    let closed = false;
    let refreshRequestId = 0;

    async function refreshAppliedLogPage(isStillRelevant: () => boolean): Promise<boolean> {
      // In-flight loads already replay maintenance invalidations. Do not launch
      // a second owner that can replace their newer query or release its flags.
      if (pendingLogLoadRef.current || pendingRefreshRef.current) return false;
      const generation = generationRef.current;
      const query = appliedQueryRef.current;
      const requestId = refreshRequestId + 1;
      refreshRequestId = requestId;
      const pendingLoad: PendingLogLoad = { controller: new AbortController(), generation, query, liveEvents: [], snapshot: null };
      pendingRefreshRef.current = pendingLoad;
      loadMoreRequestIdRef.current += 1;
      pendingMoreLoadRef.current?.controller.abort();
      pendingMoreLoadRef.current = null;
      isLoadingMoreLogsRef.current = false;
      setIsLoadingMoreLogs(false);
      isLoadingLogsRef.current = true;
      setIsLoadingLogs(true);
      const isCurrent = () => !closed && !pendingLoad.controller.signal.aborted && isStillRelevant() && isCurrentLogPageRequest(
        generation, generationRef.current, query, appliedQueryRef.current, requestId, refreshRequestId
      );
      try {
        // ponytail: recovery starts from one bounded first page. Preserving a
        // paged scroll position would require refreshing its contiguous range;
        // merging disconnected windows could silently skip missed records.
        const nextPage = await fetchPendingLogPage(pendingLoad, isCurrent);
        if (isCurrent()) {
          // A matching query does not make an old offset valid for a new window.
          loadMoreRequestIdRef.current += 1;
          pendingMoreLoadRef.current = null;
          isLoadingMoreLogsRef.current = false;
          setIsLoadingMoreLogs(false);
          setLogState((previous) => ({
            page: nextPage,
            syncVersion: previous.syncVersion + 1,
            liveInsertIds: []
          }));
          setRequestError((previous) => previous?.queryKey === logPageQueryKey(query) ? null : previous);
          setStreamError(null);
          onServerRecovered();
          return true;
        }
      } catch (error) {
        if (isCurrent()) {
          setRequestError((previous) => previous?.operation === "first-page" ? previous : {
            message: errorSummary(error), queryKey: logPageQueryKey(query), operation: "refresh"
          });
        }
      } finally {
        if (pendingRefreshRef.current === pendingLoad) {
          pendingRefreshRef.current = null;
          if (!closed && generation === generationRef.current && !pendingLogLoadRef.current) {
            isLoadingLogsRef.current = false;
            setIsLoadingLogs(false);
          }
        }
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
        pendingRefreshRef.current?.controller.abort();
        pendingRefreshRef.current = null;
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
        // The interrupted poll can no longer commit; hand its slot to recovery.
        pendingRefreshRef.current?.controller.abort();
        pendingRefreshRef.current = null;
        void refreshAppliedLogPage(() => !streamInterrupted);
      }
    }

    const handleOpen = () => {
      markStreamConnected();
    };
    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as StudioSnapshotEvent;
        setKeyActivity((previous) => previous.filter((entry) => entry.config_revision === snapshot.config.revision));
        applyRemoteConfig(snapshot.config);
        setHealth(snapshot.health);
        onServerRecovered(true);
        for (const pendingLoad of [pendingLogLoadRef.current, pendingRefreshRef.current, pendingMoreLoadRef.current]) {
          if (pendingLoad?.generation === generationRef.current) {
            pendingLoad.snapshot = snapshot.log_page;
          }
        }
        if (snapshot.logs_invalidated) {
          loadMoreRequestIdRef.current += 1;
          pendingMoreLoadRef.current?.controller.abort();
          pendingMoreLoadRef.current = null;
          isLoadingMoreLogsRef.current = false;
          setIsLoadingMoreLogs(false);
          void refreshAppliedLogPage(() => true);
        } else if (isUnfilteredQuery(appliedQueryRef.current)) {
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
        if (payload.codex_status) setCodexStatus(payload.codex_status);
        for (const pendingLoad of [pendingLogLoadRef.current, pendingRefreshRef.current, pendingMoreLoadRef.current]) {
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
            operation,
            appliedQuery.drilldown
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
    const handleKeyActivity = (event: MessageEvent<string>) => {
      try {
        const activity = JSON.parse(event.data) as StudioKeyActivityEvent;
        setKeyActivity((previous) => [activity, ...previous.filter((entry) =>
          entry.scope !== activity.scope || entry.profile_id !== activity.profile_id)]);
      } catch (error) {
        setStreamError(errorSummary(error));
      }
    };
    const handleError = () => {
      setKeyActivity([]);
      streamInterrupted = true;
      if (!pollingFallbackActive) {
        setStreamError(STREAM_RECONNECTING_MESSAGE);
      }
      void pollWhileStreamInterrupted();
    };

    stream.addEventListener("open", handleOpen);
    stream.addEventListener("snapshot", handleSnapshot as EventListener);
    stream.addEventListener("log", handleLog as EventListener);
    stream.addEventListener("key_activity", handleKeyActivity as EventListener);
    stream.addEventListener("error", handleError as EventListener);

    return () => {
      closed = true;
      pendingRefreshRef.current?.controller.abort();
      pendingRefreshRef.current = null;
      window.clearInterval(recoveryPollTimer);
      stream.removeEventListener("open", handleOpen);
      stream.removeEventListener("snapshot", handleSnapshot as EventListener);
      stream.removeEventListener("log", handleLog as EventListener);
      stream.removeEventListener("key_activity", handleKeyActivity as EventListener);
      stream.removeEventListener("error", handleError as EventListener);
      stream.close();
    };
  }, [
    enabled,
    applyRemoteConfig,
    onServerRecovered,
    setHealth,
    setCodexStatus
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
    const pending: PendingLogLoad = { controller: new AbortController(), generation, query, liveEvents: [], snapshot: null };
    pendingMoreLoadRef.current = pending;
    const isCurrent = () => !pending.controller.signal.aborted && isCurrentLogPageRequest(generation, generationRef.current,
      query, appliedQueryRef.current, requestId, loadMoreRequestIdRef.current);

    try {
      const nextPage = await fetchMoreLogPage(pending, logPage, isCurrent);
      if (isCurrent()) {
        setLogState((previous) => ({
          ...previous,
          page: nextPage
        }));
        setRequestError((previous) => previous?.operation === "more" && previous.queryKey === logPageQueryKey(query) ? null : previous);
      }
    } catch (error) {
      if (isCurrent()) {
        setRequestError((previous) => previous?.operation === "first-page" ? previous : {
          message: errorSummary(error), queryKey: logPageQueryKey(query), operation: "more"
        });
      }
    } finally {
      if (pendingMoreLoadRef.current === pending) pendingMoreLoadRef.current = null;
      if (isCurrent()) {
        isLoadingMoreLogsRef.current = false;
        setIsLoadingMoreLogs(false);
      }
    }
  }

  return {
    keyActivity,
    logPage,
    // Never present the previous filtered window as a global fact while the
    // unfiltered query is loading or has failed. Reuse the same feed owner.
    globalLogPage: logState.syncVersion > 0 && isUnfilteredQuery(appliedQueryRef.current) ? logPage : null,
    globalLogError: (requestError?.queryKey === logPageQueryKey(logQueryForView(requestedQuery, false))
      ? requestError.message : null) ?? streamError,
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
    drilldown,
    setDrilldown,
    hostOptions,
    logError: requestError?.message ?? streamError,
    hasStaleLogs,
    retryLogs,
    isLoadingLogs,
    isLoadingMoreLogs,
    loadMoreLogs
  };
}
