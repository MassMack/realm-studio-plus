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
import classNames from 'classnames';
import React from 'react';
import { Badge, Button, Input } from 'reactstrap';

import { ClassFocussedHandler } from '..';
import { ILoadingProgress, Sidebar } from '../../reusable';
import { Focus, IListFocus } from '../focus';

import { ParentObjectFocus } from './ParentObjectFocus';

import './LeftSidebar.scss';

export function getFocusedSchemaName(focus: Focus | null): string | undefined {
  if (focus) {
    if (focus.kind === 'class') {
      return focus.className;
    } else if (focus.kind === 'list' || focus.kind === 'single-object') {
      return focus.parent.objectSchema().name;
    } else {
      throw new Error(`Unexpected kind of focus: ${focus}`);
    }
  } else {
    return undefined;
  }
}

export function isSelected(focus: Focus | null, schemaName: string) {
  return getFocusedSchemaName(focus) === schemaName;
}

export interface ILeftSidebarProps {
  classes: Realm.ObjectSchema[];
  className?: string;
  focus: Focus | null;
  getSchemaLength: (className: string, isAsymmetric?: boolean) => number;
  hiddenClassCount: number;
  isOpen: boolean;
  onClassFocussed: ClassFocussedHandler;
  onDeleteClass?: (className: string) => void;
  onOpenInSplitView?: (className: string) => void;
  onReload: () => void;
  onSearchQueryChange: (query: string) => void;
  onToggle: () => void;
  onTogglePinClass: (className: string) => void;
  pinnedClasses: string[];
  progress: ILoadingProgress;
  readOnly: boolean;
  searchInputRef?: (el: HTMLInputElement | null) => void;
  searchQuery: string;
  secondaryClassNames?: string[];
  toggleAddClass: () => void;
  toggleGlobalSearch?: () => void;
  toggleOverview?: () => void;
  totalVisibleClassCount: number;
}

const isMac = process.platform === 'darwin';
const filterClassesHint = isMac ? '⌘K' : 'Ctrl+K';
const globalSearchHint = isMac ? '⌘⇧F' : 'Ctrl+Shift+F';

