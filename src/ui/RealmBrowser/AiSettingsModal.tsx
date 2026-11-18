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
import * as remote from '@electron/remote';
import path from 'path';
import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  ButtonGroup,
  FormGroup,
  Input,
  InputGroup,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Progress
} from 'reactstrap';
import Realm from 'realm';

import {
  listActiveRealmsPublic,
  listActiveRealmSessions
} from '../../services/active-realms';
import {
  getAiApiKey,
  getLocalModelRecommendation,
  IOllamaPullProgress,
  isApiKeyEncryptionAvailable,
  isOllamaModelInstalled,
  listOllamaModels,
  pullOllamaModel,
  setAiApiKey,
  testAiConnection
} from '../../services/ai';
import {
  indexProjectSourceDir,
  IRealmKnowledgeBase,
  loadKnowledgeBaseForRealm,
  saveKnowledgeBase
} from '../../services/ai-knowledge-base';
import { getCandidateKeysForPath } from '../../services/encryption-keys';
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  AiProvider,
  DEFAULT_AI_MODELS,
  IAiSettings,
  settings
} from '../../services/settings';

export type AiSettingsModalTab = 'ai' | 'kb' | 'mcp';

export interface IAiSettingsModalProps {
  activeClassName?: string;
  classes?: Realm.ObjectSchema[];
  initialTab?: AiSettingsModalTab;
  isOpen: boolean;
  onSaved?: (saved: IAiSettings) => void;
  realm?: Realm;
  toggle: () => void;
}

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

const MODEL_SUGGESTIONS: Readonly<Record<AiProvider, string[]>> = {
  ollama: [
    'qwen3.5:9b',
    'qwen3:8b',
    'qwen3.5:4b',
    'qwen3:14b',
    'qwen2.5:7b'
  ],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest']
};

type McpClientFormat = 'vscode' | 'mcpServers';

let cachedMcpRuntimePaths: { nodeCommand: string; bundlePath: string } | null =
  null;

function resolveMcpRuntimePaths(): { nodeCommand: string; bundlePath: string } {
  if (cachedMcpRuntimePaths) {
    return cachedMcpRuntimePaths;
  }
  let bundlePath = 'build/mcp.bundle.js';
  try {
    bundlePath = path.join(remote.app.getAppPath(), 'build', 'mcp.bundle.js');
  } catch {
    bundlePath = path.resolve(process.cwd(), 'build', 'mcp.bundle.js');
  }

  let nodeCommand = 'node';
  try {
    const resolved = execFileSync('which', ['node'], {
      encoding: 'utf8',
      timeout: 1000
    }).trim();
    if (resolved) {
      nodeCommand = resolved;
    }
  } catch {
    // fallback to 'node' on PATH
  }
  cachedMcpRuntimePaths = { nodeCommand, bundlePath };
  return cachedMcpRuntimePaths;
}

function getPreferredEncryptionKeyHex(): string {
  const active = listActiveRealmSessions();
  for (const s of active) {
    const candidates = getCandidateKeysForPath(s.path);
    if (candidates.length > 0) {
      return candidates[0];
    }
  }
  const fallback = getCandidateKeysForPath('');
  return fallback[0] || '';
}

