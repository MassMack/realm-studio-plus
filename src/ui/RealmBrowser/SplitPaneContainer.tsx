////////////////////////////////////////////////////////////////////////////
//
// Copyright 2018 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////

import classNames from 'classnames';
import React, { useEffect, useRef, useState } from 'react';
import { Badge, Button } from 'reactstrap';

import { Focus, getClassName } from './focus';
import {
  clampSplitRatio,
  detectDropZone,
  ISplitBranchNode,
  SplitDirection,
  SplitDropZone,
  SplitLayoutNode
} from './split-layout';

export interface ISplitPaneDescriptor {
  id: string;
  focus: Focus | null;
}

export interface ISplitPaneCallbacks {
  onSelect: () => void;
  onSelectClass: (className: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClose: () => void;
  onDragStart: () => void;
}

const DROP_ZONE_LABELS: Readonly<Record<SplitDropZone, string>> = {
  left: 'Dock Left',
  right: 'Dock Right',
  top: 'Dock Top',
  bottom: 'Dock Bottom',
  center: 'Swap Panes'
};

const SplitDownIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
    style={{ verticalAlign: '-1px' }}
  >
    <rect
      x="1"
      y="1"
      width="10"
      height="10"
      rx="1.5"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <line
      x1="1"
      y1="6"
      x2="11"
      y2="6"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

export interface ISplitTreeProps {
  activePaneId: string;
  classes: Realm.ObjectSchema[];
  draggingPaneId: string | null;
  getPaneCallbacks: (paneId: string) => ISplitPaneCallbacks;
  node: SplitLayoutNode;
  onCommitRatio: (branchId: string, ratio: number) => void;
  onDragEnd: () => void;
  onDropPane: (
    sourcePaneId: string,
    targetPaneId: string,
    zone: SplitDropZone
  ) => void;
  paneOrderMap: Map<string, number>;
  panes: Record<string, ISplitPaneDescriptor | undefined>;
  renderPaneBody: (paneId: string) => React.ReactNode;
  totalPanes: number;
}

interface ISplitBranchViewProps extends Omit<ISplitTreeProps, 'node'> {
  node: ISplitBranchNode;
}

const SplitBranchView = React.memo(function SplitBranchView({
  activePaneId,
  classes,
  draggingPaneId,
  getPaneCallbacks,
  node,
  onCommitRatio,
  onDragEnd,
  onDropPane,
  paneOrderMap,
  panes,
  renderPaneBody,
  totalPanes
}: ISplitBranchViewProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const firstChildRef = useRef<HTMLDivElement | null>(null);
    const [isDraggingDivider, setIsDraggingDivider] = useState(false);

    useEffect(() => {
      if (!isDraggingDivider) {
        return;
      }
      let rafId = 0;
      let latestRatio = node.ratio;

      const applyDomFlex = (ratio: number) => {
        if (firstChildRef.current) {
          firstChildRef.current.style.flex = `0 0 calc(${ratio * 100}% - 2.5px)`;
        }
      };

      const onMouseMove = (e: MouseEvent) => {
        const container = containerRef.current;
        if (!container) {
          return;
        }
        const rect = container.getBoundingClientRect();
        const span =
          node.direction === 'horizontal' ? rect.width : rect.height;
        if (span <= 0) {
          return;
        }
        const raw =
          node.direction === 'horizontal'
            ? (e.clientX - rect.left) / span
            : (e.clientY - rect.top) / span;
        latestRatio = clampSplitRatio(raw);
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        // Mutate flex size directly via rAF so zero React reconciles run mid-drag
        rafId = requestAnimationFrame(() => applyDomFlex(latestRatio));
      };

      const onMouseUp = () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        applyDomFlex(latestRatio);
        setIsDraggingDivider(false);
        onCommitRatio(node.id, latestRatio);
        window.dispatchEvent(new Event('resize'));
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      return () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
    }, [isDraggingDivider, node.id, node.direction, node.ratio, onCommitRatio]);

    const isHorizontal = node.direction === 'horizontal';

    return (
      <div
        ref={containerRef}
        className={classNames(
          'RealmBrowser__SplitContainer',
          isHorizontal
            ? 'RealmBrowser__SplitContainer--horizontal'
            : 'RealmBrowser__SplitContainer--vertical'
        )}
      >
        <div
          ref={firstChildRef}
          className="RealmBrowser__SplitChild"
          style={{
            flex: `0 0 calc(${node.ratio * 100}% - 2.5px)`
          }}
        >
          <SplitNodeRenderer
            activePaneId={activePaneId}
            classes={classes}
            draggingPaneId={draggingPaneId}
            getPaneCallbacks={getPaneCallbacks}
            node={node.first}
            onCommitRatio={onCommitRatio}
            onDragEnd={onDragEnd}
            onDropPane={onDropPane}
            paneOrderMap={paneOrderMap}
            panes={panes}
            renderPaneBody={renderPaneBody}
            totalPanes={totalPanes}
          />
        </div>

        <div
          className={classNames(
            'RealmBrowser__SplitResizer',
            isHorizontal
              ? 'RealmBrowser__SplitResizer--horizontal'
              : 'RealmBrowser__SplitResizer--vertical',
            { 'RealmBrowser__SplitResizer--dragging': isDraggingDivider }
          )}
          role="separator"
          aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
          title="Drag to resize (double-click to reset 50/50)"
          onMouseDown={(e) => {
            e.preventDefault();
            setIsDraggingDivider(true);
          }}
          onDoubleClick={() => {
            onCommitRatio(node.id, 0.5);
            window.dispatchEvent(new Event('resize'));
          }}
        />

        <div className="RealmBrowser__SplitChild RealmBrowser__SplitChild--second">
          <SplitNodeRenderer
            activePaneId={activePaneId}
            classes={classes}
            draggingPaneId={draggingPaneId}
            getPaneCallbacks={getPaneCallbacks}
            node={node.second}
            onCommitRatio={onCommitRatio}
            onDragEnd={onDragEnd}
            onDropPane={onDropPane}
            paneOrderMap={paneOrderMap}
            panes={panes}
            renderPaneBody={renderPaneBody}
            totalPanes={totalPanes}
          />
        </div>
      </div>
    );
  }
);

interface ISplitLeafViewProps {
  callbacks: ISplitPaneCallbacks;
  classes: Realm.ObjectSchema[];
  draggingPaneId: string | null;
  isActive: boolean;
  onDragEnd: () => void;
  onDropPane: (
    sourcePaneId: string,
    targetPaneId: string,
    zone: SplitDropZone
  ) => void;
  paneId: string;
  paneNumber: number;
  paneState?: ISplitPaneDescriptor;
  renderPaneBody: (paneId: string) => React.ReactNode;
  totalPanes: number;
}

const SplitLeafView = React.memo(function SplitLeafView({
  callbacks,
  classes,
  draggingPaneId,
  isActive,
  onDragEnd,
  onDropPane,
  paneId,
  paneNumber,
  paneState,
  renderPaneBody,
  totalPanes
}: ISplitLeafViewProps) {
    const leafRef = useRef<HTMLDivElement | null>(null);
    const [hoverZone, setHoverZone] = useState<SplitDropZone | null>(null);

    const isSplit = totalPanes > 1;
    const selectedClass = paneState?.focus ? getClassName(paneState.focus) : '';
    const nonSystemClasses = classes.filter((c) => !c.name.startsWith('__'));
    const canDropHere =
      !!draggingPaneId && draggingPaneId !== paneId;

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
      if (!canDropHere || !leafRef.current) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = leafRef.current.getBoundingClientRect();
      const zone = detectDropZone(e.clientX, e.clientY, rect);
      if (zone !== hoverZone) {
        setHoverZone(zone);
      }
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
      if (
        leafRef.current &&
        e.relatedTarget instanceof Node &&
        leafRef.current.contains(e.relatedTarget)
      ) {
        return;
      }
      setHoverZone(null);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
      if (!canDropHere || !leafRef.current) {
        return;
      }
      e.preventDefault();
      const rect = leafRef.current.getBoundingClientRect();
      const zone = detectDropZone(e.clientX, e.clientY, rect);
      setHoverZone(null);
      onDropPane(draggingPaneId, paneId, zone);
    };

    return (
      <div
        ref={leafRef}
        data-pane-id={paneId}
        className={classNames('RealmBrowser__SplitPane', {
          'RealmBrowser__SplitPane--active': isSplit && isActive,
          'RealmBrowser__SplitPane--dragging': draggingPaneId === paneId
        })}
        onMouseDownCapture={() => {
          if (!isActive) {
            callbacks.onSelect();
          }
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isSplit ? (
          <div
            className={classNames('RealmBrowser__SplitPaneHeader', {
              'RealmBrowser__SplitPaneHeader--active': isActive
            })}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', paneId);
              e.dataTransfer.effectAllowed = 'move';
              callbacks.onDragStart();
            }}
            onDragEnd={() => {
              setHoverZone(null);
              onDragEnd();
            }}
            title="Drag header to move/dock Left, Right, Top, Bottom or Swap with another pane"
          >
            <div className="RealmBrowser__SplitPaneTitle">
              <span
                className="RealmBrowser__SplitDragGrip"
                aria-hidden="true"
              >
                ⋮⋮
              </span>
              <span
                className={classNames('RealmBrowser__SplitPaneLabel', {
                  'RealmBrowser__SplitPaneLabel--active': isActive
                })}
              >
                Pane #{paneNumber}
              </span>
              {isActive ? (
                <Badge color="primary" pill>
                  Active
                </Badge>
              ) : null}
              {nonSystemClasses.length > 0 && (
                <select
                  aria-label={`Pane ${paneNumber} class`}
                  className="RealmBrowser__SplitPaneSelect"
                  value={selectedClass}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => callbacks.onSelectClass(e.target.value)}
                >
                  {nonSystemClasses.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="RealmBrowser__SplitPaneActions">
              <Button
                size="sm"
                color="secondary"
                className="RealmBrowser__NavBar__Btn"
                onClick={(e) => {
                  e.stopPropagation();
                  callbacks.onSplitRight();
                }}
                title="Split this pane Right (⌘\)"
              >
                <i className="fa fa-columns" aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                color="secondary"
                className="RealmBrowser__NavBar__Btn"
                onClick={(e) => {
                  e.stopPropagation();
                  callbacks.onSplitDown();
                }}
                title="Split this pane Down (⌘⇧\)"
              >
                <SplitDownIcon />
              </Button>
              <Button
                size="sm"
                color="secondary"
                className="RealmBrowser__NavBar__Btn"
                onClick={(e) => {
                  e.stopPropagation();
                  callbacks.onClose();
                }}
                title={`Close Pane #${paneNumber}`}
              >
                <i className="fa fa-times" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}

        {renderPaneBody(paneId)}

        {canDropHere && hoverZone ? (
          <div className="RealmBrowser__SplitDropOverlay">
            <div
              className={classNames(
                'RealmBrowser__SplitDropPreview',
                `RealmBrowser__SplitDropPreview--${hoverZone}`
              )}
            >
              <span>{DROP_ZONE_LABELS[hoverZone]}</span>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
);

export const SplitNodeRenderer = React.memo(function SplitNodeRenderer(
  props: ISplitTreeProps
) {
  const { node } = props;
  if (node.kind === 'branch') {
    return <SplitBranchView {...props} node={node} />;
  }
  const callbacks = props.getPaneCallbacks(node.id);
  const paneNumber = props.paneOrderMap.get(node.id) ?? 1;
  return (
    <SplitLeafView
      callbacks={callbacks}
      classes={props.classes}
      draggingPaneId={props.draggingPaneId}
      isActive={props.activePaneId === node.id}
      onDragEnd={props.onDragEnd}
      onDropPane={props.onDropPane}
      paneId={node.id}
      paneNumber={paneNumber}
      paneState={props.panes[node.id]}
      renderPaneBody={props.renderPaneBody}
      totalPanes={props.totalPanes}
    />
  );
});

export type { SplitDirection, SplitDropZone };
