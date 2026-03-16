"use client";

import { useAuth } from "@/feature/auth";
import { cn } from "@/shared/lib/utils";
import { createPortal } from "react-dom";
import { Button } from "@/shared/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { motion, useSpring } from "framer-motion";
import { Blend, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PORTAL_ID = "app-float-portal";

function usePortalContainer(): HTMLDivElement | null {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    let el = document.getElementById(PORTAL_ID) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = PORTAL_ID;
      el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
      document.body.appendChild(el);
    }
    setContainer(el);
    return () => {
      // Don't remove - other mounts may use it
    };
  }, []);
  return container;
}

import { AppearanceFloatPanel } from "./appearance-float";
import { UserFloatPanel } from "./user-float";

// ─── Types ───────────────────────────────────────────────────────────────────

type FloatPanel = "appearance" | "user" | null;

type FloatPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left-center"
  | "right-center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

// ─── Constants ───────────────────────────────────────────────────────────────

const EDGE = 16;
const FAB = 32;
const GAP = 8;
const COUNT = 2;
const SPAN = FAB * COUNT + GAP * (COUNT - 1);
const SPRING = { stiffness: 400, damping: 30 };
const DRAG_THRESHOLD_SQ = 25;
const DEFAULT_POS: FloatPosition = "top-right";

const SNAPS: readonly { pos: FloatPosition; xPct: number; yPct: number }[] = [
  { pos: "top-left", xPct: 0, yPct: 0 },
  { pos: "top-center", xPct: 50, yPct: 0 },
  { pos: "top-right", xPct: 100, yPct: 0 },
  { pos: "left-center", xPct: 0, yPct: 50 },
  { pos: "right-center", xPct: 100, yPct: 50 },
  { pos: "bottom-left", xPct: 0, yPct: 100 },
  { pos: "bottom-center", xPct: 50, yPct: 100 },
  { pos: "bottom-right", xPct: 100, yPct: 100 },
];

// ─── Pure helpers ────────────────────────────────────────────────────────────

function isVert(pos: FloatPosition) {
  return pos === "left-center" || pos === "right-center";
}

function getCoords(pos: FloatPosition) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1920;
  const vh = typeof window !== "undefined" ? window.innerHeight : 1080;
  const v = isVert(pos);
  const w = v ? FAB : SPAN;
  const h = v ? SPAN : FAB;

  const x = pos.includes("left")
    ? EDGE
    : pos.includes("right")
      ? vw - w - EDGE
      : (vw - w) / 2;

  const y = pos.startsWith("top")
    ? EDGE
    : pos.startsWith("bottom")
      ? vh - h - EDGE
      : (vh - h) / 2;

  return { x, y, w, h };
}

