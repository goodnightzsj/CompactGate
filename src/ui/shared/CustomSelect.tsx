import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent } from "react";
import { clamp } from "./format.js";

export interface SelectOption {
  value: string;
  label: string;
  count?: number;
  meta?: string;
  tone?: string;
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

  useEffect(() => {
    if (!open) {
      return;
    }

    updateMenuPlacement();
    window.requestAnimationFrame(() => {
      optionRefs.current[selectedIndex]?.focus();
    });
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function handleReposition() {
      updateMenuPlacement();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open]);

  function closeAndFocusTrigger() {
    setOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }

  function focusOption(index: number) {
    optionRefs.current[index]?.focus();
  }

  function updateMenuPlacement() {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const width = wide ? Math.max(rect.width, Math.min(420, window.innerWidth - viewportPadding * 2)) : rect.width;
    const left = clamp(rect.left, viewportPadding, window.innerWidth - width - viewportPadding);
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const availableAbove = rect.top - viewportPadding;
    const maxHeight = Math.max(180, Math.min(320, Math.max(availableBelow, availableAbove)));
    const top = availableBelow >= 190 || availableBelow >= availableAbove
      ? rect.bottom + 8
      : Math.max(viewportPadding, rect.top - maxHeight - 8);

    setMenuStyle({
      left,
      top,
      width,
      maxHeight
    });
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
      focusOption((optionIndex - 1 + options.length) % options.length);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1);
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

      {open && !disabled && menuStyle && createPortal(
        <div
          ref={menuRef}
          id={listId}
          className={`custom-select-menu ${wide ? "is-wide" : ""} ${compact ? "is-compact" : ""}`}
          role="listbox"
          style={menuStyle}
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
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              onKeyDown={(event) => handleOptionKeyDown(event, optionIndex)}
            >
              <span className="custom-select-copy">
                <strong>{option.label}</strong>
                {option.meta && <small>{option.meta}</small>}
              </span>
              {typeof option.count === "number" && <span className="custom-select-count">{option.count}</span>}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
