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
import {
  Badge,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader
} from 'reactstrap';
import Realm from 'realm';

import { ClassFocussedHandler } from '.';
import { searchAcrossRealm } from '../../services/realm-search';

export interface IGlobalSearchModalProps {
  classes: Realm.ObjectSchema[];
  isOpen: boolean;
  onClassFocussed: ClassFocussedHandler;
  realm?: Realm;
  toggle: () => void;
}

export const GlobalSearchModal = ({
  classes,
  isOpen,
  onClassFocussed,
  realm,
  toggle
}: IGlobalSearchModalProps) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen]);

  if (!isOpen || !realm) {
    return null;
  }

  const searchResults = searchAcrossRealm(realm, classes, query);
  const totalMatches = searchResults.reduce((sum, r) => sum + r.count, 0);

  return (
    <Modal isOpen={isOpen} toggle={toggle} size="lg">
      <ModalHeader toggle={toggle}>
        <i className="fa fa-search" aria-hidden="true" /> Global Search Across
        All Classes
      </ModalHeader>
      <ModalBody>
        <div className="RealmBrowser__GlobalSearchInputWrap">
          <Input
            type="text"
            innerRef={(el) => {
              inputRef.current = el;
            }}
            placeholder="Type text, number, ObjectId, or UUID to search across every class..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query.trim() ? (
            <div className="RealmBrowser__GlobalSearchSummary">
              Found <strong>{totalMatches.toLocaleString()}</strong> matching
              records across <strong>{searchResults.length}</strong> classes
            </div>
          ) : null}
        </div>

        <div className="RealmBrowser__GlobalSearchResults">
          {searchResults.map((group) => (
            <div
              key={group.className}
              className="RealmBrowser__GlobalSearchGroup"
            >
              <div
                className="RealmBrowser__GlobalSearchGroupHeader"
                onClick={() => {
                  onClassFocussed(group.className);
                  toggle();
                }}
              >
                <strong>{group.className}</strong>
                <Badge color="primary">
                  {group.count.toLocaleString()} matches
                </Badge>
              </div>
              <div className="RealmBrowser__GlobalSearchGroupItems">
                {group.samples.map((sample, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="RealmBrowser__GlobalSearchItem"
                    onClick={() => {
                      onClassFocussed(group.className, sample.object);
                      toggle();
                    }}
                  >
                    {sample.identifier ? (
                      <span className="RealmBrowser__NavBar__CrumbId">
                        <span className="RealmBrowser__NavBar__CrumbIdKey">
                          {sample.identifier.key}:
                        </span>
                        <span className="RealmBrowser__NavBar__CrumbIdVal">
                          {sample.identifier.value}
                        </span>
                      </span>
                    ) : (
                      <span className="RealmBrowser__NavBar__CrumbId">
                        Match #{idx + 1}
                      </span>
                    )}
                    <span className="RealmBrowser__GlobalSearchPreview">
                      {sample.preview || 'Click to jump to record'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {query.trim() && searchResults.length === 0 ? (
            <div className="RealmBrowser__GlobalSearchEmpty">
              No records matching &#34;{query.trim()}&#34; in any class.
            </div>
          ) : null}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button color="secondary" size="sm" onClick={toggle}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
