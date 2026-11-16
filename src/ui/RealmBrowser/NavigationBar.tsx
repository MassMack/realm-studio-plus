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

import classNames from 'classnames';
import React, { useState } from 'react';
import { Button } from 'reactstrap';
import Realm from 'realm';

import { formatShortIdValue, IObjectIdentifier } from './display';
import { Focus } from './focus';

export interface IBreadcrumbItem {
  label: string;
  typeLabel?: string;
  objectId?: IObjectIdentifier | null;
  focus: Focus;
  highlightedObject?: Realm.Object;
}

export interface INavigationBarProps {
  activeObjectId?: IObjectIdentifier | null;
  breadcrumbs: IBreadcrumbItem[];
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onBreadcrumbClick: (index: number) => void;
}

const isMac = process.platform === 'darwin';
const backShortcutHint = isMac ? '⌘[' : 'Alt+←';
const forwardShortcutHint = isMac ? '⌘]' : 'Alt+→';

const NavigationBarComponent = ({
  activeObjectId,
  breadcrumbs,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onBreadcrumbClick
}: INavigationBarProps) => {
  const [copied, setCopied] = useState(false);

  const currentId =
    activeObjectId ??
    [...breadcrumbs].reverse().find((b) => b.objectId)?.objectId ??
    null;

  const handleCopyId = (value: string) => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="RealmBrowser__NavBar">
      <div className="RealmBrowser__NavBar__Buttons">
        <Button
          size="sm"
          color="secondary"
          className="RealmBrowser__NavBar__Btn"
          disabled={!canGoBack}
          onClick={onBack}
          title={`Go back (${backShortcutHint})`}
        >
          <i className="fa fa-arrow-left" aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          color="secondary"
          className="RealmBrowser__NavBar__Btn"
          disabled={!canGoForward}
          onClick={onForward}
          title={`Go forward (${forwardShortcutHint})`}
        >
          <i className="fa fa-arrow-right" aria-hidden="true" />
        </Button>
      </div>

      <nav className="RealmBrowser__NavBar__Breadcrumbs" aria-label="Breadcrumb">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1;
          const displayCrumbId =
            isLast && activeObjectId ? activeObjectId : crumb.objectId;
          const tooltipParts = [crumb.label];
          if (crumb.typeLabel) {
            tooltipParts.push(`(${crumb.typeLabel})`);
          }
          if (displayCrumbId) {
            tooltipParts.push(`${displayCrumbId.key} = ${displayCrumbId.value}`);
          }

          return (
            <React.Fragment key={`${index}-${crumb.label}`}>
              {index > 0 && (
                <i
                  className="fa fa-angle-right RealmBrowser__NavBar__Separator"
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                className={classNames('RealmBrowser__NavBar__Crumb', {
                  'RealmBrowser__NavBar__Crumb--active': isLast
                })}
                onClick={() => {
                  if (!isLast) {
                    onBreadcrumbClick(index);
                  }
                }}
                disabled={isLast}
                title={tooltipParts.join(' ')}
              >
                <span className="RealmBrowser__NavBar__CrumbLabel">
                  {crumb.label}
                </span>
                {crumb.typeLabel ? (
                  <span className="RealmBrowser__NavBar__CrumbType">
                    {crumb.typeLabel}
                  </span>
                ) : null}
                {displayCrumbId ? (
                  <span className="RealmBrowser__NavBar__CrumbId">
                    <span className="RealmBrowser__NavBar__CrumbIdKey">
                      {displayCrumbId.key}:
                    </span>
                    <span className="RealmBrowser__NavBar__CrumbIdVal">
                      {formatShortIdValue(displayCrumbId.value, 20)}
                    </span>
                  </span>
                ) : null}
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {currentId ? (
        <button
          type="button"
          className="RealmBrowser__NavBar__ActiveId"
          onClick={() => handleCopyId(currentId.value)}
          title={`Click to copy ${currentId.key}: ${currentId.value}`}
        >
          <span className="RealmBrowser__NavBar__ActiveIdKey">
            {currentId.key}=
          </span>
          <span className="RealmBrowser__NavBar__ActiveIdVal">
            {currentId.value}
          </span>
          <i
            className={classNames(
              'fa',
              copied ? 'fa-check' : 'fa-clone',
              'RealmBrowser__NavBar__CopyIcon'
            )}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  );
};

export const NavigationBar = React.memo(NavigationBarComponent);
