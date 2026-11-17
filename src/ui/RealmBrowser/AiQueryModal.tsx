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
  FormGroup,
  Input,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader
} from 'reactstrap';
import Realm from 'realm';

import {
  generateRealmQuery,
  IGeneratedRealmQuery,
  isLocalAiEndpoint
} from '../../services/ai';
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
  onApplyQuery: (query: string) => void;
  onOpenKnowledgeBase?: () => void;
  onOpenSettings: () => void;
  realm?: Realm;
  toggle: () => void;
}

function buildSuggestedPrompts(
  classes: Realm.ObjectSchema[],
  activeClassName?: string
): string[] {
  const schema = classes.find((c) => c.name === activeClassName);
  if (!schema) {
    return ['แสดงทั้งหมดเรียงจากล่าสุด 20 รายการ'];
  }
  const props = Object.entries(schema.properties).map(([name, raw]) => ({
    name,
    prop:
      typeof raw === 'string'
        ? ({ type: raw } as Realm.ObjectSchemaProperty)
        : (raw as Realm.ObjectSchemaProperty)
  }));

  const suggestions: string[] = [];
  const strProp = props.find((p) => p.prop.type === 'string');
  const numProp = props.find(
    (p) =>
      p.prop.type === 'int' ||
      p.prop.type === 'float' ||
      p.prop.type === 'double'
  );
  const boolProp = props.find((p) => p.prop.type === 'bool');
  const dateProp = props.find((p) => p.prop.type === 'date');

  if (strProp) {
    suggestions.push(`หา ${activeClassName} ที่ ${strProp.name} มีคำว่า "test"`);
  }
  if (numProp) {
    suggestions.push(`หา ${numProp.name} มากกว่า 0 เรียงจากมากไปน้อย`);
  }
  if (boolProp) {
    suggestions.push(`เฉพาะที่ ${boolProp.name} เป็น true`);
  }
  if (dateProp) {
    suggestions.push(`เรียงตาม ${dateProp.name} ล่าสุด 20 แถวแรก`);
  }
  if (suggestions.length === 0) {
    suggestions.push(`แสดง ${activeClassName} 20 รายการแรก`);
  }
  return suggestions.slice(0, 3);
}

