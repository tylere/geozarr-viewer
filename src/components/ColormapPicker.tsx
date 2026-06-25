import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";

export type ColormapOption = {
  name: string;
  label: string;
  rowIndex: number;
  reversed?: boolean;
};

export type ColormapPickerProps = {
  colormapsPngUrl: string;
  rowCount: number;
  value: string;
  options: ColormapOption[];
  onChange: (next: string) => void;
};

export function ColormapPicker({
  colormapsPngUrl,
  rowCount,
  value,
  options,
  onChange,
}: ColormapPickerProps) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const active = options.find((o) => o.name === value);
  const swatchHeight = 14;
  const swatchWidth = 80;
  const stripHeight = swatchHeight * rowCount;

  function swatchStyle(rowIndex: number, reversed?: boolean): CSSProperties {
    return {
      backgroundImage: `url(${colormapsPngUrl})`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `100% ${stripHeight}px`,
      backgroundPosition: `0 ${-rowIndex * swatchHeight}px`,
      transform: reversed ? "scaleX(-1)" : undefined,
      imageRendering: "auto",
    };
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // Scroll focused option into view when keyboard navigating
  useEffect(() => {
    if (!open || !focused || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-name="${CSS.escape(focused)}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [focused, open]);

  // When dropdown opens, scroll the active item into view immediately
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-name="${CSS.escape(value)}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, value]);

  function handleTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const currentFocus = focused ?? value;
    const idx = options.findIndex((o) => o.name === currentFocus);

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setFocused(value);
        } else {
          setFocused(options[Math.min(idx + 1, options.length - 1)].name);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setFocused(value);
        } else {
          setFocused(options[Math.max(idx - 1, 0)].name);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setFocused(value);
        } else if (focused) {
          onChange(focused);
          setOpen(false);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
    }
  }

  function handleSelect(name: string) {
    onChange(name);
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Trigger button — shows active colormap name + gradient swatch */}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Colormap: ${value}`}
        onClick={() => {
          setOpen((o) => !o);
          setFocused(value);
        }}
        onKeyDown={handleTriggerKeyDown}
        style={{
          width: "100%",
          display: "grid",
          gridTemplateColumns: `1fr ${swatchWidth}px 14px`,
          alignItems: "center",
          gap: 8,
          textAlign: "left",
          padding: "6px 8px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {active?.label ?? value}
        </span>
        {active && (
          <div
            aria-hidden
            style={{
              height: swatchHeight,
              borderRadius: 2,
              ...swatchStyle(active.rowIndex, active.reversed),
            }}
          />
        )}
        <span aria-hidden style={{ fontSize: 9, color: "var(--text-muted)", textAlign: "center" }}>
          ▾
        </span>
      </button>

      {/* Dropdown listbox */}
      {open && (
        <div
          role="listbox"
          ref={listRef}
          aria-label="colormap"
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            zIndex: 100,
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow)",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {options.map((o) => {
            const isSelected = o.name === value;
            const isFocused = o.name === focused;
            return (
              <div
                key={o.name}
                role="option"
                aria-selected={isSelected}
                data-name={o.name}
                onClick={() => handleSelect(o.name)}
                onMouseEnter={() => setFocused(o.name)}
                style={{
                  display: "grid",
                  gridTemplateColumns: `1fr ${swatchWidth}px`,
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 8px",
                  cursor: "pointer",
                  background:
                    isFocused || isSelected
                      ? "var(--surface-muted)"
                      : "transparent",
                  fontWeight: isSelected ? 600 : "normal",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {o.label}
                </span>
                <div
                  aria-hidden
                  data-testid="colormap-preview"
                  className="colormap-preview"
                  style={{
                    height: swatchHeight,
                    borderRadius: 2,
                    ...swatchStyle(o.rowIndex, o.reversed),
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
