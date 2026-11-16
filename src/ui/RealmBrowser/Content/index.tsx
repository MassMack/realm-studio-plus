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

import electron from 'electron';
import * as remote from '@electron/remote';
import fs from 'fs-extra';
import memoize from 'memoize-one';
import Papa from 'papaparse';
import React from 'react';
import Realm from 'realm';

import {
  ClassFocussedHandler,
  IPropertyWithName,
  ListFocussedHandler,
  IsEmbeddedTypeChecker,
  SingleListFocussedHandler,
  JsonViewerDialogExecutor
} from '..';
import { store } from '../../../store';
import { getRange } from '../../../utils';
import { canUseJsonViewer } from '../../../utils/json';
import { showError } from '../../reusable/errors';
import { ILoadingProgress } from '../../reusable/LoadingOverlay';
import { displayObject } from '../display';
import { Focus, getClassName, IClassFocus } from '../focus';
import { isPrimitive } from '../primitives';

import { Content, IContentProps } from './Content';
import { ICreateObjectDialogContainerProps } from './CreateObjectDialog';
import { IDeleteObjectsDialogProps } from './DeleteObjectsDialog';
import {
  IOpenSelectMultipleObjectsDialogContainerProps,
  IOpenSelectSingleObjectDialogContainerProps
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
  rowHeights,
  RowMouseDownHandler
} from './Table';

export enum EditMode {
  Disabled = 'disabled',
  InputBlur = 'input-blur',
  KeyPress = 'key-press'
}

export enum HighlightMode {
  Disabled = 'disabled',
  Single = 'single',
  Multiple = 'multiple'
}

export type EmbeddedInfo = {
  parent: Realm.Object & { [key: string]: any };
  key: string;
};
export type CreateObjectHandler = (
  className: string,
  values: Record<string, unknown>,
  embeddedInfo?: EmbeddedInfo
) => void;
export type QueryChangeHandler = (query: string) => void;
export type SortingChangeHandler = (sorting: ISorting | undefined) => void;

export interface ISorting {
  property: IPropertyWithName;
  reverse: boolean;
}

export type SelectObjectAction =
  | { type: 'object'; object: Realm.Object; propertyName: string }
  | { type: 'list'; list: Realm.List<any> };

export interface ISelectObjectForObjectDialog extends IOpenSelectSingleObjectDialogContainerProps {
  action: 'object';
  isOpen: true;
  multiple: false;
  object: Realm.Object;
  propertyName: string;
}

export interface ISelectObjectsForListDialog extends IOpenSelectMultipleObjectsDialogContainerProps {
  action: 'list';
  isOpen: true;
  list: Realm.List<any>;
  multiple: true;
}

export type ISelectObjectDialog =
  | ISelectObjectForObjectDialog
  | ISelectObjectsForListDialog
  | { isOpen: false };

export interface IBaseContentContainerProps {
  dataVersion?: number;
  allowCreate: boolean;
  editMode: EditMode;
  focus: Focus;
  highlightMode: HighlightMode;
  onCellClick?: CellClickHandler;
  onCellDoubleClick?: CellClickHandler;
  onCellSingleClick?: CellClickHandler;
  onClassFocussed?: ClassFocussedHandler;
  onHighlightChange?: (
    highlight: IHighlight | undefined,
    collection: Realm.OrderedCollection<any>
  ) => void;
  onListFocussed?: ListFocussedHandler;
  onSingleListFocussed?: SingleListFocussedHandler;
  onShowJsonViewerDialog: JsonViewerDialogExecutor;
  progress?: ILoadingProgress;
  readOnly: boolean;
  isEmbeddedType: IsEmbeddedTypeChecker;
}

export interface IReadOnlyContentContainerProps extends IBaseContentContainerProps {
  readOnly: true;
  editMode: EditMode.Disabled;
}

export interface IReadWriteContentContainerProps extends IBaseContentContainerProps {
  dataVersionAtBeginning?: number;
  getClassFocus: (className: string) => IClassFocus;
  onAddColumnClick: () => void;
  onCancelTransaction: () => void;
  onCommitTransaction: () => void;
  onRealmChanged: () => void;
  readOnly: boolean;
  realm: Realm;
}

export type IContentContainerProps =
  | IReadOnlyContentContainerProps
  | IReadWriteContentContainerProps;

export interface IContentContainerState {
  createObjectDialog: ICreateObjectDialogContainerProps;
  deleteObjectsDialog: IDeleteObjectsDialogProps;
  error?: Error;
  hiddenColumns: string[];
  hideSystemClasses: boolean;
  highlight?: IHighlight;
  query: string;
  selectObjectDialog: ISelectObjectDialog;
  sorting?: ISorting;
}

class ContentContainer extends React.Component<
  IContentContainerProps,
  IContentContainerState
