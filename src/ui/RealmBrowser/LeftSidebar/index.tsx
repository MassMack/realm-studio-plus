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

import { ClassFocussedHandler } from '..';
import { store } from '../../../store';
import { ILoadingProgress } from '../../reusable';
import { Focus } from '../focus';

import { LeftSidebar } from './LeftSidebar';

const PINNED_CLASSES_STORAGE_KEY = 'realm-studio-pinned-classes';

function loadPinnedClasses(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_CLASSES_STORAGE_KEY);
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

function savePinnedClasses(classes: string[]) {
  try {
    localStorage.setItem(PINNED_CLASSES_STORAGE_KEY, JSON.stringify(classes));
  } catch {
    // ignore
  }
}

function isSystemClassName(cls?: Realm.ObjectSchema) {
  return cls && cls.name.indexOf('__') === 0;
}

interface ILeftSidebarContainerProps {
  classes: Realm.ObjectSchema[];
  className?: string;
  focus: Focus | null;
  getSchemaLength: (className: string, isAsymmetric?: boolean) => number;
  isOpen: boolean;
  onClassFocussed: ClassFocussedHandler;
  onDeleteClass?: (className: string) => void;
  onOpenInSplitView?: (className: string) => void;
  onReload: () => void;
  onToggle: () => void;
  progress: ILoadingProgress;
  readOnly?: boolean;
  secondaryClassNames?: string[];
  toggleAddClass: () => void;
  toggleGlobalSearch?: () => void;
  toggleOverview?: () => void;
}

interface ILeftSidebarContainerState {
  hideSystemClasses: boolean;
  pinnedClasses: string[];
  searchQuery: string;
}

class LeftSidebarContainer extends React.Component<
  ILeftSidebarContainerProps,
  ILeftSidebarContainerState
> {
  public state: ILeftSidebarContainerState = {
    hideSystemClasses: !store.shouldShowSystemClasses(),
    pinnedClasses: loadPinnedClasses(),
    searchQuery: ''
  };

  private removeShowSystemClassesListener: (() => void) | null = null;
  private searchInputElement: HTMLInputElement | null = null;

  public componentDidMount() {
    this.removeShowSystemClassesListener = store.onDidChange(
      store.KEY_SHOW_SYSTEM_CLASSES,
      this.onShowSystemClassesChange
    );
    window.addEventListener('keydown', this.onWindowKeyDown);
  }

  public componentWillUnmount() {
    if (typeof this.removeShowSystemClassesListener === 'function') {
      this.removeShowSystemClassesListener();
    }
    window.removeEventListener('keydown', this.onWindowKeyDown);
  }

  public render() {
    const visible = this.visibleClasses;
    const hiddenClassCount = this.props.classes.length - visible.length;
    const normalizedQuery = this.state.searchQuery.trim().toLowerCase();
    const filteredClasses = normalizedQuery
      ? visible.filter((c) => c.name.toLowerCase().includes(normalizedQuery))
      : visible;

    return (
      <LeftSidebar
        classes={filteredClasses}
        className={this.props.className}
        focus={this.props.focus}
        getSchemaLength={this.props.getSchemaLength}
        hiddenClassCount={hiddenClassCount}
        isOpen={this.props.isOpen}
        onClassFocussed={this.props.onClassFocussed}
        onDeleteClass={this.props.onDeleteClass}
        onOpenInSplitView={this.props.onOpenInSplitView}
        onReload={this.props.onReload}
        onSearchQueryChange={this.onSearchQueryChange}
        onToggle={this.props.onToggle}
        onTogglePinClass={this.onTogglePinClass}
        pinnedClasses={this.state.pinnedClasses}
        progress={this.props.progress}
        readOnly={this.props.readOnly || false}
        searchInputRef={this.setSearchInputRef}
        searchQuery={this.state.searchQuery}
        secondaryClassNames={this.props.secondaryClassNames}
        toggleAddClass={this.props.toggleAddClass}
        toggleGlobalSearch={this.props.toggleGlobalSearch}
        toggleOverview={this.props.toggleOverview}
        totalVisibleClassCount={visible.length}
      />
    );
  }

  private onTogglePinClass = (className: string) => {
    this.setState((prev) => {
      const isPinned = prev.pinnedClasses.includes(className);
      const next = isPinned
        ? prev.pinnedClasses.filter((c) => c !== className)
        : [...prev.pinnedClasses, className];
      savePinnedClasses(next);
      return { pinnedClasses: next };
    });
  };

  private setSearchInputRef = (el: HTMLInputElement | null) => {
    this.searchInputElement = el;
  };

  private onWindowKeyDown = (e: KeyboardEvent) => {
    const isFilterClassesShortcut =
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'k';
    if (isFilterClassesShortcut) {
      e.preventDefault();
      if (!this.props.isOpen) {
        this.props.onToggle();
      }
      setTimeout(() => {
        if (this.searchInputElement) {
          this.searchInputElement.focus();
          this.searchInputElement.select();
        }
      }, 0);
    }
  };

  private get visibleClasses() {
    const { pinnedClasses } = this.state;
    const result = this.state.hideSystemClasses
      ? this.props.classes.filter((c) => !isSystemClassName(c))
      : [...this.props.classes];
    // Put pinned classes first, then non-embedded classes
    return result.sort((a, b) => {
      const aPinned = pinnedClasses.includes(a.name);
      const bPinned = pinnedClasses.includes(b.name);
      if (aPinned !== bPinned) {
        return aPinned ? -1 : 1;
      }
      if (Boolean(a.embedded) !== Boolean(b.embedded)) {
        return a.embedded ? 1 : -1;
      }
      return 0;
    });
  }

  private onSearchQueryChange = (searchQuery: string) => {
    this.setState({ searchQuery });
  };

  private onShowSystemClassesChange = (showSystemClasses: boolean) => {
    this.setState({ hideSystemClasses: !showSystemClasses }, () => {
      const shouldSelectAnotherClass = this.isFocussedOnSystemClass();
      if (showSystemClasses === false && shouldSelectAnotherClass) {
        // Focus on another class
        const firstClass = this.visibleClasses.find(
          (c) => !isSystemClassName(c)
        );
        if (firstClass) {
          this.props.onClassFocussed(firstClass.name);
        }
      }
    });
  };

  private isFocussedOnSystemClass() {
    const { focus, classes } = this.props;
    if (focus && (focus.kind === 'class' || focus.kind === 'list')) {
      const name =
        focus.kind === 'class'
          ? focus.className
          : focus.parent.objectSchema().name;
      const targetClass = classes.find((cls) => cls.name === name);
      return isSystemClassName(targetClass);
    } else {
      return false;
    }
  }
}

export { LeftSidebarContainer as LeftSidebar };
