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
import path from 'path';
import React from 'react';
import Realm from 'realm';

import { main } from '../../actions/main';
import { IUpdateStatus } from '../../main/Updater';
import {
  findAndroidRealmFiles,
  IAndroidRealmFile,
  pullAndroidRealmFile,
  resolveAdbBinary
} from '../../services/android-finder';
import {
  getRecentFiles,
  IRecentFile,
  removeRecentFile
} from '../../services/recent-files';
import {
  findSimulatorRealmFiles,
  getDefaultSimulatorRoot
} from '../../services/simulator-finder';
import { IMenuGeneratorProps } from '../../windows/MenuGenerator';
import { showError } from '../reusable/errors';

import { Greeting } from './Greeting';
import { IHistoryEntry } from './HistoryPanel/HistoryEntry';

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatRecentTime(mtimeMs: number): string {
  if (!mtimeMs) {
    return 'unknown time';
  }
  const diffSec = Math.floor((Date.now() - mtimeMs) / 1000);
  if (diffSec >= 0 && diffSec < 60) {
    return 'just now';
  }
  if (diffSec >= 60 && diffSec < 3600) {
    return `${Math.floor(diffSec / 60)}m ago`;
  }
  const d = new Date(mtimeMs);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) {
    return `Today ${time}`;
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function buildStatusPrefix(opts: {
  isActiveInProcess?: boolean;
  activeTarget?: string;
  isLatest?: boolean;
  isAppRunning?: boolean;
}): string {
  const tags: string[] = [];
  if (opts.isActiveInProcess) {
    tags.push(
      opts.activeTarget ? `DEBUGGING (${opts.activeTarget})` : 'DEBUGGING NOW'
    );
  } else if (opts.isAppRunning) {
    tags.push('APP RUNNING');
  }
  if (opts.isLatest) {
    tags.push('LATEST');
  }
  if (tags.length === 0) {
    return '';
  }
  const icon = opts.isActiveInProcess ? '🟢' : opts.isLatest ? '★' : '●';
  return `${icon} [${tags.join(' · ')}] `;
}

interface IGreetingContainerState {
  androidStatus: string | null;
  isDraggingOver: boolean;
  recentFiles: IRecentFile[];
  updateStatus: IUpdateStatus;
  version: string;
}

class GreetingContainer extends React.Component<
  IMenuGeneratorProps,
  IGreetingContainerState
> {
  public state: IGreetingContainerState = {
    androidStatus: null,
    isDraggingOver: false,
    recentFiles: getRecentFiles(),
    updateStatus: {
      state: 'up-to-date'
    },
    version: remote.app.getVersion() || 'unknown'
  };

  public componentDidMount() {
    electron.ipcRenderer.on('update-status', this.updateStatusChanged);
    window.addEventListener('focus', this.refreshRecentFiles);
  }

  public componentWillUnmount() {
    electron.ipcRenderer.removeListener(
      'update-status',
      this.updateStatusChanged
    );
    window.removeEventListener('focus', this.refreshRecentFiles);
  }

  public render() {
    const entries: IHistoryEntry[] = this.state.recentFiles.map((file) => ({
      path: file.path
    }));
    return (
      <Greeting
        {...this.state}
        {...this}
        historyEntries={entries}
        onDropFiles={this.onDropFiles}
        onDragStateChange={this.onDragStateChange}
        onFindAndroidRealms={this.onFindAndroidRealms}
        onFindSimulatorRealms={this.onFindSimulatorRealms}
        onGenerateDemoRealm={this.onGenerateDemoRealm}
        onOpenRecentFile={this.onOpenRecentFile}
        onRemoveRecentFile={this.onRemoveRecentFile}
      />
    );
  }

  public onOpenLocalRealm = () => {
    main.showOpenLocalRealm().then(this.refreshRecentFiles);
  };

  public onCheckForUpdates = () => {
    main.checkForUpdates();
  };

  public updateStatusChanged = (
    e: Electron.IpcRendererEvent,
    status: IUpdateStatus
  ) => {
    this.setState({ updateStatus: status });
  };

  private onDragStateChange = (isDraggingOver: boolean) => {
    if (this.state.isDraggingOver !== isDraggingOver) {
      this.setState({ isDraggingOver });
    }
  };

  private onDropFiles = (filePaths: string[]) => {
    this.setState({ isDraggingOver: false });
    for (const filePath of filePaths) {
      if (filePath) {
        void main
          .showOpenLocalRealmAtPath(filePath)
          .then(this.refreshRecentFiles);
      }
    }
  };

  private handlePullAndroidFile = async (
    adbBin: string,
    item: IAndroidRealmFile
  ) => {
    const fileName = path.basename(item.remoteRelPath);
    const totalMb =
      item.sizeBytes > 0
        ? ` / ${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
        : '';
    this.setState({
      androidStatus: `Pulling ${fileName} from ${item.deviceName}...`
    });
    try {
      const destDir = path.join(
        remote.app.getPath('temp'),
        'realm-studio-android'
      );
      const destFile = await pullAndroidRealmFile({
        adbBin,
        item,
        destDir,
        onProgress: (written) => {
          const mb = (written / (1024 * 1024)).toFixed(1);
          this.setState({
            androidStatus: `Pulling ${fileName}: ${mb} MB${totalMb}...`
          });
        }
      });
      this.setState({ androidStatus: null });
      void main
        .showOpenLocalRealmAtPath(destFile)
        .then(this.refreshRecentFiles);
    } catch (err) {
      this.setState({ androidStatus: null });
      showError('Failed pulling Realm file via ADB', err);
    }
  };

  private onFindAndroidRealms = async () => {
    if (this.state.androidStatus) {
      return;
    }
    const { Menu, MenuItem } = remote;
    const adbBin = resolveAdbBinary();

    if (!adbBin) {
      const menu = new Menu();
      menu.append(
        new MenuItem({
          label: 'Android Platform-Tools (adb) not found on this machine',
          enabled: false
        })
      );
      menu.popup();
      return;
    }

    this.setState({
      androidStatus: 'Scanning Android devices & emulators...'
    });

    try {
      const { devices, files } = await findAndroidRealmFiles(adbBin);
      this.setState({ androidStatus: null });

      const menu = new Menu();
      const readyDevices = devices.filter((d) => d.state === 'device');
      const blockedDevices = devices.filter((d) => d.state !== 'device');

      if (devices.length === 0) {
        menu.append(
          new MenuItem({
            label: 'No running Android Emulator or connected ADB device found',
            enabled: false
          })
        );
      } else if (readyDevices.length === 0) {
        for (const dev of blockedDevices) {
          const hint =
            dev.state === 'unauthorized'
              ? 'Allow USB debugging on device'
              : dev.state;
          menu.append(
            new MenuItem({
              label: `${dev.model} (${dev.serial}): ${hint}`,
              enabled: false
            })
          );
        }
      } else if (files.length === 0) {
        const names = readyDevices.map((d) => d.model).join(', ');
        menu.append(
          new MenuItem({
            label: `Scanned ${names} — no debuggable .realm files found`,
            enabled: false
          })
        );
      } else {
        menu.append(
          new MenuItem({
            label: `Found ${files.length} Android Realm(s) — active debugging & latest first:`,
            enabled: false
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
        for (const item of files.slice(0, 20)) {
          const fileName = path.basename(item.remoteRelPath);
          const parentFolder = path.dirname(item.remoteRelPath);
          const devTag = `${item.isEmulator ? '[Emu] ' : ''}${item.deviceName}`;
          const prefix = buildStatusPrefix({
            isActiveInProcess: item.isActiveInProcess,
            activeTarget: item.activePid ? `PID ${item.activePid}` : undefined,
            isAppRunning: item.isAppRunning,
            isLatest: item.isLatest
          });
          const sizeLabel = formatByteSize(item.sizeBytes);
          const timeLabel = formatRecentTime(item.mtimeMs);
          menu.append(
            new MenuItem({
              label: `${prefix}${fileName} (${devTag} • ${sizeLabel} • ${timeLabel} • ${item.pkg}/${parentFolder})`,
              click: () => {
                void this.handlePullAndroidFile(adbBin, item);
              }
            })
          );
        }
      }
      menu.popup();
    } catch (err) {
      this.setState({ androidStatus: null });
      showError('Failed scanning Android devices via ADB', err);
    }
  };

  private onFindSimulatorRealms = () => {
    const simRoot = getDefaultSimulatorRoot();
    const { Menu, MenuItem } = remote;
    const menu = new Menu();

    if (!fs.existsSync(simRoot)) {
      menu.append(
        new MenuItem({
          label: 'No iOS Simulator directory found on this Mac',
          enabled: false
        })
      );
      menu.popup();
      return;
    }

    const found = findSimulatorRealmFiles(simRoot);

    if (found.length === 0) {
      menu.append(
        new MenuItem({
          label: 'No .realm files found in iOS Simulators',
          enabled: false
        })
      );
    } else {
      menu.append(
        new MenuItem({
          label: `Found ${found.length} Simulator Realm(s) — active debugging, Booted & latest first:`,
          enabled: false
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      for (const item of found.slice(0, 15)) {
        const fileName = path.basename(item.path);
        const parentDir = path.basename(path.dirname(item.path));
        const devLabel = `${item.isBooted ? '● ' : ''}${item.deviceName}`;
        const prefix = buildStatusPrefix({
          isActiveInProcess: item.isActiveInProcess,
          activeTarget: item.activeProcessName,
          isLatest: item.isLatest
        });
        const sizeLabel = formatByteSize(item.size);
        const timeStr = formatRecentTime(item.mtimeMs);
        menu.append(
          new MenuItem({
            label: `${prefix}${fileName} (${devLabel} • ${sizeLabel} • ${timeStr} • ${parentDir})`,
            click: () => {
              void main
                .showOpenLocalRealmAtPath(item.path)
                .then(this.refreshRecentFiles);
            }
          })
        );
      }
    }
    menu.popup();
  };

  private onGenerateDemoRealm = () => {
    try {
      const demoPath = path.join(
        remote.app.getPath('userData'),
        'demo-studio-plus.realm'
      );
      if (!fs.existsSync(demoPath)) {
        const AddressSchema: Realm.ObjectSchema = {
          name: 'Address',
          embedded: true,
          properties: {
            city: 'string',
            country: 'string'
          }
        };
        const OrderItemSchema: Realm.ObjectSchema = {
          name: 'OrderItem',
          primaryKey: 'id',
          properties: {
            id: 'int',
            productName: 'string',
            price: 'double',
            quantity: 'int'
          }
        };
        const OrderSchema: Realm.ObjectSchema = {
          name: 'Order',
          primaryKey: 'orderId',
          properties: {
            orderId: 'string',
            status: 'string',
            total: 'double',
            createdAt: 'date',
            items: 'OrderItem[]'
          }
        };
        const UserSchema: Realm.ObjectSchema = {
          name: 'User',
          primaryKey: '_id',
          properties: {
            _id: 'objectId',
            name: 'string',
            email: 'string',
            isActive: 'bool',
            address: 'Address',
            orders: 'Order[]'
          }
        };
        const demoRealm = new Realm({
          path: demoPath,
          schema: [AddressSchema, OrderItemSchema, OrderSchema, UserSchema]
        });
        demoRealm.write(() => {
          const item1 = demoRealm.create('OrderItem', {
            id: 1,
            productName: 'MacBook Pro M4 Max',
            price: 3499.0,
            quantity: 1
          });
          const item2 = demoRealm.create('OrderItem', {
            id: 2,
            productName: 'Pro Display XDR',
            price: 4999.0,
            quantity: 1
          });
          const order1 = demoRealm.create('Order', {
            orderId: 'ORD-1001',
            status: 'delivered',
            total: 8498.0,
            createdAt: new Date(),
            items: [item1, item2]
          });
          demoRealm.create('User', {
            _id: new Realm.BSON.ObjectId(),
            name: 'Boss Max',
            email: 'max@realmstudio.plus',
            isActive: true,
            address: { city: 'Bangkok', country: 'Thailand' },
            orders: [order1]
          });
        });
        demoRealm.close();
      }
      void main.showOpenLocalRealmAtPath(demoPath).then(this.refreshRecentFiles);
    } catch (err) {
      showError('Failed to create Demo Realm', err);
    }
  };

  private refreshRecentFiles = () => {
    this.setState({ recentFiles: getRecentFiles() });
  };

  private onOpenRecentFile = (entry: IHistoryEntry) => {
    main.showOpenLocalRealmAtPath(entry.path);
  };

  private onRemoveRecentFile = (entry: IHistoryEntry) => {
    removeRecentFile(entry.path);
    this.refreshRecentFiles();
  };
}

export { GreetingContainer as Greeting };