const LeftSidebarComponent = ({
  classes,
  className,
  focus,
  getSchemaLength,
  hiddenClassCount,
  isOpen,
  onClassFocussed,
  onDeleteClass,
  onOpenInSplitView,
  onReload,
  onSearchQueryChange,
  onToggle,
  onTogglePinClass,
  pinnedClasses,
  progress,
  readOnly,
  searchInputRef,
  searchQuery,
  secondaryClassNames,
  toggleAddClass,
  toggleGlobalSearch,
  toggleOverview,
  totalVisibleClassCount
}: ILeftSidebarProps) => (
  <Sidebar
    className={className}
    contentClassName="LeftSidebar"
    isOpen={isOpen}
    onToggle={onToggle}
    position="left"
    minimumWidth={120}
  >
    <div className="LeftSidebar__Header">
      <span>Classes</span>
      <div className="LeftSidebar__HeaderActions">
        {toggleGlobalSearch ? (
          <Button
            size="sm"
            onClick={toggleGlobalSearch}
            title={`Global Search across all classes (${globalSearchHint})`}
          >
            <i className="fa fa-search" />
          </Button>
        ) : null}
        {toggleOverview ? (
          <Button
            size="sm"
            onClick={toggleOverview}
            title="Database Overview & Schema Stats"
          >
            <i className="fa fa-pie-chart" />
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={onReload}
          title="Reload Realm file from disk"
        >
          <i className="fa fa-refresh" />
        </Button>
        {readOnly ? null : (
          <Button size="sm" onClick={toggleAddClass} title="Add class">
            <i className="fa fa-plus" />
          </Button>
        )}
      </div>
    </div>
    {totalVisibleClassCount > 0 || searchQuery.length > 0 ? (
      <div className="LeftSidebar__Search">
        <i
          className="fa fa-search LeftSidebar__SearchIcon"
          aria-hidden="true"
        />
        <Input
          bsSize="sm"
          type="text"
          className="LeftSidebar__SearchInput"
          innerRef={searchInputRef}
          placeholder={`Filter classes... (${filterClassesHint})`}
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && searchQuery) {
              e.stopPropagation();
              onSearchQueryChange('');
            }
          }}
        />
        {searchQuery ? (
          <button
            type="button"
            className="LeftSidebar__SearchClear"
            onClick={() => onSearchQueryChange('')}
            title="Clear filter (Esc)"
          >
            <i className="fa fa-times-circle" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    ) : null}
    <div className="LeftSidebar__Classes">
      {classes && classes.length > 0 ? (
        <ul className="LeftSidebar__ClassList">
          {classes.map((schema) => {
            const selected = isSelected(focus, schema.name);
            const highlighted = selected && focus && focus.kind === 'class';
            const isPinned = pinnedClasses.includes(schema.name);
            const schemaClass = classNames('LeftSidebar__Class__Info', {
              'LeftSidebar__Class__Info--selected': selected,
              'LeftSidebar__Class__Info--highlighted': highlighted
            });
            return (
              <li
                key={schema.name}
                className="LeftSidebar__Class"
                title={schema.name}
              >
                <div
                  className={schemaClass}
                  onClick={() => onClassFocussed(schema.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const { Menu, MenuItem } = remote;
                    const menu = new Menu();
                    if (onOpenInSplitView) {
                      menu.append(
                        new MenuItem({
                          label: `Open "${schema.name}" in Split View`,
                          click: () => onOpenInSplitView(schema.name)
                        })
                      );
                    }
                    menu.append(
                      new MenuItem({
                        label: isPinned
                          ? `Unpin "${schema.name}"`
                          : `Pin "${schema.name}" to top`,
                        click: () => onTogglePinClass(schema.name)
                      })
                    );
                    menu.append(
                      new MenuItem({
                        label: `Copy class name "${schema.name}"`,
                        click: () => {
                          void navigator.clipboard.writeText(schema.name);
                        }
                      })
                    );
                    if (!readOnly && onDeleteClass) {
                      menu.append(new MenuItem({ type: 'separator' }));
                      menu.append(
                        new MenuItem({
                          label: `Delete class "${schema.name}"...`,
                          click: () => onDeleteClass(schema.name)
                        })
                      );
                    }
                    menu.popup({ x: e.clientX, y: e.clientY });
                  }}
                >
                  <button
                    type="button"
                    className={classNames('LeftSidebar__Class__PinBtn', {
                      'LeftSidebar__Class__PinBtn--pinned': isPinned
                    })}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePinClass(schema.name);
                    }}
                    title={isPinned ? 'Unpin class' : 'Pin class to top'}
                  >
                    <i
                      className={classNames(
                        'fa',
                        isPinned ? 'fa-star' : 'fa-star-o'
                      )}
                      aria-hidden="true"
                    />
                  </button>
                  <span className="LeftSidebar__Class__Name">
                    {schema.name}
                  </span>
                  {secondaryClassNames?.includes(schema.name) && !selected ? (
                    <Badge
                      color="info"
                      className="mr-1"
                      title="Open in another Split View pane"
                    >
                      Split
                    </Badge>
                  ) : null}
                  {schema.embedded ? (
                    <Badge
                      color={highlighted ? 'primary' : 'secondary'}
                      title="Embedded class"
                    >
                      E
                    </Badge>
                  ) : (
                    <Badge color={highlighted ? 'primary' : 'secondary'}>
                      {getSchemaLength(schema.name, schema.asymmetric)}
                    </Badge>
                  )}
                </div>
                {selected &&
                focus &&
                (focus.kind === 'list' || focus.kind === 'single-object') ? (
                  <ParentObjectFocus
                    focus={focus as IListFocus}
                    onClassFocussed={onClassFocussed}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : searchQuery.trim().length > 0 ? (
        <p className="LeftSidebar__NoMatchHint">
          No classes matching &#34;{searchQuery.trim()}&#34;
        </p>
      ) : progress.status === 'done' ? (
        <div className="LeftSidebar__ClassList--empty" />
      ) : null}
      {hiddenClassCount > 0 ? (
        <p className="LeftSidebar__HiddenClassesHint">
          Hiding {hiddenClassCount} system classes
        </p>
      ) : null}
      {readOnly ? (
        <p className="LeftSidebar__ReadOnlyHint">
          Opened as &#34;Read Only&#34;
        </p>
      ) : null}
    </div>
  </Sidebar>
);

export const LeftSidebar = React.memo(LeftSidebarComponent);
