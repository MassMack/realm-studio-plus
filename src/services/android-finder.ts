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
scan_dir='find files databases app_flutter no_backup -maxdepth 5 -type f -name "*.realm" 2>/dev/null | while IFS= read -r f; do sz=$(stat -c %s "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0); mt=$(stat -c %Y "$f" 2>/dev/null || echo 0); echo "$sz|$mt|$f"; done'
for p in $(pm list packages -3 2>/dev/null | cut -d: -f2 | tr -d "\\r"); do
  found=$(run-as "$p" sh -c "$scan_dir" 2>/dev/null)
  if [ -n "$found" ]; then
    printf '%s\\n' "$found" | while IFS= read -r line; do
      [ -n "$line" ] && echo "run-as|$p|$line"
    done
  elif [ "$uid" = "0" ] && [ -d "/data/data/$p" ]; then
    found=$(cd "/data/data/$p" 2>/dev/null && sh -c "$scan_dir" 2>/dev/null)
    if [ -n "$found" ]; then
      printf '%s\\n' "$found" | while IFS= read -r line; do
        [ -n "$line" ] && echo "root|$p|$line"
      done
    fi
  fi
done
`.trim();

async function scanSingleAndroidDevice(
  adbBin: string,
  device: IAdbDeviceInfo
): Promise<IAndroidRealmFile[]> {
  const out = await execFileAsync(
    adbBin,
    ['-s', device.serial, 'shell', REMOTE_SCAN_SCRIPT],
    20000
  );

  const items: IAndroidRealmFile[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const firstSep = line.indexOf('|');
    const secondSep = firstSep >= 0 ? line.indexOf('|', firstSep + 1) : -1;
    const thirdSep = secondSep >= 0 ? line.indexOf('|', secondSep + 1) : -1;
    const fourthSep = thirdSep >= 0 ? line.indexOf('|', thirdSep + 1) : -1;
    if (fourthSep < 0) {
      continue;
    }

    const modeRaw = line.slice(0, firstSep);
    const pkg = line.slice(firstSep + 1, secondSep);
    const sizeBytes = Number(line.slice(secondSep + 1, thirdSep)) || 0;
    const mtimeSec = Number(line.slice(thirdSep + 1, fourthSep)) || 0;
    const remoteRelPath = line.slice(fourthSep + 1);

    if (!pkg || !remoteRelPath.endsWith('.realm')) {
      continue;
    }

    items.push({
      serial: device.serial,
      deviceName: device.model,
      isEmulator: device.isEmulator,
      pkg,
      remoteRelPath,
      accessMode: modeRaw === 'root' ? 'root' : 'run-as',
      sizeBytes,
      mtimeMs: mtimeSec > 0 ? mtimeSec * 1000 : 0
    });
  }
  return items;
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

  const files = perDevice
    .flat()
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

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
