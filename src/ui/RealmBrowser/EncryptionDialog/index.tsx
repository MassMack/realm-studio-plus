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
  getSavedEncryptionKeys,
  ISavedEncryptionKey,
  removeSavedEncryptionKey
} from '../../../services/encryption-keys';

import { EncryptionDialog } from './EncryptionDialog';

export interface IEncryptionDialogContainerProps {
  onHide: () => void;
  onOpenWithEncryption: (
    key: string,
    remember?: boolean,
    label?: string
  ) => void;
  visible: boolean;
}

export interface IEncryptionDialogContainerState {
  key: string;
  keyLabel: string;
  rememberKey: boolean;
  savedKeys: ISavedEncryptionKey[];
}

class EncryptionDialogContainer extends React.Component<
  IEncryptionDialogContainerProps,
  IEncryptionDialogContainerState
> {
  public state: IEncryptionDialogContainerState = {
    key: '',
    keyLabel: '',
    rememberKey: true,
    savedKeys: getSavedEncryptionKeys()
  };

  public componentDidUpdate(prevProps: IEncryptionDialogContainerProps) {
    if (this.props.visible && !prevProps.visible) {
      const savedKeys = getSavedEncryptionKeys();
      this.setState({
        savedKeys,
        key: this.state.key || (savedKeys[0]?.key ?? '')
      });
    }
  }

  public render() {
    return (
      <EncryptionDialog
        encryptionKey={this.state.key}
        keyLabel={this.state.keyLabel}
        onDeleteSavedKey={this.onDeleteSavedKey}
        onExit={this.props.onHide}
        onKeyChange={this.onKeyChange}
        onKeyLabelChange={this.onKeyLabelChange}
        onRememberChange={this.onRememberChange}
        onSelectSavedKey={this.onSelectSavedKey}
        onSubmit={this.onSubmit}
        rememberKey={this.state.rememberKey}
        savedKeys={this.state.savedKeys}
        visible={this.props.visible}
      />
    );
  }

  protected onKeyChange = (key: string) => {
    this.setState({ key });
  };

  protected onKeyLabelChange = (keyLabel: string) => {
    this.setState({ keyLabel });
  };

  protected onRememberChange = (rememberKey: boolean) => {
    this.setState({ rememberKey });
  };

  protected onSelectSavedKey = (saved: ISavedEncryptionKey) => {
    this.setState({ key: saved.key, keyLabel: saved.label });
  };

  protected onDeleteSavedKey = (key: string) => {
    removeSavedEncryptionKey(key);
    this.setState({ savedKeys: getSavedEncryptionKeys() });
  };

  protected onSubmit = (e: React.FormEvent<any>) => {
    e.preventDefault();
    this.props.onHide();
    this.props.onOpenWithEncryption(
      this.state.key,
      this.state.rememberKey,
      this.state.keyLabel
    );
  };
}

export { EncryptionDialogContainer as EncryptionDialog };