function snapNearest(cx: number, cy: number): FloatPosition {
  const xPct = (cx / window.innerWidth) * 100;
  const yPct = (cy / window.innerHeight) * 100;
  let best = SNAPS[0];
  let bestD = Infinity;
  for (const s of SNAPS) {
    const d = (xPct - s.xPct) ** 2 + (yPct - s.yPct) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best.pos;
}

function tipSide(pos: FloatPosition): "top" | "bottom" | "left" | "right" {
  if (pos.startsWith("top")) return "bottom";
  if (pos.startsWith("bottom")) return "top";
  return pos === "left-center" ? "right" : "left";
}

function panelClass(pos: FloatPosition): string {
  const py = pos.startsWith("top")
    ? "top-14"
    : pos.startsWith("bottom")
      ? "bottom-14"
      : "top-1/2 -translate-y-1/2";
  const px = pos.includes("left")
    ? "left-4"
    : pos.includes("right")
      ? "right-4"
      : "left-1/2 -translate-x-1/2";
  return `fixed z-[100] flex flex-col bg-popover rounded-lg border pointer-events-auto ${py} ${px}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AppFloat() {
  const portalContainer = usePortalContainer();
  const [position, setPosition] = useState<FloatPosition>(DEFAULT_POS);
  const [activePanel, setActivePanel] = useState<FloatPanel>(null);
  const [isDragging, setIsDragging] = useState(false);
  const { user } = useAuth();

  const posRef = useRef(position);
  posRef.current = position;
  const panelRef = useRef(activePanel);
  panelRef.current = activePanel;
  const draggingRef = useRef(isDragging);
  draggingRef.current = isDragging;

  const dragRef = useRef<{
    mx: number;
    my: number;
    ox: number;
    oy: number;
    target: FloatPanel;
  } | null>(null);

  // Use 0,0 on SSR so float is on-screen; sync to correct position on mount
  const initCoords = useRef(
    typeof window !== "undefined" ? getCoords(DEFAULT_POS) : { x: 0, y: 0 },
  );
  const x = useSpring(initCoords.current.x, SPRING);
  const y = useSpring(initCoords.current.y, SPRING);

  const vertical = useMemo(() => isVert(position), [position]);
  const side = useMemo(() => tipSide(position), [position]);
  const panelClassName = useMemo(() => panelClass(position), [position]);

  useEffect(() => {
    const sync = () => {
      if (!draggingRef.current) {
        const c = getCoords(posRef.current);
        x.set(c.x);
        y.set(c.y);
      }
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [position, x, y]);

  const toggle = useCallback(
    (panel: FloatPanel) =>
      setActivePanel((prev) => (prev === panel ? null : panel)),
    [],
  );

  const close = useCallback(() => setActivePanel(null), []);

  const onDown = useCallback(
    (e: React.PointerEvent, target: FloatPanel) => {
      dragRef.current = {
        mx: e.clientX,
        my: e.clientY,
        ox: x.get(),
        oy: y.get(),
        target,
      };
      if (!panelRef.current) {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }
    },
    [x, y],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || panelRef.current) return;
      const dx = e.clientX - d.mx;
      const dy = e.clientY - d.my;
      const distSq = dx * dx + dy * dy;

      if (!draggingRef.current && distSq > DRAG_THRESHOLD_SQ)
        setIsDragging(true);
      if (draggingRef.current || distSq > DRAG_THRESHOLD_SQ) {
        x.jump(d.ox + dx);
        y.jump(d.oy + dy);
      }
    },
    [x, y],
  );

  const onUp = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      if (draggingRef.current) {
        const c = getCoords(posRef.current);
        const snap = snapNearest(x.get() + c.w / 2, y.get() + c.h / 2);
        setPosition(snap);
        const to = getCoords(snap);
        x.set(to.x);
        y.set(to.y);
      } else {
        toggle(dragRef.current?.target ?? null);
      }
      setIsDragging(false);
      dragRef.current = null;
    },
    [x, y, toggle],
  );

  const appearanceHandlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => onDown(e, "appearance"),
      onPointerMove: onMove,
      onPointerUp: onUp,
    }),
    [onDown, onMove, onUp],
  );

  const userHandlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => onDown(e, "user"),
      onPointerMove: onMove,
      onPointerUp: onUp,
    }),
    [onDown, onMove, onUp],
  );

  const content = (
    <>
      <motion.div
        className={cn(
          "fixed left-0 top-0 z-[100] flex items-center gap-2 pointer-events-auto",
          vertical && "flex-col",
        )}
        style={{ x, y }}
      >
        {/* Appearance */}
        <Tooltip open={isDragging ? false : undefined}>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="secondary"
              {...appearanceHandlers}
              className={cn(
                "size-8 rounded-full shrink-0 touch-none select-none group",
                isDragging && "cursor-grabbing",
                activePanel === "appearance" && "ring-2 ring-primary",
              )}
            >
              <Blend className="size-4 group-hover:scale-125 transition-transform duration-300" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={side}>Appearance</TooltipContent>
        </Tooltip>

        {/* User */}
        <Tooltip open={isDragging ? false : undefined}>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="secondary"
              {...userHandlers}
              className={cn(
                "size-8 rounded-full shrink-0 touch-none select-none group",
                isDragging && "cursor-grabbing",
                activePanel === "user" && "ring-2 ring-primary",
              )}
            >
              <UserRound className="size-4 group-hover:scale-125 transition-transform duration-300" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={side}>
            {user?.name || "Profile"}
          </TooltipContent>
        </Tooltip>
      </motion.div>

      {activePanel === "appearance" && (
        <AppearanceFloatPanel className={panelClassName} onClose={close} />
      )}
      {activePanel === "user" && (
        <UserFloatPanel className={panelClassName} onClose={close} />
      )}
    </>
  );

  if (!portalContainer) return null;
  return createPortal(content, portalContainer);
}
