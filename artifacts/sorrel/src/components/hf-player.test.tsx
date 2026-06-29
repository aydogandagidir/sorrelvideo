/**
 * Regression guard for the live-preview SCALE bug.
 *
 * `@hyperframes/player` fits the composition to the host with `transform:
 * scale()`, computed from the host's size at the instant its internal fit
 * routine runs — which races the host's initial layout and is NOT re-run by the
 * element's own ResizeObserver on later layout changes (verified against
 * 0.6.120). That froze the Studio preview at the wrong scale: a tiny
 * composition, or one zoomed past its frame (the "screen breaks momentarily"
 * report). HfPlayer fixes it by driving the element's `_rescale()` itself — on
 * every host resize (its own ResizeObserver) and after each load settles
 * (`ready` → rAF). These tests pin that wiring.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neutralize the package's self-registering side-effect import — jsdom can't run
// the real web component, and we drive a stub element instead.
vi.mock("@hyperframes/player", () => ({}));

import { HfPlayer, forcePlayerRefit } from "./hf-player";

// A controllable ResizeObserver: capture instances so a test can fire the
// callback on demand (jsdom has no layout engine to fire it for us).
interface MockRO {
  callback: ResizeObserverCallback;
  observed: Element[];
  fire: () => void;
}
const observers: MockRO[] = [];

class MockResizeObserver {
  private record: MockRO;
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, observed: [], fire: () => callback([], this as unknown as ResizeObserver) };
    observers.push(this.record);
  }
  observe(el: Element): void {
    this.record.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  // Run rAF callbacks synchronously so the `ready` re-fit is observable without
  // a real frame loop.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountPlayer() {
  const { container } = render(<HfPlayer src="/composition.html" autoplay loop />);
  const el = container.querySelector("hyperframes-player") as HTMLElement;
  const rescale = vi.fn();
  (el as unknown as { _rescale: () => void })._rescale = rescale;
  return { el, rescale };
}

describe("forcePlayerRefit", () => {
  it("calls the element's _rescale when present", () => {
    const rescale = vi.fn();
    forcePlayerRefit({ _rescale: rescale } as never);
    expect(rescale).toHaveBeenCalledTimes(1);
  });

  it("no-ops (does not throw) for null or an element without _rescale", () => {
    expect(() => forcePlayerRefit(null)).not.toThrow();
    expect(() => forcePlayerRefit({} as never)).not.toThrow();
  });
});

describe("HfPlayer fit-on-resize wiring", () => {
  it("observes the host element with a ResizeObserver", () => {
    const { el } = mountPlayer();
    expect(observers.length).toBeGreaterThan(0);
    expect(observers.some((o) => o.observed.includes(el))).toBe(true);
  });

  it("re-fits the composition when the host resizes", () => {
    const { el, rescale } = mountPlayer();
    rescale.mockClear();
    const ro = observers.find((o) => o.observed.includes(el));
    expect(ro).toBeDefined();
    ro?.fire();
    expect(rescale).toHaveBeenCalled();
  });

  it("re-fits after the composition reports ready (covers the layout race)", () => {
    const { el, rescale } = mountPlayer();
    rescale.mockClear();
    act(() => {
      el.dispatchEvent(new CustomEvent("ready", { detail: { duration: 5 } }));
    });
    expect(rescale).toHaveBeenCalled();
  });
});
