/**
 * HfPlayer — a React 19 wrapper around the `@hyperframes/player` web component.
 *
 * `@hyperframes/player` is a zero-dependency custom element (`<hyperframes-player>`)
 * that plays a *composition* — live, seekable HTML rendered in an iframe — rather
 * than an mp4. Sorrel uses it for a render-time **live preview** in Studio so a
 * user can scrub the composition before spending a render. (The finished mp4 on
 * the Projects page stays a plain `<video>`.)
 *
 * Responsibilities of this wrapper:
 *  - Register the element exactly once, HMR/StrictMode-safe (the package
 *    self-defines on import; we guard against double registration).
 *  - Bridge the imperative DOM event/method API to idiomatic React props and an
 *    imperative handle (`play` / `pause` / `seek` / `reload`).
 *  - Normalize React booleans (`controls`, `muted`, …) to the attribute-presence
 *    form the element expects.
 *  - Surface an internal `idle | loading | ready | error` status with a Skeleton
 *    while loading and an Alert on error.
 *
 * Verified against @hyperframes/player@0.6.64: methods `play`/`pause`/`seek`;
 * events `ready` (`detail.duration`), `timeupdate` (`detail.currentTime`),
 * `ended`, `error` (`detail.message`). There is no public `load`/`reload`
 * method, so `reload()` re-assigns `src` to force the element to reload the
 * composition.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { HyperframesPlayerElement } from "@/types/hyperframes-player";

// Register the custom element once. The package's module side-effect calls
// `customElements.define("hyperframes-player", …)` on import; guarding the
// dynamic import keeps StrictMode double-mounts and Vite HMR from attempting a
// second `define()` (which throws). `customElements` is undefined under SSR /
// non-DOM test runners, so we feature-detect first.
if (
  typeof customElements !== "undefined" &&
  !customElements.get("hyperframes-player")
) {
  void import("@hyperframes/player");
}

/** Playback status surfaced to the parent and used to drive overlays. */
export type HfPlayerStatus = "idle" | "loading" | "ready" | "error";

/** Imperative API exposed via `ref`. */
export interface HfPlayerHandle {
  play(): void;
  pause(): void;
  /** Seek to an absolute time, in seconds. */
  seek(timeInSeconds: number): void;
  /** Force the composition to reload from `src` (e.g. after editing vars). */
  reload(): void;
}

export interface HfPlayerProps {
  /** Composition HTML URL the element loads and plays. */
  src: string;
  /** Show the element's built-in transport controls. */
  controls?: boolean;
  /** Start muted. */
  muted?: boolean;
  /** Auto-play once the composition is ready. */
  autoplay?: boolean;
  /** Loop when the timeline ends. */
  loop?: boolean;
  /**
   * Aspect ratio as `"W:H"` (e.g. `"9:16"`). Mapped to the element's
   * `width`/`height` attributes, which drive letterboxing. Defaults to `"9:16"`.
   */
  aspect?: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** Fired once the composition timeline resolves. */
  onReady?: () => void;
  /** Fired on each playback tick with the current time and total duration (s). */
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  /** Fired when playback reaches the end of the timeline. */
  onEnded?: () => void;
  /** Fired when the composition fails to load. */
  onError?: (message: string) => void;
  /** Notified whenever the internal status changes. */
  onStatusChange?: (status: HfPlayerStatus) => void;
}

/** Parse an `"W:H"` aspect string into a sane positive ratio, default 9:16. */
function parseAspect(aspect: string | undefined): { width: number; height: number } {
  const fallback = { width: 9, height: 16 };
  if (!aspect) return fallback;
  const [w, h] = aspect.split(":");
  const width = Number.parseFloat(w);
  const height = Number.parseFloat(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }
  return { width, height };
}

/**
 * Mirror a React boolean onto an element as an attribute presence toggle.
 * The element reads these via `hasAttribute`, so the value is irrelevant —
 * presence is what matters.
 */
function setBooleanAttr(el: HTMLElement, name: string, on: boolean | undefined): void {
  if (on) el.setAttribute(name, "");
  else el.removeAttribute(name);
}

/**
 * Force the player web component to re-fit its composition to the host's CURRENT
 * size.
 *
 * `@hyperframes/player` scales the composition (rendered at its authored pixel
 * size, e.g. 1080×1920) to fit the host via `transform: scale()`, computing the
 * factor from the host's `offsetWidth/Height` at the instant its internal fit
 * routine runs. Two things make that instant unreliable here:
 *  - The fit-on-`ready` fires before the surrounding grid/flex has sized the
 *    host, so the factor is computed against a transient (tiny, or full-width
 *    pre-clamp) box and then frozen.
 *  - The element's own ResizeObserver does NOT reliably re-fit on later layout
 *    changes (window resize, opening devtools, toggling a side panel) — verified
 *    against @hyperframes/player@0.6.120: the host grows/shrinks but the scale
 *    stays stale.
 * Either leaves the live preview frozen at the wrong scale — a tiny composition
 * lost in a black box, or one zoomed past the frame and clipped (the "screen
 * breaks for a moment" report). `_rescale()` is the element's internal fit; we
 * drive it ourselves on every host resize + after each load settles. The dep is
 * pinned EXACT, so the minified name is stable — guard defensively and
 * re-verify on any @hyperframes/player bump.
 */
export function forcePlayerRefit(el: HyperframesPlayerElement | null): void {
  const fit = (el as unknown as { _rescale?: () => void } | null)?._rescale;
  if (typeof fit === "function") fit.call(el);
}

