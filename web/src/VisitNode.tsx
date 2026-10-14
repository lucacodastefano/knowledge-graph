import { Handle, Position, type NodeProps } from '@xyflow/react';
import { HANDLES, type VisitNode as VisitNodeType } from './layout.ts';
import { READONLY } from './api.ts';
import { useTouch } from './media.ts';

const POSITION = { left: Position.Left, right: Position.Right, center: Position.Top };

/**
 * A concept visit. Hovering highlights the node with its relatives (`focus`, `related`) and fades the rest (`dim`);
 * a double click opens "Approfondisci" (D7).
 */
export function VisitNode({ data }: NodeProps<VisitNodeType>) {
  const { visit, current, fresh, match } = data;
  const touch = useTouch();
  const show = () => data.onHover(visit.id);
  const hide = () => data.onHover(null);

  return (
    <div
      className={`visit${visit.ref ? (READONLY ? ' ref disabled' : ' ref') : ''}${data.also.length ? ' shared' : ''}${data.collapsible ? ` branch-${data.toggleSide ?? 'right'}` : ''}${current ? ' current' : ''}${fresh ? ' fresh' : ''}${match ? ' match' : ''}${
        data.cover ? ' cover' : data.focus ? ' focus' : data.related ? ' related' : data.dim ? ' dim' : ''
      }`}
      title={visit.ref ? (READONLY ? `Rimando al grafo «${visit.ref.title}» (non incluso in questa pagina)` : `Rimando al grafo «${visit.ref.title}»: clic per aprirlo`) : undefined}
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
      <span className="visit-title">{visit.ref ? <>↗ {visit.ref.title}</> : visit.title}</span>
      {visit.sourceCount > 0 && (
        <span className="source-badge" title={visit.sourceCount === 1 ? '1 fonte' : `${visit.sourceCount} fonti`} aria-label="Fonti">
          {visit.sourceCount}
        </span>
      )}
      {data.collapsible && (!touch || data.collapsed) && (
        <button
          type="button"
          className={`collapse-toggle nodrag nopan ${data.toggleSide ?? 'right'}${data.collapsed ? ' folded' : ''}`}
          aria-label={data.collapsed ? `Espandi il ramo (${data.hiddenCount} nodi nascosti)` : 'Comprimi il ramo'}
          title={data.collapsed ? `Mostra i ${data.hiddenCount} nodi nascosti` : 'Nascondi i nodi sotto questo'}
          data-testid="collapse-toggle"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(visit.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {data.collapsed ? data.hiddenCount : '−'}
        </button>
      )}
      {data.also.length > 0 && (
        <span className="also" title={`Compare anche sotto: ${data.also.map((o) => o.parent).join(', ')}`}>
          compare anche sotto{' '}
          {data.also.map((o, i) => (
            <span key={o.id}>
              {i > 0 && ', '}
              {touch ? (
                <span>«{o.parent}»</span>
              ) : (
              <button
                type="button"
                className="also-link nodrag nopan"
                title="Vai a quel nodo"
                onClick={(e) => {
                  e.stopPropagation();
                  data.onGoto(o.id);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                «{o.parent}»
              </button>
              )}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
