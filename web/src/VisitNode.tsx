import { useRef, useState } from 'react';
import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { HANDLES, type VisitNode as VisitNodeType } from './layout.ts';

const POSITION = { left: Position.Left, right: Position.Right, center: Position.Top };

/**
 * A concept visit. Hovering shows the short summary beside the node, on the side with more room, with an
 * "Approfondisci" button (D7, WP6); only one tooltip is open at a time and it never blocks clicks on the canvas.
 * The view highlights the hovered or clicked node with its relatives (`focus`, `related`) and fades the rest (`dim`).
 */
export function VisitNode({ data }: NodeProps<VisitNodeType>) {
  const { visit, current, fresh, hovered, match } = data;
  const ref = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<Position>(Position.Right);
  const show = () => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setSide(box.left + box.width / 2 > innerWidth / 2 ? Position.Left : Position.Right);
    data.onHover(visit.id);
  };
  const hide = () => data.onHover(null);

  return (
    <div
      ref={ref}
      className={`visit${data.also.length ? ' shared' : ''}${current ? ' current' : ''}${fresh ? ' fresh' : ''}${match ? ' match' : ''}${
        data.focus ? ' focus' : data.related ? ' related' : data.dim ? ' dim' : ''
      }`}
      onMouseEnter={show}
      onMouseLeave={hide}
      data-testid="visit"
    >
      {/* Every handle is always mounted: edges pick theirs by id, so a node changing side never leaves stale positions. */}
      {HANDLES.map((h) => (
        <Handle key={`t-${h}`} id={`t-${h}`} type="target" position={POSITION[h]} className={h} />
      ))}
      {HANDLES.map((h) => (
        <Handle key={`s-${h}`} id={`s-${h}`} type="source" position={POSITION[h]} className={h} />
      ))}
      <span className="visit-title">{visit.title}</span>
      {visit.sourceCount > 0 && (
        <span className="source-badge" title={visit.sourceCount === 1 ? '1 fonte' : `${visit.sourceCount} fonti`} aria-label="Fonti">
          {visit.sourceCount}
        </span>
      )}
      {data.also.length > 0 && (
        <span className="also" title={`Anche in: ${data.also.join(', ')}`}>
          anche in: {data.also.join(', ')}
        </span>
      )}
      <NodeToolbar isVisible={hovered} position={side} offset={10}>
        <div className="tooltip passive" role="tooltip">
          <p>{visit.summary || 'Nessun riassunto.'}</p>
          <button
            type="button"
            onMouseEnter={() => data.onHover(visit.id)}
            onMouseLeave={hide}
            onClick={() => data.onOpen(visit.conceptId)}
          >
            Approfondisci
          </button>
        </div>
      </NodeToolbar>
    </div>
  );
}
