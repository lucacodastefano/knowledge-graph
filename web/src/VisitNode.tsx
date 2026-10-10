import { useRef, useState } from 'react';
import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { VisitNode as VisitNodeType } from './layout.ts';

/**
 * A concept visit. Hovering shows the short summary beside the node, on the side with more room, with an
 * "Approfondisci" button (D7, WP6); only one tooltip is open at a time and it never blocks clicks on the canvas.
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
      className={`visit${data.also.length ? ' shared' : ''}${current ? ' current' : ''}${fresh ? ' fresh' : ''}${match ? ' match' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      data-testid="visit"
    >
      <Handle type="target" position={Position.Left} />
      <span className="visit-title">{visit.title}</span>
      {data.also.length > 0 && (
        <span className="also" title={`Anche in: ${data.also.join(', ')}`}>
          anche in: {data.also.join(', ')}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
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