function buildMcpConfigSnippet(
  format: McpClientFormat,
  includeSavedKey: boolean
): string {
  const { nodeCommand, bundlePath } = resolveMcpRuntimePaths();
  const keyHex = includeSavedKey ? getPreferredEncryptionKeyHex() : '';

  if (format === 'vscode') {
    return JSON.stringify(
      {
        servers: {
          'realm-studio-ultimate': {
            type: 'stdio',
            command: nodeCommand,
            args: [bundlePath],
            env: {
              REALM_ENCRYPTION_KEY: keyHex
            }
          }
        }
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      mcpServers: {
        'realm-studio-ultimate': {
          command: nodeCommand,
          args: [bundlePath],
          env: {
            REALM_ENCRYPTION_KEY: keyHex
          }
        }
      }
    },
    null,
    2
  );
}

export const AiSettingsModal = ({
  activeClassName,
  classes = [],
  initialTab = 'ai',
  isOpen,
  onSaved,
  realm,
  toggle
}: IAiSettingsModalProps) => {
  const [selectedTab, setSelectedTab] = useState<AiSettingsModalTab | null>(null);
  const activeTab = selectedTab ?? initialTab;
  const [mcpFormat, setMcpFormat] = useState<McpClientFormat>('vscode');
  const [includeSavedKeyInEnv, setIncludeSavedKeyInEnv] = useState(false);
  const [openRealmsCount, setOpenRealmsCount] = useState(0);
  const [activeRealmName, setActiveRealmName] = useState<string | null>(null);
  const [hasAutoUnlockKey, setHasAutoUnlockKey] = useState(false);
  const [form, setForm] = useState<IAiSettings>(() => settings.getAiSettings());
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaReachable, setOllamaReachable] = useState<boolean | null>(null);
  const [isScanningOllama, setIsScanningOllama] = useState(false);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<IOllamaPullProgress | null>(
    null
  );
  const pullAbortRef = useRef<AbortController | null>(null);
  const modelRec = useMemo(() => getLocalModelRecommendation(), []);
  const [isTesting, setIsTesting] = useState(false);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const [kb, setKb] = useState<IRealmKnowledgeBase | null>(null);
  const [kbClassName, setKbClassName] = useState('');
  const [kbStatus, setKbStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const nonSystemClasses = classes.filter((c) => !c.name.startsWith('__'));

  const scanOllamaQuietly = async (targetUrl: string) => {
    setIsScanningOllama(true);
    try {
      const models = await listOllamaModels(targetUrl);
      setOllamaModels(models);
      setOllamaReachable(true);
    } catch {
      setOllamaModels([]);
      setOllamaReachable(false);
    } finally {
      setIsScanningOllama(false);
    }
  };

  const handleOpened = () => {
    const current = settings.getAiSettings();
    setSelectedTab(null);
    setForm(current);
    setApiKey(getAiApiKey(current.provider));
    setShowKey(false);
    setTestResult(null);
    setOllamaModels([]);
    setOllamaReachable(null);
    setPullingModel(null);
    setPullProgress(null);
    setCopiedMcp(false);
    setKbStatus(null);
    if (current.provider === 'ollama') {
      void scanOllamaQuietly(current.ollamaUrl);
    }

    const active = listActiveRealmsPublic();
    setOpenRealmsCount(active.length);
    setActiveRealmName(active[0] ? path.basename(active[0].path) : null);
    setHasAutoUnlockKey(getPreferredEncryptionKeyHex().length > 0);

    const realmPath = realm?.path || active[0]?.path || '';
    if (realmPath || nonSystemClasses.length > 0) {
      const loaded = loadKnowledgeBaseForRealm(realmPath, classes);
      setKb(loaded);
      const defaultCls =
        (activeClassName &&
        nonSystemClasses.some((c) => c.name === activeClassName)
          ? activeClassName
          : nonSystemClasses[0]?.name) || '';
      setKbClassName(defaultCls);
    } else {
      setKb(null);
      setKbClassName('');
    }
  };

  const mcpConfigJson = buildMcpConfigSnippet(mcpFormat, includeSavedKeyInEnv);

  const handleProviderChange = (provider: AiProvider) => {
    const isUsingDefaultModel = Object.values(DEFAULT_AI_MODELS).includes(
      form.model
    );
    setForm((prev) => ({
      ...prev,
      provider,
      model: isUsingDefaultModel ? DEFAULT_AI_MODELS[provider] : prev.model
    }));
    setApiKey(getAiApiKey(provider));
    setTestResult(null);
  };

  const handleScanOllama = async () => {
    setIsScanningOllama(true);
    setTestResult(null);
    try {
      const models = await listOllamaModels(form.ollamaUrl);
      setOllamaModels(models);
      setOllamaReachable(true);
      if (models.length === 0) {
        setTestResult({
          ok: true,
          message:
            'Connected to Ollama. No local models are installed yet — choose one below to download if desired, or skip Local AI.'
        });
      } else if (!isOllamaModelInstalled(models, form.model)) {
        setTestResult({
          ok: true,
          message: `Connected to Ollama (${models.length} installed: ${models.slice(0, 4).join(', ')}). "${form.model}" is not downloaded yet.`
        });
      } else {
        setTestResult({
          ok: true,
          message: `Connected to Ollama. Model "${form.model}" is installed and ready.`
        });
      }
    } catch (err) {
      setOllamaModels([]);
      setOllamaReachable(false);
      setTestResult({
        ok: false,
        message: `Could not reach Ollama at ${form.ollamaUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`
      });
    } finally {
      setIsScanningOllama(false);
    }
  };

  const handlePullModel = async (tag: string) => {
    if (pullAbortRef.current) {
      pullAbortRef.current.abort();
    }
    const controller = new AbortController();
    pullAbortRef.current = controller;
    setPullingModel(tag);
    setPullProgress({ status: 'Starting download...' });
    setTestResult(null);

    try {
      await pullOllamaModel({
        ollamaUrl: form.ollamaUrl,
        model: tag,
        signal: controller.signal,
        onProgress: (p) => {
          if (!controller.signal.aborted) {
            setPullProgress(p);
          }
        }
      });
      if (!controller.signal.aborted) {
        setForm((prev) => ({ ...prev, model: tag }));
        const refreshed = await listOllamaModels(form.ollamaUrl).catch(
          () => ollamaModels
        );
        setOllamaModels(refreshed);
        setOllamaReachable(true);
        setTestResult({
          ok: true,
          message: `Model "${tag}" downloaded and selected cleanly.`
        });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setTestResult({
          ok: false,
          message: `Cancelled downloading "${tag}".`
        });
      } else {
        setTestResult({
          ok: false,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      if (pullAbortRef.current === controller) {
        pullAbortRef.current = null;
        setPullingModel(null);
        setPullProgress(null);
      }
    }
  };

  const handleCancelPull = () => {
    if (pullAbortRef.current) {
      pullAbortRef.current.abort();
      pullAbortRef.current = null;
    }
    setPullingModel(null);
    setPullProgress(null);
  };

  const handleOpenOllamaDownloadPage = () => {
    try {
      void remote.shell.openExternal(OLLAMA_DOWNLOAD_URL);
    } catch {
      // ignore outside electron
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    const result = await testAiConnection(form, apiKey);
    setTestResult({ ok: result.ok, message: result.message });
    setIsTesting(false);
  };

  const handleBrowseSourceDir = async () => {
    if (!kb) {
      return;
    }
    try {
      const res = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
        title: 'Select App Source Folder (Swift / Kotlin / Dart / TS)',
        properties: ['openDirectory']
      });
      if (!res.canceled && res.filePaths[0]) {
        const chosenDir = res.filePaths[0];
        const { symbols, scannedFiles } = indexProjectSourceDir(
          chosenDir,
          classes
        );
        const updated = saveKnowledgeBase({
          ...kb,
          sourceDir: chosenDir,
          indexedSymbols: symbols,
          lastIndexedAt: new Date().toISOString()
        });
        setKb(updated);
        setKbStatus({
          ok: true,
          message: `Indexed ${symbols.length} model/enum/doc snippets from ${scannedFiles} source files.`
        });
      }
    } catch (err) {
      setKbStatus({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const handleIndexSourceDir = () => {
    if (!kb || !kb.sourceDir?.trim()) {
      setKbStatus({
        ok: false,
        message: 'Please select or enter a local source folder first.'
      });
      return;
    }
    try {
      const { symbols, scannedFiles } = indexProjectSourceDir(
        kb.sourceDir,
        classes
      );
      const updated = saveKnowledgeBase({
        ...kb,
        indexedSymbols: symbols,
        lastIndexedAt: new Date().toISOString()
      });
      setKb(updated);
      setKbStatus({
        ok: true,
        message: `Indexed ${symbols.length} model/enum/doc snippets from ${scannedFiles} source files.`
      });
    } catch (err) {
      setKbStatus({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const updateKbClassDescription = (className: string, description: string) => {
    setKb((prev) => {
      if (!prev || !className) {
        return prev;
      }
      const existing = prev.classes[className] || {};
      return {
        ...prev,
        classes: {
          ...prev.classes,
          [className]: {
            ...existing,
            description
          }
        }
      };
    });
  };

  const updateKbPropertyDescription = (
    className: string,
    propName: string,
    description: string
  ) => {
    setKb((prev) => {
      if (!prev || !className || !propName) {
        return prev;
      }
      const existing = prev.classes[className] || {};
      const nextProps = { ...(existing.properties || {}) };
      if (description.trim()) {
        nextProps[propName] = description;
      } else {
        delete nextProps[propName];
      }
      return {
        ...prev,
        classes: {
          ...prev.classes,
          [className]: {
            ...existing,
            properties: nextProps
          }
        }
      };
    });
  };

  const handleSave = () => {
    const saved = settings.setAiSettings(form);
    if (form.provider !== 'ollama') {
      setAiApiKey(form.provider, apiKey);
    }
    if (kb) {
      saveKnowledgeBase(kb);
    }
    if (onSaved) {
      onSaved(saved);
    }
    toggle();
  };

  const handleSaveKbOnly = (closeAfter = false) => {
    if (!kb) {
      return;
    }
    const saved = saveKnowledgeBase(kb);
    setKb(saved);
    setKbStatus({
      ok: true,
      message: 'Domain Knowledge Base saved for both Local AI and MCP Schema.'
    });
    if (closeAfter) {
      toggle();
    }
  };

  const encryptedSupported = isApiKeyEncryptionAvailable();
  const suggestedModels =
    form.provider === 'ollama' && ollamaModels.length > 0
      ? ollamaModels
      : MODEL_SUGGESTIONS[form.provider];

  const selectedSchema = nonSystemClasses.find((c) => c.name === kbClassName);
  const selectedProps = selectedSchema
    ? Object.keys(selectedSchema.properties)
    : [];

  return (
    <Modal
      isOpen={isOpen}
      toggle={toggle}
      onOpened={handleOpened}
      onClosed={() => {
        if (pullAbortRef.current) {
          pullAbortRef.current.abort();
          pullAbortRef.current = null;
          setPullingModel(null);
          setPullProgress(null);
        }
        setSelectedTab(null);
      }}
      size="lg"
    >
      <ModalHeader toggle={toggle}>
        <i className="fa fa-sliders" aria-hidden="true" /> AI Assistant, Domain
        Knowledge Base &amp; MCP Settings
      </ModalHeader>
      <ModalBody>
        <div className="mb-3">
          <ButtonGroup size="sm">
            <Button
              color={activeTab === 'ai' ? 'primary' : 'secondary'}
              onClick={() => setSelectedTab('ai')}
            >
              <i className="fa fa-magic" aria-hidden="true" /> AI Provider
            </Button>
            <Button
              color={activeTab === 'kb' ? 'primary' : 'secondary'}
              onClick={() => setSelectedTab('kb')}
            >
              <i className="fa fa-book" aria-hidden="true" /> Domain Knowledge
              Base
            </Button>
            <Button
              color={activeTab === 'mcp' ? 'primary' : 'secondary'}
              onClick={() => setSelectedTab('mcp')}
            >
              <i className="fa fa-plug" aria-hidden="true" /> MCP Server
              (Read-Only)
            </Button>
          </ButtonGroup>
        </div>

        {activeTab === 'ai' ? (
          <>
            <Alert color="info" className="py-2 px-3 small mb-3">
              <i className="fa fa-shield" aria-hidden="true" />{' '}
              <strong>Privacy-by-Design:</strong> Cloud providers only receive
              schema metadata &amp; domain notes (never row data). Local Ollama
              stays 100% offline on your Mac.
            </Alert>

            <FormGroup>
              <Label for="ai-provider-select">AI Provider</Label>
              <Input
                id="ai-provider-select"
                type="select"
                bsSize="sm"
                value={form.provider}
                onChange={(e) =>
                  handleProviderChange(e.target.value as AiProvider)
                }
              >
                {AI_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {AI_PROVIDER_LABELS[p]}
                  </option>
                ))}
              </Input>
            </FormGroup>

            {form.provider === 'ollama' && (
              <FormGroup>
                <Label for="ai-ollama-url">Ollama Endpoint URL</Label>
                <InputGroup size="sm">
                  <Input
                    id="ai-ollama-url"
                    value={form.ollamaUrl}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        ollamaUrl: e.target.value
                      }))
                    }
                    placeholder="http://127.0.0.1:11434"
                  />
                  <Button
                    color="secondary"
                    onClick={handleScanOllama}
                    disabled={isScanningOllama}
                  >
                    <i className="fa fa-refresh" aria-hidden="true" />{' '}
                    {isScanningOllama ? 'Scanning...' : 'Scan Models'}
                  </Button>
                </InputGroup>
              </FormGroup>
            )}

            {form.provider === 'openai' && (
              <FormGroup>
                <Label for="ai-openai-url">
                  Base URL (OpenAI or LM Studio)
                </Label>
                <Input
                  id="ai-openai-url"
                  bsSize="sm"
                  value={form.openaiBaseUrl}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      openaiBaseUrl: e.target.value
                    }))
                  }
                  placeholder="https://api.openai.com/v1 or http://127.0.0.1:1234/v1"
                />
              </FormGroup>
            )}

            <FormGroup>
              <Label for="ai-model-input">Model</Label>
              <Input
                id="ai-model-input"
                bsSize="sm"
                value={form.model}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, model: e.target.value }))
                }
                placeholder={DEFAULT_AI_MODELS[form.provider]}
              />
              <div className="d-flex flex-wrap gap-1 mt-2">
                {suggestedModels.slice(0, 6).map((m) => (
                  <Badge
                    key={m}
                    color={form.model === m ? 'primary' : 'secondary'}
                    pill
                    style={{
                      cursor: 'pointer',
                      marginRight: 4,
                      marginBottom: 4
                    }}
                    onClick={() => setForm((prev) => ({ ...prev, model: m }))}
                  >
                    {m}
                  </Badge>
                ))}
              </div>
            </FormGroup>

            {form.provider === 'ollama' && (
              <div className="border rounded p-2 mb-3 small">
                <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap">
                  <div>
                    <strong>Optional Local AI Models</strong>{' '}
                    <Badge color="info" className="ml-1">
                      System RAM: {modelRec.ramGb} GB · Recommended:{' '}
                      {modelRec.recommendedTag}
                    </Badge>
                  </div>
                  <span className="text-muted">
                    User choice — never downloaded automatically
                  </span>
                </div>

                {ollamaReachable === false ? (
                  <Alert color="secondary" className="py-2 px-2 small mb-2">
                    <div className="d-flex justify-content-between align-items-center flex-wrap">
                      <span>
                        Ollama is not running yet (optional). Install Ollama
                        only if you want private offline AI, or use Cloud /
                        Copilot MCP instead.
                      </span>
                      <div className="mt-1 mt-sm-0">
                        <Button
                          size="sm"
                          color="primary"
                          className="mr-1"
                          onClick={handleOpenOllamaDownloadPage}
                        >
                          <i
                            className="fa fa-external-link"
                            aria-hidden="true"
                          />{' '}
                          Get Ollama
                        </Button>
                        <Button
                          size="sm"
                          color="secondary"
                          onClick={() => void handleScanOllama()}
                          disabled={isScanningOllama}
                        >
                          Re-Check
                        </Button>
                      </div>
                    </div>
                  </Alert>
                ) : null}

                {modelRec.presets.map((preset) => {
                  const installed = isOllamaModelInstalled(
                    ollamaModels,
                    preset.tag
                  );
                  const isPullingThis = pullingModel === preset.tag;
                  return (
                    <div
                      key={preset.tag}
                      className="d-flex justify-content-between align-items-center py-1 border-top"
                    >
                      <div style={{ minWidth: 0, marginRight: 8 }}>
                        <div>
                          <code>{preset.tag}</code>{' '}
                          <Badge color="secondary" className="ml-1">
                            {preset.approxSizeGb}
                          </Badge>
                          {preset.recommended ? (
                            <Badge color="primary" className="ml-1">
                              Best for {modelRec.ramGb} GB RAM
                            </Badge>
                          ) : null}
                          {installed ? (
                            <Badge color="success" className="ml-1">
                              Installed
                            </Badge>
                          ) : null}
                        </div>
                        <div className="text-muted">{preset.note}</div>
                      </div>
                      <div className="d-flex flex-shrink-0">
                        <Button
                          size="sm"
                          color={form.model === preset.tag ? 'primary' : 'secondary'}
                          outline={form.model !== preset.tag}
                          className="mr-1"
                          onClick={() =>
                            setForm((prev) => ({ ...prev, model: preset.tag }))
                          }
                        >
                          {form.model === preset.tag ? 'Selected' : 'Select'}
                        </Button>
                        {!installed && ollamaReachable !== false ? (
                          <Button
                            size="sm"
                            color="success"
                            outline
                            disabled={Boolean(pullingModel)}
                            onClick={() => void handlePullModel(preset.tag)}
                          >
                            {isPullingThis ? 'Downloading...' : 'Download'}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}

                {pullingModel && pullProgress ? (
                  <div className="mt-2 pt-2 border-top">
                    <div className="d-flex justify-content-between align-items-center mb-1">
                      <span>
                        Downloading <code>{pullingModel}</code>:{' '}
                        {pullProgress.status}
                        {pullProgress.completedBytes !== undefined &&
                        pullProgress.totalBytes
                          ? ` (${(
                              pullProgress.completedBytes /
                              (1024 * 1024)
                            ).toFixed(0)} / ${(
                              pullProgress.totalBytes /
                              (1024 * 1024)
                            ).toFixed(0)} MB)`
                          : ''}
                      </span>
                      <Button
                        size="sm"
                        color="danger"
                        onClick={handleCancelPull}
                      >
                        Cancel
                      </Button>
                    </div>
                    <Progress
                      animated
                      color="info"
                      value={pullProgress.percent ?? 15}
                    />
                  </div>
                ) : null}
              </div>
            )}

            {form.provider === 'ollama' && (
              <FormGroup>
                <Label for="ai-ollama-num-ctx">
                  Ollama Context Window (<code>num_ctx</code>)
                </Label>
                <Input
                  id="ai-ollama-num-ctx"
                  type="select"
                  bsSize="sm"
                  value={form.ollamaNumCtx}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      ollamaNumCtx: Number(e.target.value)
                    }))
                  }
                >
                  <option value={4096}>4,096 tokens (Low RAM)</option>
                  <option value={8192}>
                    8,192 tokens (Recommended for KB + RQL)
                  </option>
                  <option value={16384}>16,384 tokens (Large Schemas)</option>
                </Input>
              </FormGroup>
            )}

            {form.provider !== 'ollama' && (
              <FormGroup>
                <Label for="ai-api-key">
                  API Key{' '}
                  <Badge color={encryptedSupported ? 'success' : 'secondary'}>
                    {encryptedSupported ? 'Keychain Encrypted' : 'Local Storage'}
                  </Badge>
                </Label>
                <InputGroup size="sm">
                  <Input
                    id="ai-api-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      form.provider === 'openai'
                        ? 'sk-... (optional for local LM Studio)'
                        : 'Paste your API key...'
                    }
                  />
                  <Button
                    color="secondary"
                    onClick={() => setShowKey((prev) => !prev)}
                    title={showKey ? 'Hide key' : 'Show key'}
                  >
                    <i
                      className={showKey ? 'fa fa-eye-slash' : 'fa fa-eye'}
                      aria-hidden="true"
                    />
                  </Button>
                </InputGroup>
              </FormGroup>
            )}

            <FormGroup check className="mb-2">
              <Label check className="small">
                <Input
                  type="checkbox"
                  checked={form.enableSelfCorrection}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      enableSelfCorrection: e.target.checked
                    }))
                  }
                />{' '}
                <strong>RQL Self-Correction Loop:</strong> Test generated RQL
                on Realm engine &amp; auto-fix syntax errors (up to 2 retries)
              </Label>
            </FormGroup>

            <FormGroup check className="mb-3">
              <Label check className="small">
                <Input
                  type="checkbox"
                  checked={form.enableLocalDataHints}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      enableLocalDataHints: e.target.checked
                    }))
                  }
                />{' '}
                <strong>On-Device Enum Value Hints (Local AI only):</strong>{' '}
                Sample up to 6 non-PII low-cardinality values so local Ollama
                knows exact stored codes (never sent to cloud APIs)
              </Label>
            </FormGroup>

            <FormGroup className="mb-2">
              <Label for="ai-timeout-select">Request Timeout</Label>
              <Input
                id="ai-timeout-select"
                type="select"
                bsSize="sm"
                value={form.timeoutMs}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    timeoutMs: Number(e.target.value)
                  }))
                }
              >
                <option value={10000}>10 seconds</option>
                <option value={20000}>20 seconds</option>
                <option value={30000}>30 seconds (Default)</option>
                <option value={60000}>60 seconds</option>
                <option value={120000}>120 seconds (Large Local Models)</option>
              </Input>
            </FormGroup>

            {testResult && (
              <Alert
                color={testResult.ok ? 'success' : 'danger'}
                className="py-2 px-3 small mt-3 mb-0"
              >
                {testResult.message}
              </Alert>
            )}
          </>
        ) : activeTab === 'kb' ? (
          <div>
            {!kb ? (
              <Alert color="warning" className="py-2 px-3 small mb-0">
                Open a <code>.realm</code> database first to configure its
                Domain Knowledge Base.
              </Alert>
            ) : (
              <>
                <Alert color="info" className="py-2 px-3 small mb-3">
                  <i className="fa fa-book" aria-hidden="true" />{' '}
                  <strong>Shared Domain Knowledge Base:</strong> Tied to schema
                  fingerprint <code>{kb.schemaHash}</code> (
                  <code>{kb.realmName}</code>) — persists across Simulator UUID
                  and Android temp pulls, and automatically enriches{' '}
                  <strong>Local AI</strong> and <strong>MCP</strong> (
                  <code>get_class_schema</code>).
                </Alert>

                <FormGroup className="mb-2">
                  <Label for="kb-project-notes" className="small font-weight-bold">
                    Project &amp; Business Rules Notes (Thai / English)
                  </Label>
                  <Input
                    id="kb-project-notes"
                    type="textarea"
                    rows={3}
                    bsSize="sm"
                    value={kb.projectNotes}
                    onChange={(e) =>
                      setKb((prev) =>
                        prev ? { ...prev, projectNotes: e.target.value } : prev
                      )
                    }
                    placeholder="e.g. status: 1=Active, 2=Suspended, 9=Cancelled | เวลาที่เก็บใน DB เป็น UTC | ลูกค้า VIP คือ tier == 'GOLD'"
                  />
                </FormGroup>

                <FormGroup className="mb-3">
                  <Label for="kb-source-dir" className="small font-weight-bold">
                    App Source Folder (Optional Local Code/Enum RAG — Swift,
                    Kotlin, Dart, TS, Markdown)
                  </Label>
                  <InputGroup size="sm">
                    <Input
                      id="kb-source-dir"
                      value={kb.sourceDir || ''}
                      onChange={(e) =>
                        setKb((prev) =>
                          prev ? { ...prev, sourceDir: e.target.value } : prev
                        )
                      }
                      placeholder="/path/to/your/mobile-app-repo"
                    />
                    <Button color="secondary" onClick={handleBrowseSourceDir}>
                      Browse...
                    </Button>
                    <Button color="info" onClick={handleIndexSourceDir}>
                      Index Code
                    </Button>
                  </InputGroup>
                  <div className="small text-muted mt-1">
                    Indexed symbols: <strong>{kb.indexedSymbols.length}</strong>
                    {kb.lastIndexedAt
                      ? ` (last indexed ${new Date(kb.lastIndexedAt).toLocaleString()})`
                      : ''}
                  </div>
                </FormGroup>

                {nonSystemClasses.length > 0 && (
                  <div className="mb-3 p-2 border rounded">
                    <div className="d-flex justify-content-between align-items-center mb-2">
                      <strong className="small">
                        Class &amp; Field Descriptions (mapped to AI &amp; MCP)
                      </strong>
                      <Input
                        type="select"
                        bsSize="sm"
                        style={{ maxWidth: 240 }}
                        value={kbClassName}
                        onChange={(e) => setKbClassName(e.target.value)}
                      >
                        {nonSystemClasses.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </Input>
                    </div>

                    {kbClassName && (
                      <>
                        <Input
                          bsSize="sm"
                          className="mb-2"
                          value={kb.classes[kbClassName]?.description || ''}
                          onChange={(e) =>
                            updateKbClassDescription(
                              kbClassName,
                              e.target.value
                            )
                          }
                          placeholder={`Describe ${kbClassName} table purpose...`}
                        />
                        <div
                          style={{
                            maxHeight: 165,
                            overflowY: 'auto',
                            paddingRight: 4
                          }}
                        >
                          {selectedProps.map((propName) => (
                            <div
                              key={propName}
                              className="d-flex align-items-center mb-1"
                            >
                              <code
                                className="small text-truncate mr-2"
                                style={{ width: 150, flexShrink: 0 }}
                                title={propName}
                              >
                                {propName}
                              </code>
                              <Input
                                bsSize="sm"
                                value={
                                  kb.classes[kbClassName]?.properties?.[
                                    propName
                                  ] || ''
                                }
                                onChange={(e) =>
                                  updateKbPropertyDescription(
                                    kbClassName,
                                    propName,
                                    e.target.value
                                  )
                                }
                                placeholder="Field meaning / enum codes..."
                              />
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="d-flex justify-content-between align-items-center small text-muted">
                  <span>
                    Learned Few-Shot RQL Examples:{' '}
                    <strong>{kb.customExamples.length}</strong>
                  </span>
                  <div>
                    {kb.customExamples.length > 0 && (
                      <Button
                        size="sm"
                        color="link"
                        className="text-danger py-0 mr-2"
                        onClick={() =>
                          setKb((prev) =>
                            prev ? { ...prev, customExamples: [] } : prev
                          )
                        }
                      >
                        Clear Examples
                      </Button>
                    )}
                    <Button
                      size="sm"
                      color="info"
                      outline
                      onClick={() => handleSaveKbOnly(false)}
                    >
                      Apply Notes Now
                    </Button>
                  </div>
                </div>

                {kbStatus && (
                  <Alert
                    color={kbStatus.ok ? 'success' : 'danger'}
                    className="py-2 px-3 small mt-2 mb-0"
                  >
                    {kbStatus.message}
                  </Alert>
                )}
              </>
            )}
          </div>
        ) : (
          <div>
            <Alert color="info" className="py-2 px-3 small mb-3">
              <i className="fa fa-link" aria-hidden="true" />{' '}
              <strong>Auto-Linked to Open Windows &amp; Key Vault:</strong>{' '}
              {openRealmsCount > 0 ? (
                <>
                  Active window: <code>{activeRealmName}</code>
                  {openRealmsCount > 1 ? ` (+${openRealmsCount - 1} more)` : ''}.
                </>
              ) : (
                'Omit path to use the most recently opened Realm.'
              )}{' '}
              {hasAutoUnlockKey ? (
                <span>
                  Unlocked/Vault keys are reused locally without putting them in
                  chat.
                </span>
              ) : (
                <span>
                  For encrypted Realms, unlock them here or paste the 128-hex
                  key into <code>REALM_ENCRYPTION_KEY</code>.
                </span>
              )}
            </Alert>

            <div className="d-flex justify-content-between align-items-center mb-2">
              <ButtonGroup size="sm">
                <Button
                  color={mcpFormat === 'vscode' ? 'primary' : 'secondary'}
                  onClick={() => setMcpFormat('vscode')}
                >
                  VS Code (.vscode/mcp.json)
                </Button>
                <Button
                  color={mcpFormat === 'mcpServers' ? 'primary' : 'secondary'}
                  onClick={() => setMcpFormat('mcpServers')}
                >
                  Cursor / Claude / Antigravity
                </Button>
              </ButtonGroup>

              <Button
                size="sm"
                color="primary"
                onClick={() => {
                  void navigator.clipboard.writeText(mcpConfigJson);
                  setCopiedMcp(true);
                  setTimeout(() => setCopiedMcp(false), 1500);
                }}
              >
                <i
                  className={`fa ${copiedMcp ? 'fa-check' : 'fa-copy'}`}
                  aria-hidden="true"
                />{' '}
                {copiedMcp ? 'Copied!' : 'Copy Config'}
              </Button>
            </div>

            <FormGroup check className="mb-2">
              <Label check className="small">
                <Input
                  type="checkbox"
                  checked={includeSavedKeyInEnv}
                  onChange={(e) => setIncludeSavedKeyInEnv(e.target.checked)}
                />{' '}
                Pre-fill active / Vault key into{' '}
                <code>env.REALM_ENCRYPTION_KEY</code> (leave unchecked if
                committing <code>.vscode/mcp.json</code> to Git)
              </Label>
            </FormGroup>

            <pre
              style={{
                fontSize: '12px',
                maxHeight: '185px',
                overflow: 'auto',
                marginBottom: '10px'
              }}
            >
              {mcpConfigJson}
            </pre>

            <div className="small text-muted">
              <strong>Available Tools (9, Read-Only):</strong>{' '}
              <code>get_open_realms</code>,{' '}
              <code>inspect_realm_overview</code>,{' '}
              <code>get_class_schema</code>, <code>query_realm</code>,{' '}
              <code>count_realm_objects</code>,{' '}
              <code>list_simulator_realms</code>,{' '}
              <code>list_android_realms</code>,{' '}
              <code>pull_android_realm</code>, <code>list_recent_realms</code>.{' '}
              Schema tools automatically include your Domain Knowledge Base{' '}
              <code>description</code> annotations.
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        {activeTab === 'ai' ? (
          <>
            <Button
              size="sm"
              color="secondary"
              onClick={handleTest}
              disabled={isTesting}
              className="mr-auto"
            >
              <i className="fa fa-plug" aria-hidden="true" />{' '}
              {isTesting ? 'Testing...' : 'Test Connection'}
            </Button>
            <Button size="sm" color="secondary" onClick={toggle}>
              Cancel
            </Button>
            <Button size="sm" color="primary" onClick={handleSave}>
              Save Settings
            </Button>
          </>
        ) : activeTab === 'kb' ? (
          <>
            <Button size="sm" color="secondary" onClick={toggle}>
              Cancel
            </Button>
            <Button
              size="sm"
              color="primary"
              disabled={!kb}
              onClick={() => handleSaveKbOnly(true)}
            >
              Save Knowledge Base
            </Button>
          </>
        ) : (
          <Button size="sm" color="secondary" onClick={toggle}>
            Close
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
};
