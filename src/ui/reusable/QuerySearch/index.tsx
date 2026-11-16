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
import React from 'react';

import { QuerySearch } from './QuerySearch';

const RECENT_QUERIES_STORAGE_KEY = 'realm-studio-recent-queries';
const SAVED_QUERIES_STORAGE_KEY = 'realm-studio-saved-queries-v1';
const MAX_RECENT_QUERIES = 12;

function loadStringArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function saveStringArray(key: string, items: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // ignore
  }
}

export interface IQuerySearchContainerProps {
  onQueryChange: (query: string) => void;
  onQueryHelp?: () => void;
  queryHelpTooltip?: React.JSX.Element;
  query: string;
  queryError?: Error;
  placeholder: string;
  className?: string;
}

interface IQuerySearchContainerState {
  inputElement?: HTMLInputElement;
  isPopoverOpen: boolean;
  localQuery: string;
  prevPropQuery: string;
  recentQueries: string[];
  savedQueries: string[];
}

class QuerySearchContainer extends React.Component<
  IQuerySearchContainerProps,
  IQuerySearchContainerState
> {
  public static getDerivedStateFromProps(
    nextProps: IQuerySearchContainerProps,
    prevState: IQuerySearchContainerState
  ): Partial<IQuerySearchContainerState> | null {
    if (nextProps.query !== prevState.prevPropQuery) {
      return {
        localQuery: nextProps.query,
        prevPropQuery: nextProps.query
      };
    }
    return null;
  }

  public state: IQuerySearchContainerState = {
    isPopoverOpen: false,
    localQuery: this.props.query,
    prevPropQuery: this.props.query,
    recentQueries: loadStringArray(RECENT_QUERIES_STORAGE_KEY),
    savedQueries: loadStringArray(SAVED_QUERIES_STORAGE_KEY)
  };

  public componentDidMount() {
    window.addEventListener('keydown', this.onWindowKeyDown);
  }

  public componentWillUnmount() {
    window.removeEventListener('keydown', this.onWindowKeyDown);
  }

  public render() {
    const hasQueriesOrCurrent =
      this.state.recentQueries.length > 0 ||
      this.state.savedQueries.length > 0 ||
      this.state.localQuery.trim().length > 0;
    return (
      <QuerySearch
        className={this.props.className}
        hasRecentQueries={hasQueriesOrCurrent}
        onClearQuery={this.onClearQuery}
        onKeyDown={this.onInputKeyDown}
        onOpenRecentQueries={this.onOpenRecentQueries}
        onQueryChange={this.handleQueryChange}
        onQueryHelp={this.props.onQueryHelp}
        onQueryFocus={this.onQueryFocus}
        onQueryBlur={this.onQueryBlur}
        query={this.state.localQuery}
        queryError={this.props.queryError}
        placeholder={this.props.placeholder}
        inputRef={this.inputRef}
        inputElement={this.state.inputElement}
        isPopoverOpen={this.state.isPopoverOpen}
        queryHelpTooltip={this.props.queryHelpTooltip}
      />
    );
  }

  private recordQueryInHistory(query: string) {
    const trimmed = query.trim();
    if (!trimmed || this.props.queryError) {
      return;
    }
    const next = [
      trimmed,
      ...this.state.recentQueries.filter((q) => q !== trimmed)
    ].slice(0, MAX_RECENT_QUERIES);
    this.setState({ recentQueries: next });
    saveStringArray(RECENT_QUERIES_STORAGE_KEY, next);
  }

  private toggleBookmarkQuery(query: string) {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    const exists = this.state.savedQueries.includes(trimmed);
    const next = exists
      ? this.state.savedQueries.filter((q) => q !== trimmed)
      : [trimmed, ...this.state.savedQueries];
    this.setState({ savedQueries: next });
    saveStringArray(SAVED_QUERIES_STORAGE_KEY, next);
  }

  private handleQueryChange = (query: string) => {
    this.setState({ localQuery: query });
    React.startTransition(() => {
      this.props.onQueryChange(query);
    });
  };

  private onClearQuery = () => {
    this.recordQueryInHistory(this.state.localQuery);
    this.setState({ localQuery: '' });
    this.props.onQueryChange('');
  };

  private onInputKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (
    e
  ) => {
    if (e.key === 'Escape') {
      if (this.state.localQuery) {
        e.stopPropagation();
        this.onClearQuery();
      } else if (this.state.inputElement) {
        this.state.inputElement.blur();
      }
    } else if (e.key === 'Enter') {
      this.recordQueryInHistory(this.state.localQuery);
    }
  };

  private onOpenRecentQueries = () => {
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    const currentTrimmed = this.state.localQuery.trim();

    if (currentTrimmed) {
      const isBookmarked = this.state.savedQueries.includes(currentTrimmed);
      menu.append(
        new MenuItem({
          label: isBookmarked
            ? `★ Remove bookmark for "${currentTrimmed}"`
            : `☆ Bookmark current query "${currentTrimmed}"`,
          click: () => this.toggleBookmarkQuery(currentTrimmed)
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (this.state.savedQueries.length > 0) {
      menu.append(
        new MenuItem({
          label: 'Bookmarked Queries',
          enabled: false
        })
      );
      for (const q of this.state.savedQueries) {
        menu.append(
          new MenuItem({
            label: `★ ${q}`,
            click: () => {
              this.setState({ localQuery: q });
              this.props.onQueryChange(q);
            }
          })
        );
      }
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (this.state.recentQueries.length > 0) {
      menu.append(
        new MenuItem({
          label: 'Recent Queries',
          enabled: false
        })
      );
      for (const q of this.state.recentQueries) {
        menu.append(
          new MenuItem({
            label: q,
            click: () => {
              this.setState({ localQuery: q });
              this.props.onQueryChange(q);
            }
          })
        );
      }
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Clear Recent Queries',
          click: () => {
            this.setState({ recentQueries: [] });
            saveStringArray(RECENT_QUERIES_STORAGE_KEY, []);
          }
        })
      );
    }
    menu.popup();
  };

  private onWindowKeyDown = (e: KeyboardEvent) => {
    const isFindShortcut =
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'f';
    if (isFindShortcut && this.state.inputElement) {
      e.preventDefault();
      this.state.inputElement.focus();
      this.state.inputElement.select();
    }
  };

  private inputRef = (inputElement: HTMLInputElement) => {
    this.setState({ inputElement });
  };

  private onQueryFocus = () => {
    this.setState({ isPopoverOpen: true });
  };

  private onQueryBlur = () => {
    this.recordQueryInHistory(this.state.localQuery);
    this.setState({ isPopoverOpen: false });
  };
}

export { QuerySearchContainer as QuerySearch };
