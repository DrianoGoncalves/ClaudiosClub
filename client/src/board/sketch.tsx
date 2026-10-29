import { memo, useMemo } from 'react';
import rough from 'roughjs';
import type { Options } from 'roughjs/bin/core';

// Traço de caneta: o rough.js só gera os caminhos SVG (sem canvas), e as cores vêm das variáveis CSS
// via `style`, para o quadro branco virar quadro negro no modo escuro.

export const generator = rough.generator();

export type SketchVariant = 'project' | 'user' | 'agent' | 'busy' | 'skill' | 'synced' | 'portrait' | 'warn' | 'waiting' | 'room' | 'room-color' | 'header';

const VARIANTS: Record<SketchVariant, Options> = {
  project: { stroke: 'var(--ink-blue)', strokeWidth: 2.2, roughness: 1.3 },
  user: { stroke: 'var(--ink)', strokeWidth: 2, roughness: 1.6, strokeLineDash: [10, 7] },
  agent: { stroke: 'var(--ink)', strokeWidth: 1.5, roughness: 1.1 },
  // Trabalhando: traço azul mais grosso; o CSS anima o contorno sendo redesenhado.
  busy: { stroke: 'var(--busy)', strokeWidth: 2.2, roughness: 1.3 },
  skill: {
    stroke: 'var(--ink-green)',
    strokeWidth: 1.4,
    roughness: 1.2,
    fill: 'var(--ink-green-soft)',
    fillStyle: 'hachure',
    hachureGap: 7,
    fillWeight: 1,
  },
  synced: { stroke: 'var(--ink-muted)', strokeWidth: 1.3, roughness: 1.4, strokeLineDash: [6, 6] },
  portrait: { stroke: 'var(--ink)', strokeWidth: 1.4, roughness: 1 },
  warn: { stroke: 'var(--ink-red)', strokeWidth: 2, roughness: 1.4 },
  // Esperando você: amarelo da bolinha de alerta (`.dot-waiting`), não o vermelho de erro.
  waiting: { stroke: 'var(--waiting)', strokeWidth: 2.2, roughness: 1.3 },
  // Parede da sala: traço leve e mais tremido, para não competir com os cartões.
  room: { stroke: 'var(--ink-muted)', strokeWidth: 1.2, roughness: 1.8, bowing: 0.6 },
  // Sala com cor escolhida: a mesma parede, um pouco mais grossa para a cor aparecer.
  'room-color': { stroke: 'var(--room-wall)', strokeWidth: 2, roughness: 1.8, bowing: 0.6 },
  // Cabeçalho colado na moldura: o mesmo traço da parede, na cor dela (`--room-wall`, ver nodes.tsx).
  header: { stroke: 'var(--room-wall)', strokeWidth: 2, roughness: 1.8, bowing: 0.6 },
};

/** Semente estável por id: o traço não "treme" a cada renderização. */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 2147483646) + 1;
}

interface SketchProps {
  variant: SketchVariant;
  shape?: 'rect' | 'ellipse';
  width: number;
  height: number;
  seed: string;
  className?: string;
}

export const Sketch = memo(function Sketch({ variant, shape = 'rect', width, height, seed, className }: SketchProps) {
  const paths = useMemo(() => {
    const opts = { ...VARIANTS[variant], seed: seedOf(seed) };
    const pad = 3;
    const drawable =
      shape === 'ellipse'
        ? generator.ellipse(width / 2, height / 2, width - pad * 2, height - pad * 2, opts)
        : generator.rectangle(pad, pad, width - pad * 2, height - pad * 2, opts);
    return generator.toPaths(drawable);
  }, [variant, shape, width, height, seed]);

  const dash = VARIANTS[variant].strokeLineDash?.join(' ');
  return (
    <svg className={`sketch ${className ?? ''}`} width={width} height={height} aria-hidden="true">
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          style={{
            stroke: p.stroke,
            strokeWidth: p.strokeWidth,
            fill: p.fill ?? 'none',
            strokeDasharray: p.fill && p.fill !== 'none' ? undefined : dash,
          }}
        />
      ))}
    </svg>
  );
});