export const HfPlayer = forwardRef<HfPlayerHandle, HfPlayerProps>(function HfPlayer(
  {
    src,
    controls,
    muted,
    autoplay,
    loop,
    aspect = "9:16",
    className,
    onReady,
    onTimeUpdate,
    onEnded,
    onError,
    onStatusChange,
  },
  ref,
) {
  const elRef = useRef<HyperframesPlayerElement | null>(null);
  const [status, setStatus] = useState<HfPlayerStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep the latest callbacks in a ref so the event-binding effect can bind
  // once per mount without going stale. Refs are exempt from exhaustive-deps,
  // so no dependency churn and no eslint suppression.
  const handlers = useRef({ onReady, onTimeUpdate, onEnded, onError, onStatusChange });
  handlers.current = { onReady, onTimeUpdate, onEnded, onError, onStatusChange };

  useImperativeHandle(
    ref,
    () => ({
      play: () => elRef.current?.play(),
      pause: () => elRef.current?.pause(),
      seek: (timeInSeconds: number) => elRef.current?.seek(timeInSeconds),
      reload: () => {
        const el = elRef.current;
        if (!el) return;
        // No public reload() on the element; re-assigning `src` re-triggers its
        // attributeChangedCallback("src") which resets readiness and reloads the
        // iframe. attributeChangedCallback only fires on a *changed* value, so
        // clear it first, then restore on the next frame.
        const url = src;
        setErrorMessage(null);
        setStatus("loading");
        el.removeAttribute("src");
        requestAnimationFrame(() => {
          if (elRef.current === el) el.setAttribute("src", url);
        });
      },
    }),
    // `src` is read inside reload(); rebuild the handle if it changes.
    // setStatus/setErrorMessage are stable React setters (exempt).
    [src],
  );

  // Notify the parent whenever status changes. Reads `onStatusChange` from the
  // handlers ref so the only reactive dependency is `status` itself.
  useEffect(() => {
    handlers.current.onStatusChange?.(status);
  }, [status]);

  // Bind DOM events once per element mount. Body touches only refs (elRef,
  // handlers) and the stable `setStatus`/`setErrorMessage` setters, so `[]` is
  // genuinely exhaustive — no suppression needed.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const handleReady = (ev: CustomEvent<{ duration: number }>) => {
      setErrorMessage(null);
      setStatus("ready");
      handlers.current.onReady?.();
      // Surface the initial duration immediately so consumers can enable a
      // scrubber without waiting for the first playback tick. `ready.detail`
      // carries the duration; fall back to the element property.
      const duration = ev.detail?.duration ?? el.duration;
      handlers.current.onTimeUpdate?.(el.currentTime, duration);
      // The element's own fit-on-ready races the host's layout (see
      // forcePlayerRefit). Re-fit on the next frames, once the surrounding
      // layout has settled, so the composition isn't frozen at a stale scale.
      requestAnimationFrame(() => {
        forcePlayerRefit(el);
        requestAnimationFrame(() => forcePlayerRefit(el));
      });
    };
    const handleTimeUpdate = (ev: CustomEvent<{ currentTime: number }>) => {
      // `timeupdate` carries only currentTime; duration comes from the element
      // property (populated at `ready`).
      const currentTime = ev.detail?.currentTime ?? el.currentTime;
      handlers.current.onTimeUpdate?.(currentTime, el.duration);
    };
    const handleEnded = () => {
      handlers.current.onEnded?.();
    };
    const handleError = (ev: CustomEvent<{ message: string }>) => {
      const message = ev.detail?.message ?? "Failed to load preview";
      setErrorMessage(message);
      setStatus("error");
      handlers.current.onError?.(message);
    };

    el.addEventListener("ready", handleReady);
    el.addEventListener("timeupdate", handleTimeUpdate);
    el.addEventListener("ended", handleEnded);
    el.addEventListener("error", handleError);
    return () => {
      el.removeEventListener("ready", handleReady);
      el.removeEventListener("timeupdate", handleTimeUpdate);
      el.removeEventListener("ended", handleEnded);
      el.removeEventListener("error", handleError);
    };
  }, []);

  // Keep the composition fitted to the host across layout changes. The element's
  // own ResizeObserver doesn't reliably re-fit (see forcePlayerRefit), so we
  // observe the host ourselves and drive its fit on every resize. The initial
  // observation also re-fits once the host has its laid-out size, covering the
  // ready/layout race. Body touches only refs + a stable helper, so `[]` is
  // exhaustive.
  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => forcePlayerRefit(el));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Reflect boolean props onto the element as attribute presence.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    setBooleanAttr(el, "controls", controls);
    setBooleanAttr(el, "muted", muted);
    setBooleanAttr(el, "autoplay", autoplay);
    setBooleanAttr(el, "loop", loop);
  }, [controls, muted, autoplay, loop]);

  // Moving to a new `src` (without a remount) re-enters the loading state until
  // the next `ready`/`error`. The element handles the actual reload via its
  // observed `src` attribute; we just track UI state.
  useEffect(() => {
    setErrorMessage(null);
    setStatus(src ? "loading" : "idle");
  }, [src]);

  const { width, height } = parseAspect(aspect);

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-lg border bg-black",
        className,
      )}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <hyperframes-player
        ref={elRef}
        src={src}
        width={width}
        height={height}
        style={{ width: "100%", height: "100%", display: "block" }}
      />

      {status === "loading" && (
        <div className="absolute inset-0 grid place-items-center bg-black/40">
          <Skeleton className="h-full w-full rounded-none bg-white/10" />
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 grid place-items-center bg-background/95 p-4">
          <Alert variant="destructive" className="max-w-sm">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Preview unavailable</AlertTitle>
            <AlertDescription>
              {errorMessage ?? "The composition could not be loaded."}
            </AlertDescription>
          </Alert>
        </div>
      )}
    </div>
  );
});
