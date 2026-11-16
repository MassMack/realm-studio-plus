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

import * as remote from '@electron/remote';
import { Button } from 'reactstrap';

import { QuerySearch } from '../../reusable/QuerySearch';
import { IPropertyWithName } from '..';
import { Focus, getClassName } from '../focus';

import { QueryChangeHandler } from '.';

interface ITopBarProps {
  allProperties?: IPropertyWithName[];
  filteredCount?: number;
  focus: Focus;
  hiddenColumns?: string[];
  onAskAi?: () => void;
  onDeleteFilteredRows?: () => void;
  onExportView?: (format: 'json' | 'csv') => void;
  onGenerateMockRows?: (count: number) => void;
  onImportJsonFile?: () => void;
  onNewObjectClick?: () => void;
  onPasteJson?: () => void;
  onQueryChange: QueryChangeHandler;
  onQueryHelp: () => void;
  onShowAllColumns?: () => void;
  onToggleColumn?: (propName: string) => void;
  query: string;
  queryError: Error | undefined;
  readOnly: boolean;
  selectedCount?: number;
  totalCount?: number;
  allowCreate: boolean;
}

const isMac = process.platform === 'darwin';
const findShortcutHint = isMac ? '⌘F' : 'Ctrl+F';
const aiShortcutHint = isMac ? '⌘⇧A' : 'Ctrl+Shift+A';

