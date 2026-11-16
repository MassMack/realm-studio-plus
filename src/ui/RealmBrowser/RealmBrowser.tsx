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

import { ILoadingProgress, LoadingOverlay } from '../reusable/LoadingOverlay';
import { ImportableFile, ImportFormat } from '../../services/data-importer';

import {
  ClassFocussedHandler,
  ListFocussedHandler,
  IsEmbeddedTypeChecker,
  SingleListFocussedHandler,
  JsonViewerDialogExecutor
} from '.';
import { AddClassModal } from './AddClassModal';
import { AddPropertyModal } from './AddPropertyModal';
import { AiQueryModal } from './AiQueryModal';
import { AiSettingsModal } from './AiSettingsModal';
import {
  CommandPaletteModal,
  ICommandPaletteAction
} from './CommandPaletteModal';
import { Content, EditMode, HighlightMode } from './Content';
import { IHighlight } from './Content/Table';
import { DatabaseOverviewModal } from './DatabaseOverviewModal';
import { IObjectIdentifier } from './display';
import { EncryptionDialog } from './EncryptionDialog';
import { Focus, IClassFocus } from './focus';
import { GlobalSearchModal } from './GlobalSearchModal';
import { LeftSidebar } from './LeftSidebar';
import { IBreadcrumbItem, NavigationBar } from './NavigationBar';
import { NoFocusPlaceholder } from './NoFocusPlaceholder';
import { EmbeddedFocusPlaceholder } from './EmbeddedFocusPlaceholder';
import { ImportDialog } from './ImportDialog';
import { JsonViewerDialog } from './JsonViewerDialog';

import './RealmBrowser.scss';

export interface IRealmBrowserProps {
  activeObjectId: IObjectIdentifier | null;
  breadcrumbs: IBreadcrumbItem[];
  canGoBack: boolean;
  canGoForward: boolean;
  classes: Realm.ObjectSchema[];
  commandPaletteActions: ICommandPaletteAction[];
  contentKey: string;
  contentRef: (instance: Content | null) => void;
  createObjectSchema?: Realm.ObjectSchema;
  dataVersion: number;
  dataVersionAtBeginning?: number;
  allowCreate: boolean;
  editMode: EditMode;
  focus: Focus | null;
  getClassFocus: (className: string) => IClassFocus;
  getSchemaLength: (name: string, isAsymmetric?: boolean) => number;
  importDialog: null | { filePaths: string[]; classNames: string[] };
  isAddClassOpen: boolean;
  isAddPropertyOpen: boolean;
  isAiQueryOpen: boolean;
  isAiSettingsOpen: boolean;
  isClassNameAvailable: (name: string) => boolean;
  isCommandPaletteOpen: boolean;
  isEncryptionDialogVisible: boolean;
  isGlobalSearchOpen: boolean;
  isLeftSidebarOpen: boolean;
  isOverviewOpen: boolean;
  isPropertyNameAvailable: (name: string) => boolean;
  jsonViewerDialog: null | {
    value: unknown;
    onSave?: (updatedJson: string) => void;
  };
  onAddClass: (schema: Realm.ObjectSchema) => void;
  onAddProperty: (name: string, type: Realm.PropertyType | string) => void;
  onApplyAiQuery: (query: string) => void;
  onBack: () => void;
  onBreadcrumbClick: (index: number) => void;
  onCancelTransaction: () => void;
  onClassFocussed: ClassFocussedHandler;
  onCommitTransaction: () => void;
  onDeleteClass: (className: string) => void;
  onForward: () => void;
  onHighlightChange: (
    highlight: IHighlight | undefined,
    collection: Realm.OrderedCollection<any>
  ) => void;
  onHideEncryptionDialog: () => void;
  onHideImportDialog: () => void;
  onImport: (format: ImportFormat, files: ImportableFile[]) => void;
  onShowJsonViewerDialog: JsonViewerDialogExecutor;
  onHideJsonViewerDialog: () => void;
  onLeftSidebarToggle: () => void;
  onListFocussed: ListFocussedHandler;
  onSingleListFocussed: SingleListFocussedHandler;
  onOpenWithEncryption: (
    key: string,
    remember?: boolean,
    label?: string
  ) => void;
  onRealmChanged: () => void;
  onReload: () => void;
  progress: ILoadingProgress;
  realm?: Realm;
  toggleAddClass: () => void;
  toggleAddClassProperty: () => void;
  toggleAiQuery: () => void;
  toggleAiSettings: () => void;
  toggleCommandPalette: () => void;
  toggleGlobalSearch: () => void;
  toggleOverview: () => void;
  isEmbeddedType: IsEmbeddedTypeChecker;
}

