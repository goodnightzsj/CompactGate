import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent } from "react";
import { clamp } from "./format.js";

export interface SelectOption {
  value: string;
  label: string;
  count?: number;
  meta?: string;
  tone?: string;
  disabled?: boolean;
}

export function selectMenuPlacement(
  rect: Pick<DOMRect, "left" | "top" | "bottom" | "width">,
  viewport: { width: number; height: number },
  contentHeight: number,
  wide = false
): CSSProperties {
  const padding = 12;
  const gap = 8;
  const width = Math.min(Math.max(0, viewport.width - padding * 2), wide ? Math.max(rect.width, 420) : rect.width);
  const below = Math.max(0, viewport.height - rect.bottom - padding - gap);
  const above = Math.max(0, rect.top - padding - gap);
  const openAbove = below < Math.min(320, contentHeight) && above > below;
  return {
    left: clamp(rect.left, padding, Math.max(padding, viewport.width - width - padding)),
    width,
    maxHeight: Math.min(320, openAbove ? above : below),
    // Anchor the near edge, not an assumed height: a two-option menu is much
    // shorter than maxHeight and must still sit directly beside its trigger.
    ...(openAbove ? { bottom: viewport.height - rect.top + gap } : { top: rect.bottom + gap })
  };
}

export function CustomSelect({
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
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    updateMenuPlacement();
    const frame = window.requestAnimationFrame(() => {
      focusOption(selectedIndex);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectedIndex, wide, compact, options.length]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handleOutsideFocusOrPointer(event: Event) {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function scheduleReposition() {
      if (rafRef.current !== null) {
        return;
      }
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateMenuPlacement();
      });
    }

    document.addEventListener("pointerdown", handleOutsideFocusOrPointer);
    document.addEventListener("focusin", handleOutsideFocusOrPointer);
    window.addEventListener("resize", scheduleReposition);
    window.addEventListener("scroll", scheduleReposition, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideFocusOrPointer);
      document.removeEventListener("focusin", handleOutsideFocusOrPointer);
      window.removeEventListener("resize", scheduleReposition);
      window.removeEventListener("scroll", scheduleReposition, true);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }

  function focusOption(index: number, direction = 1) {
    for (let offset = 0; offset < options.length; offset += 1) {
      const next = (index + offset * direction + options.length) % options.length;
      if (!options[next].disabled) {
        const option = optionRefs.current[next];
        option?.focus({ preventScroll: true });
        // Scroll only the portaled menu, never the page behind it.
        const menu = menuRef.current;
        if (menu && option) {
          const item = option.getBoundingClientRect();
          const box = menu.getBoundingClientRect();
          const top = box.top + menu.clientTop;
          const bottom = top + menu.clientHeight;
          menu.scrollTop += item.top < top ? item.top - top : Math.max(0, item.bottom - bottom);
        }
        return;
      }
    }
    triggerRef.current?.focus();
  }

  function updateMenuPlacement() {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const menu = menuRef.current;
    if (!menu) return;
    setMenuStyle(selectMenuPlacement(trigger.getBoundingClientRect(), {
      width: window.innerWidth, height: window.innerHeight
    }, menu.scrollHeight + menu.offsetHeight - menu.clientHeight, wide));
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
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
    event: KeyboardEvent<HTMLButtonElement>,
    optionIndex: number
  ) {
    if (event.key === "Tab") {
      // Resume native tab order beside the trigger, not at the end of the
      // document where this portal lives. Do not cancel the browser's Tab.
      triggerRef.current?.focus({ preventScroll: true });
      setOpen(false);
      return;
    }
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
      focusOption((optionIndex - 1 + options.length) % options.length, -1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1, -1);
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
        onClick={() => !disabled && setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="custom-select-copy">
          <strong>{selected.label}</strong>
          {selected.meta && <small>{selected.meta}</small>}
        </span>
        {typeof selected.count === "number" && <span className="custom-select-count">{selected.count}</span>}
      </button>

      {open && !disabled && createPortal(
        <div
          ref={menuRef}
          id={listId}
          className={`custom-select-menu ${wide ? "is-wide" : ""} ${compact ? "is-compact" : ""}`}
          role="listbox"
          aria-label={label}
          style={menuStyle ?? { visibility: "hidden", maxHeight: 320 }}
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
              tabIndex={-1}
              disabled={option.disabled}
              aria-disabled={option.disabled || undefined}
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                // Closing unmounts the portal together with the focused option,
                // which drops focus on <body>: the next Tab restarts from the
                // top of the page and Shift+Tab cannot reach this select again.
                closeAndFocusTrigger();
              }}
              onKeyDown={(event) => handleOptionKeyDown(event, optionIndex)}
            >
              <span className="custom-select-copy">
                <strong>{option.label}</strong>
                {option.meta && <small>{option.meta}</small>}
              </span>
              {typeof option.count === "number" && <span className="custom-select-count">{option.count}</span>}
              {typeof option.count !== "number" && option.value === value && <span className="custom-select-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
