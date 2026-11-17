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

import assert from 'assert';
import { JSDOM } from 'jsdom';
import React, { act, useCallback, useMemo, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';

import {
  allocateLayoutId,
  clampSplitRatio,
  closePaneInLayout,
  containsPane,
  countLeaves,
  createInitialLayout,
  detectDropZone,
  findAdjacentPaneId,
  listLeafIds,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  moveOrSwapPaneInLayout,
  SplitDirection,
  SplitDropZone,
  SplitLayoutNode,
  splitPaneInLayout,
  updateBranchRatioInLayout
} from './split-layout';
import {
  ISplitPaneCallbacks,
  ISplitPaneDescriptor,
  SplitNodeRenderer
} from './SplitPaneContainer';

function collectBranchIds(node: SplitLayoutNode, out: string[] = []): string[] {
  if (node.kind === 'leaf') {
    return out;
  }
  out.push(node.id);
  collectBranchIds(node.first, out);
  collectBranchIds(node.second, out);
  return out;
}

function assertTreeInvariants(node: SplitLayoutNode): void {
  const leaves = listLeafIds(node);
  assert.strictEqual(countLeaves(node), leaves.length);
  assert.ok(leaves.length >= 1);
  assert.strictEqual(new Set(leaves).size, leaves.length);
  for (const leafId of leaves) {
    assert.strictEqual(containsPane(node, leafId), true);
  }
  const walk = (curr: SplitLayoutNode) => {
    if (curr.kind === 'branch') {
      assert.ok(
        curr.ratio >= MIN_SPLIT_RATIO && curr.ratio <= MAX_SPLIT_RATIO,
        `Expected ratio ${curr.ratio} within bounds`
      );
      walk(curr.first);
      walk(curr.second);
    }
  };
  walk(node);
}

describe('RealmBrowser unlimited split layout engine', () => {
  it('creates an initial single leaf and prevents closing the last pane', () => {
    const initial = createInitialLayout('pane-1');
    assert.strictEqual(countLeaves(initial), 1);
    assert.deepStrictEqual(listLeafIds(initial), ['pane-1']);
    assert.strictEqual(containsPane(initial, 'pane-1'), true);
    assert.strictEqual(containsPane(initial, 'missing'), false);

    const closed = closePaneInLayout(initial, 'pane-1');
    assert.strictEqual(closed, initial);
    assertTreeInvariants(closed);
  });

  it('supports unlimited nested horizontal and vertical splits and structural sharing', () => {
    let layout: SplitLayoutNode = createInitialLayout('pane-1');
    layout = splitPaneInLayout(
      layout,
      'pane-1',
      'pane-2',
      'horizontal',
      'after',
      'branch-root'
    );
    layout = splitPaneInLayout(
      layout,
      'pane-2',
      'pane-3',
      'vertical',
      'after',
      'branch-right'
    );
    layout = splitPaneInLayout(
      layout,
      'pane-3',
      'pane-4',
      'horizontal',
      'before',
      'branch-nested'
    );
    layout = splitPaneInLayout(
      layout,
      'pane-1',
      'pane-5',
      'vertical',
      'after',
      'branch-left'
    );

    assert.deepStrictEqual(listLeafIds(layout), [
      'pane-1',
      'pane-5',
      'pane-2',
      'pane-4',
      'pane-3'
    ]);
    assertTreeInvariants(layout);
    assert.strictEqual(layout.kind, 'branch');
    const rightBranch = layout.second;

    // Updating only the left branch ratio preserves the exact right branch object reference
    const resizedLeft = updateBranchRatioInLayout(layout, 'branch-left', 0.35);
    assert.strictEqual(resizedLeft.kind, 'branch');
    assert.strictEqual(resizedLeft.second, rightBranch);
    assert.strictEqual(
      resizedLeft.first.kind === 'branch' ? resizedLeft.first.ratio : 0,
      0.35
    );

    // Clamping extrema and negligible changes keep referential equality
    const noopResize = updateBranchRatioInLayout(
      resizedLeft,
      'branch-left',
      0.35001
    );
    assert.strictEqual(noopResize, resizedLeft);
    assert.strictEqual(clampSplitRatio(0.01), MIN_SPLIT_RATIO);
    assert.strictEqual(clampSplitRatio(0.99), MAX_SPLIT_RATIO);
    assert.strictEqual(clampSplitRatio(Number.NaN), 0.5);
  });

  it('finds adjacent panes and collapses parent branches cleanly on close', () => {
    let layout: SplitLayoutNode = createInitialLayout('pane-1');
    layout = splitPaneInLayout(
      layout,
      'pane-1',
      'pane-2',
      'horizontal',
      'after',
      'b1'
    );
    layout = splitPaneInLayout(
      layout,
      'pane-2',
      'pane-3',
      'vertical',
      'after',
      'b2'
    );

    assert.strictEqual(findAdjacentPaneId(layout, 'pane-1'), 'pane-2');
    assert.strictEqual(findAdjacentPaneId(layout, 'pane-2'), 'pane-1');
    assert.strictEqual(findAdjacentPaneId(layout, 'pane-3'), 'pane-2');

    const afterClose2 = closePaneInLayout(layout, 'pane-2');
    assert.deepStrictEqual(listLeafIds(afterClose2), ['pane-1', 'pane-3']);
    assertTreeInvariants(afterClose2);

    const afterClose3 = closePaneInLayout(afterClose2, 'pane-3');
    assert.deepStrictEqual(listLeafIds(afterClose3), ['pane-1']);
    assert.strictEqual(afterClose3.kind, 'leaf');
  });

  it('detects 5 docking zones and handles drag-to-dock & swap accurately', () => {
    const rect = { left: 100, top: 200, width: 400, height: 200 };
    assert.strictEqual(detectDropZone(110, 300, rect), 'left');
    assert.strictEqual(detectDropZone(490, 300, rect), 'right');
    assert.strictEqual(detectDropZone(300, 210, rect), 'top');
    assert.strictEqual(detectDropZone(300, 390, rect), 'bottom');
    assert.strictEqual(detectDropZone(300, 300, rect), 'center');
    assert.strictEqual(
      detectDropZone(0, 0, { left: 0, top: 0, width: 0, height: 0 }),
      'center'
    );

    let layout: SplitLayoutNode = createInitialLayout('pane-1');
    layout = splitPaneInLayout(layout, 'pane-1', 'pane-2', 'horizontal');
    layout = splitPaneInLayout(layout, 'pane-2', 'pane-3', 'vertical');

    // Swap pane-1 and pane-3 via center drop
    const swapped = moveOrSwapPaneInLayout(layout, 'pane-1', 'pane-3', 'center');
    assert.deepStrictEqual(listLeafIds(swapped), ['pane-3', 'pane-2', 'pane-1']);
    assertTreeInvariants(swapped);

    // Dock pane-3 above pane-2
    const dockedTop = moveOrSwapPaneInLayout(swapped, 'pane-3', 'pane-2', 'top');
    assert.deepStrictEqual(listLeafIds(dockedTop), [
      'pane-3',
      'pane-2',
      'pane-1'
    ]);
    assert.strictEqual(dockedTop.kind, 'branch');
    assert.strictEqual(dockedTop.first.kind, 'branch');
    assert.strictEqual(dockedTop.first.direction, 'vertical');

    // Self-drop or unknown pane is a no-op returning same reference
    assert.strictEqual(
      moveOrSwapPaneInLayout(dockedTop, 'pane-2', 'pane-2', 'left'),
      dockedTop
    );
    assert.strictEqual(
      moveOrSwapPaneInLayout(dockedTop, 'missing', 'pane-2', 'left'),
      dockedTop
    );
  });

  it('survives 50 randomized split, dock, swap, resize, and close stress transitions', () => {
    let seed = 0x5f3759df;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const zones: SplitDropZone[] = ['left', 'right', 'top', 'bottom', 'center'];

    let layout: SplitLayoutNode = createInitialLayout('pane-init');
    for (let step = 0; step < 50; step++) {
      const leaves = listLeafIds(layout);
      const branches = collectBranchIds(layout);
      const op = rand();

      if (leaves.length < 2 || (leaves.length < 7 && op < 0.45)) {
        const target = leaves[Math.floor(rand() * leaves.length)];
        const dir: SplitDirection = rand() < 0.5 ? 'horizontal' : 'vertical';
        const pos = rand() < 0.5 ? 'after' : 'before';
        layout = splitPaneInLayout(
          layout,
          target,
          allocateLayoutId('stress-pane'),
          dir,
          pos
        );
      } else if (op < 0.72 && leaves.length >= 2) {
        const srcIdx = Math.floor(rand() * leaves.length);
        let dstIdx = Math.floor(rand() * leaves.length);
        if (dstIdx === srcIdx) {
          dstIdx = (srcIdx + 1) % leaves.length;
        }
        const zone = zones[Math.floor(rand() * zones.length)];
        layout = moveOrSwapPaneInLayout(
          layout,
          leaves[srcIdx],
          leaves[dstIdx],
          zone
        );
      } else if (op < 0.88 && branches.length > 0) {
        const branchId = branches[Math.floor(rand() * branches.length)];
        layout = updateBranchRatioInLayout(layout, branchId, rand());
      } else if (leaves.length > 1) {
        const target = leaves[Math.floor(rand() * leaves.length)];
        layout = closePaneInLayout(layout, target);
      }

      assertTreeInvariants(layout);
    }

    // Collapse cleanly down to 1 pane
    while (countLeaves(layout) > 1) {
      const leaves = listLeafIds(layout);
      layout = closePaneInLayout(layout, leaves[leaves.length - 1]);
      assertTreeInvariants(layout);
    }
    assert.strictEqual(countLeaves(layout), 1);
  });
});

describe('SplitNodeRenderer UI integration, drag-docking, and memo performance', () => {
  const savedGlobals: Partial<Record<string, unknown>> = {};
  const globalKeys = [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'Event',
    'MouseEvent',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT'
  ];

  let dom: JSDOM;
  let container: HTMLElement;
  let root: Root | null = null;
  let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let rafSeq = 1;

  const flushRaf = () => {
    const batch = rafQueue.slice();
    rafQueue = [];
    for (const item of batch) {
      item.cb(16);
    }
  };

  before(() => {
    for (const key of globalKeys) {
      if (key in globalThis) {
        savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
      }
    }
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://localhost/'
    });
    const g = globalThis as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.Node = dom.window.Node;
    g.Element = dom.window.Element;
    g.HTMLElement = dom.window.HTMLElement;
    g.Event = dom.window.Event;
    g.MouseEvent = dom.window.MouseEvent;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = rafSeq++;
      rafQueue.push({ id, cb });
      return id;
    };
    g.cancelAnimationFrame = (id: number) => {
      rafQueue = rafQueue.filter((item) => item.id !== id);
    };
  });

  after(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of globalKeys) {
      if (Object.prototype.hasOwnProperty.call(savedGlobals, key)) {
        g[key] = savedGlobals[key];
      } else {
        delete g[key];
      }
    }
    dom.window.close();
  });

  beforeEach(() => {
    rafQueue = [];
    container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      const currentRoot = root;
      root = null;
      await act(async () => {
        currentRoot.unmount();
      });
    }
    container.remove();
  });

  const makeFakeSchema = (name: string): Realm.ObjectSchema => ({
    name,
    properties: { id: 'string' }
  });

  const makeFakeFocus = (className: string): any => ({
    kind: 'class',
    className,
    results: [],
    properties: [],
    isEmbedded: false
  });

  it('rapidly splits, switches classes, drag-docks, resizes via rAF, closes, and isolates untouched sibling renders', async () => {
    const renderCounts = new Map<string, number>();

    const PaneBody = React.memo(function PaneBody({
      paneId,
      className
    }: {
      paneId: string;
      className: string;
    }) {
      renderCounts.set(paneId, (renderCounts.get(paneId) ?? 0) + 1);
      return (
        <div className="TestPaneBody" data-pane={paneId} data-class={className}>
          {className}
        </div>
      );
    });

    const schemas = [
      makeFakeSchema('User'),
      makeFakeSchema('Order'),
      makeFakeSchema('Invoice')
    ];

    let api: {
      splitActive: (dir: SplitDirection) => void;
      resizeFirstBranch: (ratio: number) => void;
      getLeafIds: () => string[];
    } | null = null;

    const Harness = function Harness() {
      const [layout, setLayout] = useState<SplitLayoutNode>(() =>
        createInitialLayout('pane-1')
      );
      const [activePaneId, setActivePaneId] = useState('pane-1');
      const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
      const [panes, setPanes] = useState<
        Record<string, ISplitPaneDescriptor & { className: string }>
      >({
        'pane-1': {
          id: 'pane-1',
          className: 'User',
          focus: makeFakeFocus('User')
        }
      });

      const leafIds = useMemo(() => listLeafIds(layout), [layout]);
      const paneOrderMap = useMemo(() => {
        const m = new Map<string, number>();
        leafIds.forEach((id, i) => m.set(id, i + 1));
        return m;
      }, [leafIds]);

      api = {
        splitActive: (dir) => {
          const newId = allocateLayoutId('pane');
          const cls = schemas[leafIds.length % schemas.length].name;
          setPanes((prev) => ({
            ...prev,
            [newId]: { id: newId, className: cls, focus: makeFakeFocus(cls) }
          }));
          setLayout((prev) =>
            splitPaneInLayout(prev, activePaneId, newId, dir)
          );
          setActivePaneId(newId);
        },
        resizeFirstBranch: (ratio) => {
          setLayout((prev) =>
            prev.kind === 'branch'
              ? updateBranchRatioInLayout(prev, prev.id, ratio)
              : prev
          );
        },
        getLeafIds: () => leafIds
      };

      const callbacksMap = useMemo(() => {
        const map = new Map<string, ISplitPaneCallbacks>();
        for (const id of leafIds) {
          map.set(id, {
            onSelect: () => setActivePaneId(id),
            onSelectClass: (cls) =>
              setPanes((prev) => {
                const cur = prev[id];
                if (!cur) {
                  return prev;
                }
                return {
                  ...prev,
                  [id]: { ...cur, className: cls, focus: makeFakeFocus(cls) }
                };
              }),
            onSplitRight: () => {
              const newId = allocateLayoutId('pane');
              setPanes((prev) => ({
                ...prev,
                [newId]: {
                  id: newId,
                  className: 'Order',
                  focus: makeFakeFocus('Order')
                }
              }));
              setLayout((prev) =>
                splitPaneInLayout(prev, id, newId, 'horizontal')
              );
              setActivePaneId(newId);
            },
            onSplitDown: () => {
              const newId = allocateLayoutId('pane');
              setPanes((prev) => ({
                ...prev,
                [newId]: {
                  id: newId,
                  className: 'Invoice',
                  focus: makeFakeFocus('Invoice')
                }
              }));
              setLayout((prev) =>
                splitPaneInLayout(prev, id, newId, 'vertical')
              );
              setActivePaneId(newId);
            },
            onClose: () => {
              setLayout((prev) => closePaneInLayout(prev, id));
              setActivePaneId((cur) =>
                cur === id ? findAdjacentPaneId(layout, id) ?? 'pane-1' : cur
              );
            },
            onDragStart: () => setDraggingPaneId(id)
          });
        }
        return map;
      }, [leafIds, layout]);

      const getPaneCallbacks = useCallback(
        (id: string) => callbacksMap.get(id)!,
        [callbacksMap]
      );

      const handleCommitRatio = useCallback((branchId: string, ratio: number) => {
        setLayout((prev) => updateBranchRatioInLayout(prev, branchId, ratio));
      }, []);

      const handleDragEnd = useCallback(() => {
        setDraggingPaneId(null);
      }, []);

      const handleDropPane = useCallback(
        (src: string, dst: string, zone: SplitDropZone) => {
          setDraggingPaneId(null);
          setLayout((prev) => moveOrSwapPaneInLayout(prev, src, dst, zone));
          setActivePaneId(src);
        },
        []
      );

      const renderPaneBody = useCallback(
        (id: string) => (
          <PaneBody
            paneId={id}
            className={panes[id]?.className ?? 'User'}
          />
        ),
        [panes]
      );

      return (
        <SplitNodeRenderer
          activePaneId={activePaneId}
          classes={schemas}
          draggingPaneId={draggingPaneId}
          getPaneCallbacks={getPaneCallbacks}
          node={layout}
          onCommitRatio={handleCommitRatio}
          onDragEnd={handleDragEnd}
          onDropPane={handleDropPane}
          paneOrderMap={paneOrderMap}
          panes={panes}
          renderPaneBody={renderPaneBody}
          totalPanes={leafIds.length}
        />
      );
    };

    await act(async () => {
      root!.render(<Harness />);
    });

    // Single pane mode omits split header and resizers
    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitPane').length,
      1
    );
    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitPaneHeader').length,
      0
    );
    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitResizer').length,
      0
    );

    // Split Right -> 2 panes; then Split Down on Pane #2 -> 3 panes
    await act(async () => {
      api!.splitActive('horizontal');
    });
    await act(async () => {
      api!.splitActive('vertical');
    });

    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitPane').length,
      3
    );
    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitPaneHeader').length,
      3
    );
    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitResizer').length,
      2
    );

    // Verify PaneBody memoization isolates untouched panes when one pane changes
    const leavesBeforeUpdate = api!.getLeafIds();
    const secondPaneId = leavesBeforeUpdate[1];
    const thirdPaneId = leavesBeforeUpdate[2];
    const thirdBefore = renderCounts.get(thirdPaneId) ?? 0;

    const firstSelect = container.querySelector(
      '.RealmBrowser__SplitPane[data-pane-id="pane-1"] select'
    ) as HTMLSelectElement;
    assert.ok(firstSelect);
    await act(async () => {
      firstSelect.value = 'Invoice';
      firstSelect.dispatchEvent(
        new dom.window.Event('change', { bubbles: true })
      );
    });
    assert.strictEqual(
      renderCounts.get(thirdPaneId),
      thirdBefore,
      'Untouched PaneBody #3 should skip re-render via React.memo'
    );

    // Drag Pane #1 header onto left edge of Pane #2 to test Drag-to-Dock preview and drop
    const pane1Header = container.querySelector(
      '.RealmBrowser__SplitPane[data-pane-id="pane-1"] .RealmBrowser__SplitPaneHeader'
    ) as HTMLElement;
    const pane2El = container.querySelector(
      `.RealmBrowser__SplitPane[data-pane-id="${secondPaneId}"]`
    ) as HTMLElement;
    pane2El.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 300,
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect;

    const fakeDataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'all',
      setData: () => undefined
    };

    await act(async () => {
      const dragStartEv = new dom.window.Event('dragstart', { bubbles: true });
      Object.defineProperty(dragStartEv, 'dataTransfer', {
        value: fakeDataTransfer
      });
      pane1Header.dispatchEvent(dragStartEv);
    });

    await act(async () => {
      const dragOverEv = new dom.window.MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 150
      });
      Object.defineProperty(dragOverEv, 'dataTransfer', {
        value: fakeDataTransfer
      });
      pane2El.dispatchEvent(dragOverEv);
    });

    const overlayLabel = container.querySelector(
      '.RealmBrowser__SplitDropPreview--left'
    );
    assert.ok(overlayLabel, 'Expected left dock drop preview overlay');

    await act(async () => {
      const dropEv = new dom.window.MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 150
      });
      Object.defineProperty(dropEv, 'dataTransfer', {
        value: fakeDataTransfer
      });
      pane2El.dispatchEvent(dropEv);
    });

    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitDropOverlay').length,
      0
    );
    assert.strictEqual(
      api!.getLeafIds()[0],
      'pane-1',
      'Dropped pane-1 docked left before target pane'
    );

    // Resizer drag uses rAF direct style updates with zero React commits until mouseup
    const branchContainer = container.querySelector(
      '.RealmBrowser__SplitContainer--horizontal'
    ) as HTMLElement;
    assert.ok(branchContainer);
    const branchChildren = Array.from(branchContainer.children) as HTMLElement[];
    const firstChild = branchChildren[0];
    const resizer = branchChildren[1];
    branchContainer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect;

    const countBeforeDrag = renderCounts.get(thirdPaneId) ?? 0;
    await act(async () => {
      resizer.dispatchEvent(
        new dom.window.MouseEvent('mousedown', { bubbles: true })
      );
    });
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MouseEvent('mousemove', { clientX: 300, clientY: 100 })
      );
      dom.window.dispatchEvent(
        new dom.window.MouseEvent('mousemove', { clientX: 650, clientY: 100 })
      );
      flushRaf();
    });

    assert.strictEqual(
      firstChild.style.flex,
      '0 0 calc(65% - 2.5px)',
      'Divider drag applies smooth flex update via rAF'
    );
    assert.strictEqual(
      renderCounts.get(thirdPaneId),
      countBeforeDrag,
      'PaneBody does not re-render mid-drag'
    );

    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MouseEvent('mouseup', { clientX: 650, clientY: 100 })
      );
    });
    assert.strictEqual(firstChild.style.flex, '0 0 calc(65% - 2.5px)');

    // Double-click resizer resets split back to 50/50
    await act(async () => {
      resizer.dispatchEvent(
        new dom.window.MouseEvent('dblclick', { bubbles: true })
      );
    });
    assert.strictEqual(firstChild.style.flex, '0 0 calc(50% - 2.5px)');

    // Close panes repeatedly back down to single pane
    for (let i = 0; i < 2; i++) {
      const closeBtn = container.querySelector(
        '.RealmBrowser__SplitPaneActions button:last-child'
      ) as HTMLButtonElement;
      assert.ok(closeBtn);
      await act(async () => {
        closeBtn.dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true })
        );
      });
    }

    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitPane').length,
      1
    );
    assert.strictEqual(
      container.querySelectorAll('.RealmBrowser__SplitPaneHeader').length,
      0
    );

    // Rapid open/close toggle stress cycle on live React tree
    for (let cycle = 0; cycle < 6; cycle++) {
      await act(async () => {
        api!.splitActive(cycle % 2 === 0 ? 'horizontal' : 'vertical');
        api!.splitActive(cycle % 2 === 0 ? 'vertical' : 'horizontal');
      });
      assert.strictEqual(api!.getLeafIds().length, 3);
      for (let j = 0; j < 2; j++) {
        const closeBtn = container.querySelector(
          '.RealmBrowser__SplitPaneActions button:last-child'
        ) as HTMLButtonElement;
        await act(async () => {
          closeBtn.dispatchEvent(
            new dom.window.MouseEvent('click', { bubbles: true })
          );
        });
      }
      assert.strictEqual(api!.getLeafIds().length, 1);
    }

    // Resize branch helper call compiles cleanly and works
    await act(async () => {
      api!.splitActive('horizontal');
      api!.resizeFirstBranch(0.4);
    });
    assert.strictEqual(api!.getLeafIds().length, 2);
  });
});
