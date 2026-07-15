import { useState, type Dispatch, type SetStateAction } from "react";
import type { LogBodyPurgeResult } from "../../shared/types.js";
import { api, errorSummary } from "../shared/api.js";
import type { ConfigFormState } from "./types.js";

type StorageMode = "separated" | "metadata" | "sqlite";
type CleanupState = "idle" | "confirming" | "running" | "success" | "error";

const DEFAULT_CAPTURE_DIR = "./compactgate-captures";

export function LoggingStoragePanel({
  form,
  onFormChange
}: {
  form: ConfigFormState;
  onFormChange: Dispatch<SetStateAction<ConfigFormState>>;
}) {
  const storageMode = storageModeForForm(form);
  const [cleanupState, setCleanupState] = useState<CleanupState>("idle");
  const [cleanupResult, setCleanupResult] = useState<LogBodyPurgeResult | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const selectStorageMode = (mode: StorageMode) => {
    onFormChange((previous) => {
      if (mode === "separated") {
        return {
          ...previous,
          loggingPersistBody: false,
          loggingCaptureDir: previous.loggingCaptureDir.trim() || DEFAULT_CAPTURE_DIR
        };
      }
      if (mode === "sqlite") {
        return {
          ...previous,
          loggingPersistBody: true,
          loggingCaptureDir: ""
        };
      }
      return {
        ...previous,
        loggingPersistBody: false,
        loggingCaptureDir: ""
      };
    });
  };

  const purgeStoredBodies = async () => {
    setCleanupState("running");
    setCleanupError(null);
    setCleanupResult(null);
    try {
      const result = await api<LogBodyPurgeResult>("/api/logs/maintenance/purge-bodies", {
        method: "POST",
        body: JSON.stringify({ confirm: true })
      });
      setCleanupResult(result);
      setCleanupState("success");
    } catch (error) {
      setCleanupError(errorSummary(error));
      setCleanupState("error");
    }
  };

  return (
    <div className="logging-storage-panel">
      <section className="logging-storage-intro" aria-labelledby="logging-storage-title">
        <div>
          <span className="profile-item-kicker">存储策略</span>
          <h3 id="logging-storage-title">日志与原始请求分离存储</h3>
          <p>
            SQLite 保留可检索的请求元数据，原始请求与响应写入有界抓包目录。目录达到上限时只删除旧抓包，并把日志状态更新为已清理。
          </p>
        </div>
        <div className="logging-storage-summary" aria-label="当前草稿存储状态">
          <span>
            SQLite
            <strong>{form.loggingPersistBody ? "元数据 + 正文" : "仅元数据"}</strong>
          </span>
          <span>
            抓包
            <strong>{form.loggingCaptureDir.trim() ? "已启用" : "已关闭"}</strong>
          </span>
        </div>
      </section>

      <fieldset className="logging-mode-fieldset">
        <legend>存储模式</legend>
        <div className="logging-mode-grid" role="radiogroup" aria-label="日志存储模式">
          <button
            type="button"
            role="radio"
            aria-checked={storageMode === "separated"}
            className={`logging-mode-card ${storageMode === "separated" ? "is-active" : ""}`}
            onClick={() => selectStorageMode("separated")}
          >
            <span className="logging-mode-card-head">
              <strong>分离存储</strong>
              <span className="logging-recommended-badge">推荐</span>
            </span>
            <span>SQLite 仅保存元数据，原始请求与响应进入有大小上限的 JSON 抓包目录。</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={storageMode === "metadata"}
            className={`logging-mode-card ${storageMode === "metadata" ? "is-active" : ""}`}
            onClick={() => selectStorageMode("metadata")}
          >
            <span className="logging-mode-card-head">
              <strong>仅元数据</strong>
            </span>
            <span>占用最小，不保存任何原始请求或响应正文，适合长期运行。</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={storageMode === "sqlite"}
            className={`logging-mode-card ${storageMode === "sqlite" ? "is-active" : ""}`}
            onClick={() => selectStorageMode("sqlite")}
          >
            <span className="logging-mode-card-head">
              <strong>SQLite 正文</strong>
              <span className="logging-legacy-badge">兼容模式</span>
            </span>
            <span>正文继续写入 SQLite。达到数据库上限时会先清正文，再考虑删除最旧元数据。</span>
          </button>
        </div>
      </fieldset>

      <section className="logging-settings-section" aria-labelledby="logging-settings-title">
        <div className="logging-section-head">
          <div>
            <h3 id="logging-settings-title">容量与保留</h3>
            <p>界面使用 MiB 与 GiB，保存时会转换为精确字节数。</p>
          </div>
          <label className="auto-schedule-switch">
            <input
              type="checkbox"
              checked={form.loggingRedactBody}
              onChange={(event) =>
                onFormChange((previous) => ({
                  ...previous,
                  loggingRedactBody: event.target.checked
                }))
              }
            />
            <span className="auto-schedule-track" aria-hidden="true">
              <span className="auto-schedule-thumb" />
            </span>
            <span>正文脱敏</span>
          </label>
        </div>

        <div className="logging-settings-grid">
          <label className="field" htmlFor="logging-keep-recent">
            <span>每页日志条数</span>
            <input
              id="logging-keep-recent"
              type="number"
              min="1"
              max="2000"
              step="1"
              value={form.loggingKeepRecent}
              onChange={(event) =>
                onFormChange((previous) => ({
                  ...previous,
                  loggingKeepRecent: Number(event.target.value)
                }))
              }
            />
            <small>只控制 Studio 单页读取量，不是 SQLite 总条数上限。</small>
          </label>

          <label className="field" htmlFor="logging-max-database-mib">
            <span>SQLite 上限（MiB）</span>
            <input
              id="logging-max-database-mib"
              type="number"
              min="1"
              step="1"
              value={form.loggingMaxDatabaseMiB}
              onChange={(event) =>
                onFormChange((previous) => ({
                  ...previous,
                  loggingMaxDatabaseMiB: Number(event.target.value)
                }))
              }
            />
            <small>默认 1024 MiB。超限时先清理 SQLite 中的历史正文。</small>
          </label>

          <label className="field logging-capture-dir-field" htmlFor="logging-capture-dir">
            <span>抓包目录</span>
            <input
              id="logging-capture-dir"
              type="text"
              value={form.loggingCaptureDir}
              disabled={storageMode !== "separated"}
              placeholder={DEFAULT_CAPTURE_DIR}
              onChange={(event) =>
                onFormChange((previous) => ({
                  ...previous,
                  loggingPersistBody: false,
                  loggingCaptureDir: event.target.value
                }))
              }
            />
            <small>
              仅分离存储模式启用。接口与 Studio 都不会返回本机绝对路径。
            </small>
          </label>

          <label className="field" htmlFor="logging-capture-body-mib">
            <span>单段正文上限（MiB）</span>
            <input
              id="logging-capture-body-mib"
              type="number"
              min="0.01"
              step="0.25"
              value={form.loggingCaptureBodyMaxMiB}
              onChange={(event) =>
                onFormChange((previous) => ({
                  ...previous,
                  loggingCaptureBodyMaxMiB: Number(event.target.value)
                }))
              }
            />
            <small>请求与响应的每个阶段分别截断，保留原始字节长度与截断状态。</small>
          </label>

          <label className="field" htmlFor="logging-capture-dir-gib">
            <span>抓包目录上限（GiB）</span>
            <input
              id="logging-capture-dir-gib"
              type="number"
              min="0.01"
              step="0.25"
              value={form.loggingCaptureDirMaxGiB}
              onChange={(event) =>
                onFormChange((previous) => ({
                  ...previous,
                  loggingCaptureDirMaxGiB: Number(event.target.value)
                }))
              }
            />
            <small>默认 20 GiB。达到上限后按修改时间从旧到新删除受管抓包。</small>
          </label>
        </div>
      </section>

      <section className="logging-maintenance-section" aria-labelledby="logging-maintenance-title">
        <div className="logging-section-head">
          <div>
            <span className="profile-item-kicker">一次性维护</span>
            <h3 id="logging-maintenance-title">清理 SQLite 历史正文</h3>
            <p>
              清空四段历史正文并保留请求时间、路由、模型、状态、耗时、Token 与抓包状态。此操作不可恢复，执行时会同步回收 SQLite 空间。
            </p>
          </div>
          {cleanupState === "idle" && (
            <button
              type="button"
              className="ghost-button logging-cleanup-button"
              onClick={() => setCleanupState("confirming")}
            >
              清理历史正文
            </button>
          )}
        </div>

        {cleanupState === "confirming" && (
          <div className="logging-cleanup-confirm" role="alert">
            <p>
              确认后，SQLite 中现有原始请求与响应正文会永久删除。元数据行不会删除。
            </p>
            <div>
              <button
                type="button"
                className="solid-button danger-solid-button"
                onClick={() => void purgeStoredBodies()}
              >
                确认清理
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setCleanupState("idle")}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {cleanupState === "running" && (
          <p className="logging-maintenance-feedback" role="status" aria-live="polite">
            正在清理并回收 SQLite 空间，请勿关闭服务……
          </p>
        )}

        {cleanupState === "success" && cleanupResult && (
          <div className="logging-maintenance-feedback is-success" role="status" aria-live="polite">
            <strong>清理完成</strong>
            <span>
              已清理 {cleanupResult.rows_cleared} 条正文记录，元数据行保持{" "}
              {cleanupResult.row_count_after} 条。
            </span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setCleanupState("idle")}
            >
              关闭结果
            </button>
          </div>
        )}

        {cleanupState === "error" && (
          <div className="logging-maintenance-feedback is-error" role="alert">
            <strong>清理失败</strong>
            <span>{cleanupError ?? "未知错误"}</span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setCleanupState("confirming")}
            >
              重试
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function storageModeForForm(form: ConfigFormState): StorageMode {
  if (form.loggingPersistBody) {
    return "sqlite";
  }
  return form.loggingCaptureDir.trim() ? "separated" : "metadata";
}
