/**
 * Stub for `@hyperframes/core/runtime/lottie-readiness`.
 *
 * That subpath is declared in @hyperframes/core's package `exports` (0.6.6 AND
 * 0.6.65) but the target file is NOT shipped — a packaging bug. @hyperframes/
 * studio's `Player.tsx` imports exactly one symbol from it, `isLottieAnimationLoaded`,
 * used to keep a "loading" overlay up until every registered Lottie animation
 * is ready. Sorrel's compositions don't use Lottie (`window.__hfLottie` is
 * empty), so this stub is inert for them; for a hypothetical Lottie composition
 * it honours an `isLoaded` flag when present and otherwise treats the animation
 * as ready (the preview just won't gate playback on Lottie readiness — a minor,
 * preview-only imperfection, never a correctness or security concern). A Vite
 * `resolve.alias` redirects the studio's import here at build time.
 */
export function isLottieAnimationLoaded(animation: unknown): boolean {
  if (
    animation &&
    typeof animation === "object" &&
    "isLoaded" in animation
  ) {
    return Boolean((animation as { isLoaded?: unknown }).isLoaded);
  }
  return true;
}
