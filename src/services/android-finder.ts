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

import { execFile, execFileSync, spawn } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

export interface IAdbDeviceInfo {
  serial: string;
  state: string;
  model: string;
  isEmulator: boolean;
}

export interface IAndroidRealmFile {
  serial: string;
  deviceName: string;
  isEmulator: boolean;
  pkg: string;
  remoteRelPath: string;
  accessMode: 'run-as' | 'root';
  sizeBytes: number;
  mtimeMs: number;
  isAppRunning: boolean;
  isActiveInProcess: boolean;
  activePid?: string;
  isLatest: boolean;
}

export interface IAndroidScanResult {
  devices: IAdbDeviceInfo[];
  files: IAndroidRealmFile[];
}

export function resolveAdbBinary(): string | null {
  const sdkEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const adbExe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates: string[] = [];

  if (sdkEnv) {
    candidates.push(path.join(sdkEnv, 'platform-tools', adbExe));
  }
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local');
    candidates.push(path.join(localAppData, 'Android/Sdk/platform-tools/adb.exe'));
  } else {
    candidates.push(
      path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
      path.join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb'
    );
  }
  candidates.push(adbExe);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], {
        stdio: 'ignore',
        timeout: 2000
      });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function listAdbDevices(adbBin: string): Promise<IAdbDeviceInfo[]> {
  const out = await execFileAsync(adbBin, ['devices', '-l'], 4000);
  const devices: IAdbDeviceInfo[] = [];

  for (const rawLine of out.split('\n').slice(1)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*')) {
      continue;
    }
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || 'unknown';
    const modelToken = parts.find((p) => p.startsWith('model:'));
    const deviceToken = parts.find((p) => p.startsWith('device:'));
    const rawModel = modelToken
      ? modelToken.slice('model:'.length).replace(/_/g, ' ')
      : deviceToken
        ? deviceToken.slice('device:'.length)
        : '';
    const isEmulator =
      serial.startsWith('emulator-') ||
      /\b(sdk|emulator|gphone)\b/i.test(rawModel);

    devices.push({
      serial,
      state,
      model: rawModel || serial,
      isEmulator
    });
  }
  return devices;
}

const REMOTE_SCAN_SCRIPT = `
uid=$(id -u 2>/dev/null || echo 2000)
scan_dir='find files databases app_flutter no_backup -maxdepth 5 -type f -name "*.realm" 2>/dev/null | while IFS= read -r f; do sz=$(stat -c %s "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0); mt=$(stat -c %Y "$f" 2>/dev/null || echo 0); lmt=$(stat -c %Y "$f.lock" 2>/dev/null || echo 0); [ "$lmt" -gt "$mt" ] 2>/dev/null && mt="$lmt"; echo "$sz|$mt|$f"; done'
for p in $(pm list packages -3 2>/dev/null | cut -d: -f2 | tr -d "\\r"); do
  pid=$(pidof "$p" 2>/dev/null | awk '{print $1}')
  found=$(run-as "$p" sh -c "$scan_dir" 2>/dev/null)
  mode="run-as"
  if [ -z "$found" ] && [ "$uid" = "0" ] && [ -d "/data/data/$p" ]; then
    found=$(cd "/data/data/$p" 2>/dev/null && sh -c "$scan_dir" 2>/dev/null)
    mode="root"
  fi
  if [ -n "$found" ]; then
    if [ -n "$pid" ]; then
      if [ "$mode" = "run-as" ]; then
        fds=$(run-as "$p" ls -l "/proc/$pid/fd" 2>/dev/null | grep -F ".realm" || true)
      else
        fds=$(ls -l "/proc/$pid/fd" 2>/dev/null | grep -F ".realm" || true)
      fi
      if [ -n "$fds" ]; then
        printf '%s\\n' "$fds" | while IFS= read -r fdline; do
          target="\${fdline#* -> }"
          [ -n "$target" ] && echo "FD|$p|$pid|$target"
        done
      fi
    fi
    printf '%s\\n' "$found" | while IFS= read -r line; do
      [ -n "$line" ] && echo "FILE|$mode|$p|$line|$pid"
    done
  fi
done
`.trim();

function normalizeOpenRealmTarget(targetPath: string): string {
  const mgmtIdx = targetPath.indexOf('.realm.management/');
  if (mgmtIdx >= 0) {
    return `${targetPath.slice(0, mgmtIdx)}.realm`;
  }
  if (targetPath.endsWith('.realm.lock')) {
    return targetPath.slice(0, -'.lock'.length);
  }
  if (targetPath.endsWith('.realm.note')) {
    return targetPath.slice(0, -'.note'.length);
  }
  return targetPath;
}

