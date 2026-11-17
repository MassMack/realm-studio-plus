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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  ButtonGroup,
  FormGroup,
  Input,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Progress
} from 'reactstrap';
import Realm from 'realm';

import {
  getLocalModelRecommendation,
  IOllamaPullProgress,
  isLocalAiEndpoint,
  isOllamaModelInstalled,
  listOllamaModels,
  pullOllamaModel
} from '../../services/ai';
import {
  AiAssistantMode,
  askAiAssistant,
  IAiChatTurn,
  IAiFoundObjectHit
} from '../../services/ai-assistant';
import {
  loadKnowledgeBaseForRealm,
  recordVerifiedQueryExample
} from '../../services/ai-knowledge-base';
import { validateRqlAgainstRealm } from '../../services/rql-reference';
import { AI_PROVIDER_LABELS, IAiSettings, settings } from '../../services/settings';

export interface IAiQueryModalProps {
  activeClassName?: string;
  classes: Realm.ObjectSchema[];
  currentQuery: string;
  isOpen: boolean;
  onApplyQuery: (query: string, targetClassName?: string) => void;
  onJumpToObject?: (className: string, highlightedObject?: Realm.Object) => void;
  onOpenInSplitView?: (
    className: string,
    highlightedObject?: Realm.Object
  ) => void;
  onOpenKnowledgeBase?: () => void;
  onOpenSettings: () => void;
  realm?: Realm;
  toggle: () => void;
}

interface IModalExchange {
  id: number;
  prompt: string;
  answer: string;
  hits: IAiFoundObjectHit[];
  toolsUsed: string[];
  suggestedRql?: string;
  suggestedClassName?: string;
  capabilityLimited: boolean;
  limitationReason?: string;
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  search_realm_everywhere: 'Global ID & Data Search',
  get_schema_overview: 'Schema & Counts',
  query_class_objects: 'RQL Data Query',
  propose_table_filter: 'Verified RQL Filter',
  generate_rql: 'RQL Generator'
};

function buildSuggestedPrompts(
  classes: Realm.ObjectSchema[],
  activeClassName?: string
): string[] {
  const suggestions: string[] = [
    'สรุปโครงสร้าง Realm นี้และจำนวนข้อมูลแต่ละ Class',
    'วิธีเขียน query วันที่และ array ใน RQL ต่างจาก SQL ยังไง'
  ];

  const schema = classes.find((c) => c.name === activeClassName);
  if (schema && activeClassName) {
    const props = Object.entries(schema.properties).map(([name, raw]) => ({
      name,
      prop:
        typeof raw === 'string'
          ? ({ type: raw } as Realm.ObjectSchemaProperty)
          : (raw as Realm.ObjectSchemaProperty)
    }));
    const pkName = schema.primaryKey;
    const strProp = props.find((p) => p.prop.type === 'string');
    const numProp = props.find(
      (p) =>
        p.prop.type === 'int' ||
        p.prop.type === 'float' ||
        p.prop.type === 'double'
    );
    const dateProp = props.find((p) => p.prop.type === 'date');

    if (pkName) {
      suggestions.unshift(`หา ${activeClassName} ที่ ${pkName} ล่าสุด 5 รายการ`);
    }
    if (strProp) {
      suggestions.push(`หา ${activeClassName} ที่ ${strProp.name} มีคำว่า "test"`);
    } else if (numProp) {
      suggestions.push(`หา ${numProp.name} มากกว่า 0 เรียงจากมากไปน้อย`);
    } else if (dateProp) {
      suggestions.push(`เรียงตาม ${dateProp.name} ล่าสุด 20 แถวแรก`);
    }
  }

  return suggestions.slice(0, 4);
}

