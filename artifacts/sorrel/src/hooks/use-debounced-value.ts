import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value. The returned value only updates after
 * `delayMs` of no further changes — used to throttle the live-preview src so a
 * burst of keystrokes triggers one composition fetch, not one per character.
 */
export function useDebouncedValue<T>(value: T, delayMs = 600): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