async function scanSingleAndroidDevice(
  adbBin: string,
  device: IAdbDeviceInfo
): Promise<IAndroidRealmFile[]> {
  const out = await execFileAsync(
    adbBin,
    ['-s', device.serial, 'shell', REMOTE_SCAN_SCRIPT],
    20000
  );

  const openFilesByPkg = new Map<string, Set<string>>();
  const rawItems: Array<Omit<IAndroidRealmFile, 'isActiveInProcess'>> = [];

  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split('|');
    if (parts[0] === 'FD' && parts.length >= 4) {
      const pkg = parts[1];
      const target = normalizeOpenRealmTarget(parts.slice(3).join('|'));
      if (pkg && target) {
        let set = openFilesByPkg.get(pkg);
        if (!set) {
          set = new Set<string>();
          openFilesByPkg.set(pkg, set);
        }
        set.add(target);
      }
      continue;
    }

    // Format: FILE|mode|pkg|sizeBytes|mtimeSec|remoteRelPath|pid
    if (parts[0] !== 'FILE' || parts.length < 7) {
      continue;
    }
    const modeRaw = parts[1];
    const pkg = parts[2];
    const sizeBytes = Number(parts[3]) || 0;
    const mtimeSec = Number(parts[4]) || 0;
    const pid = parts[parts.length - 1] || '';
    const remoteRelPath = parts.slice(5, parts.length - 1).join('|');

    if (!pkg || !remoteRelPath.endsWith('.realm')) {
      continue;
    }

    rawItems.push({
      serial: device.serial,
      deviceName: device.model,
      isEmulator: device.isEmulator,
      pkg,
      remoteRelPath,
      accessMode: modeRaw === 'root' ? 'root' : 'run-as',
      sizeBytes,
      mtimeMs: mtimeSec > 0 ? mtimeSec * 1000 : 0,
      isAppRunning: pid.length > 0,
      activePid: pid || undefined,
      isLatest: false
    });
  }

  return rawItems.map((item) => {
    const openSet = openFilesByPkg.get(item.pkg);
    const suffix = `/${item.remoteRelPath}`;
    const isActiveInProcess = openSet
      ? Array.from(openSet).some(
          (openPath) =>
            openPath === item.remoteRelPath || openPath.endsWith(suffix)
        )
      : false;
    return {
      ...item,
      isActiveInProcess
    };
  });
}

export async function findAndroidRealmFiles(
  adbBin: string
): Promise<IAndroidScanResult> {
  const devices = await listAdbDevices(adbBin);
  const readyDevices = devices.filter((d) => d.state === 'device');

  if (readyDevices.length === 0) {
    return { devices, files: [] };
  }

  const perDevice = await Promise.all(
    readyDevices.map((dev) =>
      scanSingleAndroidDevice(adbBin, dev).catch(() => [])
    )
  );

  const flat = perDevice.flat();
  const newestMtime = flat.reduce(
    (max, item) => (item.mtimeMs > max ? item.mtimeMs : max),
    0
  );

  const files = flat
    .map((item) => ({
      ...item,
      isLatest: newestMtime > 0 && item.mtimeMs === newestMtime
    }))
    .sort((a, b) => {
      if (a.isActiveInProcess !== b.isActiveInProcess) {
        return a.isActiveInProcess ? -1 : 1;
      }
      if (a.isAppRunning !== b.isAppRunning) {
        return a.isAppRunning ? -1 : 1;
      }
      return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });

  return { devices, files };
}

