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
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  ButtonGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Progress,
  Table
} from 'reactstrap';
import Realm from 'realm';

import { analyzeSchemaWithAi } from '../../services/ai';
import { saveEncryptionKeyForPath } from '../../services/encryption-keys';
import { Language, SchemaExporter } from '../../services/schema-export';
import { AI_PROVIDER_LABELS, settings } from '../../services/settings';

import { ClassFocussedHandler } from '.';

export interface IDatabaseOverviewModalProps {
  classes: Realm.ObjectSchema[];
  getSchemaLength: (name: string, isAsymmetric?: boolean) => number;
  isOpen: boolean;
  onClassFocussed: ClassFocussedHandler;
  readOnly: boolean;
  realm?: Realm;
  toggle: () => void;
}

const CODE_LANGUAGES: Language[] = [
  Language.TS,
  Language.Swift,
  Language.Kotlin,
  Language.JS,
  Language.CS,
  Language.Java
];

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
};

export const DatabaseOverviewModal = ({
  classes,
  getSchemaLength,
  isOpen,
  onClassFocussed,
  readOnly,
  realm,
  toggle
}: IDatabaseOverviewModalProps) => {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'stats' | 'code' | 'ai'>('stats');
  const [selectedLang, setSelectedLang] = useState<Language>(Language.TS);
  const [copiedCode, setCopiedCode] = useState(false);
  const [aiReport, setAiReport] = useState<string>('');
  const [aiError, setAiError] = useState<string | null>(null);
  const [isAnalyzingAi, setIsAnalyzingAi] = useState(false);
  const [copiedAi, setCopiedAi] = useState(false);
  const aiAbortRef = useRef<AbortController | null>(null);

  if (!isOpen || !realm) {
    return null;
  }

  let fileSize = 'Unknown';
  try {
    const stat = fs.statSync(realm.path);
    fileSize = formatBytes(stat.size);
  } catch {
    // ignore
  }

  const handleQuickBackup = () => {
    try {
      const ext = path.extname(realm.path) || '.realm';
      const base = path.basename(realm.path, ext);
      const dir = path.dirname(realm.path);
      const dest = remote.dialog.showSaveDialogSync({
        defaultPath: path.join(dir, `${base}.backup${ext}`),
        message: 'Save a backup copy of this Realm file'
      });
      if (dest) {
        fs.copyFileSync(realm.path, dest);
        setStatusMessage(`Backup saved: ${path.basename(dest)}`);
      }
    } catch (err) {
      setStatusMessage(
        `Backup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleSaveDecryptedCopy = () => {
    try {
      const ext = path.extname(realm.path) || '.realm';
      const base = path.basename(realm.path, ext);
      const dir = path.dirname(realm.path);
      const dest = remote.dialog.showSaveDialogSync({
        defaultPath: path.join(dir, `${base}.decrypted${ext}`),
        message: 'Save an unencrypted (decrypted) copy of this Realm file'
      });
      if (dest) {
        if (fs.existsSync(dest)) {
          fs.removeSync(dest);
        }
        realm.writeCopyTo({ path: dest });
        setStatusMessage(`Decrypted copy saved: ${path.basename(dest)}`);
      }
    } catch (err) {
      setStatusMessage(
        `Save decrypted copy failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleSaveEncryptedCopy = () => {
    try {
      const ext = path.extname(realm.path) || '.realm';
      const base = path.basename(realm.path, ext);
      const dir = path.dirname(realm.path);
      const dest = remote.dialog.showSaveDialogSync({
        defaultPath: path.join(dir, `${base}.encrypted${ext}`),
        message:
          'Save an encrypted copy (a 128-hex key will be generated & copied to Clipboard)'
      });
      if (dest) {
        if (fs.existsSync(dest)) {
          fs.removeSync(dest);
        }
        const hexKey = crypto.randomBytes(64).toString('hex');
        realm.writeCopyTo({
          path: dest,
          encryptionKey: Buffer.from(hexKey, 'hex')
        });
        saveEncryptionKeyForPath(dest, hexKey, path.basename(dest));
        void navigator.clipboard.writeText(hexKey);
        setStatusMessage(
          `Encrypted copy saved (${path.basename(dest)}) — Key copied to Clipboard & saved to Key Vault!`
        );
      }
    } catch (err) {
      setStatusMessage(
        `Save encrypted copy failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleCompactDatabase = () => {
    if (realm.isInTransaction) {
      setStatusMessage(
        'Please commit or cancel your active transaction before compacting.'
      );
      return;
    }
    try {
      const beforeBytes = fs.statSync(realm.path).size;
      const didCompact = realm.compact();
      const afterBytes = fs.statSync(realm.path).size;
      const saved = Math.max(0, beforeBytes - afterBytes);
      if (didCompact) {
        setStatusMessage(
          `Compacted: ${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)} (Saved ${formatBytes(saved)})`
        );
      } else {
        setStatusMessage(
          'File is currently open by another process or already optimal.'
        );
      }
    } catch (err) {
      setStatusMessage(
        `Compact failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  let generatedSchemaCode = '';
  if (activeTab === 'code') {
    try {
      const exporter = SchemaExporter(selectedLang);
      const files = exporter.exportSchema(realm);
      generatedSchemaCode = files
        .map((f) => `// === ${f.filename} ===\n${f.content}`)
        .join('\n\n');
    } catch (err) {
      generatedSchemaCode = `// Failed to generate schema code: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const handleCopySchemaCode = () => {
    void navigator.clipboard.writeText(generatedSchemaCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1200);
  };

  const classStats = classes
    .filter((c) => !c.name.startsWith('__'))
    .map((schema) => {
      const count = schema.embedded
        ? 0
        : getSchemaLength(schema.name, schema.asymmetric);
      const propertyCount = Object.keys(schema.properties).length;
      return {
        name: schema.name,
        embedded: !!schema.embedded,
        asymmetric: !!schema.asymmetric,
        primaryKey: schema.primaryKey,
        propertyCount,
        count
      };
    })
    .sort((a, b) => {
      if (a.embedded !== b.embedded) {
        return a.embedded ? 1 : -1;
      }
      return b.count - a.count;
    });

  const totalObjects = classStats.reduce((sum, item) => sum + item.count, 0);
  const embeddedCount = classStats.filter((c) => c.embedded).length;
  const standardCount = classStats.length - embeddedCount;
  const aiConfig = settings.getAiSettings();

  const handleCancelAi = () => {
    if (aiAbortRef.current) {
      aiAbortRef.current.abort();
      aiAbortRef.current = null;
    }
    setIsAnalyzingAi(false);
  };

  const handleAnalyzeSchema = async () => {
    if (aiAbortRef.current) {
      aiAbortRef.current.abort();
    }
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setIsAnalyzingAi(true);
    setAiError(null);
    setCopiedAi(false);

    const objectCounts: Record<string, number> = {};
    for (const item of classStats) {
      objectCounts[item.name] = item.count;
    }

    try {
      const report = await analyzeSchemaWithAi({
        classes,
        objectCounts,
        signal: controller.signal
      });
      if (!controller.signal.aborted) {
        setAiReport(report);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setAiError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setIsAnalyzingAi(false);
      }
    }
  };

  return (
    <Modal isOpen={isOpen} toggle={toggle} onClosed={handleCancelAi} size="lg">
      <ModalHeader toggle={toggle}>
        <i className="fa fa-pie-chart" aria-hidden="true" /> Database Overview,
        Encryption &amp; Schema Code
      </ModalHeader>
      <ModalBody>
        <div className="d-flex justify-content-between align-items-center mb-3">
          <ButtonGroup size="sm">
            <Button
              color={activeTab === 'stats' ? 'primary' : 'secondary'}
              onClick={() => setActiveTab('stats')}
            >
              <i className="fa fa-table" aria-hidden="true" /> Storage &amp;
              Classes
            </Button>
            <Button
              color={activeTab === 'code' ? 'primary' : 'secondary'}
              onClick={() => setActiveTab('code')}
            >
              <i className="fa fa-code" aria-hidden="true" /> Schema Code
              Preview
            </Button>
            <Button
              color={activeTab === 'ai' ? 'primary' : 'secondary'}
              onClick={() => setActiveTab('ai')}
            >
              <i className="fa fa-magic" aria-hidden="true" /> AI Schema Advisor
            </Button>
          </ButtonGroup>

          {activeTab === 'code' ? (
            <div className="d-flex gap-2 align-items-center">
              <ButtonGroup size="sm">
                {CODE_LANGUAGES.map((lang) => (
                  <Button
                    key={lang}
                    color={selectedLang === lang ? 'info' : 'secondary'}
                    onClick={() => setSelectedLang(lang)}
                  >
                    {lang}
                  </Button>
                ))}
              </ButtonGroup>
              <Button
                size="sm"
                color="primary"
                onClick={handleCopySchemaCode}
              >
                <i
                  className={`fa ${copiedCode ? 'fa-check' : 'fa-clone'}`}
                  aria-hidden="true"
                />{' '}
                {copiedCode ? 'Copied!' : 'Copy Code'}
              </Button>
            </div>
          ) : null}
        </div>

        {statusMessage ? (
          <div className="RealmBrowser__OverviewPath">
            <strong>Status:</strong> {statusMessage}
          </div>
        ) : null}

        {activeTab === 'stats' ? (
          <>
            <div className="RealmBrowser__OverviewSummary">
              <div className="RealmBrowser__OverviewCard">
                <div className="RealmBrowser__OverviewLabel">File Size</div>
                <div className="RealmBrowser__OverviewValue">{fileSize}</div>
              </div>
              <div className="RealmBrowser__OverviewCard">
                <div className="RealmBrowser__OverviewLabel">Total Objects</div>
                <div className="RealmBrowser__OverviewValue">
                  {totalObjects.toLocaleString()}
                </div>
              </div>
              <div className="RealmBrowser__OverviewCard">
                <div className="RealmBrowser__OverviewLabel">Classes</div>
                <div className="RealmBrowser__OverviewValue">
                  {standardCount} Standard / {embeddedCount} Embedded
                </div>
              </div>
              <div className="RealmBrowser__OverviewCard">
                <div className="RealmBrowser__OverviewLabel">
                  Schema Version
                </div>
                <div className="RealmBrowser__OverviewValue">
                  v{realm.schemaVersion} (
                  {readOnly ? 'Read-Only' : 'Read/Write'})
                </div>
              </div>
            </div>

            <div className="RealmBrowser__OverviewPath" title={realm.path}>
              <strong>Path:</strong> <code>{realm.path}</code>
            </div>

            <div className="RealmBrowser__OverviewTableWrap">
              <Table size="sm" hover responsive>
                <thead>
                  <tr>
                    <th>Class Name</th>
                    <th>Type</th>
                    <th>Primary Key</th>
                    <th>Properties</th>
                    <th>Records</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {classStats.map((item) => {
                    const pct =
                      totalObjects > 0
                        ? Math.round((item.count / totalObjects) * 100)
                        : 0;
                    return (
                      <tr
                        key={item.name}
                        className="RealmBrowser__OverviewRow"
                        onClick={() => {
                          onClassFocussed(item.name);
                          toggle();
                        }}
                        title={`Click to open ${item.name}`}
                      >
                        <td>
                          <strong>{item.name}</strong>
                        </td>
                        <td>
                          {item.embedded ? (
                            <Badge color="secondary">Embedded</Badge>
                          ) : item.asymmetric ? (
                            <Badge color="info">Asymmetric</Badge>
                          ) : (
                            <Badge color="primary">Standard</Badge>
                          )}
                        </td>
                        <td>
                          {item.primaryKey ? (
                            <code>{item.primaryKey}</code>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td>{item.propertyCount}</td>
                        <td>
                          {item.embedded ? (
                            <span className="text-muted">—</span>
                          ) : (
                            item.count.toLocaleString()
                          )}
                        </td>
                        <td className="RealmBrowser__OverviewBarCell">
                          {!item.embedded ? (
                            <div className="RealmBrowser__OverviewBar">
                              <Progress value={pct} color="info" />
                              <span>{pct}%</span>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          </>
        ) : activeTab === 'code' ? (
          <pre
            style={{
              maxHeight: '420px',
              overflow: 'auto',
              marginBottom: 0
            }}
          >
            {generatedSchemaCode}
          </pre>
        ) : (
          <div>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <div className="small text-muted">
                Provider:{' '}
                <Badge color="secondary">
                  {AI_PROVIDER_LABELS[aiConfig.provider]} · {aiConfig.model}
                </Badge>{' '}
                <span className="ml-2">
                  <i className="fa fa-lock" aria-hidden="true" /> Schema &amp;
                  row counts only
                </span>
              </div>
              <div className="d-flex align-items-center">
                {aiReport && (
                  <Button
                    size="sm"
                    color="secondary"
                    className="mr-2"
                    onClick={() => {
                      void navigator.clipboard.writeText(aiReport);
                      setCopiedAi(true);
                      setTimeout(() => setCopiedAi(false), 1200);
                    }}
                  >
                    <i
                      className={`fa ${copiedAi ? 'fa-check' : 'fa-copy'}`}
                      aria-hidden="true"
                    />{' '}
                    {copiedAi ? 'Copied!' : 'Copy Report'}
                  </Button>
                )}
                {isAnalyzingAi ? (
                  <Button size="sm" color="danger" onClick={handleCancelAi}>
                    Cancel
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    color="primary"
                    onClick={() => void handleAnalyzeSchema()}
                  >
                    <i className="fa fa-magic" aria-hidden="true" />{' '}
                    {aiReport ? 'Re-analyze Schema' : 'Analyze Schema'}
                  </Button>
                )}
              </div>
            </div>

            {aiError && (
              <Alert color="danger" className="py-2 px-3 small">
                {aiError}
              </Alert>
            )}

            {isAnalyzingAi && !aiReport && (
              <Alert color="info" className="py-2 px-3 small">
                <i className="fa fa-spinner fa-spin" aria-hidden="true" />{' '}
                Analyzing {classStats.length} classes and relationships with{' '}
                <strong>{aiConfig.model}</strong>...
              </Alert>
            )}

            {aiReport ? (
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  maxHeight: '380px',
                  overflow: 'auto',
                  marginBottom: 0
                }}
              >
                {aiReport}
              </pre>
            ) : !isAnalyzingAi && !aiError ? (
              <div className="text-muted small py-4 text-center">
                Click <strong>Analyze Schema</strong> to get class relationship
                summaries, index recommendations, and schema design notes.
              </div>
            ) : null}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          color="secondary"
          size="sm"
          onClick={() => electron.shell.showItemInFolder(realm.path)}
          title="Reveal Realm file in Finder / Explorer"
        >
          <i className="fa fa-folder-open" aria-hidden="true" /> Reveal in
          Finder
        </Button>
        <Button color="secondary" size="sm" onClick={handleQuickBackup}>
          <i className="fa fa-copy" aria-hidden="true" /> Quick Backup...
        </Button>
        <Button color="secondary" size="sm" onClick={handleSaveDecryptedCopy}>
          <i className="fa fa-unlock" aria-hidden="true" /> Save Decrypted
          Copy...
        </Button>
        <Button color="secondary" size="sm" onClick={handleSaveEncryptedCopy}>
          <i className="fa fa-lock" aria-hidden="true" /> Save Encrypted Copy...
        </Button>
        {!readOnly ? (
          <Button color="primary" size="sm" onClick={handleCompactDatabase}>
            <i className="fa fa-compress" aria-hidden="true" /> Compact
          </Button>
        ) : null}
        <Button color="secondary" size="sm" onClick={toggle}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