export const AiQueryModal = ({
  activeClassName,
  classes,
  currentQuery,
  isOpen,
  onApplyQuery,
  onOpenKnowledgeBase,
  onOpenSettings,
  realm,
  toggle
}: IAiQueryModalProps) => {
  const [prompt, setPrompt] = useState('');
  const [generatedQuery, setGeneratedQuery] = useState('');
  const [explanation, setExplanation] = useState('');
  const [generationMeta, setGenerationMeta] =
    useState<IGeneratedRealmQuery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('Generating RQL...');
  const [copied, setCopied] = useState(false);
  const [kbBadgeText, setKbBadgeText] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<IAiSettings>(() =>
    settings.getAiSettings()
  );

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const unsubscribe = settings.onDidChangeAiSettings((next) => {
      setAiSettings(next);
    });
    return unsubscribe;
  }, []);

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
    setAiSettings(settings.getAiSettings());
    setError(null);
    setCopied(false);
    refreshKbStatus();
    if (currentQuery && !generatedQuery) {
      setGeneratedQuery(currentQuery);
    }
    inputRef.current?.focus();
  };

  const handleClosed = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsLoading(false);
    }
  };

  const examples = useMemo(
    () => buildSuggestedPrompts(classes, activeClassName),
    [classes, activeClassName]
  );

  // Live validation whenever the user edits or AI produces a candidate RQL string
  const liveValidation = useMemo(() => {
    const trimmed = generatedQuery.trim();
    if (!trimmed || !realm || !activeClassName) {
      return null;
    }
    return validateRqlAgainstRealm(realm, activeClassName, trimmed);
  }, [generatedQuery, realm, activeClassName]);

  const handleCancelRequest = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsLoading(false);
  };

  const handleGenerate = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? prompt).trim();
    if (!text || !activeClassName) {
      return;
    }
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setLoadingStatus('Generating RQL...');
    setError(null);
    setCopied(false);

    try {
      const result = await generateRealmQuery({
        prompt: text,
        classes,
        activeClassName,
        realm,
        signal: controller.signal,
        onProgress: (status) => {
          if (!controller.signal.aborted) {
            setLoadingStatus(status);
          }
        }
      });
      if (!controller.signal.aborted) {
        setGeneratedQuery(result.query);
        setExplanation(result.explanation);
        setGenerationMeta(result);
        refreshKbStatus();
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
    if (
      realm?.path &&
      activeClassName &&
      prompt.trim() &&
      liveValidation?.valid
    ) {
      try {
        recordVerifiedQueryExample({
          realmPath: realm.path,
          classes,
          className: activeClassName,
          naturalLanguage: prompt.trim(),
          rql: trimmed
        });
      } catch {
        // non-fatal KB history write error
      }
    }
    onApplyQuery(trimmed);
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
        <i className="fa fa-magic" aria-hidden="true" /> Ask AI — Natural
        Language to Realm Query{' '}
        {activeClassName ? (
          <Badge color="primary" className="ml-2">
            {activeClassName}
          </Badge>
        ) : null}
      </ModalHeader>
      <ModalBody>
        <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap">
          <div className="small text-muted">
            <Badge color="secondary">
              {AI_PROVIDER_LABELS[aiSettings.provider]} · {aiSettings.model}
            </Badge>{' '}
            {aiSettings.enableSelfCorrection && realm ? (
              <Badge color="info" className="ml-1">
                RQL Self-Check
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
                ? 'On-device only (schema + safe enum hints)'
                : 'Schema only (no row data sent)'}
            </span>
          </div>
          <div className="d-flex align-items-center mt-1 mt-sm-0">
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

        {!activeClassName ? (
          <Alert color="warning" className="py-2 px-3 small">
            Please select a Class in the left sidebar first.
          </Alert>
        ) : (
          <>
            <FormGroup>
              <Label for="ai-nl-prompt">
                Describe what you want to find (Thai or English)
              </Label>
              <Input
                id="ai-nl-prompt"
                type="textarea"
                rows={3}
                innerRef={(el) => {
                  inputRef.current = el;
                }}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleGenerate();
                  }
                }}
                placeholder="e.g. หาผู้ใช้ที่ status active ใน 7 วันล่าสุด เรียงจากล่าสุด 20 รายการ"
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
                      void handleGenerate(ex);
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
                onClick={() => void handleGenerate()}
                disabled={isLoading || !prompt.trim()}
              >
                <i className="fa fa-magic" aria-hidden="true" />{' '}
                {isLoading ? loadingStatus : 'Generate Realm Query'}
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
                Press <code>Enter</code> to generate
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

            {(generatedQuery || explanation) && (
              <FormGroup className="mb-0">
                <div className="d-flex justify-content-between align-items-center mb-1">
                  <Label for="ai-generated-rql" className="mb-0">
                    Generated Realm Query (editable before applying)
                  </Label>
                  {liveValidation && (
                    <Badge
                      color={liveValidation.valid ? 'success' : 'warning'}
                      className="ml-2"
                    >
                      {liveValidation.valid
                        ? `Verified RQL · ${liveValidation.matchedCount?.toLocaleString()} / ${liveValidation.totalInClass?.toLocaleString()} rows${
                            generationMeta?.attempts &&
                            generationMeta.attempts > 1
                              ? ` (auto-fixed #${generationMeta.attempts})`
                              : ''
                          }`
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
                {explanation && (
                  <div className="small text-muted mt-2">
                    <i className="fa fa-info-circle" aria-hidden="true" />{' '}
                    {explanation}
                  </div>
                )}
              </FormGroup>
            )}
          </>
        )}
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
        <Button
          size="sm"
          color="success"
          disabled={!generatedQuery.trim()}
          onClick={handleApply}
        >
          <i className="fa fa-check" aria-hidden="true" /> Apply Filter
        </Button>
      </ModalFooter>
    </Modal>
  );
};
