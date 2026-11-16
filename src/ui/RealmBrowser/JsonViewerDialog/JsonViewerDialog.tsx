////////////////////////////////////////////////////////////////////////////
//
// Copyright 2021 Realm Inc.
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

import * as remote from '@electron/remote';
import fs from 'fs-extra';
import { useState } from 'react';
import {
  Button,
  CardBody,
  CardText,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader
} from 'reactstrap';

export interface IJSonViewerDialogProps {
  onCancel: () => void;
  onSave?: (updatedJson: string) => void;
  visible: boolean;
  json: string;
}

export const JsonViewerDialog = ({
  onCancel,
  onSave,
  visible,
  json
}: IJSonViewerDialogProps) => {
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftJson, setDraftJson] = useState(json);
  const [parseError, setParseError] = useState<string | null>(null);

  const handleCopy = () => {
    void navigator.clipboard.writeText(isEditing ? draftJson : json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const handleSaveFile = () => {
    const dest = remote.dialog.showSaveDialogSync({
      defaultPath: 'object.json',
      message: 'Save JSON to file',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (dest) {
      fs.writeFileSync(dest, isEditing ? draftJson : json, 'utf8');
    }
  };

  const handleSaveToRealm = () => {
    if (!onSave) {
      return;
    }
    try {
      JSON.parse(draftJson);
      setParseError(null);
      onSave(draftJson);
      onCancel();
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  const trimmed = search.trim().toLowerCase();
  const displayJson = trimmed
    ? json
        .split('\n')
        .filter((line) => line.toLowerCase().includes(trimmed))
        .join('\n') || '// No matching lines'
    : json;

  return (
    <Modal isOpen={visible} toggle={onCancel} size="lg">
      <ModalHeader toggle={onCancel}>
        <i className="fa fa-code" aria-hidden="true" />{' '}
        {isEditing ? 'Edit Row as JSON' : 'JSON Inspector'}
      </ModalHeader>
      {json.includes('"$refId":') && !isEditing && (
        <CardBody
          style={{
            borderBottom: '1px solid var(--bs-border-color-translucent)'
          }}
        >
          <CardText>
            <small>
              {
                '"$refId" & "$ref" has been added to the serialized output, to resolve circular structures.'
              }
            </small>
          </CardText>
        </CardBody>
      )}
      <ModalBody>
        {!isEditing ? (
          <>
            <div className="RealmBrowser__GlobalSearchInputWrap">
              <Input
                bsSize="sm"
                type="text"
                placeholder="Filter keys or values in JSON..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && search) {
                    e.stopPropagation();
                    setSearch('');
                  }
                }}
              />
            </div>
            <pre
              style={{
                maxHeight: '420px',
                overflow: 'auto',
                marginBottom: 0
              }}
            >
              {displayJson}
            </pre>
          </>
        ) : (
          <>
            {parseError ? (
              <div className="text-danger mb-2">
                <small>JSON Error: {parseError}</small>
              </div>
            ) : null}
            <Input
              type="textarea"
              rows={16}
              style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}
              value={draftJson}
              onChange={(e) => {
                setDraftJson(e.target.value);
                setParseError(null);
              }}
            />
          </>
        )}
      </ModalBody>
      <ModalFooter>
        {onSave && !isEditing ? (
          <Button
            color="info"
            size="sm"
            onClick={() => {
              setDraftJson(json);
              setIsEditing(true);
            }}
          >
            <i className="fa fa-pencil" aria-hidden="true" /> Edit as JSON
          </Button>
        ) : null}
        {onSave && isEditing ? (
          <>
            <Button
              color="secondary"
              size="sm"
              onClick={() => {
                setIsEditing(false);
                setParseError(null);
              }}
            >
              Cancel Edit
            </Button>
            <Button color="primary" size="sm" onClick={handleSaveToRealm}>
              <i className="fa fa-check" aria-hidden="true" /> Save to Realm
            </Button>
          </>
        ) : null}
        <Button color="secondary" size="sm" onClick={handleSaveFile}>
          <i className="fa fa-download" aria-hidden="true" /> Save .json...
        </Button>
        <Button color="primary" size="sm" onClick={handleCopy}>
          <i
            className={`fa ${copied ? 'fa-check' : 'fa-clone'}`}
            aria-hidden="true"
          />{' '}
          {copied ? 'Copied!' : 'Copy JSON'}
        </Button>
        <Button color="secondary" size="sm" onClick={onCancel}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
