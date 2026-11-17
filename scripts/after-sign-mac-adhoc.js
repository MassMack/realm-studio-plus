/*
 * electron-builder `afterSign` hook for macOS.
 *
 * When Developer ID signing is unavailable (for example CI with
 * `CSC_IDENTITY_AUTO_DISCOVERY=false`), electron-builder skips `codesign`
 * completely, leaving Electron's upstream stub signature without
 * `_CodeSignature/CodeResources` while Info.plist/app.asar have changed.
 * macOS Gatekeeper then rejects quarantined downloads as "damaged" with:
 *   "code has no resources but signature indicates they must be present"
 *
 * This hook applies a valid inside-out ad-hoc signature (`codesign --sign -`)
 * whenever no Developer ID Authority is present, and verifies the bundle with
 * `codesign --verify --deep --strict`.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCodesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' });
}

function getCodesignDetails(targetPath) {
  try {
    return execFileSync('codesign', ['-dvvv', targetPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

function hasDeveloperIdAuthority(appPath) {
  const details = getCodesignDetails(appPath);
  const match = /^Authority=(.+)$/m.exec(details);
  return Boolean(match && match[1].trim().length > 0);
}

function adhocSign(targetPath) {
  runCodesign(['--force', '--sign', '-', targetPath]);
}

function walkFiles(dirPath, visitor) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  const entries = fs.readdirSync(dirPath);
  for (const name of entries) {
    const full = path.join(dirPath, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(full, visitor);
    } else if (stat.isFile()) {
      visitor(full, stat);
    }
  }
}

function isMachOExecutable(filePath, stat) {
  if ((stat.mode & 0o111) !== 0) {
    return true;
  }
  const ext = path.extname(filePath);
  return ext === '.dylib' || ext === '.node' || ext === '.so';
}

function signUnpackedBinaries(appPath) {
  const unpackedDir = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked'
  );
  walkFiles(unpackedDir, (filePath) => {
    const ext = path.extname(filePath);
    if (ext === '.node' || ext === '.dylib' || ext === '.so') {
      adhocSign(filePath);
    }
  });
}

function signFrameworksAndHelpers(appPath) {
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  if (!fs.existsSync(frameworksDir)) {
    return;
  }
  const entries = fs.readdirSync(frameworksDir);

  // 1. Sign nested libraries/helpers inside each .framework, then sign the .framework bundle
  for (const name of entries) {
    if (!name.endsWith('.framework')) {
      continue;
    }
    const fwPath = path.join(frameworksDir, name);
    const fwName = path.basename(name, '.framework');
    walkFiles(fwPath, (filePath, stat) => {
      if (path.basename(filePath) === fwName) {
        return;
      }
      if (isMachOExecutable(filePath, stat)) {
        adhocSign(filePath);
      }
    });
    adhocSign(fwPath);
  }

  // 2. Sign nested helper .app bundles
  for (const name of entries) {
    if (!name.endsWith('.app')) {
      continue;
    }
    const helperAppPath = path.join(frameworksDir, name);
    adhocSign(helperAppPath);
  }
}

function resolveAppPath(context) {
  const candidate = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const found = fs
    .readdirSync(context.appOutDir)
    .find((entry) => entry.endsWith('.app'));
  if (!found) {
    throw new Error(`No .app bundle found in ${context.appOutDir}`);
  }
  return path.join(context.appOutDir, found);
}

/**
 * electron-builder afterSign hook.
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }
  const appPath = resolveAppPath(context);
  if (hasDeveloperIdAuthority(appPath)) {
    console.log(
      `[afterSign] Real signing authority detected on ${path.basename(appPath)}; skipping ad-hoc signing.`
    );
    return;
  }

  console.log(
    `[afterSign] Applying inside-out ad-hoc macOS signature to ${path.basename(appPath)}...`
  );
  signUnpackedBinaries(appPath);
  signFrameworksAndHelpers(appPath);
  adhocSign(appPath);

  runCodesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log(
    `[afterSign] Verified ad-hoc signature for ${path.basename(appPath)}.`
  );
};
