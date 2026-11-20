import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import type { RoutePreviewResponse } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";

const DEFAULT_PREVIEW_BODY = JSON.stringify({ model: "gpt-5.5", stream: true }, null, 2);
const DEFAULT_PREVIEW_HEADERS = "{}";
export type RoutePreviewMethod = "GET" | "POST";

export function useRoutePreviewAction(configRevision: string | null) {
  const [previewMethod, setPreviewMethod] = useState<RoutePreviewMethod>("POST");
  const [previewPath, setPreviewPath] = useState("/v1/responses/compact");
  const [previewBody, setPreviewBody] = useState(DEFAULT_PREVIEW_BODY);
  const [previewHeaders, setPreviewHeaders] = useState(DEFAULT_PREVIEW_HEADERS);
  const [preview, setPreview] = useState<RoutePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    clearPreview();
    return () => pending.current?.abort();
  }, [configRevision]);

  async function previewRoute(event: FormEvent) {
    event.preventDefault();
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setPreviewError(null);
    setIsPreviewing(true);

    try {
      const parsedHeaders = previewHeaders.trim().length > 0 ? JSON.parse(previewHeaders) : {};
      const nextPreview = await api<RoutePreviewResponse>("/api/test-route", {
        method: "POST",
        signal: request.signal,
        body: JSON.stringify({
          method: previewMethod,
          path: previewPath,
          ...(previewMethod === "POST" ? { body: previewBody.trim() ? JSON.parse(previewBody) : {} } : {}),
          headers: parsedHeaders
        })
      });
      if (!request.signal.aborted) {
        setPreview(nextPreview);
      }
    } catch (error) {
      if (!request.signal.aborted) {
        setPreview(null);
        setPreviewError(errorSummary(error));
      }
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setIsPreviewing(false);
      }
    }
  }

  /**
   * A preview outranks the newest real request on the routes page, so without a
   * way to drop it the page kept showing a hypothetical route forever — every
   * subsequent real request was invisible there until a reload.
   */
  function clearPreview() {
    pending.current?.abort();
    pending.current = null;
    setPreview(null);
    setPreviewError(null);
    setIsPreviewing(false);
  }

  function edit<T>(current: T, next: T, set: (value: T) => void) {
    if (current === next) return;
    clearPreview();
    set(next);
  }

  return {
    isPreviewing,
    preview,
    previewBody,
    previewError,
    previewHeaders,
    previewMethod,
    previewPath,
    previewRoute,
    clearPreview,
    setPreviewBody: (value: string) => edit(previewBody, value, setPreviewBody),
    setPreviewHeaders: (value: string) => edit(previewHeaders, value, setPreviewHeaders),
    setPreviewMethod: (value: RoutePreviewMethod) => edit(previewMethod, value, setPreviewMethod),
    setPreviewPath: (value: string) => edit(previewPath, value, setPreviewPath)
  };
}