export function pullAndroidRealmFile(params: {
  adbBin: string;
  item: IAndroidRealmFile;
  destDir: string;
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}): Promise<string> {
  const { adbBin, item, destDir, onProgress } = params;
  const targetDir = path.join(destDir, item.serial, item.pkg);
  fs.ensureDirSync(targetDir);

  const destFile = path.join(targetDir, path.basename(item.remoteRelPath));
  const tempFile = `${destFile}.part`;
  const metaFile = `${destFile}.meta.json`;

  const adbArgs =
    item.accessMode === 'root'
      ? [
          '-s',
          item.serial,
          'exec-out',
          'cat',
          `/data/data/${item.pkg}/${item.remoteRelPath}`
        ]
      : [
          '-s',
          item.serial,
          'exec-out',
          'run-as',
          item.pkg,
          'cat',
          item.remoteRelPath
        ];

  return new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(tempFile);
    const child = spawn(adbBin, adbArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderrText = '';
    let bytesWritten = 0;
    let lastProgressAt = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      outStream.destroy();
      try {
        fs.removeSync(tempFile);
      } catch {
        // ignore cleanup failure
      }
      reject(err);
    };

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrText.length < 2000) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      bytesWritten += chunk.length;
      if (!outStream.write(chunk)) {
        child.stdout.pause();
        outStream.once('drain', () => child.stdout.resume());
      }
      if (onProgress) {
        const now = Date.now();
        if (now - lastProgressAt >= 120) {
          lastProgressAt = now;
          onProgress(bytesWritten, item.sizeBytes);
        }
      }
    });

    child.on('error', (err) => fail(err));

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      outStream.end(() => {
        if (settled) {
          return;
        }
        if (code !== 0 || bytesWritten === 0) {
          const detail = stderrText.trim() || `adb exited with code ${code}`;
          fail(new Error(`Failed to pull ${item.remoteRelPath}: ${detail}`));
          return;
        }
        try {
          fs.moveSync(tempFile, destFile, { overwrite: true });
          try {
            fs.writeJsonSync(metaFile, {
              source: 'android-adb',
              serial: item.serial,
              deviceName: item.deviceName,
              isEmulator: item.isEmulator,
              pkg: item.pkg,
              remoteRelPath: item.remoteRelPath,
              accessMode: item.accessMode,
              destDir,
              sizeBytes: item.sizeBytes,
              mtimeMs: item.mtimeMs,
              pulledAt: Date.now()
            });
          } catch {
            // ignore metadata cache write failure
          }
          settled = true;
          if (onProgress) {
            onProgress(bytesWritten, item.sizeBytes || bytesWritten);
          }
          resolve(destFile);
        } catch (moveErr) {
          fail(
            moveErr instanceof Error ? moveErr : new Error(String(moveErr))
          );
        }
      });
    });

    outStream.on('error', (err) => fail(err));
  });
}

export async function pullMatchingAndroidRealm(params: {
  serial?: string;
  pkg?: string;
  remoteRelPath?: string;
  forceRefresh?: boolean;
  destDir?: string;
}): Promise<{
  path: string;
  reusedCache: boolean;
  durationMs: number;
  file: IAndroidRealmFile;
}> {
  const adbBin = resolveAdbBinary();
  if (!adbBin) {
    throw new Error('Android Platform-Tools (adb) not found on this machine.');
  }

  const { devices, files } = await findAndroidRealmFiles(adbBin);
  const readyDevices = devices.filter((d) => d.state === 'device');
  if (readyDevices.length === 0) {
    if (devices.length > 0) {
      const states = devices.map((d) => `${d.model}: ${d.state}`).join(', ');
      throw new Error(`No ready ADB device (${states}).`);
    }
    throw new Error('No running Android Emulator or connected ADB device found.');
  }

  const matches = files.filter((f) => {
    if (params.serial && f.serial !== params.serial) {
      return false;
    }
    if (params.pkg && f.pkg !== params.pkg) {
      return false;
    }
    if (
      params.remoteRelPath &&
      f.remoteRelPath !== params.remoteRelPath &&
      path.basename(f.remoteRelPath) !== params.remoteRelPath
    ) {
      return false;
    }
    return true;
  });

  if (matches.length === 0) {
    throw new Error(
      'No matching debuggable .realm file found on connected Android device(s).'
    );
  }

  const target = matches[0];
  const destDir = params.destDir || path.join(os.tmpdir(), 'realm-studio-android');
  const expectedDest = path.join(
    destDir,
    target.serial,
    target.pkg,
    path.basename(target.remoteRelPath)
  );
  const metaFile = `${expectedDest}.meta.json`;

  // Always pull fresh from Android while debugging unless caller opts into cache (`forceRefresh: false`)
  const forceRefresh = params.forceRefresh ?? true;

  if (!forceRefresh && fs.existsSync(expectedDest) && fs.existsSync(metaFile)) {
    try {
      const meta = fs.readJsonSync(metaFile) as {
        sizeBytes?: number;
        mtimeMs?: number;
      };
      if (
        target.sizeBytes > 0 &&
        meta.sizeBytes === target.sizeBytes &&
        meta.mtimeMs === target.mtimeMs
      ) {
        return {
          path: expectedDest,
          reusedCache: true,
          durationMs: 0,
          file: target
        };
      }
    } catch {
      // ignore stale cache metadata
    }
  }

  const t0 = Date.now();
  const pulledPath = await pullAndroidRealmFile({
    adbBin,
    item: target,
    destDir
  });
  return {
    path: pulledPath,
    reusedCache: false,
    durationMs: Date.now() - t0,
    file: target
  };
}

