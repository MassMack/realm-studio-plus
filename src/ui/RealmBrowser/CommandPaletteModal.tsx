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

import { useEffect, useRef, useState } from 'react';
import { Badge, Input, Modal, ModalBody, ModalHeader } from 'reactstrap';

export interface ICommandPaletteAction {
  id: string;
  label: string;
  category: string;
  run: () => void;
}

export interface ICommandPaletteModalProps {
  actions: ICommandPaletteAction[];
  isOpen: boolean;
  toggle: () => void;
}

export const CommandPaletteModal = ({
  actions,
  isOpen,
  toggle
}: ICommandPaletteModalProps) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 40);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? actions.filter(
        (a) =>
          a.label.toLowerCase().includes(trimmed) ||
          a.category.toLowerCase().includes(trimmed)
      )
    : actions;

  const clampedIndex =
    filtered.length > 0 ? Math.min(selectedIndex, filtered.length - 1) : 0;

  const executeItem = (item?: ICommandPaletteAction) => {
    if (!item) {
      return;
    }
    toggle();
    setQuery('');
    setSelectedIndex(0);
    item.run();
  };

  return (
    <Modal isOpen={isOpen} toggle={toggle}>
      <ModalHeader toggle={toggle}>
        <i className="fa fa-bolt" aria-hidden="true" /> Command Palette (⌘P)
      </ModalHeader>
      <ModalBody>
        <div className="RealmBrowser__GlobalSearchInputWrap">
          <Input
            type="text"
            innerRef={(el) => {
              inputRef.current = el;
            }}
            placeholder="Type a class name or command (↑/↓ to navigate, Enter to run)..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex((prev) =>
                  filtered.length > 0 ? (prev + 1) % filtered.length : 0
                );
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex((prev) =>
                  filtered.length > 0
                    ? (prev - 1 + filtered.length) % filtered.length
                    : 0
                );
              } else if (e.key === 'Enter' && filtered.length > 0) {
                e.preventDefault();
                executeItem(filtered[clampedIndex]);
              }
            }}
          />
        </div>
        <div className="RealmBrowser__GlobalSearchResults">
          <div className="RealmBrowser__GlobalSearchGroup">
            <div className="RealmBrowser__GlobalSearchGroupItems">
              {filtered.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  className="RealmBrowser__GlobalSearchItem"
                  style={
                    idx === clampedIndex
                      ? { background: 'var(--rs-list-hover-bg)' }
                      : undefined
                  }
                  onClick={() => executeItem(item)}
                >
                  <Badge
                    color={item.category === 'Class' ? 'primary' : 'secondary'}
                  >
                    {item.category}
                  </Badge>
                  <span>{item.label}</span>
                </button>
              ))}
              {filtered.length === 0 ? (
                <div className="RealmBrowser__GlobalSearchEmpty">
                  No matching commands or classes.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
};
