import { EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type EdgeProps, type EdgeTypes } from '@xyflow/react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardEdge, BoardEdgeData, StaffLink } from './layout';
import { generator, seedOf } from './sketch';
import { t } from '../i18n';

/** Ações das linhas, fornecidas pelo quadro (Board.tsx). */
export const EdgeActions = createContext<{ onUnlink?: (link: StaffLink) => void }>({});

const STYLE: Record<BoardEdgeData['kind'], { stroke: string; width: number; dash?: string; roughness: number; label?: string }> = {
  // Hierarquia: linhas retas de caneta, de cima para baixo.
  contains: { stroke: 'var(--ink-muted)', width: 1.3, roughness: 0.7 },
  // Recursos do projeto, ao lado: mais discretas.
  side: { stroke: 'var(--ink-muted)', width: 1, roughness: 0.6, dash: '3 5' },
  // Gestor extra (funcionário chamado por mais de um).
  calls: { stroke: 'var(--ink-blue)', width: 1.5, roughness: 0.8, dash: '7 5', label: t('board.alsoCalls') },
  // Empréstimo entre salas (symlink/junction).
  borrow: { stroke: 'var(--ink-red)', width: 1.8, roughness: 1.1, dash: '9 7', label: t('board.edgeBorrow') },
  // Funcionário delegando a um agent agora (orquestrador → executor). Só existe enquanto dura.
  delegates: { stroke: 'var(--busy)', width: 1.8, roughness: 1, dash: '5 5', label: t('board.edgeDelegating') },
};

function RoughEdge(props: EdgeProps<BoardEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const kind = data?.kind ?? 'contains';
  const s = STYLE[kind];
  const geometry = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [d, labelX, labelY] =
    kind === 'borrow' || kind === 'delegates'
      ? getBezierPath(geometry)
      : getSmoothStepPath({ ...geometry, borderRadius: 0, offset: kind === 'side' ? 14 : 20 });

  const paths = useMemo(
    () =>
      generator.toPaths(
        generator.path(d, {
          seed: seedOf(id),
          roughness: s.roughness,
          bowing: kind === 'borrow' ? 1.5 : 0.6,
          stroke: s.stroke,
          strokeWidth: s.width,
          disableMultiStroke: kind !== 'borrow',
        }),
      ),
    [d, id, kind, s],
  );

  // Vínculo entre funcionários: no hover, aparece o botão de desfazer. Um pequeno atraso ao sair
  // deixa o mouse ir da linha até o botão (que fica fora do SVG) sem ele sumir.
  const { onUnlink } = useContext(EdgeActions);
  const link = onUnlink ? data?.link : undefined;
  const [hover, setHover] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(leave.current), []);
  const enter = () => (clearTimeout(leave.current), setHover(true));
  const exit = () => (leave.current = setTimeout(() => setHover(false), 250));

  return (
    <>
      <g className={`rough-edge rough-edge-${kind} ${link && hover ? 'is-hover' : ''}`} onMouseEnter={link ? enter : undefined} onMouseLeave={link ? exit : undefined}>
        {/* Faixa invisível e larga: a linha de caneta é fina demais para acertar com o mouse. */}
        {link && <path d={d} className="rough-edge-hit" />}
        {paths.map((p, i) => (
          <path key={i} d={p.d} style={{ stroke: p.stroke, strokeWidth: p.strokeWidth, fill: 'none', strokeDasharray: s.dash }} />
        ))}
      </g>
      {data?.active && <ConversationDots path={d} />}
      {(s.label || (link && hover)) && (
        <EdgeLabelRenderer>
          {s.label && (
            <div
              className={`edge-label edge-label-${kind}`}
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            >
              {s.label}
            </div>
          )}
          {link && hover && (
            <button
              className="edge-unlink nodrag nopan"
              // Abaixo do rótulo, quando a linha tem um.
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (s.label ? 24 : 0)}px)` }}
              onMouseEnter={enter}
              onMouseLeave={exit}
              onClick={(e) => (e.stopPropagation(), onUnlink!(link))}
              title={t('board.unlinkTitle')}
              aria-label={t('board.unlink')}
            >
              ×
            </button>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Conversa passando pela linha: as bolinhas correm de quem manda para quem recebe.
 * É animação SVG nativa (animateMotion): o navegador move as bolinhas sem redesenhar o React,
 * e só existe nas linhas de quem está trabalhando. Some com "animações" desligado no topo.
 */
function ConversationDots({ path }: { path: string }) {
  return (
    <g className="edge-dots" aria-hidden="true">
      {/* Só no sentido da mensagem: de quem manda (origem da linha) para quem recebe. Duas bolinhas
          defasadas no mesmo sentido dão a ideia de fluxo contínuo. */}
      <circle r={4.5} className="edge-dot edge-dot-down">
        <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
      </circle>
      <circle r={3.5} className="edge-dot edge-dot-down">
        <animateMotion dur="1.8s" begin="0.9s" repeatCount="indefinite" path={path} />
      </circle>
    </g>
  );
}

export const edgeTypes: EdgeTypes = { rough: RoughEdge };
