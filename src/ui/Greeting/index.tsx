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

import { execFileSync } from 'child_process';
import electron from 'electron';
import * as remote from '@electron/remote';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import React from 'react';
import Realm from 'realm';

import { main } from '../../actions/main';
import { IUpdateStatus } from '../../main/Updater';
import {
  getRecentFiles,
  IRecentFile,
  removeRecentFile
} from '../../services/recent-files';
import { IMenuGeneratorProps } from '../../windows/MenuGenerator';
import { showError } from '../reusable/errors';

import { Greeting } from './Greeting';
import { IHistoryEntry } from './HistoryPanel/HistoryEntry';

interface ISimulatorRealmFile {
  path: string;
  mtimeMs: number;
  size: number;
  deviceUdid: string;
}

interface ISimulatorDeviceInfo {
  name: string;
  isBooted: boolean;
}

function getSimulatorDeviceMap(): Map<string, ISimulatorDeviceInfo> {
  const map = new Map<string, ISimulatorDeviceInfo>();
  try {
    const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
      encoding: 'utf8',
      timeout: 2000
    });
    const parsed = JSON.parse(raw) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
    };
    if (parsed.devices) {
      for (const list of Object.values(parsed.devices)) {
        for (const dev of list) {
          if (dev.udid && dev.name) {
            map.set(dev.udid, {
              name: dev.name,
              isBooted: dev.state === 'Booted'
            });
          }
        }
      }
    }
  } catch {
    // Fallback to UDID if xcrun is unavailable
  }
  return map;
}

const SKIP_SIM_DIRS = new Set([
  'Caches',
  'tmp',
  'SplashBoard',
  'Snapshots',
  'SystemData',
  'Bundle'
]);

function scanContainerForRealmFiles(
  dir: string,
  deviceUdid: string,
  depth = 0,
  maxDepth = 8,
  acc: ISimulatorRealmFile[] = []
): ISimulatorRealmFile[] {
  if (depth > maxDepth || acc.length >= 100) {
    return acc;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (
      entry.name.startsWith('.') ||
      entry.name.endsWith('.realm.management') ||
      SKIP_SIM_DIRS.has(entry.name)
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanContainerForRealmFiles(fullPath, deviceUdid, depth + 1, maxDepth, acc);
    } else if (entry.isFile() && entry.name.endsWith('.realm')) {
      try {
        const stat = fs.statSync(fullPath);
        acc.push({
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          deviceUdid
        });
      } catch {
        // ignore
      }
    }
  }
  return acc;
}

