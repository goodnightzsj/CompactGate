import { type FormEvent, useState } from "react";
import type { RoutePreviewResponse } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";

const DEFAULT_PREVIEW_BODY = JSON.stringify({ model: "gpt-5.5", stream: true }, null, 2);

export function useRoutePreviewAction() {
  const [previewPath, setPreviewPath] = useState("/v1/responses/compact");
  const [previewBody, setPreviewBody] = useState(DEFAULT_PREVIEW_BODY);
  const [preview, setPreview] = useState<RoutePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function previewRoute(event: FormEvent) {
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

  return {
    preview,
    previewBody,
    previewError,
    previewPath,
    previewRoute,
    setPreviewBody,
    setPreviewPath
  };
}
