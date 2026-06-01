/**
 * Ambient JSX typing for the `@hyperframes/player` web component.
 *
 * `@hyperframes/player` self-defines a `<hyperframes-player>` custom element on
 * import (see `customElements.define("hyperframes-player", …)` in its dist). It
 * ships no React bindings, so TSX has no idea the tag exists. This file teaches
 * React 19's JSX type-checker about the element and its documented attributes.
 *
 * React 19 (`@types/react` v19) moved the JSX namespace out of global scope and
 * onto the `react` module, so we augment `React.JSX.IntrinsicElements` rather
 * than the legacy global `JSX`. The element is consumed only through the typed
 * `HfPlayer` wrapper (`components/hf-player.tsx`); this declaration exists so the
 * wrapper's single `<hyperframes-player>` usage type-checks.
 *
 * Attributes mirror the component's `observedAttributes` plus the boolean
 * attributes (`controls`, `autoplay`, `loop`) it reads via `hasAttribute`.
 * Verified against @hyperframes/player@0.6.64.
 */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

/** Custom events dispatched by `<hyperframes-player>` (verified against 0.6.64). */
export interface HyperframesPlayerEventMap {
  /** Composition timeline resolved; `detail.duration` is total seconds. */
  ready: CustomEvent<{ duration: number }>;
  /** Fired on each playback tick; `detail.currentTime` is seconds. */
  timeupdate: CustomEvent<{ currentTime: number }>;
  /** Playback reached the end of the composition timeline. */
  ended: Event;
  /** A non-fatal playback error (e.g. blocked audio). */
  play: Event;
  pause: Event;
  /** Composition failed to load / no timeline found; `detail.message`. */
  error: CustomEvent<{ message: string }>;
  /** Shader transition lifecycle updates (advanced; unused by Sorrel today). */
  shadertransitionstate: CustomEvent<unknown>;
}

/**
 * The DOM element interface for the custom element. We expose only the methods
 * Sorrel calls imperatively plus the read-only playback properties; the full
 * surface lives in the package's own `.d.ts` (`HyperframesPlayer`).
 */
export interface HyperframesPlayerElement extends HTMLElement {
  play(): void;
  pause(): void;
  seek(timeInSeconds: number): void;
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ready: boolean;
  addEventListener<K extends keyof HyperframesPlayerEventMap>(
    type: K,
    listener: (this: HyperframesPlayerElement, ev: HyperframesPlayerEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HyperframesPlayerEventMap>(
    type: K,
    listener: (this: HyperframesPlayerElement, ev: HyperframesPlayerEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

/**
 * JSX-facing attributes for `<hyperframes-player>`. Booleans are intentionally
 * typed as the DOM-attribute presence form (`""` toggles them on) — the
 * `HfPlayer` wrapper normalizes React booleans to this representation.
 */
export interface HyperframesPlayerAttributes
  extends DetailedHTMLProps<HTMLAttributes<HyperframesPlayerElement>, HyperframesPlayerElement> {
  /** URL of the composition HTML to load and play. */
  src?: string;
  /** Inline composition HTML (alternative to `src`). */
  srcdoc?: string;
  /** Show the built-in player chrome when present. */
  controls?: boolean | "";
  /** Start muted when present. */
  muted?: boolean | "";
  /** Begin playback automatically once the composition is ready. */
  autoplay?: boolean | "";
  /** Loop playback when the timeline ends. */
  loop?: boolean | "";
  /** Poster image shown before the first frame. */
  poster?: string;
  /** Playback speed multiplier (kebab-case DOM attribute). */
  "playback-rate"?: number | string;
  /** Optional external audio track URL. */
  "audio-src"?: string;
  /** Composition aspect width (drives letterboxing, not pixel output). */
  width?: number | string;
  /** Composition aspect height (drives letterboxing, not pixel output). */
  height?: number | string;
}

declare module "react" {
  // `declare module` is a declaration context, so this namespace is allowed by
  // the workspace ESLint rule `@typescript-eslint/no-namespace`
  // ({ allowDeclarations: true }) — the same pattern used for Express's
  // `declare global { namespace Express { … } }`.
  namespace JSX {
    interface IntrinsicElements {
      "hyperframes-player": HyperframesPlayerAttributes;
    }
  }
}