export const TopBar = ({
  allProperties,
  filteredCount,
  focus,
  hiddenColumns = [],
  onAskAi,
  onDeleteFilteredRows,
  onExportView,
  onGenerateMockRows,
  onImportJsonFile,
  onNewObjectClick,
  onPasteJson,
  onQueryChange,
  onQueryHelp,
  onShowAllColumns,
  onToggleColumn,
  query,
  queryError,
  readOnly,
  selectedCount = 0,
  totalCount,
  allowCreate
}: ITopBarProps) => {
  const className = getClassName(focus);

  const handleColumnsClick = () => {
    if (!allProperties || !onToggleColumn) {
      return;
    }
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    for (const prop of allProperties) {
      const propName = prop.name;
      if (!propName || propName === '#') {
        continue;
      }
      const isVisible = !hiddenColumns.includes(propName);
      menu.append(
        new MenuItem({
          label: `${propName} (${prop.objectType || prop.type})`,
          type: 'checkbox',
          checked: isVisible,
          click: () => onToggleColumn(propName)
        })
      );
    }
    if (hiddenColumns.length > 0 && onShowAllColumns) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: `Show All Columns (${hiddenColumns.length} hidden)`,
          click: () => onShowAllColumns()
        })
      );
    }
    menu.popup();
  };

  const handleExportClick = () => {
    if (!onExportView) {
      return;
    }
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    menu.append(
      new MenuItem({
        label: `Export current view as JSON...`,
        click: () => onExportView('json')
      })
    );
    menu.append(
      new MenuItem({
        label: `Export current view as CSV...`,
        click: () => onExportView('csv')
      })
    );
    if (!readOnly && allowCreate && focus.kind === 'class') {
      if (onPasteJson || onImportJsonFile) {
        menu.append(new MenuItem({ type: 'separator' }));
      }
      if (onPasteJson) {
        menu.append(
          new MenuItem({
            label: `Paste JSON row(s) from Clipboard into ${className}`,
            click: () => onPasteJson()
          })
        );
      }
      if (onImportJsonFile) {
        menu.append(
          new MenuItem({
            label: `Import JSON file into ${className}...`,
            click: () => onImportJsonFile()
          })
        );
      }
    }
    menu.popup();
  };

  const isFiltered = query.trim().length > 0 && !queryError;

  const handleToolsClick = () => {
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    if (allowCreate && !readOnly && focus.kind === 'class' && onGenerateMockRows) {
      menu.append(
        new MenuItem({
          label: `Generate 10 mock ${className} rows`,
          click: () => onGenerateMockRows(10)
        })
      );
      menu.append(
        new MenuItem({
          label: `Generate 50 mock ${className} rows`,
          click: () => onGenerateMockRows(50)
        })
      );
      menu.append(
        new MenuItem({
          label: `Generate 100 mock ${className} rows`,
          click: () => onGenerateMockRows(100)
        })
      );
    }
    if (
      !readOnly &&
      onDeleteFilteredRows &&
      typeof filteredCount === 'number' &&
      filteredCount > 0
    ) {
      if (menu.items.length > 0) {
        menu.append(new MenuItem({ type: 'separator' }));
      }
      menu.append(
        new MenuItem({
          label: isFiltered
            ? `Delete all ${filteredCount.toLocaleString()} filtered rows...`
            : `Clear all ${filteredCount.toLocaleString()} rows in ${className}...`,
          click: () => onDeleteFilteredRows()
        })
      );
    }
    if (menu.items.length > 0) {
      menu.popup();
    }
  };

  return (
    <div className="RealmBrowser__Topbar">
      <QuerySearch
        className="RealmBrowser__Topbar__Filter"
        onQueryChange={onQueryChange}
        onQueryHelp={onQueryHelp}
        query={query}
        queryError={queryError}
        placeholder={`Quick search text/ID or enter RQL query (${findShortcutHint})`}
      />
      {onAskAi ? (
        <Button
          size="sm"
          color="primary"
          className="RealmBrowser__Topbar__Button"
          onClick={onAskAi}
          title={`Ask AI to write Realm Query (${aiShortcutHint})`}
        >
          <i className="fa fa-magic" aria-hidden="true" /> Ask AI
        </Button>
      ) : null}
      {typeof filteredCount === 'number' && typeof totalCount === 'number' ? (
        <span
          className="RealmBrowser__Topbar__Count"
          title={
            isFiltered
              ? `Showing ${filteredCount.toLocaleString()} of ${totalCount.toLocaleString()} records`
              : `${totalCount.toLocaleString()} total records`
          }
        >
          {isFiltered
            ? `${filteredCount.toLocaleString()} / ${totalCount.toLocaleString()} rows`
            : `${totalCount.toLocaleString()} rows`}
          {selectedCount > 1 ? ` (${selectedCount} selected)` : ''}
        </span>
      ) : null}
      {allProperties && allProperties.length > 1 && onToggleColumn ? (
        <Button
          size="sm"
          color="secondary"
          className="RealmBrowser__Topbar__Button"
          onClick={handleColumnsClick}
          title="Show or hide table columns"
        >
          <i className="fa fa-columns" aria-hidden="true" /> Columns
          {hiddenColumns.length > 0 ? ` (${hiddenColumns.length})` : ''}
        </Button>
      ) : null}
      {onExportView ? (
        <Button
          size="sm"
          color="secondary"
          className="RealmBrowser__Topbar__Button"
          onClick={handleExportClick}
          title={`Export / Import ${className} (JSON / CSV)`}
        >
          <i className="fa fa-download" aria-hidden="true" /> Export
        </Button>
      ) : null}
      {!readOnly &&
      focus.kind === 'class' &&
      !focus.isEmbedded &&
      (onGenerateMockRows || onDeleteFilteredRows) ? (
        <Button
          size="sm"
          color="secondary"
          className="RealmBrowser__Topbar__Button"
          onClick={handleToolsClick}
          title="Mock Data Generator & Bulk Delete Tools"
        >
          <i className="fa fa-magic" aria-hidden="true" /> Tools
        </Button>
      ) : null}
      {allowCreate && !readOnly ? (
        <Button
          size="sm"
          color="secondary"
          className="RealmBrowser__Topbar__Button"
          onClick={onNewObjectClick}
          title={`Create ${className}`}
        >
          Create {className}
        </Button>
      ) : null}
    </div>
  );
};
