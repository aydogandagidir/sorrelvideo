import React from "react";

/**
 * The animated 9:16 video composition — a faithful port of the Claude Design
 * handoff's composition.jsx (the design's signature piece). Pure presentational;
 * scales via container-query units (cqw) so it is pixel-correct from a tiny
 * thumbnail to a full preview. Entrance animations animate transform only, so
 * content is never trapped invisible. Must render inside `container-type: size`.
 */

export type CompositionLayout = "center" | "stat" | "quote" | "grid" | "sweep";

export interface CompositionVars {
  headline?: string;
  body?: string;
  cta?: string;
}
export interface CompositionBrand {
  companyName?: string;
  logoMark?: string;
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** Eased progress within a [a,b] window of the global 0..1 timeline. */
function seg(t: number, a: number, b: number, ease = easeOut) {
  if (t <= a) return 0;
  if (t >= b) return 1;
  return ease((t - a) / (b - a));
}
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  );
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// design-space px → container-query width units (reference frame 360px wide).
const u = (px: number) => (((px / 360) * 100).toFixed(3) + "cqw") as string;

export function Composition({
  t,
  vars,
  brand,
  accent,
  bg,
  layout = "center",
  chrome = true,
}: {
  t: number;
  vars: CompositionVars;
  brand: CompositionBrand;
  accent: string;
  bg: string;
  layout?: CompositionLayout;
  chrome?: boolean;
}) {
  const headlineLines = (vars.headline || "").split("\n");
  const inA = seg(t, 0.04, 0.34);
  const bodyA = seg(t, 0.3, 0.55);
  const ctaA = seg(t, 0.52, 0.74);
  const outFade = t > 0.94 ? 1 - (t - 0.94) / 0.06 : 1;
  const txtMain = "#f6f8f4";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: bg,
        color: txtMain,
        overflow: "hidden",
        fontFamily: "var(--font-display)",
        opacity: outFade,
      }}
    >
      {/* ambient gradient driven by accent */}
      <div
        style={{
          position: "absolute",
          inset: "-20%",
          background: `radial-gradient(60% 50% at ${lerp(30, 70, easeInOut(t))}% ${lerp(28, 40, t)}%, ${hexA(accent, 0.22)} 0%, transparent 60%)`,
          filter: "blur(10px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(120% 80% at 50% 120%, rgba(0,0,0,.5), transparent)",
        }}
      />

      {layout === "sweep" && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "55%",
            left: `${lerp(-60, 110, easeInOut(seg(t, 0.1, 0.85, easeInOut)))}%`,
            background: `linear-gradient(105deg, transparent, ${hexA(accent, 0.5)}, transparent)`,
            transform: "skewX(-12deg)",
            mixBlendMode: "screen",
          }}
        />
      )}

      {/* brand chrome — logo */}
      {chrome && (
        <div
          style={{
            position: "absolute",
            top: u(22),
            left: u(22),
            display: "flex",
            alignItems: "center",
            gap: u(8),
            opacity: seg(t, 0.02, 0.18),
          }}
        >
          <div
            style={{
              width: u(26),
              height: u(26),
              borderRadius: u(7),
              background: accent,
              color: bg,
              display: "grid",
              placeItems: "center",
              fontWeight: 700,
              fontSize: u(15),
            }}
          >
            {brand.logoMark || "S"}
          </div>
          <span
            style={{
              fontSize: u(12.5),
              fontWeight: 600,
              letterSpacing: ".04em",
              opacity: 0.92,
            }}
          >
            {brand.companyName}
          </span>
        </div>
      )}

      {/* main stack */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: layout === "stat" ? "center" : "flex-end",
          padding: `0 ${u(26)} ${u(92)}`,
          gap: u(12),
          alignItems:
            layout === "quote"
              ? "flex-start"
              : layout === "stat"
                ? "center"
                : "flex-start",
          textAlign: layout === "stat" ? "center" : "left",
        }}
      >
        {layout === "quote" && (
          <div
            style={{
              fontSize: u(64),
              lineHeight: 0.6,
              color: accent,
              opacity: inA,
            }}
          >
            &ldquo;
          </div>
        )}
        {layout === "grid" && (
          <div style={{ display: "flex", gap: u(6), marginBottom: u(4) }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  height: u(6),
                  width: u(30),
                  borderRadius: u(3),
                  background: accent,
                  opacity: seg(t, 0.2 + i * 0.08, 0.4 + i * 0.08),
                  transform: `scaleX(${seg(t, 0.2 + i * 0.08, 0.42 + i * 0.08)})`,
                  transformOrigin: "left",
                }}
              />
            ))}
          </div>
        )}

        {/* headline */}
        <div
          style={{
            fontSize: layout === "stat" ? u(50) : u(38),
            fontWeight: 700,
            lineHeight: 1.04,
            letterSpacing: "-.03em",
            color: layout === "stat" ? accent : txtMain,
          }}
        >
          {headlineLines.map((line, i) => {
            const la = seg(t, 0.06 + i * 0.07, 0.34 + i * 0.07);
            return (
              <div key={i} style={{ overflow: "hidden", paddingBottom: ".04em" }}>
                <div style={{ transform: `translateY(${lerp(105, 0, la)}%)`, opacity: la }}>
                  {line || " "}
                </div>
              </div>
            );
          })}
        </div>

        {/* body */}
        <p
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: u(14),
            lineHeight: 1.4,
            fontWeight: 450,
            color: "rgba(246,248,244,.82)",
            maxWidth: layout === "stat" ? u(260) : u(310),
            margin: 0,
            opacity: bodyA,
            transform: `translateY(${lerp(14, 0, bodyA)}px)`,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {vars.body}
        </p>

        {/* CTA chip */}
        <div
          style={{
            marginTop: u(6),
            display: "inline-flex",
            alignItems: "center",
            gap: u(7),
            background: accent,
            color: bg,
            fontFamily: "var(--font-sans)",
            fontWeight: 700,
            fontSize: u(13.5),
            padding: `${u(10)} ${u(17)}`,
            borderRadius: 99,
            alignSelf: layout === "stat" ? "center" : "flex-start",
            opacity: ctaA,
            transform: `translateY(${lerp(16, 0, ctaA)}px) scale(${lerp(0.94, 1, ctaA)})`,
            boxShadow: `0 8px 24px ${hexA(accent, 0.35)}`,
          }}
        >
          {vars.cta}
          <svg
            width={u(13)}
            height={u(13)}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </div>
      </div>

      {/* bottom progress line */}
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          height: u(4),
          width: `${t * 100}%`,
          background: accent,
          boxShadow: `0 0 12px ${hexA(accent, 0.6)}`,
        }}
      />
    </div>
  );
}

/** Static poster thumbnail (a frozen frame ~66% through) for gallery cards. */
export function CompositionThumb({
  vars,
  brand,
  accent,
  bg,
  layout,
  frame = 0.66,
  chrome = false,
}: {
  vars: CompositionVars;
  brand: CompositionBrand;
  accent: string;
  bg: string;
  layout?: CompositionLayout;
  frame?: number;
  chrome?: boolean;
}) {
  return (
    <div
      style={
        {
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          background: bg,
          containerType: "size",
        } as React.CSSProperties
      }
    >
      <Composition
        t={frame}
        vars={vars}
        brand={brand}
        accent={accent}
        bg={bg}
        layout={layout}
        chrome={chrome}
      />
    </div>
  );
}
