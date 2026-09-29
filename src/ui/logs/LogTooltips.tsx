import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from "react";
import type { RequestLogEntry } from "../../shared/types.js";
import { clamp, formatMetricNumber } from "../shared/format.js";
import { LogTokenSummary } from "./LogSummary.js";
import {
  cacheCreationInputTokens,
  cacheReadInputTokens,
  displayInputTokens,
  displayTotalTokens,
  formatCacheHitRate,
  hasAdditiveCachedInput,
  totalInputTokens
} from "./log-utils.js";

const TOKEN_TOOLTIP_WIDTH = 350;
const TOKEN_TOOLTIP_ESTIMATED_HEIGHT = 216;
const LOG_TEXT_TOOLTIP_WIDTH = 420;
const LOG_TEXT_TOOLTIP_ESTIMATED_HEIGHT = 120;
const TOOLTIP_VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 10;

function TooltipPanel({ anchorRef, onDismiss, ...props }: HTMLAttributes<HTMLSpanElement> & {
  anchorRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  const panelRef = useRef<HTMLSpanElement>(null);
  // Subscribe only while a panel is open, not once for every loaded log cell.
  useEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    let dismissTimer: ReturnType<typeof setTimeout> | undefined;
    const keepOpen = () => clearTimeout(dismissTimer);
    // Give the pointer time to cross the gap between trigger and portal.
    const leave = () => { keepOpen(); dismissTimer = setTimeout(onDismiss, 150); };
    const contains = (target: EventTarget | null) => target instanceof Node && (anchor?.contains(target) || panel?.contains(target));
    const blur = (event: FocusEvent) => { if (!contains(event.relatedTarget)) onDismiss(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node && panel?.contains(event.target))) onDismiss(); };
    const pointerDown = (event: PointerEvent) => { if (!contains(event.target)) onDismiss(); };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };
    for (const element of [anchor, panel]) {
      element?.addEventListener("mouseenter", keepOpen);
      element?.addEventListener("mouseleave", leave);
      element?.addEventListener("focusout", blur);
    }
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onDismiss);
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    // A portal can open under a moving pointer before these listeners mount.
    if (!anchor?.matches(":hover, :focus-within") && !panel?.matches(":hover, :focus-within")) leave();
    return () => {
      keepOpen();
      for (const element of [anchor, panel]) {
        element?.removeEventListener("mouseenter", keepOpen);
        element?.removeEventListener("mouseleave", leave);
        element?.removeEventListener("focusout", blur);
      }
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onDismiss);
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [anchorRef, onDismiss]);
  return createPortal(<span {...props} ref={panelRef} tabIndex={-1}
    onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} />, document.body);
}

export function TokenTooltip({ entry }: { entry: RequestLogEntry }) {
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const tooltipId = useId();
  const anchorRef = useRef<HTMLButtonElement | null>(null);

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
    <button
      ref={anchorRef}
      type="button"
      className="token-tooltip"
      aria-label="Token 明细"
      data-label="Token"
      aria-describedby={placement ? tooltipId : undefined}
      aria-expanded={placement !== null}
      onClick={showTooltip}
      onMouseEnter={showTooltip}
      onFocus={showTooltip}
    >
      <LogTokenSummary entry={entry} />
      {placement && (
          <TooltipPanel
            anchorRef={anchorRef}
            onDismiss={hideTooltip}
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
            {cacheCreationInputTokens(entry) !== null && (
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
          </TooltipPanel>
        )}
    </button>
  );
}

export function LogTextTooltip({
  value,
  tooltip,
  className,
  children
}: {
  value: string;
  tooltip?: string;
  className?: string;
  children?: ReactNode;
}) {
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
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
        onFocus={showTooltip}
      >
        {children ?? value}
      </span>
      {placement && (
          <TooltipPanel
            anchorRef={anchorRef}
            onDismiss={hideTooltip}
            className="portal-tooltip-panel log-text-tooltip-panel"
            id={tooltipId}
            role="tooltip"
            style={placement}
          >
            {tooltipText}
          </TooltipPanel>
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
): CSSProperties {
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
  const placement: CSSProperties = {
    left,
    ...(showBelow ? { top: rect.bottom + TOOLTIP_GAP } : { bottom: window.innerHeight - rect.top + TOOLTIP_GAP }),
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
