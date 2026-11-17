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

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ImportableFile, ImportFormat } from '../../services/data-importer';
import { ILoadingProgress, LoadingOverlay } from '../reusable/LoadingOverlay';

import {
  ClassFocussedHandler,
  IPaneContentCallbacks,
  IPaneViewState,
  IsEmbeddedTypeChecker,
  ISplitPaneUiCallbacks,
  JsonViewerDialogExecutor
} from '.';
import { AddClassModal } from './AddClassModal';
import { AddPropertyModal } from './AddPropertyModal';
import { AiQueryModal } from './AiQueryModal';
import { AiSettingsModal, AiSettingsModalTab } from './AiSettingsModal';
import {
  CommandPaletteModal,
  ICommandPaletteAction
} from './CommandPaletteModal';
import { Content, EditMode, HighlightMode } from './Content';
import { DatabaseOverviewModal } from './DatabaseOverviewModal';
import { IObjectIdentifier } from './display';
import { EmbeddedFocusPlaceholder } from './EmbeddedFocusPlaceholder';
import { EncryptionDialog } from './EncryptionDialog';
import { generateKey, getClassName, IClassFocus } from './focus';
import { GlobalSearchModal } from './GlobalSearchModal';
import { ImportDialog } from './ImportDialog';
import { JsonViewerDialog } from './JsonViewerDialog';
import { LeftSidebar } from './LeftSidebar';
import { IBreadcrumbItem, NavigationBar } from './NavigationBar';
import { NoFocusPlaceholder } from './NoFocusPlaceholder';
import {
  listLeafIds,
  SplitDirection,
  SplitDropZone,
  SplitLayoutNode
} from './split-layout';
import { ISplitPaneCallbacks, SplitNodeRenderer } from './SplitPaneContainer';

import './RealmBrowser.scss';

export interface IRealmBrowserProps {
  activeObjectId: IObjectIdentifier | null;
  activePaneId: string;
  aiSettingsInitialTab: AiSettingsModalTab;
  androidAutoSyncSec: number;
  androidSyncStatus: string | null;
  breadcrumbs: IBreadcrumbItem[];
  canGoBack: boolean;
  canGoForward: boolean;
  classes: Realm.ObjectSchema[];
  commandPaletteActions: ICommandPaletteAction[];
  dataVersion: number;
  dataVersionAtBeginning?: number;
  editMode: EditMode;
  getClassFocus: (className: string) => IClassFocus;
  getPaneContentCallbacks: (paneId: string) => IPaneContentCallbacks;
  getPaneUiCallbacks: (paneId: string) => ISplitPaneUiCallbacks;
  getSchemaLength: (name: string, isAsymmetric?: boolean) => number;
  importDialog: null | { filePaths: string[]; classNames: string[] };
  isAddClassOpen: boolean;
  isAddPropertyOpen: boolean;
  isAiQueryOpen: boolean;
  isAiSettingsOpen: boolean;
  isAndroidTracked: boolean;
  isClassNameAvailable: (name: string) => boolean;
  isCommandPaletteOpen: boolean;
  isEmbeddedType: IsEmbeddedTypeChecker;
  isEncryptionDialogVisible: boolean;
  isGlobalSearchOpen: boolean;
  isLeftSidebarOpen: boolean;
  isOverviewOpen: boolean;
  isPropertyNameAvailable: (name: string) => boolean;
  jsonViewerDialog: null | {
    value: unknown;
    onSave?: (updatedJson: string) => void;
  };
  layout: SplitLayoutNode;
  onAddClass: (schema: Realm.ObjectSchema) => void;
  onAddProperty: (name: string, type: Realm.PropertyType | string) => void;
  onApplyAiQuery: (query: string, targetClassName?: string) => void;
  onBack: () => void;
  onBreadcrumbClick: (index: number) => void;
  onCancelTransaction: () => void;
  onClassFocussed: ClassFocussedHandler;
  onCommitBranchRatio: (branchId: string, ratio: number) => void;
  onCommitTransaction: () => void;
  onConfigureAndroidSync: () => void;
  onDeleteClass: (className: string) => void;
  onDropPane: (
    sourcePaneId: string,
    targetPaneId: string,
    zone: SplitDropZone
  ) => void;
  onForward: () => void;
  onHideEncryptionDialog: () => void;
  onHideImportDialog: () => void;
  onHideJsonViewerDialog: () => void;
  onImport: (format: ImportFormat, files: ImportableFile[]) => void;
  onLeftSidebarToggle: () => void;
  onOpenAiSettingsTab: (tab?: AiSettingsModalTab) => void;
  onOpenInSplitView: (
    className: string,
    highlightedObject?: Realm.Object
  ) => void;
  onOpenWithEncryption: (
    key: string,
    remember?: boolean,
    label?: string
  ) => void;
  onRealmChanged: () => void;
  onReload: () => void;
  onResetSinglePane: () => void;
  onShowJsonViewerDialog: JsonViewerDialogExecutor;
  onSplitPane: (targetPaneId: string, direction: SplitDirection) => void;
  panes: Record<string, IPaneViewState | undefined>;
  progress: ILoadingProgress;
  realm?: Realm;
  toggleAddClass: () => void;
  toggleAddClassProperty: () => void;
  toggleAiQuery: () => void;
  toggleAiSettings: () => void;
  toggleCommandPalette: () => void;
  toggleGlobalSearch: () => void;
  toggleOverview: () => void;
}

