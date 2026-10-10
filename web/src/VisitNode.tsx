import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { VisitNode as VisitNodeType } from './layout.ts';

/** A concept visit. Hover shows the short summary with an "Approfondisci" button (D7); only one tooltip is open at a time. */
export function VisitNode({ data }: NodeProps<VisitNodeType>) {
  const { visit, current, fresh, hovered, match } = data;
  const show = () => data.onHover(visit.id);
  const hide = () => data.onHover(null);

  return (
    <div
      className={`visit${current ? ' current' : ''}${fresh ? ' fresh' : ''}${match ? ' match' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      data-testid="visit"
    >
      <Handle type="target" position={Position.Left} />
      <span className="visit-title">{visit.title}</span>
      <Handle type="source" position={Position.Right} />
      <NodeToolbar isVisible={hovered} position={Position.Bottom} offset={8}>
        <div className="tooltip" onMouseEnter={show} onMouseLeave={hide} role="tooltip">
          <p>{visit.summary || 'Nessun riassunto.'}</p>
          <div className="actions">
            <button type="button" onClick={() => data.onOpen(visit.conceptId)}>
              Approfondisci
            </button>
            <button type="button" className="secondary" onClick={() => data.onEdit(visit.id)}>
              Modifica
            </button>
          </div>
        </div>
      </NodeToolbar>
    </div>
  );
}