export const RealmBrowser = ({
  activeObjectId,
  breadcrumbs,
  canGoBack,
  canGoForward,
  classes,
  commandPaletteActions,
  contentKey,
  contentRef,
  dataVersion,
  dataVersionAtBeginning,
  allowCreate,
  editMode,
  focus,
  getClassFocus,
  getSchemaLength,
  importDialog,
  isAddClassOpen,
  isAddPropertyOpen,
  isAiQueryOpen,
  isAiSettingsOpen,
  isClassNameAvailable,
  isCommandPaletteOpen,
  isEncryptionDialogVisible,
  isGlobalSearchOpen,
  isLeftSidebarOpen,
  isOverviewOpen,
  isPropertyNameAvailable,
  jsonViewerDialog,
  onAddClass,
  onAddProperty,
  onApplyAiQuery,
  onBack,
  onBreadcrumbClick,
  onCancelTransaction,
  onClassFocussed,
  onCommitTransaction,
  onDeleteClass,
  onForward,
  onHighlightChange,
  onHideEncryptionDialog,
  onHideImportDialog,
  onImport,
  onShowJsonViewerDialog,
  onHideJsonViewerDialog,
  onLeftSidebarToggle,
  onListFocussed,
  onSingleListFocussed,
  onOpenWithEncryption,
  onRealmChanged,
  onReload,
  progress,
  realm,
  toggleAddClass,
  toggleAddClassProperty,
  toggleAiQuery,
  toggleAiSettings,
  toggleCommandPalette,
  toggleGlobalSearch,
  toggleOverview,
  isEmbeddedType
}: IRealmBrowserProps) => {
  return (
    <div className="RealmBrowser">
      <LeftSidebar
        classes={classes}
        className="RealmBrowser__LeftSidebar"
        focus={focus}
        getSchemaLength={getSchemaLength}
        isOpen={isLeftSidebarOpen}
        onClassFocussed={onClassFocussed}
        onDeleteClass={onDeleteClass}
        onReload={onReload}
        onToggle={onLeftSidebarToggle}
        progress={progress}
        readOnly={editMode === EditMode.Disabled}
        toggleAddClass={toggleAddClass}
        toggleGlobalSearch={toggleGlobalSearch}
        toggleOverview={toggleOverview}
      />

      <div className="RealmBrowser__Wrapper">
        {focus && realm ? (
          <>
            <NavigationBar
              activeObjectId={activeObjectId}
              breadcrumbs={breadcrumbs}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onBack={onBack}
              onForward={onForward}
              onBreadcrumbClick={onBreadcrumbClick}
            />
            <Content
              dataVersion={dataVersion}
              dataVersionAtBeginning={dataVersionAtBeginning}
              allowCreate={allowCreate}
              editMode={editMode}
              focus={focus}
              getClassFocus={getClassFocus}
              highlightMode={HighlightMode.Multiple}
              key={contentKey}
              onAddColumnClick={toggleAddClassProperty}
              onAskAi={toggleAiQuery}
              onCancelTransaction={onCancelTransaction}
              onClassFocussed={onClassFocussed}
              onCommitTransaction={onCommitTransaction}
              onHighlightChange={onHighlightChange}
              onListFocussed={onListFocussed}
              onSingleListFocussed={onSingleListFocussed}
              onRealmChanged={onRealmChanged}
              onShowJsonViewerDialog={onShowJsonViewerDialog}
              progress={progress}
              readOnly={editMode === EditMode.Disabled}
              realm={realm}
              ref={contentRef}
              isEmbeddedType={isEmbeddedType}
            />
          </>
        ) : (
          // TODO: Use the loading overlay until Realm has fully loaded
          <NoFocusPlaceholder />
        )}
        {focus && focus.kind === 'class' && focus.isEmbedded && (
          <EmbeddedFocusPlaceholder />
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
        activeClassName={
          focus
            ? focus.kind === 'class'
              ? focus.className
              : focus.property.objectType
            : undefined
        }
        classes={classes}
        currentQuery=""
        isOpen={isAiQueryOpen}
        onApplyQuery={onApplyAiQuery}
        onOpenSettings={toggleAiSettings}
        toggle={toggleAiQuery}
      />

      <AiSettingsModal
        isOpen={isAiSettingsOpen}
        toggle={toggleAiSettings}
      />

      {focus && focus.kind === 'class' ? (
        <AddPropertyModal
          focus={focus}
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

      <LoadingOverlay progress={progress} fade={true} />
    </div>
  );
};
