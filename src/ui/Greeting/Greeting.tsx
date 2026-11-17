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
import { Button } from 'reactstrap';

import { IUpdateStatus } from '../../main/Updater';

import realmLogo from '../../../static/svgs/realm-logo.svg';
import { HistoryPanel } from './HistoryPanel/HistoryPanel';
import { IHistoryEntry } from './HistoryPanel/HistoryEntry';
import { UpdateStatusIndicator } from './UpdateStatusIndicator';

import './Greeting.scss';

const { app } = remote;

export const Greeting = ({
  androidStatus,
  historyEntries,
  isDraggingOver,
  onCheckForUpdates,
  onDragStateChange,
  onDropFiles,
  onFindAndroidRealms,
  onFindSimulatorRealms,
  onGenerateDemoRealm,
  onOpenLocalRealm,
  onOpenRecentFile,
  onRemoveRecentFile,
  updateStatus,
  version
}: {
  androidStatus?: string | null;
  historyEntries: IHistoryEntry[];
  isDraggingOver?: boolean;
  onCheckForUpdates: () => void;
  onDragStateChange?: (dragging: boolean) => void;
  onDropFiles?: (paths: string[]) => void;
  onFindAndroidRealms?: () => void;
  onFindSimulatorRealms?: () => void;
  onGenerateDemoRealm?: () => void;
  onOpenLocalRealm: () => void;
  onOpenRecentFile: (entry: IHistoryEntry) => void;
  onRemoveRecentFile: (entry: IHistoryEntry) => void;
  updateStatus: IUpdateStatus;
  version: string;
}) => (
  <div
    className="Greeting"
    onDragOver={(e) => {
      e.preventDefault();
      e.stopPropagation();
      if (onDragStateChange) {
        onDragStateChange(true);
      }
    }}
    onDragLeave={(e) => {
      e.preventDefault();
      e.stopPropagation();
      if (onDragStateChange) {
        onDragStateChange(false);
      }
    }}
    onDrop={(e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onDropFiles) {
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      const paths = files
        .map((f) => {
          if (
            electron.webUtils &&
            typeof electron.webUtils.getPathForFile === 'function'
          ) {
            return electron.webUtils.getPathForFile(f);
          }
          return (f as File & { path?: string }).path ?? '';
        })
        .filter(Boolean);
      onDropFiles(paths);
    }}
  >
    <div className="Greeting__ActionsPanel">
      <div className="Greeting__Brand">
        <svg className="Greeting__Logo" viewBox={realmLogo.viewBox}>
          <use xlinkHref={`#${realmLogo.id}`} />
        </svg>
        <h4 className="Greeting__Title">{app.name}</h4>
        <div className="Greeting__Version">Version {version}</div>
        <UpdateStatusIndicator
          status={updateStatus}
          onCheckForUpdates={onCheckForUpdates}
        />
      </div>

      <div className="Greeting__Actions">
        <Button
          color="primary"
          className="Greeting__ActionBtn"
          onClick={onOpenLocalRealm}
        >
          <i className="fa fa-folder-open" aria-hidden="true" /> Open Realm file
        </Button>
        {process.platform === 'darwin' && onFindSimulatorRealms ? (
          <Button
            color="secondary"
            size="sm"
            className="Greeting__ActionBtn"
            onClick={onFindSimulatorRealms}
            title="Scan ~/Library/Developer/CoreSimulator for .realm files"
          >
            <i className="fa fa-apple" aria-hidden="true" /> Find in iOS
            Simulators
          </Button>
        ) : null}
        {onFindAndroidRealms ? (
          <Button
            color="secondary"
            size="sm"
            className="Greeting__ActionBtn"
            disabled={!!androidStatus}
            onClick={onFindAndroidRealms}
            title="Pull .realm files from connected Android physical devices or Emulators"
          >
            <i
              className={
                androidStatus ? 'fa fa-spinner fa-spin' : 'fa fa-android'
              }
              aria-hidden="true"
            />{' '}
            {androidStatus ? 'Working...' : 'Pull from Android (ADB)'}
          </Button>
        ) : null}
        {androidStatus ? (
          <div className="small text-muted text-center mt-1">
            {androidStatus}
          </div>
        ) : null}
      </div>

      <div className="Greeting__DownloadDemo">
        {isDraggingOver ? (
          <strong>Drop .realm file here to open</strong>
        ) : (
          <>
            <div>Drag &amp; drop a .realm file anywhere</div>
            <button
              type="button"
              className="btn btn-link btn-sm p-0"
              onClick={onGenerateDemoRealm}
            >
              or open built-in Demo Realm
            </button>
          </>
        )}
      </div>
    </div>
    <HistoryPanel
      entries={historyEntries}
      onOpen={onOpenRecentFile}
      onRemove={onRemoveRecentFile}
    />
  </div>
);
