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

import React from 'react';
import {
  Button,
  Form,
  FormGroup,
  Input,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader
} from 'reactstrap';

import { ISavedEncryptionKey } from '../../../services/encryption-keys';

export interface IEncryptionDialogProps {
  encryptionKey: string;
  keyLabel: string;
  onDeleteSavedKey: (key: string) => void;
  onExit: () => void;
  onKeyChange: (key: string) => void;
  onKeyLabelChange: (label: string) => void;
  onRememberChange: (remember: boolean) => void;
  onSelectSavedKey: (saved: ISavedEncryptionKey) => void;
  onSubmit: (e: React.FormEvent<any>) => void;
  rememberKey: boolean;
  savedKeys: ISavedEncryptionKey[];
  visible: boolean;
}

export const EncryptionDialog = ({
  encryptionKey,
  keyLabel,
  onDeleteSavedKey,
  onExit,
  onKeyChange,
  onKeyLabelChange,
  onRememberChange,
  onSelectSavedKey,
  onSubmit,
  rememberKey,
  savedKeys,
  visible
}: IEncryptionDialogProps) => (
  <Modal isOpen={visible} onExit={onExit}>
    <Form onSubmit={onSubmit}>
      <ModalHeader toggle={onExit}>
        <i className="fa fa-key" aria-hidden="true" /> Encrypted Realm Key
      </ModalHeader>
      <ModalBody>
        <p>
          Enter the 128-character hex encryption key for this Realm file, or
          pick a saved key below.
        </p>
        {savedKeys.length > 0 ? (
          <FormGroup>
            <Label>Saved Keys ({savedKeys.length})</Label>
            <div className="RealmBrowser__GlobalSearchGroupItems">
              {savedKeys.map((item) => (
                <div
                  key={item.key}
                  className="RealmBrowser__GlobalSearchItem"
                  style={{ justifyContent: 'space-between' }}
                >
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0 text-start"
                    style={{ textDecoration: 'none', flex: 1 }}
                    onClick={() => onSelectSavedKey(item)}
                    title={`Use key: ${item.key}`}
                  >
                    <strong>{item.label}</strong>{' '}
                    <code>
                      {item.key.slice(0, 10)}…{item.key.slice(-8)}
                    </code>
                  </button>
                  <Button
                    color="secondary"
                    size="sm"
                    type="button"
                    onClick={() => onDeleteSavedKey(item.key)}
                    title="Forget this saved key"
                  >
                    <i className="fa fa-trash" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          </FormGroup>
        ) : null}
        <FormGroup>
          <Label>Encryption Key (128 hex chars)</Label>
          <Input
            value={encryptionKey}
            onChange={(e) => {
              onKeyChange(e.target.value.trim());
            }}
            pattern="[a-fA-F0-9]{128}"
            placeholder="128-character hex-encoded encryption key"
            required={true}
          />
        </FormGroup>
        <FormGroup check className="mt-2">
          <Label check>
            <Input
              type="checkbox"
              checked={rememberKey}
              onChange={(e) => onRememberChange(e.target.checked)}
            />{' '}
            Remember this encryption key for automatic unlock
          </Label>
        </FormGroup>
        {rememberKey ? (
          <FormGroup className="mt-2">
            <Input
              bsSize="sm"
              value={keyLabel}
              onChange={(e) => onKeyLabelChange(e.target.value)}
              placeholder="Optional key label (e.g. Production / Staging App Key)"
            />
          </FormGroup>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button color="secondary" type="button" onClick={onExit}>
          Cancel
        </Button>
        <Button color="primary" type="submit">
          Unlock Realm
        </Button>
      </ModalFooter>
    </Form>
  </Modal>
);
