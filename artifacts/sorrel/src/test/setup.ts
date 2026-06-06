import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement ResizeObserver, which cmdk (the ⌘K Command palette)
// and some Radix primitives instantiate on mount. Provide a no-op stub so those
// components can render under tests.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}

// jsdom doesn't implement scrollIntoView, which cmdk calls on the active item.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
