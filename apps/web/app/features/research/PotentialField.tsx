import { useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";

type Point = [number, number, number];

/** A conceptual excitation field. It contains no patient or measured mapping data. */
export function PotentialField() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d", { alpha: true });
    if (!ctx) return;
    let width = 0, height = 0, frame = 0, visible = true, lastPaint = 0;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(0);
    });
    const intersection = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; });
    const surface = (u: number, v: number): Point => {
      const r = 1 + 0.23 * Math.sin(3 * u) * Math.sin(v) ** 2 + 0.05 * Math.cos(5 * v);
      return [Math.cos(u) * Math.sin(v) * r * 1.09 + 0.13 * Math.cos(v), Math.cos(v) * r * 0.85 + 0.07 * Math.sin(2 * u) * Math.sin(v), Math.sin(u) * Math.sin(v) * r * 0.92];
    };
    function paint(time: number) {
      if (!ctx || !width || !height) return;
      ctx.clearRect(0, 0, width, height);
      const radius = Math.min(width * 0.3, height * 0.335);
      const turn = -0.38 + (paused || reduced ? 0 : Math.sin(time / 11000) * 0.06) + pointer.current.x * 0.08;
      const tilt = -0.24 + pointer.current.y * 0.035;
      const cx = width * 0.53, cy = height * 0.51;
      const project = ([x, y, z]: Point) => {
        const a = x * Math.cos(turn) + z * Math.sin(turn);
        const b = z * Math.cos(turn) - x * Math.sin(turn);
        const c = y * Math.cos(tilt) - b * Math.sin(tilt);
        const depth = b * Math.cos(tilt) + y * Math.sin(tilt);
        const scale = 1 + depth * 0.075;
        return { x: cx + a * radius * scale, y: cy + c * radius * scale, depth };
      };
      // Faint paths around the field provide depth without an enclosing dashboard frame.
      for (let ring = 0; ring < 2; ring++) {
        ctx.beginPath();
        for (let i = 0; i <= 140; i++) {
          const t = i / 140 * Math.PI * 2;
          const p = project([1.49 * Math.cos(t), 0.46 * Math.sin(t) + (ring ? -0.22 : 0.32), 1.33 * Math.sin(t)]);
          if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = "rgba(73,123,179,0.14)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      const sweep = (paused || reduced ? 1.35 : time / 2500) % (Math.PI * 2);
      const points: { x: number; y: number; depth: number; active: number }[] = [];
      for (let line = 1; line < 58; line++) {
        const v = line / 58 * Math.PI;
        for (let i = 0; i < 116; i++) {
          const u = i / 116 * Math.PI * 2;
          const p = project(surface(u, v));
          const wave = Math.cos(u - sweep + v * 0.48);
          points.push({ ...p, active: Math.max(0, wave) ** 18 });
          if (line > 1 && i % 4 === 0) {
            const prev = project(surface(u, (line - 1) / 58 * Math.PI));
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y);
            ctx.strokeStyle = `rgba(38,100,171,${0.06 + Math.max(0, p.depth) * 0.19})`;
            ctx.lineWidth = 0.65; ctx.stroke();
          }
        }
      }
      points.sort((a, b) => a.depth - b.depth);
      for (const p of points) {
        const light = Math.max(0, p.depth);
        ctx.fillStyle = `rgba(${p.active > 0.2 ? "30,110,244" : "25,81,143"},${0.18 + light * 0.58 + p.active * 0.2})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, 0.65 + light * 0.57 + p.active * 0.62, 0, Math.PI * 2); ctx.fill();
      }
      // The conduits and asymmetric surface evoke the atrial field without claiming anatomical accuracy.
      for (let vein = 0; vein < 4; vein++) {
        const left = vein < 2;
        const origin: Point = [left ? -0.59 : 0.59, -0.51 - (vein % 2) * 0.1, (vein % 2) ? -0.34 : 0.32];
        for (let step = 0; step <= 16; step++) {
          const travel = step / 16;
          ctx.beginPath();
          for (let i = 0; i <= 60; i++) {
            const a = i / 60 * Math.PI * 2;
            const p = project([origin[0] + (left ? -0.19 : 0.25) * travel + 0.13 * Math.cos(a), origin[1] - 0.42 * travel, origin[2] + 0.13 * Math.sin(a)]);
            if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          }
          ctx.strokeStyle = `rgba(59,112,176,${0.16 + travel * 0.34})`;
          ctx.lineWidth = step === 16 ? 1.3 : 0.7; ctx.stroke();
        }
      }
    }
    const tick = (time: number) => {
      if (visible && !document.hidden && !paused && !reduced && time - lastPaint > 32) { paint(time); lastPaint = time; }
      frame = requestAnimationFrame(tick);
    };
    resize.observe(el); intersection.observe(el);
    if (!paused && !reduced) frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect(); };
  }, [paused, reduced]);

  return (
    <figure className="ep-field" onPointerMove={(event) => {
      if (reduced || paused) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      pointer.current = { x: (event.clientX - bounds.left) / bounds.width - 0.5, y: (event.clientY - bounds.top) / bounds.height - 0.5 };
    }} onPointerLeave={() => { pointer.current = { x: 0, y: 0 }; }}>
      <canvas ref={canvas} aria-hidden="true" />
      <div className="ep-field-label"><span className="ep-live-dot" />POTENTIAL / 电位流线</div>
      <figcaption>以电生理为灵感的概念视觉</figcaption>
      {!reduced && <button className="ep-field-pause" onClick={() => setPaused(!paused)} aria-label={paused ? "播放动效" : "暂停动效"}>
        {paused ? <PlayIcon weight="fill" size={14} /> : <PauseIcon weight="fill" size={14} />}
      </button>}
    </figure>
  );
}