export const AiQueryModal = ({
  activeClassName,
  classes,
  currentQuery,
  isOpen,
  onApplyQuery,
  onJumpToObject,
  onOpenInSplitView,
  onOpenKnowledgeBase,
  onOpenSettings,
  realm,
  toggle
}: IAiQueryModalProps) => {
  const [mode, setMode] = useState<AiAssistantMode>('auto');
  const [prompt, setPrompt] = useState('');
  const [exchanges, setExchanges] = useState<IModalExchange[]>([]);
  const [generatedQuery, setGeneratedQuery] = useState('');
  const [targetFilterClass, setTargetFilterClass] = useState<string | undefined>(
    undefined
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('Thinking...');
  const [copied, setCopied] = useState(false);
  const [kbBadgeText, setKbBadgeText] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<IAiSettings>(() =>
    settings.getAiSettings()
  );
  const [installedOllamaModels, setInstalledOllamaModels] = useState<
    string[] | null
  >(null);
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [dismissedSetupBanner, setDismissedSetupBanner] = useState(false);
  const [pullProgress, setPullProgress] = useState<IOllamaPullProgress | null>(
    null
  );
  const [isPullingModel, setIsPullingModel] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const pullAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const nextExchangeIdRef = useRef(1);
  const modelRec = useMemo(() => getLocalModelRecommendation(), []);

  useEffect(() => {
    const unsubscribe = settings.onDidChangeAiSettings((next) => {
      setAiSettings(next);
    });
    return unsubscribe;
  }, []);

  const checkOllamaStatusQuietly = async (cfg: IAiSettings) => {
    if (cfg.provider !== 'ollama') {
      setOllamaOnline(null);
      setInstalledOllamaModels(null);
      return;
    }
    try {
      const models = await listOllamaModels(cfg.ollamaUrl);
      setInstalledOllamaModels(models);
      setOllamaOnline(true);
    } catch {
      setInstalledOllamaModels([]);
      setOllamaOnline(false);
    }
  };

  const refreshKbStatus = () => {
    if (!realm?.path) {
      setKbBadgeText(null);
      return;
    }
    const kb = loadKnowledgeBaseForRealm(realm.path, classes);
    const hasNotes =
      kb.projectNotes.trim().length > 0 ||
      Object.keys(kb.classes || {}).length > 0;
    const hasCode = kb.indexedSymbols.length > 0;
    const hasEx = kb.customExamples.length > 0;
    if (!hasNotes && !hasCode && !hasEx) {
      setKbBadgeText(null);
      return;
    }
    const parts: string[] = [];
    if (hasNotes) {
      parts.push('Glossary');
    }
    if (hasCode) {
      parts.push(`${kb.indexedSymbols.length} Symbols`);
    }
    if (hasEx) {
      parts.push(`${kb.customExamples.length} Examples`);
    }
    setKbBadgeText(`KB: ${parts.join(' · ')}`);
  };

  const handleOpened = () => {
    const currentCfg = settings.getAiSettings();
    setAiSettings(currentCfg);
    setError(null);
    setCopied(false);
    setDismissedSetupBanner(false);
    refreshKbStatus();
    void checkOllamaStatusQuietly(currentCfg);
    if (currentQuery && !generatedQuery) {
      setGeneratedQuery(currentQuery);
      setTargetFilterClass(activeClassName);
    }
    inputRef.current?.focus();
  };

  const handleClosed = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsLoading(false);
    }
    if (pullAbortRef.current) {
      pullAbortRef.current.abort();
      pullAbortRef.current = null;
      setIsPullingModel(false);
      setPullProgress(null);
    }
  };

  const handlePullChosenModel = async (tag: string) => {
    if (pullAbortRef.current) {
      pullAbortRef.current.abort();
    }
    const controller = new AbortController();
    pullAbortRef.current = controller;
    setIsPullingModel(true);
    setPullProgress({ status: `Downloading ${tag}...` });
    setError(null);
    try {
      await pullOllamaModel({
        ollamaUrl: aiSettings.ollamaUrl,
        model: tag,
        signal: controller.signal,
        onProgress: (p) => {
          if (!controller.signal.aborted) {
            setPullProgress(p);
          }
        }
      });
      if (!controller.signal.aborted) {
        const updated = settings.setAiSettings({ model: tag });
        setAiSettings(updated);
        await checkOllamaStatusQuietly(updated);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (pullAbortRef.current === controller) {
        pullAbortRef.current = null;
        setIsPullingModel(false);
        setPullProgress(null);
      }
    }
  };

  const handleCancelPull = () => {
    if (pullAbortRef.current) {
      pullAbortRef.current.abort();
      pullAbortRef.current = null;
    }
    setIsPullingModel(false);
    setPullProgress(null);
  };

  const handleUseExistingModel = (tag: string) => {
    const updated = settings.setAiSettings({ model: tag });
    setAiSettings(updated);
  };

  const examples = useMemo(
    () => buildSuggestedPrompts(classes, activeClassName),
    [classes, activeClassName]
  );

  const filterValidationClass = targetFilterClass || activeClassName;

  const liveValidation = useMemo(() => {
    const trimmed = generatedQuery.trim();
    if (!trimmed || !realm || !filterValidationClass) {
      return null;
    }
    return validateRqlAgainstRealm(realm, filterValidationClass, trimmed);
  }, [generatedQuery, realm, filterValidationClass]);

  const handleCancelRequest = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsLoading(false);
  };

  const handleClearChat = () => {
    setExchanges([]);
    setGeneratedQuery('');
    setTargetFilterClass(undefined);
    setError(null);
  };

  const handleAsk = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? prompt).trim();
    if (!text) {
      return;
    }
    if (mode === 'rql' && !activeClassName) {
      setError('Please select a Class in the left sidebar for RQL Filter mode.');
      return;
    }
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setLoadingStatus(
      mode === 'rql' ? 'Generating RQL...' : 'Searching & thinking...'
    );
    setError(null);
    setCopied(false);

    const historyTurns: IAiChatTurn[] = [];
    for (const ex of exchanges.slice(-3)) {
      historyTurns.push({ role: 'user', content: ex.prompt });
      historyTurns.push({ role: 'assistant', content: ex.answer });
    }

    try {
      const result = await askAiAssistant({
        prompt: text,
        mode,
        classes,
        activeClassName,
        history: historyTurns,
        realm,
        signal: controller.signal,
        onProgress: (status) => {
          if (!controller.signal.aborted) {
            setLoadingStatus(status);
          }
        }
      });

      if (!controller.signal.aborted) {
        const exchangeId = nextExchangeIdRef.current++;
        setExchanges((prev) => [
          ...prev,
          {
            id: exchangeId,
            prompt: text,
            answer: result.answer,
            hits: result.hits,
            toolsUsed: result.toolsUsed,
            suggestedRql: result.suggestedQuery?.rql,
            suggestedClassName: result.suggestedQuery?.className,
            capabilityLimited: result.capabilityLimited,
            limitationReason: result.limitationReason
          }
        ]);
        if (result.suggestedQuery?.rql) {
          setGeneratedQuery(result.suggestedQuery.rql);
          setTargetFilterClass(result.suggestedQuery.className);
        }
        setPrompt('');
        refreshKbStatus();
        setTimeout(() => {
          threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 40);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsLoading(false);
      }
    }
  };

  const handleApply = () => {
    const trimmed = generatedQuery.trim();
    if (!trimmed) {
      return;
    }
    const applyClass = targetFilterClass || activeClassName;
    const latestPrompt = exchanges[exchanges.length - 1]?.prompt || prompt.trim();
    if (realm?.path && applyClass && latestPrompt && liveValidation?.valid) {
      try {
        recordVerifiedQueryExample({
          realmPath: realm.path,
          classes,
          className: applyClass,
          naturalLanguage: latestPrompt,
          rql: trimmed
        });
      } catch {
        // non-fatal KB history write error
      }
    }
    onApplyQuery(trimmed, applyClass);
    toggle();
  };

  const handleCopy = () => {
    if (!generatedQuery.trim()) {
      return;
    }
    void navigator.clipboard.writeText(generatedQuery.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const isLocal = isLocalAiEndpoint(aiSettings);

  return (
    <Modal
      isOpen={isOpen}
      toggle={toggle}
      onOpened={handleOpened}
      onClosed={handleClosed}
      size="lg"
    >
      <ModalHeader toggle={toggle}>
        <i className="fa fa-magic" aria-hidden="true" /> AI Assistant — Search,
        Q&amp;A &amp; RQL{' '}
        {activeClassName ? (
          <Badge color="primary" className="ml-2">
            {activeClassName}
          </Badge>
        ) : null}
      </ModalHeader>
      <ModalBody>
        <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap">
          <div className="small text-muted">
            <Badge color="secondary">
              {AI_PROVIDER_LABELS[aiSettings.provider]} · {aiSettings.model}
            </Badge>{' '}
            {aiSettings.enableSelfCorrection && realm ? (
              <Badge color="info" className="ml-1">
                Live Realm Tools
              </Badge>
            ) : null}
            {kbBadgeText ? (
              <Badge color="success" className="ml-1">
                {kbBadgeText}
              </Badge>
            ) : null}
            <span className="ml-2">
              <i className="fa fa-lock" aria-hidden="true" />{' '}
              {isLocal && aiSettings.enableLocalDataHints
                ? 'On-device search & inspection (passwords masked)'
                : 'Privacy guard (cloud sees schema/ID counts only)'}
            </span>
          </div>
          <div className="d-flex align-items-center mt-1 mt-sm-0">
            {exchanges.length > 0 && (
              <Button
                size="sm"
                color="link"
                className="text-muted mr-2 p-0"
                onClick={handleClearChat}
              >
                Clear
              </Button>
            )}
            {onOpenKnowledgeBase ? (
              <Button
                size="sm"
                color="info"
                outline
                className="mr-2"
                onClick={onOpenKnowledgeBase}
              >
                <i className="fa fa-book" aria-hidden="true" /> Domain KB
              </Button>
            ) : null}
            <Button size="sm" color="secondary" onClick={onOpenSettings}>
              <i className="fa fa-cog" aria-hidden="true" /> AI Settings
            </Button>
          </div>
        </div>

        <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap">
          <ButtonGroup size="sm">
            <Button
              color={mode === 'auto' ? 'primary' : 'secondary'}
              outline={mode !== 'auto'}
              onClick={() => setMode('auto')}
            >
              Auto (Search · Ask · RQL)
            </Button>
            <Button
              color={mode === 'search' ? 'primary' : 'secondary'}
              outline={mode !== 'search'}
              onClick={() => setMode('search')}
            >
              Search ID &amp; Q&amp;A
            </Button>
            <Button
              color={mode === 'rql' ? 'primary' : 'secondary'}
              outline={mode !== 'rql'}
              onClick={() => setMode('rql')}
            >
              RQL Filter Only
            </Button>
          </ButtonGroup>
          <span className="small text-muted">
            {mode === 'rql'
              ? 'Translates straight into active-table RQL'
              : 'Searches across every Class for IDs, answers schema/general questions, or builds RQL'}
          </span>
        </div>

        {!dismissedSetupBanner &&
        aiSettings.provider === 'ollama' &&
        (ollamaOnline === false ||
          (ollamaOnline === true &&
            installedOllamaModels !== null &&
            !isOllamaModelInstalled(
              installedOllamaModels,
              aiSettings.model
            ))) ? (
          <Alert color="info" className="py-2 px-3 small mb-3">
            <div className="d-flex justify-content-between align-items-start flex-wrap">
              <div style={{ flex: 1, minWidth: 220 }}>
                {ollamaOnline === false ? (
                  <>
                    <strong>Local Ollama ยังไม่ได้เปิด/ติดตั้ง</strong>{' '}
                    (เป็นตัวเลือกเสริม — คุณเลือกได้เองว่าจะใช้ Local AI หรือใช้ Cloud / MCP Copilot แทน)
                  </>
                ) : (
                  <>
                    <strong>
                      Model <code>{aiSettings.model}</code> ยังไม่ได้ดาวน์โหลด
                    </strong>{' '}
                    — เลือกว่าจะโหลด ({modelRec.ramGb} GB RAM แนะนำ{' '}
                    <code>{modelRec.recommendedTag}</code>) หรือสลับไปใช้โมเดลที่มีแล้ว
                  </>
                )}
                {isPullingModel && pullProgress ? (
                  <div className="mt-2">
                    <div className="d-flex justify-content-between align-items-center mb-1">
                      <span>
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
              <div className="d-flex flex-wrap align-items-center ml-sm-2 mt-2 mt-sm-0">
                {ollamaOnline &&
                installedOllamaModels &&
                installedOllamaModels.length > 0 ? (
                  <Button
                    size="sm"
                    color="success"
                    className="mr-1 mb-1"
                    disabled={isPullingModel}
                    onClick={() =>
                      handleUseExistingModel(installedOllamaModels[0])
                    }
                  >
                    Use {installedOllamaModels[0]}
                  </Button>
                ) : null}
                {ollamaOnline ? (
                  <Button
                    size="sm"
                    color="primary"
                    className="mr-1 mb-1"
                    disabled={isPullingModel}
                    onClick={() =>
                      void handlePullChosenModel(aiSettings.model)
                    }
                  >
                    Download {aiSettings.model}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    color="primary"
                    className="mr-1 mb-1"
                    onClick={onOpenSettings}
                  >
                    Setup Local AI / MCP
                  </Button>
                )}
                <Button
                  size="sm"
                  color="link"
                  className="text-muted p-1 mb-1"
                  onClick={() => setDismissedSetupBanner(true)}
                >
                  Skip
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}

        {exchanges.length > 0 && (
          <div
            className="mb-3 p-2 border rounded"
            style={{
              maxHeight: 310,
              overflowY: 'auto',
              background: 'rgba(0, 0, 0, 0.08)'
            }}
          >
            {exchanges.map((ex) => (
              <div key={ex.id} className="mb-3">
                <div className="small font-weight-bold text-info mb-1">
                  <i className="fa fa-user-circle" aria-hidden="true" />{' '}
                  {ex.prompt}
                </div>

                {ex.toolsUsed.length > 0 && (
                  <div className="mb-1">
                    {ex.toolsUsed.map((tool) => (
                      <Badge
                        key={tool}
                        color="dark"
                        className="mr-1"
                        style={{ fontWeight: 'normal' }}
                      >
                        <i className="fa fa-wrench" aria-hidden="true" />{' '}
                        {TOOL_LABELS[tool] || tool}
                      </Badge>
                    ))}
                  </div>
                )}

                {ex.capabilityLimited && ex.limitationReason ? (
                  <Alert color="warning" className="py-2 px-3 small mb-2">
                    <div className="d-flex justify-content-between align-items-start">
                      <span style={{ whiteSpace: 'pre-wrap' }}>
                        <strong>ข้อจำกัดของ Local AI:</strong>{' '}
                        {ex.limitationReason}
                      </span>
                      <Button
                        size="sm"
                        color="light"
                        className="ml-2 flex-shrink-0"
                        onClick={onOpenSettings}
                      >
                        MCP / Cloud
                      </Button>
                    </div>
                  </Alert>
                ) : null}

                {ex.answer ? (
                  <div
                    className="small mb-2"
                    style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
                  >
                    {ex.answer}
                  </div>
                ) : null}

                {ex.hits.length > 0 && (
                  <div className="mt-1">
                    <div className="small text-muted mb-1">
                      <strong>Verified Matches ({ex.hits.length}):</strong>
                    </div>
                    {ex.hits.map((hit, idx) => (
                      <div
                        key={`${hit.className}-${hit.primaryKeyValue}-${idx}`}
                        className="d-flex align-items-center justify-content-between border rounded px-2 py-1 mb-1 small"
                      >
                        <div style={{ minWidth: 0, marginRight: 8 }}>
                          <div>
                            <Badge color="primary" className="mr-1">
                              {hit.className}
                            </Badge>
                            <code>
                              {hit.primaryKeyLabel}: {hit.primaryKeyValue}
                            </code>
                            {hit.matchedFields.length > 0 ? (
                              <span className="text-muted ml-2">
                                (matched: {hit.matchedFields.join(', ')})
                              </span>
                            ) : null}
                          </div>
                          {hit.preview ? (
                            <div
                              className="text-muted text-truncate"
                              title={hit.preview}
                            >
                              {hit.preview}
                            </div>
                          ) : null}
                          {hit.relatedLinks && hit.relatedLinks.length > 0 ? (
                            <div className="text-info">
                              Referenced by:{' '}
                              {hit.relatedLinks
                                .map(
                                  (l) =>
                                    `${l.fromClass}.${l.propName} (${l.count})`
                                )
                                .join(', ')}
                            </div>
                          ) : null}
                        </div>
                        <div className="d-flex flex-shrink-0">
                          {onJumpToObject ? (
                            <Button
                              size="sm"
                              color="primary"
                              outline
                              className="mr-1"
                              onClick={() => {
                                const validObj =
                                  hit.object && hit.object.isValid()
                                    ? hit.object
                                    : undefined;
                                onJumpToObject(hit.className, validObj);
                                toggle();
                              }}
                              title={`Jump to ${hit.className}`}
                            >
                              Jump
                            </Button>
                          ) : null}
                          {onOpenInSplitView ? (
                            <Button
                              size="sm"
                              color="secondary"
                              outline
                              onClick={() => {
                                const validObj =
                                  hit.object && hit.object.isValid()
                                    ? hit.object
                                    : undefined;
                                onOpenInSplitView(hit.className, validObj);
                                toggle();
                              }}
                              title={`Open ${hit.className} in Split View`}
                            >
                              Split
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {ex.suggestedRql ? (
                  <div className="mt-1 small">
                    <Button
                      size="sm"
                      color="success"
                      outline
                      onClick={() => {
                        setGeneratedQuery(ex.suggestedRql || '');
                        setTargetFilterClass(ex.suggestedClassName);
                      }}
                    >
                      <i className="fa fa-filter" aria-hidden="true" /> Load RQL
                      {ex.suggestedClassName
                        ? ` (${ex.suggestedClassName})`
                        : ''}
                      : <code>{ex.suggestedRql}</code>
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
            <div ref={threadEndRef} />
          </div>
        )}

        <FormGroup>
          <Label for="ai-nl-prompt">
            Ask anything, find where an ID is, or describe a filter (Thai or
            English)
          </Label>
          <Input
            id="ai-nl-prompt"
            type="textarea"
            rows={2}
            innerRef={(el) => {
              inputRef.current = el;
            }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleAsk();
              }
            }}
            placeholder="เช่น id usr_9981 อยู่ตรงไหน / Realm นี้มีกี่ตาราง / หา status active 7 วันล่าสุด / RQL ต่างจาก SQL ยังไง"
            disabled={isLoading}
          />
          <div className="d-flex flex-wrap align-items-center mt-2">
            <span className="small text-muted mr-2">Examples:</span>
            {examples.map((ex) => (
              <Badge
                key={ex}
                color="secondary"
                style={{
                  cursor: 'pointer',
                  marginRight: 6,
                  marginBottom: 4,
                  fontWeight: 'normal'
                }}
                onClick={() => {
                  setPrompt(ex);
                  void handleAsk(ex);
                }}
              >
                {ex}
              </Badge>
            ))}
          </div>
        </FormGroup>

        <div className="d-flex align-items-center mb-3">
          <Button
            size="sm"
            color="primary"
            onClick={() => void handleAsk()}
            disabled={isLoading || !prompt.trim()}
          >
            <i className="fa fa-magic" aria-hidden="true" />{' '}
            {isLoading
              ? loadingStatus
              : mode === 'rql'
                ? 'Generate Realm Query'
                : 'Ask & Search AI'}
          </Button>
          {isLoading && (
            <Button
              size="sm"
              color="danger"
              className="ml-2"
              onClick={handleCancelRequest}
            >
              Cancel
            </Button>
          )}
          <span className="small text-muted ml-3">
            Press <code>Enter</code> to send
          </span>
        </div>

        {error && (
          <Alert color="danger" className="py-2 px-3 small">
            <div className="d-flex justify-content-between align-items-center">
              <span>{error}</span>
              <Button
                size="sm"
                color="light"
                className="ml-2"
                onClick={onOpenSettings}
              >
                Open AI Settings
              </Button>
            </div>
          </Alert>
        )}

        {generatedQuery ? (
          <FormGroup className="mb-0">
            <div className="d-flex justify-content-between align-items-center mb-1">
              <Label for="ai-generated-rql" className="mb-0">
                Suggested / Active RQL Filter
                {filterValidationClass ? ` (${filterValidationClass})` : ''}
              </Label>
              {liveValidation && (
                <Badge
                  color={liveValidation.valid ? 'success' : 'warning'}
                  className="ml-2"
                >
                  {liveValidation.valid
                    ? `Verified RQL · ${liveValidation.matchedCount?.toLocaleString()} / ${liveValidation.totalInClass?.toLocaleString()} rows`
                    : 'RQL Syntax Issue'}
                </Badge>
              )}
            </div>
            <Input
              id="ai-generated-rql"
              bsSize="sm"
              value={generatedQuery}
              onChange={(e) => setGeneratedQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleApply();
                }
              }}
              style={{ fontFamily: 'monospace' }}
            />
            {liveValidation && !liveValidation.valid && (
              <Alert color="warning" className="py-2 px-3 small mt-2 mb-0">
                <strong>Realm Engine Rejected Query:</strong>{' '}
                {liveValidation.errorMessage}
                {liveValidation.correctionHint ? (
                  <div className="mt-1">
                    <strong>Hint:</strong> {liveValidation.correctionHint}
                  </div>
                ) : null}
              </Alert>
            )}
          </FormGroup>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {generatedQuery && (
          <Button size="sm" color="secondary" onClick={handleCopy}>
            <i className="fa fa-copy" aria-hidden="true" />{' '}
            {copied ? 'Copied!' : 'Copy RQL'}
          </Button>
        )}
        <Button size="sm" color="secondary" onClick={toggle}>
          Close
        </Button>
        {generatedQuery.trim() && (
          <Button size="sm" color="success" onClick={handleApply}>
            <i className="fa fa-check" aria-hidden="true" /> Apply Filter
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
};
