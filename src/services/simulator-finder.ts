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
  isActiveInProcess: boolean;
  activeProcessName?: string;
  isLatest: boolean;
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

function getEffectiveRealmMtime(realmPath: string, fallbackMtime: number): number {
  let latest = fallbackMtime;
  const lockPath = `${realmPath}.lock`;
  try {
    if (fs.existsSync(lockPath)) {
      const lockStat = fs.statSync(lockPath);
      if (lockStat.mtimeMs > latest) {
        latest = lockStat.mtimeMs;
      }
    }
  } catch {
    // ignore lock stat failure
  }
  return latest;
}

function normalizeRealmTargetPath(openPath: string): string {
  const mgmtIdx = openPath.indexOf('.realm.management/');
  if (mgmtIdx >= 0) {
    return `${openPath.slice(0, mgmtIdx)}.realm`;
  }
  if (openPath.endsWith('.realm.lock')) {
    return openPath.slice(0, -'.lock'.length);
  }
  return openPath;
}

function getOpenRealmProcessesOnMac(
  realmPaths: string[]
): Map<string, string> {
  const activeByPath = new Map<string, string>();
  if (process.platform !== 'darwin' || realmPaths.length === 0) {
    return activeByPath;
  }

  const candidateToRealm = new Map<string, string>();
  const targets: string[] = [];
  for (const rPath of realmPaths.slice(0, 40)) {
    const checkPaths = [rPath, `${rPath}.lock`];
    for (const p of checkPaths) {
      if (!fs.existsSync(p)) {
        continue;
      }
      targets.push(p);
      candidateToRealm.set(p, rPath);
      try {
        candidateToRealm.set(fs.realpathSync(p), rPath);
      } catch {
        // ignore realpath error
      }
    }
  }
  if (targets.length === 0) {
    return activeByPath;
  }

  let rawOut = '';
  try {
    rawOut = execFileSync('lsof', ['-F', 'pcn', '--', ...targets], {
      encoding: 'utf8',
      timeout: 1500
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown })?.stdout;
    if (typeof stdout === 'string') {
      rawOut = stdout;
    }
  }

  let currentPid = '';
  let currentCmd = '';
  const selfPid = String(process.pid);
  for (const line of rawOut.split('\n')) {
    if (!line) {
      continue;
    }
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      currentPid = value;
      currentCmd = '';
    } else if (tag === 'c') {
      currentCmd = value.replace(/\\x20/g, ' ');
    } else if (tag === 'n' && currentPid && currentPid !== selfPid) {
      const normalized = normalizeRealmTargetPath(value);
      const matchedRealm =
        candidateToRealm.get(value) || candidateToRealm.get(normalized);
      if (matchedRealm && !/realm\s*studio/i.test(currentCmd)) {
        activeByPath.set(matchedRealm, currentCmd || `PID ${currentPid}`);
      }
    }
  }
  return activeByPath;
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
          mtimeMs: getEffectiveRealmMtime(fullPath, stat.mtimeMs),
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

  const activeProcesses = getOpenRealmProcessesOnMac(
    rawFiles.map((f) => f.path)
  );
  const newestMtime = rawFiles.reduce(
    (max, item) => (item.mtimeMs > max ? item.mtimeMs : max),
    0
  );

  return rawFiles
    .map((item) => {
      const devInfo = deviceMap.get(item.deviceUdid);
      const activeProcessName = activeProcesses.get(item.path);
      return {
        ...item,
        deviceName: devInfo?.name || item.deviceUdid.slice(0, 8),
        isBooted: !!devInfo?.isBooted,
        isActiveInProcess: !!activeProcessName,
        activeProcessName,
        isLatest: newestMtime > 0 && item.mtimeMs === newestMtime
      };
    })
    .sort((a, b) => {
      if (a.isActiveInProcess !== b.isActiveInProcess) {
        return a.isActiveInProcess ? -1 : 1;
      }
      if (a.isBooted !== b.isBooted) {
        return a.isBooted ? -1 : 1;
      }
      return b.mtimeMs - a.mtimeMs;
    });
}
