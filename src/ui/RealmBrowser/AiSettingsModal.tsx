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

import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  FormGroup,
  Input,
  InputGroup,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader
} from 'reactstrap';

import {
  getAiApiKey,
  isApiKeyEncryptionAvailable,
  listOllamaModels,
  setAiApiKey,
  testAiConnection
} from '../../services/ai';
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  AiProvider,
  DEFAULT_AI_MODELS,
  IAiSettings,
  settings
} from '../../services/settings';

export interface IAiSettingsModalProps {
  isOpen: boolean;
  toggle: () => void;
  onSaved?: (saved: IAiSettings) => void;
}

const MODEL_SUGGESTIONS: Readonly<Record<AiProvider, string[]>> = {
  ollama: ['qwen2.5:7b', 'llama3.2:3b', 'llama3.1:8b', 'gemma3:4b'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest']
};

export const AiSettingsModal = ({
  isOpen,
  toggle,
  onSaved
}: IAiSettingsModalProps) => {
  const [form, setForm] = useState<IAiSettings>(() => settings.getAiSettings());
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isScanningOllama, setIsScanningOllama] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const handleOpened = () => {
    const current = settings.getAiSettings();
    setForm(current);
    setApiKey(getAiApiKey(current.provider));
    setShowKey(false);
    setTestResult(null);
    setOllamaModels([]);
  };

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
      if (models.length === 0) {
        setTestResult({
          ok: false,
          message: `Connected to Ollama, but no models found. Run "ollama pull ${form.model}" first.`
        });
      } else if (!models.includes(form.model)) {
        setForm((prev) => ({ ...prev, model: models[0] }));
      }
    } catch (err) {
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

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    const result = await testAiConnection(form, apiKey);
    setTestResult({ ok: result.ok, message: result.message });
    setIsTesting(false);
  };

  const handleSave = () => {
    const saved = settings.setAiSettings(form);
    if (form.provider !== 'ollama') {
      setAiApiKey(form.provider, apiKey);
    }
    if (onSaved) {
      onSaved(saved);
    }
    toggle();
  };

  const encryptedSupported = isApiKeyEncryptionAvailable();
  const suggestedModels =
    form.provider === 'ollama' && ollamaModels.length > 0
      ? ollamaModels
      : MODEL_SUGGESTIONS[form.provider];

  return (
    <Modal isOpen={isOpen} toggle={toggle} onOpened={handleOpened} size="md">
      <ModalHeader toggle={toggle}>
        <i className="fa fa-sliders" aria-hidden="true" /> AI Assistant Settings
      </ModalHeader>
      <ModalBody>
        <Alert color="info" className="py-2 px-3 small mb-3">
          <i className="fa fa-shield" aria-hidden="true" />{' '}
          <strong>Privacy-by-Design:</strong> Only schema metadata (class &amp;
          property names/types) is sent when generating queries. Your row data
          never leaves your device.
        </Alert>

        <FormGroup>
          <Label for="ai-provider-select">AI Provider</Label>
          <Input
            id="ai-provider-select"
            type="select"
            bsSize="sm"
            value={form.provider}
            onChange={(e) => handleProviderChange(e.target.value as AiProvider)}
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
                  setForm((prev) => ({ ...prev, ollamaUrl: e.target.value }))
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
            <Label for="ai-openai-url">Base URL (OpenAI or LM Studio)</Label>
            <Input
              id="ai-openai-url"
              bsSize="sm"
              value={form.openaiBaseUrl}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, openaiBaseUrl: e.target.value }))
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
                style={{ cursor: 'pointer', marginRight: 4, marginBottom: 4 }}
                onClick={() => setForm((prev) => ({ ...prev, model: m }))}
              >
                {m}
              </Badge>
            ))}
          </div>
        </FormGroup>

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
            <option value={20000}>20 seconds (Default)</option>
            <option value={30000}>30 seconds</option>
            <option value={60000}>60 seconds</option>
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
      </ModalBody>
      <ModalFooter>
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
      </ModalFooter>
    </Modal>
  );
};
