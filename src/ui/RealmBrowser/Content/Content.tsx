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

import React from 'react';
import Realm from 'realm';

import { Bottombar } from '../Bottombar';
import { IPropertyWithName } from '..';
import { Focus, IClassFocus } from '../focus';

import {
  EditMode,
  ISorting,
  QueryChangeHandler,
  SortingChangeHandler
} from '.';
import {
  CreateObjectDialog,
  ICreateObjectDialogContainerProps
} from './CreateObjectDialog';
import {
  DeleteObjectsDialog,
  IDeleteObjectsDialogProps
} from './DeleteObjectsDialog';
import { ResponsiveTable } from './ResponsiveTable';
import {
  ISelectObjectDialogContainerProps,
  SelectObjectDialog
} from './SelectObjectDialog';
import {
  CellChangeHandler,
  CellClickHandler,
  CellContextMenuHandler,
  CellHighlightedHandler,
  CellValidatedHandler,
  IHighlight,
  ReorderingEndHandler,
  ReorderingStartHandler,
  RowMouseDownHandler
} from './Table';
import { TopBar } from './TopBar';

interface IBaseContentProps {
  allProperties?: IPropertyWithName[];
  contentRef: (element: HTMLElement | null) => void;
  dataVersion?: number;
  allowCreate: boolean;
  editMode: EditMode;
  error?: Error;
  filteredCount?: number;
  filteredSortedResults: Realm.OrderedCollection<any>;
  focus: Focus;
  hiddenColumns?: string[];
  highlight?: IHighlight;
  isActivePane?: boolean;
  onAddColumnClick?: () => void;
  onAskAi?: () => void;
  onCellChange: CellChangeHandler;
  onCellClick: CellClickHandler;
  onCellHighlighted: CellHighlightedHandler;
  onCellValidated: CellValidatedHandler;
  onContentContextMenu?: React.MouseEventHandler<HTMLElement>;
  onContextMenu: CellContextMenuHandler;
  onDeleteFilteredRows?: () => void;
  onExportView?: (format: 'json' | 'csv') => void;
  onGenerateMockRows?: (count: number) => void;
  onImportJsonFile?: () => void;
  onPasteJson?: () => void;
  onRowMouseDown: RowMouseDownHandler;
  onNewObjectClick?: () => void;
  onQueryChange: QueryChangeHandler;
  onQueryHelp: () => void;
  onResetHighlight: () => void;
  onShowAllColumns?: () => void;
  onSortingChange: SortingChangeHandler;
  onToggleColumn?: (propName: string) => void;
  query: string;
  queryError?: Error | undefined;
  selectedCount?: number;
  sorting?: ISorting;
  totalCount?: number;
}

interface IReadOnlyContentProps extends IBaseContentProps {
  editMode: EditMode.Disabled;
  readOnly: true;
}

interface IReadWriteContentProps extends IBaseContentProps {
  changeCount: number;
  createObjectDialog: ICreateObjectDialogContainerProps;
  deleteObjectsDialog: IDeleteObjectsDialogProps;
  editMode: EditMode;
  getClassFocus: (className: string) => IClassFocus;
  inTransaction: boolean;
  onCancelTransaction: () => void;
  onCommitTransaction: () => void;
  onReorderingEnd: ReorderingEndHandler;
  onReorderingStart: ReorderingStartHandler;
  readOnly: false;
  realm: Realm;
  selectObjectDialog: ISelectObjectDialogContainerProps;
}

export type IContentProps = IReadOnlyContentProps | IReadWriteContentProps;

export const Content = ({
  allProperties,
  contentRef,
  dataVersion,
  editMode,
  error,
  filteredCount,
  filteredSortedResults,
  focus,
  hiddenColumns,
  highlight,
  isActivePane = true,
  onAddColumnClick,
  onAskAi,
  onCellChange,
  onCellClick,
  onCellHighlighted,
  onCellValidated,
  onContentContextMenu,
  onContextMenu,
  onDeleteFilteredRows,
  onExportView,
  onGenerateMockRows,
  onImportJsonFile,
  onNewObjectClick,
  onPasteJson,
  onQueryChange,
  onQueryHelp,
  onResetHighlight,
  onRowMouseDown,
  onShowAllColumns,
  onSortingChange,
  onToggleColumn,
  query,
  queryError,
  selectedCount,
  sorting,
  totalCount,
  ...props
}: IContentProps) =>
  error ? (
    <div className="RealmBrowser__Content RealmBrowser__Content--error">
      <span className="RealmBrowser__Content__Error">{error.message}</span>
    </div>
  ) : (
    <div
      className="RealmBrowser__Content"
      ref={contentRef}
      onContextMenu={onContentContextMenu}
    >
      <TopBar
        allProperties={allProperties}
        enableGlobalFindShortcut={isActivePane}
        filteredCount={filteredCount}
        focus={focus}
        hiddenColumns={hiddenColumns}
        onAskAi={onAskAi}
        onDeleteFilteredRows={onDeleteFilteredRows}
        onExportView={onExportView}
        onGenerateMockRows={onGenerateMockRows}
        onImportJsonFile={onImportJsonFile}
        onNewObjectClick={onNewObjectClick}
        onPasteJson={onPasteJson}
        onQueryChange={onQueryChange}
        onQueryHelp={onQueryHelp}
        onShowAllColumns={onShowAllColumns}
        onToggleColumn={onToggleColumn}
        query={query}
        queryError={queryError}
        readOnly={props.readOnly}
        selectedCount={selectedCount}
        totalCount={totalCount}
        allowCreate={props.allowCreate}
      />

      <div className="RealmBrowser__TableContainer">
        <ResponsiveTable
          dataVersion={dataVersion}
          editMode={editMode}
          filteredSortedResults={filteredSortedResults}
          focus={focus}
          highlight={highlight}
          onAddColumnClick={
            focus.kind === 'class' ? onAddColumnClick : undefined
          }
          onCellChange={onCellChange}
          onCellClick={onCellClick}
          onCellHighlighted={onCellHighlighted}
          onCellValidated={onCellValidated}
          onContextMenu={onContextMenu}
          onRowMouseDown={onRowMouseDown}
          onReorderingEnd={props.readOnly ? undefined : props.onReorderingEnd}
          onReorderingStart={
            props.readOnly ? undefined : props.onReorderingStart
          }
          onResetHighlight={onResetHighlight}
          onSortingChange={onSortingChange}
          query={query}
          readOnly={props.readOnly}
          sorting={sorting}
        />
      </div>

      {!props.readOnly ? (
        <React.Fragment>
          <Bottombar
            changeCount={props.changeCount}
            onCancelTransaction={props.onCancelTransaction}
            onCommitTransaction={props.onCommitTransaction}
            inTransaction={props.inTransaction}
          />
          <CreateObjectDialog {...props.createObjectDialog} />
          <SelectObjectDialog {...props.selectObjectDialog} />
          <DeleteObjectsDialog {...props.deleteObjectsDialog} />
        </React.Fragment>
      ) : null}
    </div>
  );