export const RealmBrowser = ({
  activeObjectId,
  activePaneId,
  aiSettingsInitialTab,
  androidAutoSyncSec,
  androidSyncStatus,
  breadcrumbs,
  canGoBack,
  canGoForward,
  classes,
  commandPaletteActions,
  dataVersion,
  dataVersionAtBeginning,
  editMode,
  getClassFocus,
  getPaneContentCallbacks,
  getPaneUiCallbacks,
  getSchemaLength,
  importDialog,
  isAddClassOpen,
  isAddPropertyOpen,
  isAiQueryOpen,
  isAiSettingsOpen,
  isAndroidTracked,
  isClassNameAvailable,
  isCommandPaletteOpen,
  isEmbeddedType,
  isEncryptionDialogVisible,
  isGlobalSearchOpen,
  isLeftSidebarOpen,
  isOverviewOpen,
  isPropertyNameAvailable,
  jsonViewerDialog,
  layout,
  onAddClass,
  onAddProperty,
  onApplyAiQuery,
  onBack,
  onBreadcrumbClick,
  onCancelTransaction,
  onClassFocussed,
  onCommitBranchRatio,
  onCommitTransaction,
  onConfigureAndroidSync,
  onDeleteClass,
  onDropPane,
  onForward,
  onHideEncryptionDialog,
  onHideImportDialog,
  onHideJsonViewerDialog,
  onImport,
  onLeftSidebarToggle,
  onOpenAiSettingsTab,
  onOpenInSplitView,
  onOpenWithEncryption,
  onRealmChanged,
  onReload,
  onResetSinglePane,
  onShowJsonViewerDialog,
  onSplitPane,
  panes,
  progress,
  realm,
  toggleAddClass,
  toggleAddClassProperty,
  toggleAiQuery,
  toggleAiSettings,
  toggleCommandPalette,
  toggleGlobalSearch,
  toggleOverview
}: IRealmBrowserProps) => {
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);

  // Clear drag state if drag ends or drops outside a valid target
  useEffect(() => {
    if (!draggingPaneId) {
      return;
    }
    const clearDrag = () => setDraggingPaneId(null);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('drop', clearDrag);
    return () => {
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('drop', clearDrag);
    };
  }, [draggingPaneId]);

  const leafIds = useMemo(() => listLeafIds(layout), [layout]);

  const paneOrderMap = useMemo(() => {
    const map = new Map<string, number>();
    leafIds.forEach((id, index) => {
      map.set(id, index + 1);
    });
    return map;
  }, [leafIds]);

  const totalPanes = leafIds.length;
  const activePaneNumber = paneOrderMap.get(activePaneId) ?? 1;
  const activePaneFocus = panes[activePaneId]?.focus ?? null;
  const activeClassName = activePaneFocus
    ? getClassName(activePaneFocus)
    : undefined;
  const hasAnyFocus = Boolean(
    activePaneFocus || leafIds.some((id) => Boolean(panes[id]?.focus))
  );

  const secondaryClassNames = useMemo(() => {
    if (totalPanes <= 1) {
      return [];
    }
    const names = new Set<string>();
    for (const id of leafIds) {
      if (id === activePaneId) {
        continue;
      }
      const paneFocus = panes[id]?.focus;
      if (paneFocus) {
        names.add(getClassName(paneFocus));
      }
    }
    return Array.from(names);
  }, [activePaneId, leafIds, panes, totalPanes]);

  const paneCallbacksMap = useMemo(() => {
    const map = new Map<string, ISplitPaneCallbacks>();
    for (const id of leafIds) {
      const ui = getPaneUiCallbacks(id);
      map.set(id, {
        ...ui,
        onDragStart: () => setDraggingPaneId(id)
      });
    }
    return map;
  }, [getPaneUiCallbacks, leafIds]);

  const getPaneCallbacks = useCallback(
    (paneId: string): ISplitPaneCallbacks => {
      return (
        paneCallbacksMap.get(paneId) ?? {
          ...getPaneUiCallbacks(paneId),
          onDragStart: () => setDraggingPaneId(paneId)
        }
      );
    },
    [getPaneUiCallbacks, paneCallbacksMap]
  );

  const handleDragEnd = useCallback(() => {
    setDraggingPaneId(null);
  }, []);

  const handleDropPane = useCallback(
    (sourcePaneId: string, targetPaneId: string, zone: SplitDropZone) => {
      setDraggingPaneId(null);
      onDropPane(sourcePaneId, targetPaneId, zone);
    },
    [onDropPane]
  );

  const handleSplitActiveRight = useCallback(() => {
    onSplitPane(activePaneId, 'horizontal');
  }, [activePaneId, onSplitPane]);

  const handleSplitActiveDown = useCallback(() => {
    onSplitPane(activePaneId, 'vertical');
  }, [activePaneId, onSplitPane]);

  const renderPaneBody = useCallback(
    (paneId: string) => {
      if (!realm) {
        return <NoFocusPlaceholder />;
      }
      const paneState = panes[paneId];
      if (!paneState || !paneState.focus) {
        return <NoFocusPlaceholder />;
      }
      const paneFocus = paneState.focus;
      const paneCallbacks = getPaneContentCallbacks(paneId);
      const isPaneActive = activePaneId === paneId;
      const contentKey = `${paneId}:${generateKey(paneFocus, true)}`;

      return (
        <>
          <Content
            allowCreate={paneState.allowCreate}
            dataVersion={dataVersion}
            dataVersionAtBeginning={dataVersionAtBeginning}
            editMode={editMode}
            focus={paneFocus}
            getClassFocus={getClassFocus}
            highlightMode={HighlightMode.Multiple}
            isActivePane={isPaneActive}
            isEmbeddedType={isEmbeddedType}
            key={contentKey}
            onAddColumnClick={paneCallbacks.onAddColumnClick}
            onAskAi={paneCallbacks.onAskAi}
            onCancelTransaction={onCancelTransaction}
            onClassFocussed={paneCallbacks.onClassFocussed}
            onCommitTransaction={onCommitTransaction}
            onHighlightChange={paneCallbacks.onHighlightChange}
            onListFocussed={paneCallbacks.onListFocussed}
            onRealmChanged={onRealmChanged}
            onShowJsonViewerDialog={onShowJsonViewerDialog}
            onSingleListFocussed={paneCallbacks.onSingleListFocussed}
            paneId={paneId}
            progress={progress}
            readOnly={editMode === EditMode.Disabled}
            realm={realm}
            ref={paneCallbacks.contentRef}
          />
          {paneFocus.kind === 'class' && paneFocus.isEmbedded && (
            <EmbeddedFocusPlaceholder />
          )}
        </>
      );
    },
    [
      activePaneId,
      dataVersion,
      dataVersionAtBeginning,
      editMode,
      getClassFocus,
      getPaneContentCallbacks,
      isEmbeddedType,
      onCancelTransaction,
      onCommitTransaction,
      onRealmChanged,
      onShowJsonViewerDialog,
      panes,
      progress,
      realm
    ]
  );

  return (
    <div className="RealmBrowser">
      <LeftSidebar
        classes={classes}
        className="RealmBrowser__LeftSidebar"
        focus={activePaneFocus}
        getSchemaLength={getSchemaLength}
        isOpen={isLeftSidebarOpen}
        onClassFocussed={onClassFocussed}
        onDeleteClass={onDeleteClass}
        onOpenInSplitView={onOpenInSplitView}
        onReload={onReload}
        onToggle={onLeftSidebarToggle}
        progress={progress}
        readOnly={editMode === EditMode.Disabled}
        secondaryClassNames={secondaryClassNames}
        toggleAddClass={toggleAddClass}
        toggleGlobalSearch={toggleGlobalSearch}
        toggleOverview={toggleOverview}
      />

      <div className="RealmBrowser__Wrapper">
        {hasAnyFocus && realm ? (
          <>
            <NavigationBar
              activeObjectId={activeObjectId}
              activePaneNumber={activePaneNumber}
              androidAutoSyncSec={androidAutoSyncSec}
              androidSyncStatus={androidSyncStatus}
              breadcrumbs={breadcrumbs}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              isAndroidTracked={isAndroidTracked}
              onBack={onBack}
              onBreadcrumbClick={onBreadcrumbClick}
              onConfigureAndroidSync={onConfigureAndroidSync}
              onForward={onForward}
              onResetSinglePane={onResetSinglePane}
              onSplitDown={handleSplitActiveDown}
              onSplitRight={handleSplitActiveRight}
              paneCount={totalPanes}
            />
            <SplitNodeRenderer
              activePaneId={activePaneId}
              classes={classes}
              draggingPaneId={draggingPaneId}
              getPaneCallbacks={getPaneCallbacks}
              node={layout}
              onCommitRatio={onCommitBranchRatio}
              onDragEnd={handleDragEnd}
              onDropPane={handleDropPane}
              paneOrderMap={paneOrderMap}
              panes={panes}
              renderPaneBody={renderPaneBody}
              totalPanes={totalPanes}
            />
          </>
        ) : (
          <NoFocusPlaceholder />
        )}
      </div>

      <AddClassModal
        isOpen={isAddClassOpen}
        isClassNameAvailable={isClassNameAvailable}
        onAddClass={onAddClass}
        toggle={toggleAddClass}
      />

      <DatabaseOverviewModal
        classes={classes}
        getSchemaLength={getSchemaLength}
        isOpen={isOverviewOpen}
        onClassFocussed={onClassFocussed}
        readOnly={editMode === EditMode.Disabled}
        realm={realm}
        toggle={toggleOverview}
      />

      <GlobalSearchModal
        classes={classes}
        isOpen={isGlobalSearchOpen}
        onClassFocussed={onClassFocussed}
        realm={realm}
        toggle={toggleGlobalSearch}
      />

      <CommandPaletteModal
        actions={commandPaletteActions}
        isOpen={isCommandPaletteOpen}
        toggle={toggleCommandPalette}
      />

      <AiQueryModal
        activeClassName={activeClassName}
        classes={classes}
        currentQuery=""
        isOpen={isAiQueryOpen}
        onApplyQuery={onApplyAiQuery}
        onJumpToObject={onClassFocussed}
        onOpenInSplitView={onOpenInSplitView}
        onOpenKnowledgeBase={() => onOpenAiSettingsTab('kb')}
        onOpenSettings={() => onOpenAiSettingsTab('ai')}
        realm={realm}
        toggle={toggleAiQuery}
      />

      <AiSettingsModal
        activeClassName={activeClassName}
        classes={classes}
        initialTab={aiSettingsInitialTab}
        isOpen={isAiSettingsOpen}
        realm={realm}
        toggle={toggleAiSettings}
      />

      {activePaneFocus && activePaneFocus.kind === 'class' ? (
        <AddPropertyModal
          focus={activePaneFocus}
          isOpen={isAddPropertyOpen}
          isPropertyNameAvailable={isPropertyNameAvailable}
          onAddProperty={onAddProperty}
          classes={classes}
          toggle={toggleAddClassProperty}
        />
      ) : null}

      <EncryptionDialog
        onHide={onHideEncryptionDialog}
        onOpenWithEncryption={onOpenWithEncryption}
        visible={isEncryptionDialogVisible}
      />

      <ImportDialog
        filePaths={importDialog ? importDialog.filePaths : []}
        classNames={importDialog ? importDialog.classNames : []}
        visible={importDialog !== null}
        onHide={onHideImportDialog}
        onImport={onImport}
      />

      <JsonViewerDialog
        value={jsonViewerDialog?.value}
        onSave={jsonViewerDialog?.onSave}
        visible={jsonViewerDialog !== null}
        onHide={onHideJsonViewerDialog}
      />

      <LoadingOverlay progress={progress} />
    </div>
  );
};
