import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type Props = {
  text: string;
  children: ReactNode;
};

const SHOW_DELAY_MS = 350;
const VIEWPORT_PAD = 8;
const GAP = 6;
const BUBBLE_WIDTH = 220;

export function Tooltip({ text, children }: Props) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const handleEnter = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShow(true), SHOW_DELAY_MS);
  };
  const handleLeave = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setShow(false);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (!show) return;
    const trigger = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const tr = trigger.getBoundingClientRect();
    const br = bubble.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = tr.bottom + GAP;
    let left = tr.left;

    const maxLeft = vw - br.width - VIEWPORT_PAD;
    if (left > maxLeft) left = maxLeft;
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;

    if (top + br.height > vh - VIEWPORT_PAD) {
      const above = tr.top - br.height - GAP;
      if (above >= VIEWPORT_PAD) top = above;
    }

    setPos({ top, left });
  }, [show]);

  return (
    <span
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
      onFocusCapture={handleEnter}
      onBlurCapture={handleLeave}
    >
      {children}
      {show &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? "visible" : "hidden",
              width: BUBBLE_WIDTH,
              padding: "6px 8px",
              background: "var(--accent)",
              color: "var(--accent-on)",
              fontSize: 11,
              lineHeight: 1.4,
              borderRadius: 4,
              whiteSpace: "normal",
              zIndex: 1000,
              pointerEvents: "none",
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.18)",
              textTransform: "none",
              letterSpacing: "normal",
              fontWeight: "normal",
              fontFamily: "var(--font-sans)",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Small "?" badge wrapped in a {@link Tooltip}. SVG-drawn so the glyph
 * centers reliably across fonts. Use to annotate field labels. */
export function InfoIcon({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <svg
        role="img"
        aria-label={text}
        width="12"
        height="12"
        viewBox="0 0 12 12"
        style={{
          flex: "0 0 auto",
          cursor: "help",
          opacity: 0.55,
          color: "currentColor",
        }}
      >
        <circle
          cx="6"
          cy="6"
          r="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <text
          x="6"
          y="6"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="8"
          fontWeight="700"
          fontFamily="var(--font-sans)"
          fill="currentColor"
        >
          ?
        </text>
      </svg>
    </Tooltip>
  );
}

/** Amber warning triangle wrapped in a {@link Tooltip}. Use to flag a value
 * that works but isn't current best practice (e.g. a legacy convention). */
export function WarningIcon({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <svg
        role="img"
        aria-label={text}
        width="12"
        height="12"
        viewBox="0 0 12 12"
        style={{
          flex: "0 0 auto",
          cursor: "help",
          color: "#d9a300",
        }}
      >
        <path
          d="M6 1 L11.2 10.5 L0.8 10.5 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <text
          x="6"
          y="7.4"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="6.5"
          fontWeight="700"
          fontFamily="var(--font-sans)"
          fill="currentColor"
        >
          !
        </text>
      </svg>
    </Tooltip>
  );
}
