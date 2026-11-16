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
import os from 'os';
import path from 'path';

export interface IHistoryEntry {
  path: string;
}

interface IHistoryEntryProps {
  entry: IHistoryEntry;
  onOpen?: (entry: IHistoryEntry) => void;
  onRemove?: (entry: IHistoryEntry) => void;
}

const formatDisplayPath = (fullPath: string): string => {
  const home = os.homedir();
  const dir = path.dirname(fullPath);
  if (home && dir.startsWith(home)) {
    return `~${dir.slice(home.length)}`;
  }
  return dir;
};

export const HistoryEntry = ({
  entry,
  onOpen,
  onRemove
}: IHistoryEntryProps) => {
  const fileName = path.basename(entry.path);
  const displayDir = formatDisplayPath(entry.path);

  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    if (onOpen) {
      menu.append(
        new MenuItem({
          label: `Open "${fileName}"`,
          click: () => onOpen(entry)
        })
      );
    }
    menu.append(
      new MenuItem({
        label: 'Reveal in Finder',
        click: () => electron.shell.showItemInFolder(entry.path)
      })
    );
    menu.append(
      new MenuItem({
        label: 'Copy file path',
        click: () => {
          void navigator.clipboard.writeText(entry.path);
        }
      })
    );
    if (onRemove) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Remove from Recently Opened',
          click: () => onRemove(entry)
        })
      );
    }
    menu.popup({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      className="Greeting__HistoryPanel__Entry Greeting__HistoryPanel__Entry--clickable"
      title={entry.path}
      onClick={() => onOpen && onOpen(entry)}
      onContextMenu={handleContextMenu}
    >
      <i
        className="fa fa-database Greeting__HistoryPanel__Icon Greeting__HistoryPanel__Icon--fa"
        aria-hidden="true"
      />
      <div className="Greeting__HistoryPanel__Description">
        <div className="Greeting__HistoryPanel__Name">{fileName}</div>
        <div className="Greeting__HistoryPanel__Path">{displayDir}</div>
      </div>
      <button
        type="button"
        className="Greeting__HistoryPanel__Action"
        title="Reveal in Finder"
        onClick={(e) => {
          e.stopPropagation();
          electron.shell.showItemInFolder(entry.path);
        }}
      >
        <i className="fa fa-folder-open-o" aria-hidden="true" />
      </button>
      {onRemove && (
        <button
          type="button"
          className="Greeting__HistoryPanel__Remove"
          title="Remove from list"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(entry);
          }}
        >
          <i className="fa fa-trash" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
