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
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

export interface ISimulatorDeviceInfo {
  name: string;
  isBooted: boolean;
}

export interface ISimulatorRealmFile {
  path: string;
  mtimeMs: number;
  size: number;
  deviceUdid: string;
  deviceName: string;
  isBooted: boolean;
}

const SKIP_SIM_DIRS = new Set([
  'Caches',
  'tmp',
  'SplashBoard',
  'Snapshots',
  'SystemData',
  'Bundle'
]);

export function getDefaultSimulatorRoot(): string {
  return path.join(os.homedir(), 'Library/Developer/CoreSimulator/Devices');
}

export function getSimulatorDeviceMap(): Map<string, ISimulatorDeviceInfo> {
  const map = new Map<string, ISimulatorDeviceInfo>();
  if (process.platform !== 'darwin') {
    return map;
  }
  try {
    const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
      encoding: 'utf8',
      timeout: 2000
    });
    const parsed = JSON.parse(raw) as {
      devices?: Record<
        string,
        Array<{ udid?: string; name?: string; state?: string }>
      >;
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

interface IRawSimFile {
  path: string;
  mtimeMs: number;
  size: number;
  deviceUdid: string;
}

function scanContainerForRealmFiles(
  dir: string,
  deviceUdid: string,
  depth = 0,
  maxDepth = 8,
  acc: IRawSimFile[] = []
): IRawSimFile[] {
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

export function findSimulatorRealmFiles(
  simRoot = getDefaultSimulatorRoot(),
  options?: { bootedOnly?: boolean }
): ISimulatorRealmFile[] {
  if (!fs.existsSync(simRoot)) {
    return [];
  }
  const deviceMap = getSimulatorDeviceMap();
  const rawFiles: IRawSimFile[] = [];

  let deviceEntries: fs.Dirent[] = [];
  try {
    deviceEntries = fs.readdirSync(simRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dev of deviceEntries) {
    if (!dev.isDirectory() || dev.name.startsWith('.')) {
      continue;
    }
    const deviceUdid = dev.name;
    const devInfo = deviceMap.get(deviceUdid);
    if (options?.bootedOnly && !devInfo?.isBooted) {
      continue;
    }
    const containerRoots = [
      path.join(simRoot, deviceUdid, 'data/Containers/Data/Application'),
      path.join(simRoot, deviceUdid, 'data/Containers/Shared/AppGroup'),
      path.join(simRoot, deviceUdid, 'data/Documents')
    ];
    for (const root of containerRoots) {
      if (fs.existsSync(root)) {
        scanContainerForRealmFiles(root, deviceUdid, 0, 8, rawFiles);
      }
    }
  }

  return rawFiles
    .map((item) => {
      const devInfo = deviceMap.get(item.deviceUdid);
      return {
        ...item,
        deviceName: devInfo?.name || item.deviceUdid.slice(0, 8),
        isBooted: !!devInfo?.isBooted
      };
    })
    .sort((a, b) => {
      if (a.isBooted !== b.isBooted) {
        return a.isBooted ? -1 : 1;
      }
      return b.mtimeMs - a.mtimeMs;
    });
}
