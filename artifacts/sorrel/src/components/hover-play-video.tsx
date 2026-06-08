import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Motion-first card media: shows a poster, and on hover lazily mounts a muted,
 * looping <video> of the rendered MP4 over it — the gesture that makes a gallery
 * feel like a video product (CapCut / OpusClip). The <video> only fetches its
 * src on first hover (preload="none" + mount-on-enter) so a grid never spins up
 * N downloads at once; it pauses + resets on leave and fades out to the poster.
 */
export function HoverPlayVideo({
  videoSrc,
  children,
}: {
  videoSrc: string;
  /** The always-painted poster underneath (img or CompositionThumb). */
  children: ReactNode;
}) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  return (
    <div
      className="absolute inset-0"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => {
        setActive(false);
        setPlaying(false);
        const v = ref.current;
        if (v) {
          v.pause();
          v.currentTime = 0;
        }
      }}
    >
      {children}
      {active && (
        <video
          ref={ref}
          src={videoSrc}
          muted
          loop
          playsInline
          autoPlay
          preload="none"
          onPlaying={() => setPlaying(true)}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
            playing ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </div>
  );
}
