import { type FormEvent, useRef, useState } from "react";
import type { RoutePreviewResponse } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";

const DEFAULT_PREVIEW_BODY = JSON.stringify({ model: "gpt-5.5", stream: true }, null, 2);
const DEFAULT_PREVIEW_HEADERS = "{}";

export function useRoutePreviewAction() {
  const [previewPath, setPreviewPath] = useState("/v1/responses/compact");
  const [previewBody, setPreviewBody] = useState(DEFAULT_PREVIEW_BODY);
  const [previewHeaders, setPreviewHeaders] = useState(DEFAULT_PREVIEW_HEADERS);
  const [preview, setPreview] = useState<RoutePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  async function previewRoute(event: FormEvent) {
    event.preventDefault();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setPreviewError(null);

    try {
      const parsedBody = previewBody.trim().length > 0 ? JSON.parse(previewBody) : {};
      const parsedHeaders = previewHeaders.trim().length > 0 ? JSON.parse(previewHeaders) : {};
      const nextPreview = await api<RoutePreviewResponse>("/api/test-route", {
        method: "POST",
        body: JSON.stringify({
          method: "POST",
          path: previewPath,
          body: parsedBody,
          headers: parsedHeaders
        })
      });
      if (isLatestPreviewRequest(requestId, requestIdRef.current)) {
        setPreview(nextPreview);
      }
    } catch (error) {
      if (isLatestPreviewRequest(requestId, requestIdRef.current)) {
        setPreview(null);
        setPreviewError(errorSummary(error));
      }
    }
  }

  /**
   * A preview outranks the newest real request on the routes page, so without a
   * way to drop it the page kept showing a hypothetical route forever — every
   * subsequent real request was invisible there until a reload.
   */
  function clearPreview() {
    requestIdRef.current += 1;
    setPreview(null);
    setPreviewError(null);
  }

  return {
    preview,
    previewBody,
    previewError,
    previewHeaders,
    previewPath,
    previewRoute,
    clearPreview,
    setPreviewBody,
    setPreviewHeaders,
    setPreviewPath
  };
}

export function isLatestPreviewRequest(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}