export interface IAndroidPullMetadata {
  source?: string;
  serial?: string;
  deviceName?: string;
  isEmulator?: boolean;
  pkg?: string;
  remoteRelPath?: string;
  accessMode?: 'run-as' | 'root';
  destDir?: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function getTrackedAndroidRealmInfo(
  localRealmPath: string
): IAndroidPullMetadata | null {
  const metaFile = `${localRealmPath}.meta.json`;
  if (!fs.existsSync(metaFile)) {
    return null;
  }
  try {
    const meta = fs.readJsonSync(metaFile) as IAndroidPullMetadata;
    if (
      meta.source === 'android-adb' &&
      meta.serial &&
      meta.pkg &&
      meta.remoteRelPath
    ) {
      return meta;
    }
  } catch {
    // ignore malformed metadata
  }
  return null;
}

async function fetchRemoteFileStat(
  adbBin: string,
  meta: IAndroidPullMetadata
): Promise<{ sizeBytes: number; mtimeMs: number } | null> {
  if (!meta.serial || !meta.pkg || !meta.remoteRelPath) {
    return null;
  }
  const qPath = shellSingleQuote(meta.remoteRelPath);
  const statSnippet = `f=${qPath}; [ -f "$f" ] || exit 2; sz=$(stat -c %s "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0); mt=$(stat -c %Y "$f" 2>/dev/null || echo 0); lmt=$(stat -c %Y "$f.lock" 2>/dev/null || echo 0); [ "$lmt" -gt "$mt" ] 2>/dev/null && mt="$lmt"; echo "$sz|$mt"`;

  const remoteCmd =
    meta.accessMode === 'root'
      ? `cd ${shellSingleQuote(`/data/data/${meta.pkg}`)} && ${statSnippet}`
      : `run-as ${shellSingleQuote(meta.pkg)} sh -c ${shellSingleQuote(statSnippet)}`;

  const out = await execFileAsync(
    adbBin,
    ['-s', meta.serial, 'shell', remoteCmd],
    4000
  );
  const line = out.trim().split('\n').pop()?.trim() || '';
  const parts = line.split('|');
  if (parts.length !== 2) {
    return null;
  }
  const sizeBytes = Number(parts[0]) || 0;
  const mtimeSec = Number(parts[1]) || 0;
  return {
    sizeBytes,
    mtimeMs: mtimeSec > 0 ? mtimeSec * 1000 : 0
  };
}

export async function hasAndroidRemoteFileChanged(
  localRealmPath: string
): Promise<boolean> {
  const meta = getTrackedAndroidRealmInfo(localRealmPath);
  if (!meta || !meta.serial) {
    return false;
  }
  const adbBin = resolveAdbBinary();
  if (!adbBin) {
    throw new Error('ADB binary not found');
  }
  const devices = await listAdbDevices(adbBin);
  const ready = devices.find(
    (d) => d.serial === meta.serial && d.state === 'device'
  );
  if (!ready) {
    throw new Error(`Device ${meta.deviceName || meta.serial} is offline`);
  }
  const remoteStat = await fetchRemoteFileStat(adbBin, meta);
  if (!remoteStat) {
    return true;
  }
  if (!meta.sizeBytes || !meta.mtimeMs) {
    return true;
  }
  return (
    remoteStat.sizeBytes !== meta.sizeBytes ||
    remoteStat.mtimeMs !== meta.mtimeMs
  );
}

export async function refreshLocalAndroidRealmIfTracked(
  localRealmPath: string
): Promise<boolean> {
  const meta = getTrackedAndroidRealmInfo(localRealmPath);
  if (!meta || !meta.serial || !meta.pkg || !meta.remoteRelPath) {
    return false;
  }

  const adbBin = resolveAdbBinary();
  if (!adbBin) {
    return false;
  }
  const devices = await listAdbDevices(adbBin).catch(() => []);
  const ready = devices.find(
    (d) => d.serial === meta.serial && d.state === 'device'
  );
  if (!ready) {
    throw new Error(
      `Android device "${meta.deviceName || meta.serial}" is not connected via ADB. Reconnect USB/Emulator to pull the latest data.`
    );
  }

  const remoteStat = await fetchRemoteFileStat(adbBin, meta).catch(() => null);
  const fallbackDestDir = path.dirname(
    path.dirname(path.dirname(localRealmPath))
  );
  await pullAndroidRealmFile({
    adbBin,
    destDir: meta.destDir || fallbackDestDir,
    item: {
      serial: meta.serial,
      deviceName: ready.model || meta.deviceName || meta.serial,
      isEmulator: ready.isEmulator,
      pkg: meta.pkg,
      remoteRelPath: meta.remoteRelPath,
      accessMode: meta.accessMode === 'root' ? 'root' : 'run-as',
      sizeBytes: remoteStat?.sizeBytes ?? meta.sizeBytes ?? 0,
      mtimeMs: remoteStat?.mtimeMs ?? Date.now(),
      isAppRunning: true,
      isActiveInProcess: true,
      isLatest: true
    }
  });
  return true;
}