function findSimulatorRealmFiles(simRoot: string): ISimulatorRealmFile[] {
  const acc: ISimulatorRealmFile[] = [];
  let deviceEntries: fs.Dirent[] = [];
  try {
    deviceEntries = fs.readdirSync(simRoot, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const dev of deviceEntries) {
    if (!dev.isDirectory() || dev.name.startsWith('.')) {
      continue;
    }
    const deviceUdid = dev.name;
    const containerRoots = [
      path.join(simRoot, deviceUdid, 'data/Containers/Data/Application'),
      path.join(simRoot, deviceUdid, 'data/Containers/Shared/AppGroup'),
      path.join(simRoot, deviceUdid, 'data/Documents')
    ];
    for (const root of containerRoots) {
      if (fs.existsSync(root)) {
        scanContainerForRealmFiles(root, deviceUdid, 0, 8, acc);
      }
    }
  }
  return acc;
}

interface IGreetingContainerState {
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

  private resolveAdbBinary(): string | null {
    const candidates = [
      path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
      'adb'
    ];
    for (const candidate of candidates) {
      try {
        execFileSync(candidate, ['version'], {
          stdio: 'ignore',
          timeout: 2000
        });
        return candidate;
      } catch {
        // try next
      }
    }
    return null;
  }

  private onFindAndroidRealms = () => {
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    const adbBin = this.resolveAdbBinary();

    if (!adbBin) {
      menu.append(
        new MenuItem({
          label: 'Android Platform-Tools (adb) not found on this machine',
          enabled: false
        })
      );
      menu.popup();
      return;
    }

    let deviceSerials: string[] = [];
    try {
      const out = execFileSync(adbBin, ['devices'], {
        encoding: 'utf8',
        timeout: 3000
      });
      deviceSerials = out
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.endsWith('\tdevice'))
        .map((line) => line.split('\t')[0]);
    } catch {
      // ignore
    }

    if (deviceSerials.length === 0) {
      menu.append(
        new MenuItem({
          label: 'No running Android Emulator or connected ADB device found',
          enabled: false
        })
      );
      menu.popup();
      return;
    }

    const serial = deviceSerials[0];
    const discovered: Array<{
      pkg: string;
      remoteRelPath: string;
      label: string;
    }> = [];

    try {
      const pkgOut = execFileSync(
        adbBin,
        ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'],
        { encoding: 'utf8', timeout: 4000 }
      );
      const packages = pkgOut
        .split('\n')
        .map((l) => l.trim().replace(/^package:/, ''))
        .filter(Boolean)
        .slice(0, 30);

      for (const pkg of packages) {
        try {
          const filesOut = execFileSync(
            adbBin,
            ['-s', serial, 'shell', 'run-as', pkg, 'ls', 'files'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }
          );
          for (const f of filesOut.split('\n').map((s) => s.trim())) {
            if (f.endsWith('.realm')) {
              discovered.push({
                pkg,
                remoteRelPath: `files/${f}`,
                label: `${f}  (${pkg} • ${serial})`
              });
            }
          }
        } catch {
          // package is not debuggable or has no files dir
        }
      }
    } catch {
      // ignore
    }

    if (discovered.length === 0) {
      menu.append(
        new MenuItem({
          label: `Connected to ${serial}, but no debuggable .realm files found`,
          enabled: false
        })
      );
    } else {
      menu.append(
        new MenuItem({
          label: `Android (${serial}) — click to pull & open:`,
          enabled: false
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      for (const item of discovered) {
        menu.append(
          new MenuItem({
            label: item.label,
            click: () => {
              try {
                const destDir = path.join(
                  remote.app.getPath('temp'),
                  'realm-studio-android',
                  item.pkg
                );
                fs.ensureDirSync(destDir);
                const destFile = path.join(
                  destDir,
                  path.basename(item.remoteRelPath)
                );
                const buf = execFileSync(
                  adbBin,
                  [
                    '-s',
                    serial,
                    'exec-out',
                    'run-as',
                    item.pkg,
                    'cat',
                    item.remoteRelPath
                  ],
                  { maxBuffer: 200 * 1024 * 1024, timeout: 15000 }
                );
                fs.writeFileSync(destFile, buf);
                void main
                  .showOpenLocalRealmAtPath(destFile)
                  .then(this.refreshRecentFiles);
              } catch (err) {
                showError('Failed pulling Realm file via ADB', err);
              }
            }
          })
        );
      }
    }
    menu.popup();
  };

  private onFindSimulatorRealms = () => {
    const simRoot = path.join(
      os.homedir(),
      'Library/Developer/CoreSimulator/Devices'
    );
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

    const deviceMap = getSimulatorDeviceMap();
    const found = findSimulatorRealmFiles(simRoot).sort((a, b) => {
      const aBooted = deviceMap.get(a.deviceUdid)?.isBooted ? 1 : 0;
      const bBooted = deviceMap.get(b.deviceUdid)?.isBooted ? 1 : 0;
      if (aBooted !== bBooted) {
        return bBooted - aBooted;
      }
      return b.mtimeMs - a.mtimeMs;
    });

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
          label: `Found ${found.length} Simulator Realm(s) — Booted & most recent first:`,
          enabled: false
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      for (const item of found.slice(0, 15)) {
        const fileName = path.basename(item.path);
        const parentDir = path.basename(path.dirname(item.path));
        const devInfo = deviceMap.get(item.deviceUdid);
        const devLabel = devInfo
          ? `${devInfo.isBooted ? '● ' : ''}${devInfo.name}`
          : item.deviceUdid.slice(0, 8);
        const kb = (item.size / 1024).toFixed(0);
        const timeStr = new Date(item.mtimeMs).toLocaleTimeString();
        menu.append(
          new MenuItem({
            label: `${fileName} (${devLabel} • ${kb} KB • ${parentDir} • ${timeStr})`,
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
