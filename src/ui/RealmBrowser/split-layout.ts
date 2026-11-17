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

export type SplitDirection = 'horizontal' | 'vertical';
export type SplitDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface ISplitLeafNode {
  kind: 'leaf';
  id: string;
}

export interface ISplitBranchNode {
  kind: 'branch';
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: SplitLayoutNode;
  second: SplitLayoutNode;
}

export type SplitLayoutNode = ISplitLeafNode | ISplitBranchNode;

export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

let nextNodeCounter = 1;

export function allocateLayoutId(prefix: string): string {
  nextNodeCounter += 1;
  return `${prefix}-${nextNodeCounter}`;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return 0.5;
  }
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function createInitialLayout(rootPaneId = 'pane-1'): ISplitLeafNode {
  return { kind: 'leaf', id: rootPaneId };
}

export function listLeafIds(node: SplitLayoutNode, out: string[] = []): string[] {
  if (node.kind === 'leaf') {
    out.push(node.id);
    return out;
  }
  listLeafIds(node.first, out);
  listLeafIds(node.second, out);
  return out;
}

export function countLeaves(node: SplitLayoutNode): number {
  if (node.kind === 'leaf') {
    return 1;
  }
  return countLeaves(node.first) + countLeaves(node.second);
}

export function containsPane(node: SplitLayoutNode, paneId: string): boolean {
  if (node.kind === 'leaf') {
    return node.id === paneId;
  }
  return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

export function findAdjacentPaneId(
  node: SplitLayoutNode,
  targetPaneId: string
): string | undefined {
  const leaves = listLeafIds(node);
  const idx = leaves.indexOf(targetPaneId);
  if (idx < 0) {
    return leaves[0];
  }
  if (idx > 0) {
    return leaves[idx - 1];
  }
  return leaves[1];
}

export function splitPaneInLayout(
  node: SplitLayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
  position: 'before' | 'after' = 'after',
  branchId = allocateLayoutId('split')
): SplitLayoutNode {
  if (node.kind === 'leaf') {
    if (node.id !== targetPaneId) {
      return node;
    }
    const newLeaf: ISplitLeafNode = { kind: 'leaf', id: newPaneId };
    return {
      kind: 'branch',
      id: branchId,
      direction,
      ratio: 0.5,
      first: position === 'before' ? newLeaf : node,
      second: position === 'before' ? node : newLeaf
    };
  }

  const nextFirst = splitPaneInLayout(
    node.first,
    targetPaneId,
    newPaneId,
    direction,
    position,
    branchId
  );
  if (nextFirst !== node.first) {
    return { ...node, first: nextFirst };
  }

  const nextSecond = splitPaneInLayout(
    node.second,
    targetPaneId,
    newPaneId,
    direction,
    position,
    branchId
  );
  if (nextSecond !== node.second) {
    return { ...node, second: nextSecond };
  }

  return node;
}

function removePaneInternal(
  node: SplitLayoutNode,
  targetPaneId: string
): SplitLayoutNode | null {
  if (node.kind === 'leaf') {
    return node.id === targetPaneId ? null : node;
  }

  if (node.first.kind === 'leaf' && node.first.id === targetPaneId) {
    return node.second;
  }
  if (node.second.kind === 'leaf' && node.second.id === targetPaneId) {
    return node.first;
  }

  const nextFirst = removePaneInternal(node.first, targetPaneId);
  if (nextFirst !== node.first) {
    return nextFirst ? { ...node, first: nextFirst } : node.second;
  }

  const nextSecond = removePaneInternal(node.second, targetPaneId);
  if (nextSecond !== node.second) {
    return nextSecond ? { ...node, second: nextSecond } : node.first;
  }

  return node;
}

export function closePaneInLayout(
  node: SplitLayoutNode,
  targetPaneId: string
): SplitLayoutNode {
  if (node.kind === 'leaf') {
    // Always preserve at least one pane
    return node;
  }
  return removePaneInternal(node, targetPaneId) ?? node;
}

export function updateBranchRatioInLayout(
  node: SplitLayoutNode,
  branchId: string,
  nextRatio: number
): SplitLayoutNode {
  if (node.kind === 'leaf') {
    return node;
  }
  const clamped = clampSplitRatio(nextRatio);
  if (node.id === branchId) {
    if (Math.abs(node.ratio - clamped) < 0.0001) {
      return node;
    }
    return { ...node, ratio: clamped };
  }
  const nextFirst = updateBranchRatioInLayout(node.first, branchId, clamped);
  if (nextFirst !== node.first) {
    return { ...node, first: nextFirst };
  }
  const nextSecond = updateBranchRatioInLayout(node.second, branchId, clamped);
  if (nextSecond !== node.second) {
    return { ...node, second: nextSecond };
  }
  return node;
}

function swapLeaves(
  node: SplitLayoutNode,
  paneA: string,
  paneB: string
): SplitLayoutNode {
  if (node.kind === 'leaf') {
    if (node.id === paneA) {
      return { kind: 'leaf', id: paneB };
    }
    if (node.id === paneB) {
      return { kind: 'leaf', id: paneA };
    }
    return node;
  }
  const nextFirst = swapLeaves(node.first, paneA, paneB);
  const nextSecond = swapLeaves(node.second, paneA, paneB);
  if (nextFirst === node.first && nextSecond === node.second) {
    return node;
  }
  return { ...node, first: nextFirst, second: nextSecond };
}

export function moveOrSwapPaneInLayout(
  node: SplitLayoutNode,
  sourcePaneId: string,
  targetPaneId: string,
  zone: SplitDropZone
): SplitLayoutNode {
  if (
    !sourcePaneId ||
    !targetPaneId ||
    sourcePaneId === targetPaneId ||
    !containsPane(node, sourcePaneId) ||
    !containsPane(node, targetPaneId)
  ) {
    return node;
  }

  if (zone === 'center') {
    return swapLeaves(node, sourcePaneId, targetPaneId);
  }

  const detached = removePaneInternal(node, sourcePaneId);
  if (!detached) {
    return node;
  }

  const direction: SplitDirection =
    zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
  const position: 'before' | 'after' =
    zone === 'left' || zone === 'top' ? 'before' : 'after';

  return splitPaneInLayout(
    detached,
    targetPaneId,
    sourcePaneId,
    direction,
    position
  );
}

/**
 * Classifies pointer position inside a pane rect into edge dock zones (25% border band)
 * or center swap zone.
 */
export function detectDropZone(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number }
): SplitDropZone {
  if (rect.width <= 0 || rect.height <= 0) {
    return 'center';
  }
  const rx = (clientX - rect.left) / rect.width;
  const ry = (clientY - rect.top) / rect.height;

  const edgeThreshold = 0.25;
  const distLeft = rx;
  const distRight = 1 - rx;
  const distTop = ry;
  const distBottom = 1 - ry;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);

  if (minDist > edgeThreshold) {
    return 'center';
  }
  if (minDist === distLeft) {
    return 'left';
  }
  if (minDist === distRight) {
    return 'right';
  }
  if (minDist === distTop) {
    return 'top';
  }
  return 'bottom';
}