> {
  // TODO: Reset sorting, highlight and filtering (and scroll) when focus change

  public state: IContentContainerState = {
    createObjectDialog: { isOpen: false },
    deleteObjectsDialog: { isOpen: false },
    hiddenColumns: [],
    hideSystemClasses: !store.shouldShowSystemClasses(),
    query: '',
    selectObjectDialog: { isOpen: false }
  };

  public latestCellValidation?: {
    columnIndex: number;
    rowIndex: number;
    valid: boolean;
  };

  private removeStoreListener: (() => void) | null = null;

  private clickTimeout?: any;

  private trySmartFilter(
    results: Realm.OrderedCollection<any>,
    rawQuery: string
  ): Realm.OrderedCollection<any> | null {
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      return results;
    }
    const explicitRqlPattern =
      /(?:==|!=|>=|<=|>|<|\b(?:AND|OR|NOT|CONTAINS|BEGINSWITH|ENDSWITH|LIKE|IN|BETWEEN|TRUEPREDICATE|FALSEPREDICATE|SORT|LIMIT)\b)/i;
    if (explicitRqlPattern.test(trimmed)) {
      return null;
    }

    const properties = this.props.focus?.properties ?? [];
    const clauses: string[] = [];
    const args: unknown[] = [trimmed];

    const isNumeric = /^-?\d+(\.\d+)?$/.test(trimmed);
    const isHex24 = /^[0-9a-fA-F]{24}$/.test(trimmed);
    const isUuid =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        trimmed
      );
    const lower = trimmed.toLowerCase();

    for (const prop of properties) {
      if (!prop.name || prop.name === '#') {
        continue;
      }
      if (prop.type === 'string') {
        clauses.push(`${prop.name} CONTAINS[c] $0`);
      } else if (
        isNumeric &&
        (prop.type === 'int' ||
          prop.type === 'float' ||
          prop.type === 'double' ||
          prop.type === 'decimal128')
      ) {
        clauses.push(`${prop.name} == ${Number(trimmed)}`);
      } else if (
        prop.type === 'bool' &&
        (lower === 'true' || lower === 'false')
      ) {
        clauses.push(`${prop.name} == ${lower}`);
      } else if (prop.type === 'objectId' && isHex24) {
        try {
          const oid = new Realm.BSON.ObjectId(trimmed);
          const idx = args.length;
          args.push(oid);
          clauses.push(`${prop.name} == $${idx}`);
        } catch {
          // ignore
        }
      } else if (prop.type === 'uuid' && isUuid) {
        try {
          const uuidVal = new Realm.BSON.UUID(trimmed);
          const idx = args.length;
          args.push(uuidVal);
          clauses.push(`${prop.name} == $${idx}`);
        } catch {
          // ignore
        }
      }
    }

    if (clauses.length === 0) {
      return null;
    }

    try {
      return results.filtered(clauses.join(' OR '), ...args);
    } catch {
      return null;
    }
  }

  private filteredSortedResults = memoize(
    (
      results: Realm.OrderedCollection<any>,
      query: string,
      sorting?: ISorting
    ) => {
      let filterError: Error | undefined;
      if (query) {
        try {
          results = results.filtered(query);
        } catch (err) {
          const smartResults = this.trySmartFilter(results, query);
          if (smartResults) {
            results = smartResults;
          } else {
            filterError =
              err instanceof Error ? err : new Error('Expected an Error');
          }
        }
      }
      if (sorting) {
        const propertyName = sorting.property.name;
        if (propertyName) {
          results = results.sorted(propertyName, sorting.reverse);
        }
      }
      return { results, filterError };
    }
  );

  private filteredProperties = memoize(
    (
      properties: IPropertyWithName[],
      hideSystemClasses: boolean,
      hiddenColumns: string[]
    ) => {
      const base = hideSystemClasses
        ? properties.filter(
            (p) => !(p.objectType && p.objectType.startsWith('__'))
          )
        : properties;
      if (hiddenColumns.length === 0) {
        return base;
      }
      const visible = base.filter(
        (p) => !p.name || !hiddenColumns.includes(p.name)
      );
      return visible.length > 0 ? visible : base.slice(0, 1);
    }
  );

  private contentElement: HTMLElement | null = null;
  // Used to save the initial vertical coordinate when the user starts dragging to select rows
  private rowDragStart: { offset: number; rowIndex: number } | undefined;

  public componentDidUpdate(
    prevProps: IContentContainerProps,
    prevState: IContentContainerState
  ) {
    if (
      this.state.query !== prevState.query ||
      this.state.sorting !== prevState.sorting
    ) {
      this.onResetHighlight();
    } else if (
      this.props.onHighlightChange &&
      this.state.highlight !== prevState.highlight
    ) {
      const { results } = this.filteredSortedResults(
        this.props.focus.results,
        this.state.query,
        this.state.sorting
      );
      this.props.onHighlightChange(this.state.highlight, results);
    }
  }

  public componentDidCatch(error: Error) {
    // Add some more explanation to some error messages
    if (error.message === 'Access to invalidated List object') {
      error.message = 'The parent object with the list got deleted';
    }
    this.setState({ error });
  }

  public UNSAFE_componentWillMount() {
    this.removeStoreListener = store.onDidChange(
      store.KEY_SHOW_SYSTEM_CLASSES,
      (showSystemClasses) =>
        this.setState({ hideSystemClasses: !showSystemClasses })
    );
  }

  public componentWillUnmount() {
    document.removeEventListener('mouseup', this.onRowMouseUp);
    if (this.removeStoreListener) {
      this.removeStoreListener();
    }
  }

  public render() {
    const props = this.getProps();
    return <Content {...props} />;
  }

  public highlightObject(object: Realm.Object | null) {
    const highlight = this.generateHighlight(object);
    this.setState({ highlight });
  }

  private contentRef = (element: HTMLElement | null) => {
    this.contentElement = element;
  };

  private getProps(): IContentProps {
    const { results, filterError } = this.filteredSortedResults(
      this.props.focus.results,
      this.state.query,
      this.state.sorting
    );
    const allVisibleProperties = this.filteredProperties(
      this.props.focus.properties,
      this.state.hideSystemClasses,
      []
    );
    const focus: Focus = {
      ...this.props.focus,
      properties: this.filteredProperties(
        this.props.focus.properties,
        this.state.hideSystemClasses,
        this.state.hiddenColumns
      )
    };
    const common = {
      allProperties: allVisibleProperties,
      contentRef: this.contentRef,
      dataVersion: this.props.dataVersion,
      error: this.state.error,
      filteredCount: results.length,
      filteredSortedResults: results,
      focus,
      hiddenColumns: this.state.hiddenColumns,
      highlight: this.state.highlight,
      onCellChange: this.onCellChange,
      onCellClick: this.onCellClick,
      onCellHighlighted: this.onCellHighlighted,
      onCellValidated: this.onCellValidated,
      onContentContextMenu: this.onContentContextMenu,
      onContextMenu: this.onContextMenu,
      onDeleteFilteredRows: this.onDeleteFilteredRows,
      onExportView: this.onExportFilteredView,
      onGenerateMockRows: this.onGenerateMockRows,
      onImportJsonFile: this.onImportJsonFile,
      onPasteJson: this.onPasteJsonFromClipboard,
      onRowMouseDown: this.onRowMouseDown,
      onNewObjectClick: this.onNewObjectClick,
      onQueryChange: this.onQueryChange,
      onQueryHelp: this.onQueryHelp,
      onResetHighlight: this.onResetHighlight,
      onShowAllColumns: this.onShowAllColumns,
      onSortingChange: this.onSortingChange,
      onToggleColumn: this.onToggleColumn,
      query: this.state.query,
      queryError: filterError,
      selectedCount: this.state.highlight ? this.state.highlight.rows.size : 0,
      sorting: this.state.sorting,
      totalCount: this.props.focus.results.length
    };
    if (this.props.readOnly) {
      return {
        ...common,
        editMode: EditMode.Disabled,
        readOnly: true,
        allowCreate: this.props.allowCreate
      };
    } else {
      const { dataVersion = 0, dataVersionAtBeginning = 0 } = this.props;
      return {
        ...common,
        changeCount: dataVersion - dataVersionAtBeginning,
        createObjectDialog: this.state.createObjectDialog,
        deleteObjectsDialog: this.state.deleteObjectsDialog,
        allowCreate: this.props.allowCreate,
        editMode: this.props.editMode,
        getClassFocus: this.props.getClassFocus,
        inTransaction: this.props.realm.isInTransaction,
        onAddColumnClick: this.props.onAddColumnClick,
        onCancelTransaction: this.props.onCancelTransaction,
        onCommitTransaction: this.props.onCommitTransaction,
        onReorderingEnd: this.onReorderingEnd,
        onReorderingStart: this.onReorderingStart,
        realm: this.props.realm,
        readOnly: false,
        selectObjectDialog: this.state.selectObjectDialog
      };
    }
  }

  private onCancelCreateObjectDialog = () => {
    this.setState({ createObjectDialog: { isOpen: false } });
  };

  private onCancelDeleteObjectsDialog = () => {
    this.setState({ deleteObjectsDialog: { isOpen: false } });
  };

  private onCancelSelectObjectDialog = () => {
    this.setState({ selectObjectDialog: { isOpen: false } });
  };

  private onQueryChange = (query: string) => {
    this.setState({ query });
  };

  private onQueryHelp = () => {
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    const props = this.props.focus?.properties ?? [];

    menu.append(
      new MenuItem({
        label: 'Insert RQL Query Template for Current Table:',
        enabled: false
      })
    );
    menu.append(new MenuItem({ type: 'separator' }));

    const stringProps = props.filter((p) => p.name && p.type === 'string');
    const numericProps = props.filter(
      (p) =>
        p.name &&
        (p.type === 'int' ||
          p.type === 'float' ||
          p.type === 'double' ||
          p.type === 'decimal128')
    );
    const boolProps = props.filter((p) => p.name && p.type === 'bool');
    const optionalProps = props.filter(
      (p) => p.name && p.name !== '#' && p.optional
    );
    const sortableProps = props.filter(
      (p) =>
        p.name &&
        p.name !== '#' &&
        (p.type === 'int' ||
          p.type === 'float' ||
          p.type === 'double' ||
          p.type === 'string' ||
          p.type === 'date')
    );

    for (const p of stringProps.slice(0, 4)) {
      const expr = `${p.name} CONTAINS[c] ""`;
      menu.append(
        new MenuItem({
          label: expr,
          click: () => this.onQueryChange(expr)
        })
      );
    }

    for (const p of numericProps.slice(0, 3)) {
      const expr = `${p.name} > 0`;
      menu.append(
        new MenuItem({
          label: expr,
          click: () => this.onQueryChange(expr)
        })
      );
    }

    for (const p of boolProps.slice(0, 2)) {
      const expr = `${p.name} == true`;
      menu.append(
        new MenuItem({
          label: expr,
          click: () => this.onQueryChange(expr)
        })
      );
    }

    for (const p of optionalProps.slice(0, 3)) {
      const expr = `${p.name} != null`;
      menu.append(
        new MenuItem({
          label: expr,
          click: () => this.onQueryChange(expr)
        })
      );
    }

    if (sortableProps.length > 0) {
      const firstSort = sortableProps[0].name;
      const expr = `TRUEPREDICATE SORT(${firstSort} DESC)`;
      menu.append(
        new MenuItem({
          label: expr,
          click: () => this.onQueryChange(expr)
        })
      );
    }

    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(
      new MenuItem({
        label: 'Open Official RQL Documentation in Browser...',
        click: () => {
          electron.shell.openExternal(
            'https://www.mongodb.com/docs/realm/realm-query-language/'
          );
        }
      })
    );
    menu.popup();
  };

  private onResetHighlight = () => {
    this.setState({ highlight: undefined });
  };

  private onSortingChange: SortingChangeHandler = (sorting) => {
    this.setState({ sorting });
  };

  private onToggleColumn = (propName: string) => {
    this.setState((prev) => {
      const exists = prev.hiddenColumns.includes(propName);
      const next = exists
        ? prev.hiddenColumns.filter((c) => c !== propName)
        : [...prev.hiddenColumns, propName];
      return { hiddenColumns: next };
    });
  };

  private onShowAllColumns = () => {
    this.setState({ hiddenColumns: [] });
  };

  private generateHighlight(
    object: Realm.Object | null,
    scrollToObject = true
  ): IHighlight {
    if (object) {
      const { results } = this.filteredSortedResults(
        this.props.focus.results,
        this.state.query,
        this.state.sorting
      );
      const index = results.indexOf(object);
      const result: IHighlight = {
        rows: new Set(index > -1 ? [index] : [])
      };
      if (scrollToObject) {
        result.scrollTo = {
          center: true,
          row: index
        };
      }
      return result;
    } else {
      return { rows: new Set() };
    }
  }

  private onCellChange: CellChangeHandler = (params) => {
    try {
      this.write(() => {
        const { parent, property, rowIndex, cellValue } = params;
        if (property.name !== null) {
          parent[rowIndex][property.name] = cellValue;
        } else {
          parent[rowIndex] = cellValue;
        }
      });
    } catch (err) {
      showError('Failed when saving the value', err);
    }
  };

  private onObjectSelect = (
    selectedObjects: Realm.Object | Realm.Object[] | null
  ) => {
    if (this.state.selectObjectDialog.isOpen) {
      const { selectObjectDialog } = this.state;
      this.write(() => {
        if (
          selectObjectDialog.action === 'list' &&
          Array.isArray(selectedObjects)
        ) {
          selectObjectDialog.list.push(...selectedObjects);
        } else if (
          selectObjectDialog.action === 'object' &&
          !Array.isArray(selectedObjects)
        ) {
          // { [p: string]: any } is needed bacause of a Realm JS type issue
          const parent: { [p: string]: any } = selectObjectDialog.object;
          parent[selectObjectDialog.propertyName] = selectedObjects;
        }
        // Close the dialog
        this.setState({ selectObjectDialog: { isOpen: false } });
      });
    }
  };

  private onCellClick: CellClickHandler = (params, e) => {
    if (this.props.onCellClick) {
      this.props.onCellClick(params, e);
    } else {
      if (!this.latestCellValidation || this.latestCellValidation.valid) {
        // Ensuring that the last cell validation didn't fail
        if (this.clickTimeout) {
          clearTimeout(this.clickTimeout);
          this.onCellDoubleClick(params, e);
          this.clickTimeout = null;
        } else {
          this.clickTimeout = setTimeout(() => {
            this.onCellSingleClick(params, e);
            this.clickTimeout = null;
          }, 200);
        }
      }
    }
  };

  private onCellSingleClick: CellClickHandler = (params, e) => {
    if (this.props.onCellSingleClick) {
      this.props.onCellSingleClick(params, e);
    } else {
      const { property, rowObject, cellValue } = params;
      if (!property) return;

      if (
        canUseJsonViewer(property, cellValue) &&
        this.props.onShowJsonViewerDialog
      ) {
        this.props.onShowJsonViewerDialog(cellValue);
      } else if (property.type === 'data' && cellValue) {
        this.inspectBinaryData(cellValue, property.name ?? 'data');
      } else if (property.type === 'list' && this.props.onListFocussed) {
        this.props.onListFocussed(rowObject, property);
      } else if (
        property.type === 'object' &&
        property.objectType &&
        (cellValue || property.isEmbedded) &&
        this.props.onClassFocussed
      ) {
        // Handle Embedded Objects
        if (property.isEmbedded) {
          if (cellValue === null && property.name && property.objectType) {
            this.onShowCreateObjectDialog(property.objectType, {
              key: property.name,
              parent: rowObject
            });
          } else if (this.props.onSingleListFocussed) {
            this.props.onSingleListFocussed(rowObject, property);
          }
        } else {
          this.props.onClassFocussed(
            property.objectType,
            cellValue,
            rowObject,
            property
          );
        }
      }
    }
  };

  private onCellDoubleClick: CellClickHandler = (params, e) => {
    if (this.props.onCellDoubleClick) {
      this.props.onCellDoubleClick(params, e);
    } else {
      const { property, rowObject } = params;
      if (
        property &&
        property.type === 'object' &&
        property.name &&
        property.objectType &&
        !property.isEmbedded
      ) {
        this.onShowSelectObjectDialog({
          action: {
            type: 'object',
            object: rowObject,
            propertyName: property.name
          },
          className: property.objectType,
          isOptional: property.optional,
          isEmbeddedType: this.props.isEmbeddedType,
          onShowJsonViewerDialog: this.props.onShowJsonViewerDialog
        });
      }
    }
  };

  private onCellHighlighted: CellHighlightedHandler = ({
    rowIndex,
    columnIndex
  }) => {
    this.setState({
      highlight: {
        rows: new Set([rowIndex]),
        scrollTo: {
          column: columnIndex,
          row: rowIndex
        }
      }
    });
  };

  private onCellValidated: CellValidatedHandler = (
    rowIndex,
    columnIndex,
    valid
  ) => {
    this.latestCellValidation = {
      columnIndex,
      rowIndex,
      valid
    };
  };

  private serializeRealmValue(
    val: unknown,
    depth = 0,
    seen = new WeakSet<object>()
  ): unknown {
    if (val === null || val === undefined) {
      return null;
    }
    if (
      typeof val === 'string' ||
      typeof val === 'number' ||
      typeof val === 'boolean'
    ) {
      return val;
    }
    if (val instanceof Date) {
      return val.toISOString();
    }
    if (val instanceof ArrayBuffer) {
      return Buffer.from(val).toString('base64');
    }
    if (
      typeof (val as { toHexString?: unknown }).toHexString === 'function' ||
      val instanceof Realm.BSON.ObjectId ||
      val instanceof Realm.BSON.UUID ||
      val instanceof Realm.BSON.Decimal128
    ) {
      return String(val);
    }
    if (typeof val === 'object') {
      if (seen.has(val as object)) {
        return '[Circular]';
      }
      if (depth > 2) {
        return String(val);
      }
      seen.add(val as object);

      if (
        Array.isArray(val) ||
        val instanceof Realm.List ||
        val instanceof Realm.Set
      ) {
        return Array.from(val as Iterable<unknown>).map((item) =>
          this.serializeRealmValue(item, depth + 1, seen)
        );
      }

      if (typeof (val as Realm.Object).objectSchema === 'function') {
        const realmObj = val as Realm.Object;
        if (!realmObj.isValid()) {
          return null;
        }
        const schema = realmObj.objectSchema();
        const record = realmObj as unknown as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(schema.properties)) {
          out[key] = this.serializeRealmValue(record[key], depth + 1, seen);
        }
        return out;
      }

      const plain: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        plain[k] = this.serializeRealmValue(v, depth + 1, seen);
      }
      return plain;
    }
    return String(val);
  }

  private buildRqlComparison(
    property: IPropertyWithName,
    cellValue: unknown,
    operator: '==' | '!='
  ): string | null {
    if (!property.name || property.name === '#') {
      return null;
    }
    if (cellValue === null || cellValue === undefined) {
      return `${property.name} ${operator} null`;
    }
    switch (property.type) {
      case 'string':
        return `${property.name} ${operator} ${JSON.stringify(String(cellValue))}`;
      case 'int':
      case 'float':
      case 'double':
      case 'decimal128':
      case 'bool':
        return `${property.name} ${operator} ${String(cellValue)}`;
      case 'objectId':
        return `${property.name} ${operator} oid(${String(cellValue)})`;
      case 'uuid':
        return `${property.name} ${operator} uuid(${String(cellValue)})`;
      default:
        return null;
    }
  }

  private onExportFilteredView = (format: 'json' | 'csv') => {
    try {
      const { results } = this.filteredSortedResults(
        this.props.focus.results,
        this.state.query,
        this.state.sorting
      );
      const className = getClassName(this.props.focus);
      const destinationPath = remote.dialog.showSaveDialogSync({
        defaultPath: `${className}.${format}`,
        message: `Export ${results.length} ${className} records as ${format.toUpperCase()}`,
        filters: [
          {
            name: format.toUpperCase(),
            extensions: [format]
          }
        ]
      });
      if (!destinationPath) {
        return;
      }
      const rows = Array.from(results).map((row) =>
        this.serializeRealmValue(row, 0)
      );
      if (format === 'json') {
        fs.writeFileSync(
          destinationPath,
          JSON.stringify(rows, null, 2),
          'utf8'
        );
      } else {
        const flatRows = rows.map((row) => {
          if (!row || typeof row !== 'object') {
            return { value: row };
          }
          const out: Record<string, string | number | boolean | null> = {};
          for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
            out[k] =
              v !== null && typeof v === 'object'
                ? JSON.stringify(v)
                : (v as string | number | boolean | null);
          }
          return out;
        });
        const csvContent = Papa.unparse(flatRows);
        fs.writeFileSync(destinationPath, csvContent, 'utf8');
      }
    } catch (err) {
      showError(`Failed to export view as ${format.toUpperCase()}`, err);
    }
  };

  private onContextMenu: CellContextMenuHandler = (
    e: React.MouseEvent<any>,
    params
  ) => {
    e.preventDefault();
    const { allowCreate, focus, readOnly } = this.props;
    const { Menu, MenuItem } = remote;

    const contextMenu = new Menu();

    if (params) {
      const { cellValue, property, rowObject } = params;

      if (property) {
        const filterEq = this.buildRqlComparison(property, cellValue, '==');
        const filterNeq = this.buildRqlComparison(property, cellValue, '!=');
        if (filterEq) {
          contextMenu.append(
            new MenuItem({
              label: `Filter: ${filterEq}`,
              click: () => {
                this.onQueryChange(filterEq);
              }
            })
          );
        }
        if (filterNeq) {
          contextMenu.append(
            new MenuItem({
              label: `Exclude: ${filterNeq}`,
              click: () => {
                this.onQueryChange(filterNeq);
              }
            })
          );
        }
        if (filterEq || filterNeq) {
          contextMenu.append(new MenuItem({ type: 'separator' }));
        }
      }

      contextMenu.append(
        new MenuItem({
          label: 'Copy cell value',
          click: () => {
            const serialized =
              cellValue === null || cellValue === undefined
                ? 'null'
                : typeof cellValue === 'object'
                  ? JSON.stringify(this.serializeRealmValue(cellValue))
                  : String(cellValue);
            void navigator.clipboard.writeText(serialized);
          }
        })
      );

      const highlightedRows = this.state.highlight?.rows;
      if (highlightedRows && highlightedRows.size > 1) {
        const { results } = this.filteredSortedResults(
          this.props.focus.results,
          this.state.query,
          this.state.sorting
        );
        contextMenu.append(
          new MenuItem({
            label: `Copy ${highlightedRows.size} selected rows as JSON`,
            click: () => {
              const selected = Array.from(highlightedRows)
                .sort((a, b) => a - b)
                .map((idx) => this.serializeRealmValue(results[idx]));
              void navigator.clipboard.writeText(
                JSON.stringify(selected, null, 2)
              );
            }
          })
        );
        if (highlightedRows.size === 2) {
          contextMenu.append(
            new MenuItem({
              label: 'Compare 2 selected rows (Diff)...',
              click: () => {
                const [idxA, idxB] = Array.from(highlightedRows).sort(
                  (a, b) => a - b
                );
                this.compareTwoRows(results[idxA], results[idxB], idxA, idxB);
              }
            })
          );
        }
      } else if (rowObject) {
        contextMenu.append(
          new MenuItem({
            label: 'Copy row as JSON',
            click: () => {
              const serialized = this.serializeRealmValue(rowObject);
              void navigator.clipboard.writeText(
                JSON.stringify(serialized, null, 2)
              );
            }
          })
        );
      }

      if (rowObject && this.props.onShowJsonViewerDialog) {
        const canEditRowJson =
          !readOnly &&
          focus &&
          focus.kind === 'class' &&
          !focus.isEmbedded &&
          typeof (rowObject as Realm.Object).objectSchema === 'function';
        contextMenu.append(
          new MenuItem({
            label: canEditRowJson
              ? 'Inspect / Edit row as JSON...'
              : 'Inspect row in JSON Viewer',
            click: () => {
              this.props.onShowJsonViewerDialog(
                this.serializeRealmValue(rowObject),
                canEditRowJson
                  ? (updatedJson: string) =>
                      this.updateRowFromJson(
                        rowObject as Realm.Object,
                        updatedJson
                      )
                  : undefined
              );
            }
          })
        );
      }

      if (property && property.type === 'data') {
        if (cellValue) {
          contextMenu.append(
            new MenuItem({
              label: 'Inspect binary data (Hex / UTF-8 / Base64)...',
              click: () => {
                this.inspectBinaryData(cellValue, property.name ?? 'data');
              }
            })
          );
          contextMenu.append(
            new MenuItem({
              label: 'Save binary data to file...',
              click: () => {
                this.saveBinaryDataToFile(cellValue, property.name ?? 'data');
              }
            })
          );
        }
        if (!readOnly && property.name && rowObject) {
          contextMenu.append(
            new MenuItem({
              label: 'Load binary data from file into cell...',
              click: () => {
                this.loadBinaryDataFromFile(
                  rowObject as Realm.Object,
                  property.name!
                );
              }
            })
          );
        }
        contextMenu.append(new MenuItem({ type: 'separator' }));
      }

      if (property && property.name && property.name !== '#') {
        const colStatsMenu = this.buildColumnStatsSubmenu(property);
        contextMenu.append(
          new MenuItem({
            label: `Column "${property.name}" stats & actions`,
            submenu: colStatsMenu
          })
        );
      }

      if (
        rowObject &&
        typeof (rowObject as Realm.Object).objectSchema === 'function' &&
        'realm' in this.props
      ) {
        const clickX = e.clientX;
        const clickY = e.clientY;
        contextMenu.append(
          new MenuItem({
            label: 'Find references to this object (Backlinks)...',
            click: () => {
              this.findReferencesToObject(
                rowObject as Realm.Object,
                clickX,
                clickY
              );
            }
          })
        );
      }

      if (
        !readOnly &&
        allowCreate &&
        focus &&
        focus.kind === 'class' &&
        !focus.isEmbedded &&
        rowObject
      ) {
        contextMenu.append(
          new MenuItem({
            label: 'Duplicate row',
            click: () => {
              this.duplicateRow(rowObject);
            }
          })
        );
      }

      if (
        !readOnly &&
        property &&
        property.name &&
        property.name !== '#' &&
        !property.isPrimaryKey &&
        !property.readOnly &&
        highlightedRows &&
        highlightedRows.size >= 1 &&
        (property.type === 'string' ||
          property.type === 'int' ||
          property.type === 'float' ||
          property.type === 'double' ||
          property.type === 'decimal128' ||
          property.type === 'bool')
      ) {
        const bulkSubmenu = new Menu();
        if (property.type === 'bool') {
          bulkSubmenu.append(
            new MenuItem({
              label: `Set "${property.name}" = true`,
              click: () => this.bulkSetProperty(property, true)
            })
          );
          bulkSubmenu.append(
            new MenuItem({
              label: `Set "${property.name}" = false`,
              click: () => this.bulkSetProperty(property, false)
            })
          );
        }
        if (
          highlightedRows.size > 1 &&
          cellValue !== undefined &&
          cellValue !== null
        ) {
          bulkSubmenu.append(
            new MenuItem({
              label: `Set all to "${String(cellValue)}" (match clicked cell)`,
              click: () => this.bulkSetProperty(property, cellValue)
            })
          );
        }
        bulkSubmenu.append(
          new MenuItem({
            label: `Set "${property.name}" from Clipboard value`,
            click: () => {
              void this.bulkSetPropertyFromClipboard(property);
            }
          })
        );
        if (property.optional) {
          bulkSubmenu.append(
            new MenuItem({
              label: `Set "${property.name}" = null`,
              click: () => this.bulkSetProperty(property, null)
            })
          );
        }
        contextMenu.append(
          new MenuItem({
            label: `Bulk update "${property.name}" (${highlightedRows.size} row${highlightedRows.size > 1 ? 's' : ''})`,
            submenu: bulkSubmenu
          })
        );
      }

      contextMenu.append(new MenuItem({ type: 'separator' }));

      // If we clicked a property that refers to an object
      if (
        !readOnly &&
        property &&
        property.type === 'object' &&
        property.isEmbedded !== true
      ) {
        contextMenu.append(
          new MenuItem({
            label: 'Update reference',
            click: () => {
              if (property.objectType && property.name) {
                this.onShowSelectObjectDialog({
                  action: {
                    type: 'object',
                    object: rowObject,
                    propertyName: property.name
                  },
                  className: property.objectType,
                  isOptional: property.optional,
                  isEmbeddedType: this.props.isEmbeddedType,
                  onShowJsonViewerDialog: this.props.onShowJsonViewerDialog
                });
              }
            }
          })
        );
      }

      // If we have one or more rows highlighted - we can delete those
      if (
        !readOnly &&
        focus &&
        this.state.highlight &&
        this.state.highlight.rows.size > 0
      ) {
        const { label, title, description } = this.generateDeleteTexts(
          focus,
          this.state.highlight.rows.size > 1
        );

        contextMenu.append(
          new MenuItem({
            label,
            click: () => {
              if (this.state.highlight) {
                // Clear the highlight before deleting the objects
                this.onShowDeleteObjectDialog(
                  title,
                  description,
                  label,
                  this.state.highlight.rows
                );
              }
            }
          })
        );
      }
    }

    // If we right-clicking on the content we can add an existing object when we are focusing an object list
    if (
      !readOnly &&
      focus &&
      focus.kind === 'list' &&
      focus.property.objectType &&
      !isPrimitive(focus.property.objectType) &&
      !focus.property.isEmbedded
    ) {
      const className = getClassName(focus);
      contextMenu.append(
        new MenuItem({
          label: `Add existing ${className}`,
          click: () => {
            if (focus.property.objectType) {
              this.onShowSelectObjectDialog({
                action: {
                  type: 'list',
                  list: focus.results
                },
                className: focus.property.objectType,
                isEmbeddedType: this.props.isEmbeddedType,
                onShowJsonViewerDialog: this.props.onShowJsonViewerDialog
              });
            }
          }
        })
      );
    }

    // If we right-clicking on the content we can always create a new object
    if (allowCreate && !readOnly && focus) {
      const className = getClassName(focus);
      contextMenu.append(
        new MenuItem({
          label: `Create new ${className}`,
          click: () => {
            this.onShowCreateObjectDialog(className);
          }
        })
      );
      if (focus.kind === 'class' && !focus.isEmbedded) {
        contextMenu.append(
          new MenuItem({
            label: `Paste JSON row(s) from Clipboard`,
            click: () => {
              this.onPasteJsonFromClipboard();
            }
          })
        );
      }
    }

    // If we have items to show - popup the menu
    if (contextMenu.items.length > 0) {
      contextMenu.popup({
        x: e.clientX,
        y: e.clientY
      });
    }
  };

  private onContentContextMenu: React.MouseEventHandler<HTMLElement> = (e) => {
    const target = e.target as HTMLElement | null;
    const headerEl = target?.closest('[data-column-name]') as HTMLElement | null;
    if (!headerEl) {
      return;
    }
    const colName = headerEl.getAttribute('data-column-name');
    if (!colName) {
      return;
    }
    const property = this.props.focus.properties.find(
      (p) => p.name === colName
    );
    if (!property) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const colStatsMenu = this.buildColumnStatsSubmenu(property);
    colStatsMenu.popup({ x: e.clientX, y: e.clientY });
  };

  private buildColumnStatsSubmenu(property: IPropertyWithName) {
    const { Menu, MenuItem } = remote;
    const submenu = new Menu();
    const propName = property.name;
    if (!propName) {
      return submenu;
    }

    const { results } = this.filteredSortedResults(
      this.props.focus.results,
      this.state.query,
      this.state.sorting
    );

    submenu.append(
      new MenuItem({
        label: `${propName} (${property.objectType || property.type}) — ${results.length.toLocaleString()} rows`,
        enabled: false
      })
    );
    submenu.append(new MenuItem({ type: 'separator' }));

    const isNumeric =
      property.type === 'int' ||
      property.type === 'float' ||
      property.type === 'double' ||
      property.type === 'decimal128';

    if (
      isNumeric &&
      results.length > 0 &&
      typeof results.min === 'function'
    ) {
      try {
        const minVal = results.min(propName);
        const maxVal = results.max(propName);
        const sumVal = results.sum(propName);
        const avgVal = results.avg(propName);
        for (const [statName, val] of [
          ['Min', minVal],
          ['Max', maxVal],
          ['Sum', sumVal],
          ['Average', avgVal]
        ] as const) {
          if (val !== undefined && val !== null) {
            const formatted =
              typeof val === 'number' && !Number.isInteger(val)
                ? val.toFixed(2)
                : String(val);
            submenu.append(
              new MenuItem({
                label: `${statName}: ${formatted}  (click to copy)`,
                click: () => {
                  void navigator.clipboard.writeText(String(val));
                }
              })
            );
          }
        }
        submenu.append(new MenuItem({ type: 'separator' }));
      } catch {
        // ignore
      }
    }

    // Distinct value frequency (sample up to 500 rows for instant speed)
    const sampleSize = Math.min(results.length, 500);
    if (
      sampleSize > 0 &&
      (property.type === 'string' ||
        property.type === 'int' ||
        property.type === 'bool' ||
        property.type === 'objectId' ||
        property.type === 'uuid')
    ) {
      const counts = new Map<string, { raw: unknown; count: number }>();
      let nullCount = 0;
      for (let i = 0; i < sampleSize; i++) {
        const row = results[i] as Record<string, unknown> | undefined;
        const val = row ? row[propName] : undefined;
        if (val === null || val === undefined) {
          nullCount++;
        } else {
          const key = String(val);
          const existing = counts.get(key);
          if (existing) {
            existing.count++;
          } else {
            counts.set(key, { raw: val, count: 1 });
          }
        }
      }

      if (nullCount > 0 && property.optional) {
        submenu.append(
          new MenuItem({
            label: `Null values: ${nullCount}  (click to filter null)`,
            click: () => this.onQueryChange(`${propName} == null`)
          })
        );
      }

      const topDistinct = Array.from(counts.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 6);

      if (topDistinct.length > 0) {
        const distinctMenu = new Menu();
        for (const [label, info] of topDistinct) {
          const expr = this.buildRqlComparison(property, info.raw, '==');
          distinctMenu.append(
            new MenuItem({
              label: `${label.length > 32 ? `${label.slice(0, 32)}…` : label}  (${info.count})`,
              click: () => {
                if (expr) {
                  this.onQueryChange(expr);
                }
              }
            })
          );
        }
        submenu.append(
          new MenuItem({
            label: `Top distinct values (${counts.size} unique)`,
            submenu: distinctMenu
          })
        );
        submenu.append(new MenuItem({ type: 'separator' }));
      }
    }

    submenu.append(
      new MenuItem({
        label: `Copy all "${propName}" column values`,
        click: () => {
          const values: string[] = [];
          const limit = Math.min(results.length, 5000);
          for (let i = 0; i < limit; i++) {
            const row = results[i] as Record<string, unknown> | undefined;
            const v = row ? row[propName] : null;
            values.push(v === null || v === undefined ? '' : String(v));
          }
          void navigator.clipboard.writeText(values.join('\n'));
        }
      })
    );

    submenu.append(
      new MenuItem({
        label: `Hide column "${propName}"`,
        click: () => this.onToggleColumn(propName)
      })
    );

    return submenu;
  }

  private updateRowFromJson = (
    targetObject: Realm.Object,
    updatedJson: string
  ) => {
    if (this.props.readOnly || !targetObject.isValid()) {
      return;
    }
    try {
      const parsed = JSON.parse(updatedJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON must be a single object.');
      }
      const schema = targetObject.objectSchema();
      const coerced = this.coerceJsonRecordForSchema(
        parsed as Record<string, unknown>,
        schema
      );
      const record = targetObject as unknown as Record<string, unknown>;
      this.write(() => {
        for (const propName of Object.keys(schema.properties)) {
          if (propName === schema.primaryKey || !(propName in coerced)) {
            continue;
          }
          record[propName] = coerced[propName];
        }
      });
    } catch (err) {
      showError('Failed to save JSON changes to row', err);
    }
  };

  private onGenerateMockRows = (count: number) => {
    if (
      this.props.readOnly ||
      !('realm' in this.props) ||
      this.props.focus.kind !== 'class'
    ) {
      return;
    }
    const realm = this.props.realm;
    const className = this.props.focus.className;
    const schema = realm.schema.find((s) => s.name === className);
    if (!schema) {
      return;
    }
    try {
      let nextIntPk = 1;
      if (schema.primaryKey) {
        const pkProp = schema.properties[
          schema.primaryKey
        ] as Realm.ObjectSchemaProperty;
        if (pkProp && typeof pkProp === 'object' && pkProp.type === 'int') {
          const maxVal = this.props.focus.results.max(schema.primaryKey);
          nextIntPk = (typeof maxVal === 'number' ? maxVal : 0) + 1;
        }
      }

      const buildMockObject = (
        targetSchema: Realm.ObjectSchema,
        idx: number
      ): Record<string, unknown> => {
        const obj: Record<string, unknown> = {};
        for (const propName of Object.keys(targetSchema.properties)) {
          const prop = targetSchema.properties[
            propName
          ] as Realm.ObjectSchemaProperty;
          if (!prop || typeof prop !== 'object') {
            continue;
          }
          const isPk = targetSchema.primaryKey === propName;
          const lowerName = propName.toLowerCase();

          if (prop.type === 'list' || prop.type === 'set') {
            obj[propName] = [];
            continue;
          }
          if (prop.type === 'dictionary') {
            obj[propName] = {};
            continue;
          }
          if (prop.type === 'object') {
            if (prop.objectType && this.props.isEmbeddedType(prop.objectType)) {
              const embSchema = realm.schema.find(
                (s) => s.name === prop.objectType
              );
              obj[propName] = embSchema
                ? buildMockObject(embSchema, idx)
                : null;
            } else {
              obj[propName] = null;
            }
            continue;
          }

          switch (prop.type) {
            case 'objectId':
              obj[propName] = new Realm.BSON.ObjectId();
              break;
            case 'uuid':
              obj[propName] = new Realm.BSON.UUID();
              break;
            case 'int':
              obj[propName] = isPk
                ? nextIntPk++
                : Math.floor(Math.random() * 1000) + 1;
              break;
            case 'float':
            case 'double':
              obj[propName] = Number((Math.random() * 500 + 10).toFixed(2));
              break;
            case 'decimal128':
              obj[propName] = Realm.BSON.Decimal128.fromString(
                (Math.random() * 500 + 10).toFixed(2)
              );
              break;
            case 'bool':
              obj[propName] = idx % 2 === 0;
              break;
            case 'date':
              obj[propName] = new Date(
                Date.now() - Math.floor(Math.random() * 30 * 86400000)
              );
              break;
            case 'data':
              obj[propName] = new Uint8Array([1, 2, 3, 4]).buffer;
              break;
            case 'string':
            default: {
              const suffix = `${Date.now().toString(36).slice(-4)}-${idx + 1}`;
              if (isPk) {
                obj[propName] = `${className.toLowerCase()}-${suffix}`;
              } else if (lowerName.includes('email')) {
                obj[propName] = `user.${suffix}@example.com`;
              } else if (lowerName.includes('name')) {
                obj[propName] = `Sample ${className} #${idx + 1}`;
              } else if (lowerName.includes('status')) {
                obj[propName] = idx % 2 === 0 ? 'active' : 'pending';
              } else if (lowerName.includes('url') || lowerName.includes('link')) {
                obj[propName] = `https://example.com/${suffix}`;
              } else {
                obj[propName] = `${propName}_${idx + 1}`;
              }
              break;
            }
          }
        }
        return obj;
      };

      let lastCreated: Realm.Object | null = null;
      this.write(() => {
        for (let i = 0; i < count; i++) {
          const mockData = buildMockObject(schema, i);
          lastCreated = realm.create(className, mockData);
        }
      });
      if (lastCreated) {
        this.highlightObject(lastCreated);
      }
    } catch (err) {
      showError(`Failed to generate mock ${className} rows`, err);
    }
  };

  private onDeleteFilteredRows = () => {
    const { focus, readOnly } = this.props;
    if (readOnly || !focus) {
      return;
    }
    const { results } = this.filteredSortedResults(
      focus.results,
      this.state.query,
      this.state.sorting
    );
    if (results.length === 0) {
      return;
    }
    const allRowIndices = new Set<number>(
      Array.from({ length: results.length }, (_, i) => i)
    );
    const { label, title, description } = this.generateDeleteTexts(
      focus,
      results.length > 1
    );
    this.onShowDeleteObjectDialog(title, description, label, allRowIndices);
  };

  private inspectBinaryData(rawValue: unknown, propName: string) {
    try {
      const buf =
        rawValue instanceof ArrayBuffer
          ? Buffer.from(rawValue)
          : ArrayBuffer.isView(rawValue)
            ? Buffer.from(
                rawValue.buffer,
                rawValue.byteOffset,
                rawValue.byteLength
              )
            : Buffer.from(String(rawValue));

      const hexPreview = buf
        .subarray(0, 256)
        .toString('hex')
        .replace(/(..)/g, '$1 ')
        .trim();
      const utf8Preview = buf.subarray(0, 512).toString('utf8');

      this.props.onShowJsonViewerDialog({
        _property: propName,
        _type: 'Binary Data (ArrayBuffer)',
        byteLength: buf.length,
        hexDumpPreview:
          buf.length > 256 ? `${hexPreview} ... (+${buf.length - 256} bytes)` : hexPreview,
        utf8Preview,
        base64: buf.toString('base64')
      });
    } catch (err) {
      showError('Failed to inspect binary data', err);
    }
  }

  private saveBinaryDataToFile(rawValue: unknown, propName: string) {
    try {
      const dest = remote.dialog.showSaveDialogSync({
        defaultPath: `${propName}.bin`,
        message: 'Save binary cell data to file'
      });
      if (!dest) {
        return;
      }
      const buf =
        rawValue instanceof ArrayBuffer
          ? Buffer.from(rawValue)
          : ArrayBuffer.isView(rawValue)
            ? Buffer.from(
                rawValue.buffer,
                rawValue.byteOffset,
                rawValue.byteLength
              )
            : Buffer.from(String(rawValue));
      fs.writeFileSync(dest, buf);
    } catch (err) {
      showError('Failed saving binary data to file', err);
    }
  }

  private loadBinaryDataFromFile(targetObject: Realm.Object, propName: string) {
    if (this.props.readOnly || !targetObject.isValid()) {
      return;
    }
    try {
      const paths = remote.dialog.showOpenDialogSync({
        message: `Select a file to store into "${propName}"`,
        properties: ['openFile']
      });
      if (!paths || paths.length === 0) {
        return;
      }
      const fileBuf = fs.readFileSync(paths[0]);
      const arrayBuf = fileBuf.buffer.slice(
        fileBuf.byteOffset,
        fileBuf.byteOffset + fileBuf.byteLength
      );
      this.write(() => {
        (targetObject as unknown as Record<string, unknown>)[propName] =
          arrayBuf;
      });
    } catch (err) {
      showError('Failed loading binary data from file', err);
    }
  }

  private compareTwoRows(
    rawA: unknown,
    rawB: unknown,
    idxA: number,
    idxB: number
  ) {
    const objA = (this.serializeRealmValue(rawA) ?? {}) as Record<
      string,
      unknown
    >;
    const objB = (this.serializeRealmValue(rawB) ?? {}) as Record<
      string,
      unknown
    >;
    const allKeys = Array.from(
      new Set([...Object.keys(objA), ...Object.keys(objB)])
    );
    const differences: Record<string, { rowA: unknown; rowB: unknown }> = {};
    const identical: Record<string, unknown> = {};

    for (const key of allKeys) {
      const valA = objA[key];
      const valB = objB[key];
      if (JSON.stringify(valA) !== JSON.stringify(valB)) {
        differences[key] = { rowA: valA, rowB: valB };
      } else {
        identical[key] = valA;
      }
    }

    const labelA =
      rawA && typeof (rawA as Realm.Object).objectSchema === 'function'
        ? displayObject(rawA as Realm.Object)
        : `Row #${idxA}`;
    const labelB =
      rawB && typeof (rawB as Realm.Object).objectSchema === 'function'
        ? displayObject(rawB as Realm.Object)
        : `Row #${idxB}`;

    this.props.onShowJsonViewerDialog({
      _summary: {
        rowA: labelA,
        rowB: labelB,
        differentFieldsCount: Object.keys(differences).length,
        identicalFieldsCount: Object.keys(identical).length
      },
      differences,
      identical
    });
  }

  private findReferencesToObject(
    targetObject: Realm.Object,
    x: number,
    y: number
  ) {
    if (!('realm' in this.props) || !targetObject.isValid()) {
      return;
    }
    const realm = this.props.realm;
    const targetSchema = targetObject.objectSchema();
    const targetClassName = targetSchema.name;
    const { Menu, MenuItem } = remote;
    const refMenu = new Menu();

    const matches: Array<{
      className: string;
      propName: string;
      referrer: Realm.Object;
      label: string;
    }> = [];

    for (const schema of realm.schema) {
      if (schema.embedded || schema.asymmetric || schema.name.startsWith('__')) {
        continue;
      }
      for (const propName of Object.keys(schema.properties)) {
        const prop = schema.properties[propName] as Realm.ObjectSchemaProperty;
        if (
          !prop ||
          typeof prop !== 'object' ||
          prop.objectType !== targetClassName
        ) {
          continue;
        }
        try {
          const queryExpr =
            prop.type === 'list' || prop.type === 'set'
              ? `ANY ${propName} == $0`
              : `${propName} == $0`;
          const found = realm
            .objects(schema.name)
            .filtered(queryExpr, targetObject);
          const limit = Math.min(found.length, 20);
          for (let i = 0; i < limit; i++) {
            const referrer = found[i];
            matches.push({
              className: schema.name,
              propName,
              referrer,
              label: `${displayObject(referrer)}  (via .${propName})`
            });
          }
        } catch {
          // ignore
        }
      }
    }

    if (matches.length === 0) {
      refMenu.append(
        new MenuItem({
          label: `No references found to ${displayObject(targetObject)}`,
          enabled: false
        })
      );
    } else {
      refMenu.append(
        new MenuItem({
          label: `Referenced by ${matches.length} object(s) — click to jump:`,
          enabled: false
        })
      );
      refMenu.append(new MenuItem({ type: 'separator' }));
      for (const item of matches) {
        refMenu.append(
          new MenuItem({
            label: item.label,
            click: () => {
              if (this.props.onClassFocussed) {
                this.props.onClassFocussed(item.className, item.referrer);
              }
            }
          })
        );
      }
    }

    refMenu.popup({ x, y });
  }

  private bulkSetProperty = (
    property: IPropertyWithName,
    rawValue: unknown
  ) => {
    const highlightedRows = this.state.highlight?.rows;
    if (
      this.props.readOnly ||
      !property.name ||
      !highlightedRows ||
      highlightedRows.size === 0
    ) {
      return;
    }
    const propName = property.name;
    try {
      const { results } = this.filteredSortedResults(
        this.props.focus.results,
        this.state.query,
        this.state.sorting
      );
      let coerced: unknown = rawValue;
      if (rawValue !== null && rawValue !== undefined) {
        if (
          property.type === 'int' ||
          property.type === 'float' ||
          property.type === 'double'
        ) {
          const num = Number(rawValue);
          if (Number.isNaN(num)) {
            throw new Error(`Invalid numeric value "${String(rawValue)}"`);
          }
          coerced = property.type === 'int' ? Math.trunc(num) : num;
        } else if (property.type === 'decimal128') {
          coerced = Realm.BSON.Decimal128.fromString(String(rawValue));
        } else if (property.type === 'bool') {
          if (typeof rawValue === 'boolean') {
            coerced = rawValue;
          } else {
            const lower = String(rawValue).trim().toLowerCase();
            coerced = lower === 'true' || lower === '1';
          }
        } else if (property.type === 'string') {
          coerced = String(rawValue);
        }
      }

      this.write(() => {
        for (const rowIndex of highlightedRows) {
          const obj = results[rowIndex];
          if (obj && typeof obj === 'object') {
            (obj as Record<string, unknown>)[propName] = coerced;
          }
        }
      });
    } catch (err) {
      showError(`Failed to bulk update "${propName}"`, err);
    }
  };

  private bulkSetPropertyFromClipboard = async (
    property: IPropertyWithName
  ) => {
    const text = await navigator.clipboard.readText();
    this.bulkSetProperty(property, text);
  };

  private coerceJsonRecordForSchema(
    rawRecord: Record<string, unknown>,
    schema: Realm.ObjectSchema
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const propName of Object.keys(schema.properties)) {
      if (!(propName in rawRecord)) {
        continue;
      }
      const val = rawRecord[propName];
      const prop = schema.properties[propName] as Realm.ObjectSchemaProperty;
      if (val === null || val === undefined || !prop || typeof prop !== 'object') {
        out[propName] = val;
        continue;
      }
      if (prop.type === 'objectId' && typeof val === 'string') {
        out[propName] = new Realm.BSON.ObjectId(val);
      } else if (prop.type === 'uuid' && typeof val === 'string') {
        out[propName] = new Realm.BSON.UUID(val);
      } else if (
        prop.type === 'decimal128' &&
        (typeof val === 'string' || typeof val === 'number')
      ) {
        out[propName] = Realm.BSON.Decimal128.fromString(String(val));
      } else if (
        prop.type === 'date' &&
        (typeof val === 'string' || typeof val === 'number')
      ) {
        out[propName] = new Date(val);
      } else if (
        (prop.type === 'int' ||
          prop.type === 'float' ||
          prop.type === 'double') &&
        typeof val === 'string'
      ) {
        out[propName] = Number(val);
      } else {
        out[propName] = val;
      }
    }
    return out;
  }

  private importJsonIntoCurrentClass = (rawJson: string) => {
    if (
      this.props.readOnly ||
      !('realm' in this.props) ||
      this.props.focus.kind !== 'class'
    ) {
      return;
    }
    const realm = this.props.realm;
    const className = this.props.focus.className;
    const schema = realm.schema.find((s) => s.name === className);
    if (!schema) {
      return;
    }
    try {
      const parsed = JSON.parse(rawJson);
      const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const validObjects = items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object' && !Array.isArray(item))
      );
      if (validObjects.length === 0) {
        throw new Error('JSON must be an object or an array of objects.');
      }
      let lastCreated: Realm.Object | null = null;
      this.write(() => {
        for (const item of validObjects) {
          const coerced = this.coerceJsonRecordForSchema(item, schema);
          lastCreated = schema.primaryKey
            ? realm.create(className, coerced, Realm.UpdateMode.Modified)
            : realm.create(className, coerced);
        }
      });
      if (lastCreated) {
        this.highlightObject(lastCreated);
      }
    } catch (err) {
      showError(`Failed to import JSON into ${className}`, err);
    }
  };

  private onPasteJsonFromClipboard = () => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text && text.trim()) {
          this.importJsonIntoCurrentClass(text);
        }
      })
      .catch((err) => {
        showError('Failed reading JSON from Clipboard', err);
      });
  };

  private onImportJsonFile = () => {
    try {
      const paths = remote.dialog.showOpenDialogSync({
        message: 'Select a JSON file to import into the current class',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (paths && paths.length > 0) {
        const content = fs.readFileSync(paths[0], 'utf8');
        this.importJsonIntoCurrentClass(content);
      }
    } catch (err) {
      showError('Failed to import JSON file', err);
    }
  };

  private cloneValueForDuplicate(val: unknown): unknown {
    if (val === null || val === undefined) {
      return val;
    }
    if (
      val instanceof Realm.List ||
      val instanceof Realm.Set ||
      Array.isArray(val)
    ) {
      return Array.from(val as Iterable<unknown>).map((item) =>
        this.cloneValueForDuplicate(item)
      );
    }
    if (typeof val === 'object' && typeof (val as Realm.Object).objectSchema === 'function') {
      const realmObj = val as Realm.Object;
      if (!realmObj.isValid()) {
        return null;
      }
      const schema = realmObj.objectSchema();
      if (schema.embedded) {
        const record = realmObj as unknown as Record<string, unknown>;
        const cloned: Record<string, unknown> = {};
        for (const key of Object.keys(schema.properties)) {
          cloned[key] = this.cloneValueForDuplicate(record[key]);
        }
        return cloned;
      }
      return realmObj;
    }
    return val;
  }

  private duplicateRow = (rowObject: Realm.Object) => {
    if (this.props.readOnly || !rowObject || !rowObject.isValid()) {
      return;
    }
    try {
      const schema = rowObject.objectSchema();
      const record = rowObject as unknown as Record<string, unknown>;
      const cloneData: Record<string, unknown> = {};

      for (const propName of Object.keys(schema.properties)) {
        cloneData[propName] = this.cloneValueForDuplicate(record[propName]);
      }

      if (schema.primaryKey) {
        const pkName = schema.primaryKey;
        const pkProp = schema.properties[pkName] as Realm.ObjectSchemaProperty;
        if (pkProp && typeof pkProp === 'object') {
          if (pkProp.type === 'objectId') {
            cloneData[pkName] = new Realm.BSON.ObjectId();
          } else if (pkProp.type === 'uuid') {
            cloneData[pkName] = new Realm.BSON.UUID();
          } else if (pkProp.type === 'int') {
            const maxVal = this.props.focus.results.max(pkName);
            cloneData[pkName] = (typeof maxVal === 'number' ? maxVal : 0) + 1;
          } else if (pkProp.type === 'string') {
            cloneData[pkName] = `${String(cloneData[pkName] ?? 'item')}-copy-${Date.now().toString(36).slice(-4)}`;
          }
        }
      }

      if ('realm' in this.props) {
        const realmInstance = this.props.realm;
        this.write(() => {
          const created = realmInstance.create(schema.name, cloneData);
          this.highlightObject(created);
        });
      }
    } catch (err) {
      showError('Failed to duplicate row', err);
    }
  };

  private onShowCreateObjectDialog = (
    className: string,
    embeddedInfo?: EmbeddedInfo
  ) => {
    if (!this.props.readOnly) {
      const { realm, getClassFocus, isEmbeddedType } = this.props;
      const schema =
        className && isPrimitive(className)
          ? {
              name: className,
              properties: {
                [className]: {
                  type: className
                }
              }
            }
          : realm.schema.find((s) => s.name === className);
      if (schema) {
        this.setState({
          createObjectDialog: {
            getClassFocus,
            isOpen: true,
            onCancel: this.onCancelCreateObjectDialog,
            onCreate: this.onCreateObject,
            schema,
            isEmbeddedType,
            embeddedInfo,
            onShowJsonViewerDialog: this.props.onShowJsonViewerDialog
          }
        });
      }
    }
  };

  private onShowDeleteObjectDialog = (
    title: string,
    description: string,
    actionLabel: string,
    rows: Set<number>
  ) => {
    this.setState({
      deleteObjectsDialog: {
        actionLabel,
        title,
        description,
        isOpen: true,
        onCancel: this.onCancelDeleteObjectsDialog,
        onDelete: () => {
          this.deleteObjects(rows);
          this.setState({
            // Deleting objects will mess up the highlight
            highlight: undefined,
            deleteObjectsDialog: { isOpen: false }
          });
        }
      }
    });
  };

  private onCreateObject: CreateObjectHandler = (
    className: string,
    values: Record<string, unknown>,
    embeddedInfo?: EmbeddedInfo
  ) => {
    if (!this.props.readOnly) {
      const { focus, realm } = this.props;
      let rowIndex = -1;

      this.write(() => {
        // Writing makes no sense if the realm was not loaded
        if (realm) {
          if (embeddedInfo) {
            const { parent, key } = embeddedInfo;

            if (focus && focus.kind === 'list') {
              // Using this method as instanceof Realm.List is not currently valid
              if (typeof parent[key].push === 'function') {
                parent[key].push(values);
              }
            } else {
              parent[key] = values;
            }
          } else if (isPrimitive(className)) {
            // Adding a primitive value into a list
            if (focus && focus.kind === 'list') {
              const valueToPush = (values as any)[className];
              focus.results.push(valueToPush);
              rowIndex = focus.results.indexOf(valueToPush);
            }
          } else {
            // Adding a new object into a class
            const object = realm.create(className, values);
            if (focus) {
              // New object has been created from a list, so we add it too into the list
              if (focus.kind === 'list') {
                focus.results.push(object);
              }
              if (getClassName(focus) === className) {
                rowIndex = focus.results.indexOf(object);
              }
            }
          }

          this.setState({
            createObjectDialog: { isOpen: false },
            highlight: {
              rows: new Set(rowIndex >= 0 ? [rowIndex] : []),
              scrollTo: {
                row: rowIndex
              }
            }
          });
        } else {
          throw new Error('onCreateObject called before realm was loaded');
        }
      });
    }
  };

  private onRowMouseDown: RowMouseDownHandler = (e, rowIndex) => {
    // Prevent the content grid from being clicked
    e.stopPropagation();
    const { highlightMode, focus } = this.props;
    const { highlight } = this.state;
    if (this.contentElement && highlightMode === HighlightMode.Multiple) {
      // Create a mutation friendly version of the set of row indices currently highlighted
      const rows = highlight ? new Set(highlight.rows) : new Set<number>();
      // This is a left click with the meta-key (command on Mac) pressed
      if (e.button === 0 && e.metaKey) {
        // The user wants to add or remove a row to the current selection
        if (rows.has(rowIndex)) {
          rows.delete(rowIndex);
        } else {
          rows.add(rowIndex);
        }
        this.setState({
          highlight: { rows }
        });
      } else if (e.button === 0 && e.shiftKey) {
        // The user wants to select since the previous selection
        if (this.rowDragStart !== undefined) {
          const rowIndexRange = getRange(this.rowDragStart.rowIndex, rowIndex);
          for (const i of rowIndexRange) {
            rows.add(i);
          }
        }
        this.setState({ highlight: { rows } });
      } else if (e.button === 0 && focus.kind !== 'list') {
        // The user left-clicked on a non-list row
        this.contentElement.addEventListener('mousemove', this.onRowMouseMove);
        document.addEventListener('mouseup', this.onRowMouseUp);
        const rect = e.currentTarget.getBoundingClientRect();
        this.rowDragStart = {
          offset: rect.top,
          rowIndex
        };
        // Highlight the row
        this.setState({ highlight: { rows: new Set([rowIndex]) } });
      } else if (e.button === 0 && focus.kind === 'list') {
        // The user left-clicked on a list row - highlight it
        this.setState({ highlight: { rows: new Set([rowIndex]) } });
      } else if (e.button === 2 && rows.size === 0) {
        // Right clicked when nothing was highlighted:
        // Select the row but don't start a drag
        this.setState({ highlight: { rows: new Set([rowIndex]) } });
      }
    } else if (highlightMode === HighlightMode.Single) {
      this.setState({ highlight: { rows: new Set([rowIndex]) } });
    }
  };

  private onRowMouseUp = () => {
    // If the table element is known, remove the move listener from it
    if (this.contentElement) {
      this.contentElement.removeEventListener('mousemove', this.onRowMouseMove);
    }
  };

  private onRowMouseMove = (e: MouseEvent) => {
    if (this.rowDragStart) {
      const { offset, rowIndex } = this.rowDragStart;
      const offsetRelative = e.clientY - offset;
      const offsetIndex = Math.floor(offsetRelative / rowHeights.content);
      const hoveredIndex = rowIndex + offsetIndex;
      // Compute the set of highlighted row indices
      const minIndex = Math.min(rowIndex, hoveredIndex);
      const maxIndex = Math.max(rowIndex, hoveredIndex);
      const rows = new Set<number>();
      for (let i = minIndex; i <= maxIndex; i++) {
        rows.add(i);
      }
      // Highlight the rows
      this.setState({ highlight: { rows } });
    }
  };

  private onNewObjectClick = () => {
    const { focus } = this.props;
    const className = getClassName(this.props.focus);

    const embeddedInfo: EmbeddedInfo | undefined =
      focus.isEmbedded && focus.kind === 'list' && focus.property.name
        ? {
            parent: focus.parent,
            key: focus.property.name
          }
        : undefined;

    this.onShowCreateObjectDialog(className, embeddedInfo);
  };

  private onReorderingStart: ReorderingStartHandler = () => {
    // Removing any highlight
    this.setState({ highlight: undefined });
  };

  private onReorderingEnd: ReorderingEndHandler = ({ oldIndex, newIndex }) => {
    const { focus } = this.props;
    if (focus.kind === 'list') {
      this.write(() => {
        // For embedded objects, we have to work on detached objects, as we otherwise
        // delete the moved object (not sure if this is best practice).
        if (focus.isEmbedded && focus.property.name) {
          const detached = focus.results.toJSON();

          const removed = detached.splice(oldIndex, 1);
          detached.splice(newIndex, 0, removed[0]);

          focus.parent[focus.property.name] = detached;
        } else {
          const removed = focus.results.splice(oldIndex, 1);
          focus.results.splice(newIndex, 0, removed[0]);
        }
      });
    }
    this.setState({
      highlight: {
        ...this.state.highlight,
        rows: new Set([newIndex])
      }
    });
  };

  private onShowSelectObjectDialog({
    className,
    isOptional = false,
    action,
    isEmbeddedType
  }: {
    className: string;
    isOptional?: boolean;
    action: SelectObjectAction;
    isEmbeddedType: IsEmbeddedTypeChecker;
    onShowJsonViewerDialog: JsonViewerDialogExecutor;
  }) {
    if (!this.props.readOnly) {
      const focus: IClassFocus = this.props.getClassFocus(className);
      if (action.type === 'object') {
        const selectObjectDialog: ISelectObjectForObjectDialog = {
          action: 'object',
          focus,
          isOpen: true,
          isOptional,
          multiple: false,
          object: action.object,
          onCancel: this.onCancelSelectObjectDialog,
          onSelect: this.onObjectSelect,
          propertyName: action.propertyName,
          isEmbeddedType,
          onShowJsonViewerDialog: this.props.onShowJsonViewerDialog
        };
        this.setState({ selectObjectDialog });
      } else {
        const selectObjectDialog: ISelectObjectsForListDialog = {
          action: 'list',
          focus,
          isOpen: true,
          isOptional,
          list: action.list,
          multiple: true,
          onCancel: this.onCancelSelectObjectDialog,
          onSelect: this.onObjectSelect,
          isEmbeddedType,
          onShowJsonViewerDialog: this.props.onShowJsonViewerDialog
        };
        this.setState({ selectObjectDialog });
      }
    }
  }

  private deleteObjects(rowIndices: Set<number>) {
    if (!this.props.readOnly) {
      try {
        const { focus, realm, onClassFocussed } = this.props;

        this.write(() => {
          const objects = this.getHighlightedObjects(rowIndices);
          if (realm && focus.kind === 'class') {
            for (const object of objects) {
              realm.delete(object);
            }
          } else if (focus.kind === 'list') {
            // Creating a list of the indices of the objects in the original (unfiltered, unsorted) list
            const listIndices: number[] = [];
            for (const object of objects) {
              const index = focus.results.indexOf(object);
              listIndices.push(index);
            }
            // Sort and reverse, in-place
            listIndices.sort((a, b) => a - b).reverse();
            // Remove these objects from the list one by one - starting from the bottom
            for (const index of listIndices) {
              focus.results.splice(index, 1);
            }
          } else if (focus.kind === 'single-object') {
            if (focus.results[0]) {
              const object = focus.results.pop();
              realm.delete(object);
              if (onClassFocussed) {
                onClassFocussed(focus.parent.objectSchema().name, focus.parent);
              }
            }
          }
        });
      } catch (err) {
        showError('Error deleting the object', err);
      }
    }
  }

  private getHighlightedObjects(rowIndices: Set<number>) {
    const { results } = this.filteredSortedResults(
      this.props.focus.results,
      this.state.query,
      this.state.sorting
    );
    const result = new Set<Realm.Object>();
    for (const index of rowIndices) {
      const object = results[index];
      result.add(object);
    }
    return result;
  }

  private generateDeleteTexts(focus: Focus, multiple: boolean) {
    if (focus.kind === 'list') {
      const parent = focus.isEmbedded
        ? focus.parent.objectSchema().name
        : 'list';
      const target = focus.isEmbedded
        ? 'embedded object'
        : multiple
          ? 'rows'
          : 'row';
      const determinedTarget = `${multiple ? 'these' : 'this'} ${target}`;

      return {
        label: `Remove selected ${target} from the ${parent}`,
        title: `Removing ${target}`,
        description: `Are you sure you want to remove ${determinedTarget} from the ${parent}?`
      };
    } else {
      const target = multiple ? 'objects' : 'object';
      const determinedTarget = `${multiple ? 'these' : 'this'} ${target}`;

      return {
        label: `Delete selected ${target}`,
        title: `Delete ${target}`,
        description: `Are you sure you want to delete ${determinedTarget}?`
      };
    }
  }

  private write(callback: () => void) {
    if (!this.props.readOnly) {
      if (this.props.realm.isInTransaction) {
        callback();
        // We have to signal changes manually
        this.props.onRealmChanged();
      } else {
        this.props.realm.write(callback);
      }
    }
  }
}

export { ContentContainer as Content };
