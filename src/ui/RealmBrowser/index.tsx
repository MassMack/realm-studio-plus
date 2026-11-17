////////////////////////////////////////////////////////////////////////////
//
// Copyright 2019 Realm Inc.
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

import { ipcRenderer, MenuItemConstructorOptions, shell } from 'electron';
import * as remote from '@electron/remote';
import fs from 'fs-extra';
import memoizeOne from 'memoize-one';
import path from 'path';
import Realm from 'realm';
import { flushSync } from 'react-dom';

import {
  registerOpenRealmSession,
  unregisterOpenRealmSession,
  updateOpenRealmSession
} from '../../services/active-realms';
import {
  getTrackedAndroidRealmInfo,
  hasAndroidRemoteFileChanged,
  refreshLocalAndroidRealmIfTracked
} from '../../services/android-finder';
import { DataExporter, DataExportFormat } from '../../services/data-exporter';
import * as dataImporter from '../../services/data-importer';
import {
  getCandidateKeysForPath,
  saveEncryptionKeyForPath
} from '../../services/encryption-keys';
import { Language, SchemaExporter } from '../../services/schema-export';
import { menu } from '../../utils';
import {
  IMenuGenerator,
  IMenuGeneratorProps
} from '../../windows/MenuGenerator';
import { IRealmBrowserWindowProps } from '../../windows/WindowProps';
import { showError } from '../reusable/errors';
import {
  IRealmLoadingComponentState,
  RealmLoadingComponent
} from '../reusable/RealmLoadingComponent';

import { AiSettingsModalTab } from './AiSettingsModal';
import { ICommandPaletteAction } from './CommandPaletteModal';
import { Content, EditMode } from './Content';
import { IHighlight } from './Content/Table';
import { extractObjectIdentifier, IObjectIdentifier } from './display';
import {
  Focus,
  getClassName,
  IClassFocus,
  IListFocus,
  ISingleObjectFocus
} from './focus';
import { IBreadcrumbItem } from './NavigationBar';
import { isPrimitive } from './primitives';
import { RealmBrowser } from './RealmBrowser';
import * as schemaUtils from './schema-utils';
import {
  allocateLayoutId,
  closePaneInLayout,
  containsPane,
  countLeaves,
  createInitialLayout,
  findAdjacentPaneId,
  listLeafIds,
  moveOrSwapPaneInLayout,
  SplitDirection,
  SplitDropZone,
  SplitLayoutNode,
  splitPaneInLayout,
  updateBranchRatioInLayout
} from './split-layout';
import { SingleObjectCollection } from './Content/SingleObjectCollection';
import { MockedObjectCollection } from './Content/MockedObjectCollection';

// TODO: Remove this interface once the Realm.ObjectSchemaProperty
// has a name parameter in its type definition.
export interface IPropertyWithName extends Realm.ObjectSchemaProperty {
  name: string | null;
  readOnly: boolean;
  isPrimaryKey: boolean;
  isEmbedded?: boolean;
}

export type IsEmbeddedTypeChecker = (className?: string) => boolean;
export type EditModeChangeHandler = (editMode: EditMode) => void;
export type ListFocussedHandler = (
  object: Realm.Object,
  property: IPropertyWithName,
  highlightedObject?: Realm.Object
) => void;
export type SingleListFocussedHandler = (
  parent: Realm.Object,
  property: IPropertyWithName
) => void;
export type ClassFocussedHandler = (
  className: string,
  highlightedObject?: Realm.Object,
  parentObject?: Realm.Object,
  property?: IPropertyWithName
) => void;

type ImportDialogOptions = {
  filePaths: string[];
  classNames: string[];
};

type JsonViewerDialogOptions = {
  value: unknown;
  onSave?: (updatedJson: string) => void;
};

export type JsonViewerDialogExecutor = (
  value: unknown,
  onSave?: (updatedJson: string) => void
) => void;

export interface IPaneViewState {
  id: string;
  activeObjectId: IObjectIdentifier | null;
  allowCreate: boolean;
  focus: Focus | null;
  history: INavigationEntry[];
  historyIndex: number;
}

export interface ISplitPaneUiCallbacks {
  onSelect: () => void;
  onSelectClass: (className: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClose: () => void;
}

export interface IPaneContentCallbacks {
  contentRef: (instance: Content | null) => void;
  onAddColumnClick: () => void;
  onAskAi: () => void;
  onClassFocussed: ClassFocussedHandler;
  onHighlightChange: (
    highlight: IHighlight | undefined,
    collection: Realm.OrderedCollection<any>
  ) => void;
  onListFocussed: ListFocussedHandler;
  onSingleListFocussed: SingleListFocussedHandler;
}

const INITIAL_PANE_ID = 'pane-1';
const EDIT_MODE_STORAGE_KEY = 'realm-browser-edit-mode';
const FILE_UPGRADE_NEEDED_MESSAGE = 'Database upgrade required but prohibited.';
const ARCHITECTURE_MISMATCH_MESSAGE =
  'Realm file is currently open in another process which cannot share access with this process. All processes sharing a single file must be the same architecture.';
const MAX_HISTORY_ENTRIES = 50;

interface INavigationEntry {
  focus: Focus;
  highlightedObject?: Realm.Object;
  breadcrumbs: IBreadcrumbItem[];
}

function createEmptyPaneState(id: string): IPaneViewState {
  return {
    id,
    activeObjectId: null,
    allowCreate: false,
    focus: null,
    history: [],
    historyIndex: -1
  };
}

export interface IRealmBrowserState extends IRealmLoadingComponentState {
  // A number that we can use to make components update on changes to data
  activePaneId: string;
  androidAutoSyncSec: number;
  androidSyncStatus: string | null;
  dataVersion: number;
  dataVersionAtBeginning?: number;
  editMode: EditMode;
  isAddClassOpen: boolean;
  isAddPropertyOpen: boolean;
  isAiQueryOpen: boolean;
  isAiSettingsOpen: boolean;
  aiSettingsInitialTab: AiSettingsModalTab;
  isAndroidTracked: boolean;
  isCommandPaletteOpen: boolean;
  isEncryptionDialogVisible: boolean;
  isGlobalSearchOpen: boolean;
  isLeftSidebarOpen: boolean;
  isOverviewOpen: boolean;
  importDialog: ImportDialogOptions | null;
  jsonViewerDialog: JsonViewerDialogOptions | null;
  layout: SplitLayoutNode;
  panes: Record<string, IPaneViewState | undefined>;
  // The classes are only supposed to be used to produce a list of classes in the sidebar
  classes: Realm.ObjectSchema[];
}

class RealmBrowserContainer
  extends RealmLoadingComponent<
    IRealmBrowserWindowProps & IMenuGeneratorProps,
    IRealmBrowserState
  >
  implements IMenuGenerator
{
  public state: IRealmBrowserState = {
    activePaneId: INITIAL_PANE_ID,
    androidAutoSyncSec: 0,
    androidSyncStatus: null,
    dataVersion: 0,
    editMode:
      (localStorage.getItem(EDIT_MODE_STORAGE_KEY) as EditMode) ||
      EditMode.InputBlur,
    isAddClassOpen: false,
    isAddPropertyOpen: false,
    isAiQueryOpen: false,
    isAiSettingsOpen: false,
    aiSettingsInitialTab: 'ai',
    isAndroidTracked: false,
    isCommandPaletteOpen: false,
    isEncryptionDialogVisible: false,
    isGlobalSearchOpen: false,
    isLeftSidebarOpen: true,
    isOverviewOpen: false,
    importDialog: null,
    jsonViewerDialog: null,
    layout: createInitialLayout(INITIAL_PANE_ID),
    panes: {
      [INITIAL_PANE_ID]: createEmptyPaneState(INITIAL_PANE_ID)
    },
    progress: { status: 'idle' },
    classes: []
  };

  private paneContentInstances = new Map<string, Content | null>();
  private paneContentCallbackCache = new Map<string, IPaneContentCallbacks>();
  private paneUiCallbackCache = new Map<string, ISplitPaneUiCallbacks>();
  private pendingPaneClassNames: Record<string, string | undefined> = {};
  private fileWatcher: fs.FSWatcher | null = null;
  private watchedInode: number | null = null;
  private watchedMtimeMs: number | null = null;
  private watchedSize: number | null = null;
  private watchedFileName: string | null = null;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watchStabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStableStat: { size: number; mtimeMs: number } | null = null;
  private reloadAttemptTimestamps: number[] = [];
  private watcherDisabled = false;
  private isReloading = false;
  private readonly activeSessionId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private androidSyncTimer: ReturnType<typeof setInterval> | null = null;
  private isAndroidSyncTicking = false;
  private untriedCandidateKeys: string[] | null = null;
  private pendingEncryptionSave?: {
    key: string;
    remember: boolean;
    label?: string;
  };

  public componentDidMount() {
    this.loadRealm(
      this.props.realm,
      this.props.import ? this.props.import.schema : undefined
    ).then(() => this.startWatchingRealmFile());
    this.addListeners();
  }

  public componentWillUnmount() {
    this.stopAndroidAutoSync();
    unregisterOpenRealmSession(this.activeSessionId);
    super.componentWillUnmount();
    this.removeListeners();
    this.stopWatchingRealmFile();
    for (const paneId of this.paneContentInstances.keys()) {
      Content.clearPaneCache(paneId);
    }
    this.paneContentInstances.clear();
    this.paneContentCallbackCache.clear();
    this.paneUiCallbackCache.clear();
    if (this.realm && this.realm.isInTransaction) {
      this.realm.cancelTransaction();
    }
  }

  public render() {
    const { activePaneId, layout, panes } = this.state;
    const resolvedPaneId = containsPane(layout, activePaneId)
      ? activePaneId
      : listLeafIds(layout)[0] ?? INITIAL_PANE_ID;
    const navSnapshot = this.getPaneSnapshot(resolvedPaneId);
    const breadcrumbs = this.getPaneBreadcrumbs(resolvedPaneId);
    return (
      <RealmBrowser
        activeObjectId={navSnapshot.activeObjectId}
        activePaneId={resolvedPaneId}
        aiSettingsInitialTab={this.state.aiSettingsInitialTab}
        androidAutoSyncSec={this.state.androidAutoSyncSec}
        androidSyncStatus={this.state.androidSyncStatus}
        breadcrumbs={breadcrumbs}
        canGoBack={navSnapshot.historyIndex > 0}
        canGoForward={
          navSnapshot.historyIndex >= 0 &&
          navSnapshot.historyIndex < navSnapshot.history.length - 1
        }
        classes={this.state.classes}
        commandPaletteActions={this.getCommandPaletteActions()}
        dataVersion={this.state.dataVersion}
        dataVersionAtBeginning={this.state.dataVersionAtBeginning}
        editMode={this.props.readOnly ? EditMode.Disabled : this.state.editMode}
        getClassFocus={this.getClassFocus}
        getPaneContentCallbacks={this.getPaneContentCallbacks}
        getPaneUiCallbacks={this.getPaneUiCallbacks}
        getSchemaLength={this.getSchemaLength}
        importDialog={this.state.importDialog}
        isAddClassOpen={this.state.isAddClassOpen}
        isAddPropertyOpen={this.state.isAddPropertyOpen}
        isAiQueryOpen={this.state.isAiQueryOpen}
        isAiSettingsOpen={this.state.isAiSettingsOpen}
        isAndroidTracked={this.state.isAndroidTracked}
        isClassNameAvailable={this.isClassNameAvailable}
        isCommandPaletteOpen={this.state.isCommandPaletteOpen}
        isEmbeddedType={this.isEmbeddedType}
        isEncryptionDialogVisible={this.state.isEncryptionDialogVisible}
        isGlobalSearchOpen={this.state.isGlobalSearchOpen}
        isLeftSidebarOpen={this.state.isLeftSidebarOpen}
        isOverviewOpen={this.state.isOverviewOpen}
        isPropertyNameAvailable={this.isPropertyNameAvailable}
        jsonViewerDialog={this.state.jsonViewerDialog}
        layout={layout}
        onAddClass={this.onAddClass}
        onAddProperty={this.onAddProperty}
        onApplyAiQuery={this.onApplyAiQuery}
        onBack={this.onNavigateBack}
        onBreadcrumbClick={this.onBreadcrumbClick}
        onCancelTransaction={this.onCancelTransaction}
        onClassFocussed={this.onClassFocussed}
        onCommitBranchRatio={this.onCommitBranchRatio}
        onCommitTransaction={this.onCommitTransaction}
        onConfigureAndroidSync={this.onConfigureAndroidSync}
        onDeleteClass={this.onDeleteClass}
        onDropPane={this.onDropPane}
        onForward={this.onNavigateForward}
        onHideEncryptionDialog={this.onHideEncryptionDialog}
        onHideImportDialog={this.onHideImportDialog}
        onHideJsonViewerDialog={this.onHideJsonViewerDialog}
        onImport={this.handleImport}
        onLeftSidebarToggle={this.onLeftSidebarToggle}
        onOpenAiSettingsTab={this.openAiSettingsTab}
        onOpenInSplitView={this.openClassInSplitView}
        onOpenWithEncryption={this.onOpenWithEncryption}
        onRealmChanged={this.onRealmChanged}
        onReload={this.onManualReload}
        onResetSinglePane={this.resetSinglePane}
        onShowJsonViewerDialog={this.onShowJsonViewerDialog}
        onSplitPane={this.splitPane}
        panes={panes}
        progress={this.state.progress}
        realm={this.realm}
        toggleAddClass={this.toggleAddClass}
        toggleAddClassProperty={this.toggleAddClassProperty}
        toggleAiQuery={this.toggleAiQuery}
        toggleAiSettings={this.toggleAiSettings}
        toggleCommandPalette={this.toggleCommandPalette}
        toggleGlobalSearch={this.toggleGlobalSearch}
        toggleOverview={this.toggleOverview}
      />
    );
  }

  public generateMenu(template: MenuItemConstructorOptions[]) {
    const importMenu: MenuItemConstructorOptions = {
      label: 'Import data from',
      submenu: [
        {
          label: 'CSV',
          click: () => this.onImportIntoExistingRealm()
        }
      ]
    };

    const exportSchemaMenu: MenuItemConstructorOptions = {
      label: 'Save model definitions',
      submenu: [
        {
          label: 'Swift',
          click: () => this.onExportSchema(Language.Swift)
        },
        {
          label: 'JavaScript',
          click: () => this.onExportSchema(Language.JS)
        },
        {
          label: 'TypeScript',
          click: () => this.onExportSchema(Language.TS)
        },
        {
          label: 'Java',
          click: () => this.onExportSchema(Language.Java)
        },
        {
          label: 'Kotlin',
          click: () => this.onExportSchema(Language.Kotlin)
        },
        {
          label: 'C#',
          click: () => this.onExportSchema(Language.CS)
        }
      ]
    };

    const exportDataMenu: MenuItemConstructorOptions = {
      label: 'Save data',
      submenu: [
        {
          label: 'JSON',
          click: () => this.onExportData(DataExportFormat.JSON)
        },
        {
          label: 'Local Realm',
          click: () => this.onExportData(DataExportFormat.LocalRealm)
        }
      ]
    };

    const transactionMenuItems: MenuItemConstructorOptions[] =
      this.realm && this.realm.isInTransaction
        ? [
            {
              label: 'Commit transaction',
              accelerator: 'CommandOrControl+T',
              click: () => {
                this.onCommitTransaction();
              }
            },
            {
              label: 'Cancel transaction',
              accelerator: 'CommandOrControl+Shift+T',
              click: () => {
                this.onCancelTransaction();
              }
            }
          ]
        : [
            {
              label: 'Begin transaction',
              accelerator: 'CommandOrControl+T',
              click: () => {
                this.onBeginTransaction();
              }
            }
          ];

    const editModeMenu: MenuItemConstructorOptions = {
      label: 'Edit mode',
      submenu: [
        {
          label: 'Update when leaving a field',
          type: 'radio',
          checked: this.state.editMode === EditMode.InputBlur,
          click: () => {
            this.onEditModeChange(EditMode.InputBlur);
          }
        },
        {
          label: 'Update on key press',
          type: 'radio',
          checked: this.state.editMode === EditMode.KeyPress,
          click: () => {
            this.onEditModeChange(EditMode.KeyPress);
          }
        }
      ]
    };

    const copyRealmPathItem: MenuItemConstructorOptions = {
      label: 'Copy local Realm path',
      click: () => {
        this.copyRealmPathToClipboard().then(null, (err) => {
          showError('Failed to copy Realm path', err);
        });
      }
    };

    return menu.performModifications(template, [
      {
        action: 'append',
        id: 'import',
        items: [importMenu]
      },
      {
        action: 'prepend',
        id: 'close',
        items: [
          exportSchemaMenu,
          exportDataMenu,
          copyRealmPathItem,
          { type: 'separator' }
        ]
      },
      {
        action: 'append',
        id: 'select-all',
        items: [{ type: 'separator' }, ...transactionMenuItems, editModeMenu]
      }
    ]);
  }

  protected loadingRealmFailed(err: Error) {
    const message = err.message || '';
    const mightBeEncrypted =
      message.includes('Not a Realm file.') ||
      message.includes('invalid mnemonic') ||
      message.includes('Decryption failed') ||
      message.includes('Realm file initial open failed');
    const realm = this.props.realm;
    if (mightBeEncrypted) {
      if (this.untriedCandidateKeys === null) {
        this.untriedCandidateKeys = getCandidateKeysForPath(realm.path);
      }
      const nextCandidate = this.untriedCandidateKeys.shift();
      if (nextCandidate) {
        this.pendingEncryptionSave = {
          key: nextCandidate,
          remember: true
        };
        this.props.realm.encryptionKey = Buffer.from(nextCandidate, 'hex');
        void this.loadRealm(
          this.props.realm,
          this.props.import ? this.props.import.schema : undefined
        ).then(() => this.startWatchingRealmFile());
        return;
      }
      this.setState({
        isEncryptionDialogVisible: true,
        progress: {
          status: 'done'
        }
      });
    } else if (message === FILE_UPGRADE_NEEDED_MESSAGE) {
      const buttons = ['Cancel', 'Upgrade in-place', 'Backup and upgrade'];
      const answerIndex = remote.dialog.showMessageBoxSync({
        type: 'question',
        buttons,
        defaultId: 2,
        title: 'Realm file needs an upgrade',
        message: 'The Realm file stores data in an outdated format',
        detail:
          'This file needs to be upgraded to a newer file format before it can be opened. Would you like a backup of the file, before performing an irreversible upgrade of the file?'
      });
      const answer = buttons[answerIndex];

      if (answer === 'Upgrade in-place' || answer === 'Backup and upgrade') {
        try {
          if (answer === 'Backup and upgrade') {
            // Create a backup first
            const backupDirectory = path.dirname(realm.path);
            const backupFileName = path.basename(realm.path, '.realm');
            const backupPath = path.resolve(
              backupDirectory,
              backupFileName + '.backup.realm'
            );
            // Copy, but ensure we don't override an existing file
            fs.copyFileSync(realm.path, backupPath, fs.constants.COPYFILE_EXCL);
            remote.dialog.showMessageBox({
              title: 'Backup saved',
              message: 'The backup Realm file was saved to:',
              detail: backupPath
            });
          }
          // Reopen, enabling format upgrades an upgrade
          this.loadRealm({
            ...realm,
            enableFormatUpgrade: true
          });
        } catch (err) {
          showError('Failed upgrading Realm', err);
          window.close();
        }
      } else {
        window.close();
      }
    } else if (err.message === ARCHITECTURE_MISMATCH_MESSAGE) {
      const improvedError = new Error(
        'The file is already opened by another process, with an incompatible lock file format. Try up- or downgrading Realm Studio or SDK to match their versions of Realm Core.\n\nSee Realm Studio changelog on GitHub for details on compatibility between versions.'
      );
      showError('Failed to open Realm', improvedError);
      window.close();
    } else {
      delete this.props.realm.encryptionKey;
      super.loadingRealmFailed(err);
    }
  }

  protected onRealmChanged = () => {
    this.setState({ dataVersion: this.state.dataVersion + 1 });
  };

  protected onRealmSchemaChanged = () => {
    if (!this.realm) {
      return;
    }
    const schema = this.realm.schema;
    this.setState((prev) => {
      const nextPanes: Record<string, IPaneViewState | undefined> = {};
      for (const [paneId, pane] of Object.entries(prev.panes)) {
        if (!pane) {
          continue;
        }
        const nextFocus =
          pane.focus && this.isFocusValid(pane.focus)
            ? this.refreshFocus(pane.focus)
            : null;
        nextPanes[paneId] = {
          ...pane,
          focus: nextFocus,
          allowCreate: nextFocus ? this.isCreateAllowed(nextFocus) : false,
          activeObjectId: nextFocus ? pane.activeObjectId : null
        };
      }
      return { classes: schema, panes: nextPanes };
    });
  };

  protected onRealmLoaded = () => {
    if (!this.realm) {
      throw new Error('onRealmLoaded was called without a realm sat');
    }
    if (this.pendingEncryptionSave && this.pendingEncryptionSave.remember) {
      saveEncryptionKeyForPath(
        this.props.realm.path,
        this.pendingEncryptionSave.key,
        this.pendingEncryptionSave.label
      );
      this.pendingEncryptionSave = undefined;
    }
    this.untriedCandidateKeys = [];
    if (this.props.readOnly) {
      // Monkey-patch the write function to ensure no-one writes to the Realm
      this.realm.write = () => {
        throw new Error('Realm was opened as read-only');
      };
    }

    const isAndroidTracked = !!getTrackedAndroidRealmInfo(this.realm.path);
    const nonSystem = this.realm.schema.filter(
      (c) => c.name.indexOf('__') !== 0 && !c.embedded
    );
    const firstSchemaName = nonSystem[0]?.name;
    const leafIds = listLeafIds(this.state.layout);
    const pendingSnapshot = { ...this.pendingPaneClassNames };
    this.pendingPaneClassNames = {};

    const nextPanes: Record<string, IPaneViewState> = {};
    const usedClasses = new Set<string>();
    const activeLeafId = containsPane(this.state.layout, this.state.activePaneId)
      ? this.state.activePaneId
      : leafIds[0] ?? INITIAL_PANE_ID;

    // Resolve the primary/active pane first so sibling panes pick complementary classes
    const orderedLeaves = [
      activeLeafId,
      ...leafIds.filter((id) => id !== activeLeafId)
    ];
    for (const paneId of orderedLeaves) {
      const pending = pendingSnapshot[paneId];
      let targetClassName =
        pending && nonSystem.some((c) => c.name === pending)
          ? pending
          : undefined;
      if (!targetClassName) {
        if (paneId === activeLeafId) {
          targetClassName = firstSchemaName;
        } else {
          const unused = nonSystem.find((c) => !usedClasses.has(c.name));
          targetClassName = unused?.name ?? firstSchemaName;
        }
      }
      if (targetClassName) {
        usedClasses.add(targetClassName);
        const focus = this.getClassFocus(targetClassName);
        nextPanes[paneId] = {
          id: paneId,
          activeObjectId: null,
          allowCreate: this.isCreateAllowed(focus),
          focus,
          history: [{ focus, breadcrumbs: [{ label: targetClassName, focus }] }],
          historyIndex: 0
        };
      } else {
        nextPanes[paneId] = createEmptyPaneState(paneId);
      }
    }

    const activeFocus = nextPanes[activeLeafId]?.focus;
    const activeClassName = activeFocus ? getClassName(activeFocus) : undefined;

    registerOpenRealmSession({
      id: this.activeSessionId,
      path: this.realm.path,
      activeClassName,
      schemaVersion: this.realm.schemaVersion
    });

    this.setState({
      activePaneId: activeLeafId,
      classes: this.realm.schema,
      isAndroidTracked,
      panes: nextPanes
    });
    // Start importing data if needed
    if (this.props.import && this.realm) {
      const { format, paths } = this.props.import;
      // Assume the schema class names were generated from the files basenames
      const files = paths.map((p) => ({
        path: p,
        className: path.basename(p)
      }));
      this.handleImport(format, files);
    }
  };

  private isEmbeddedType: IsEmbeddedTypeChecker = (
    className?: string
  ): boolean => {
    const { classes } = this.state;
    return classes.find((c) => c.name === className)?.embedded ?? false;
  };

  private isCreateAllowed = (focus?: Focus): boolean => {
    // Disallow creation on full embedded class list
    if (
      focus?.isEmbedded &&
      (focus.kind === 'class' || focus.kind === 'single-object')
    ) {
      return false;
    }

    return true;
  };

  private onBeginTransaction = () => {
    if (this.realm && !this.realm.isInTransaction) {
      this.realm.beginTransaction();
      // Ask the menu to update
      this.props.updateMenu();
      // Hang on to the dataVersion
      this.setState({
        dataVersionAtBeginning: this.state.dataVersion
      });
    } else {
      throw new Error(`Realm is not ready or already in transaction`);
    }
  };

  private onCommitTransaction = () => {
    if (this.realm && this.realm.isInTransaction) {
      this.realm.commitTransaction();
      this.props.updateMenu();
      this.resetDataVersion();
    } else {
      throw new Error('Cannot commit when not in a transaction');
    }
  };

  private onCancelTransaction = () => {
    if (this.realm && this.realm.isInTransaction) {
      this.realm.cancelTransaction();
      this.props.updateMenu();
      this.resetDataVersion();
    } else {
      throw new Error('Cannot cancel when not in a transaction');
    }
  };

  private isClassNameAvailable = (name: string): boolean => {
    return !this.state.classes.find((schema) => schema.name === name);
  };

  private toggleAddClass = () => {
    this.setState({
      isAddClassOpen: !this.state.isAddClassOpen
    });
  };

  private toggleOverview = () => {
    this.setState({
      isOverviewOpen: !this.state.isOverviewOpen
    });
  };

  private toggleGlobalSearch = () => {
    this.setState({
      isGlobalSearchOpen: !this.state.isGlobalSearchOpen
    });
  };

  private toggleAiQuery = () => {
    this.setState((prev) => ({
      isAiQueryOpen: !prev.isAiQueryOpen
    }));
  };

  private toggleAiSettings = () => {
    this.setState((prev) => ({
      aiSettingsInitialTab: 'ai',
      isAiSettingsOpen: !prev.isAiSettingsOpen
    }));
  };

  private openAiSettingsTab = (tab: AiSettingsModalTab = 'ai') => {
    this.setState({
      aiSettingsInitialTab: tab,
      isAiSettingsOpen: true
    });
  };

  private onApplyAiQuery = (query: string, targetClassName?: string) => {
    const activePaneId = this.getResolvedActivePaneId();
    const currentFocus = this.state.panes[activePaneId]?.focus;
    const currentClassName = currentFocus
      ? getClassName(currentFocus)
      : undefined;

    if (
      targetClassName &&
      targetClassName !== currentClassName &&
      this.realm?.schema.some((s) => s.name === targetClassName)
    ) {
      const focus = this.getClassFocus(targetClassName);
      this.changePaneFocusIfAllowed(
        activePaneId,
        focus,
        undefined,
        [{ label: targetClassName, focus }],
        () => {
          this.paneContentInstances.get(activePaneId)?.setQuery(query);
        }
      );
      return;
    }

    const targetContent = this.paneContentInstances.get(activePaneId);
    if (targetContent) {
      targetContent.setQuery(query);
    }
  };

  private toggleCommandPalette = () => {
    this.setState({
      isCommandPaletteOpen: !this.state.isCommandPaletteOpen
    });
  };

  private buildCommandPaletteActions = memoizeOne(
    (
      classes: Realm.ObjectSchema[],
      paneCount: number,
      isAndroidTracked: boolean,
      readOnly: boolean
    ): ICommandPaletteAction[] => {
      const actions: ICommandPaletteAction[] = [];
      for (const schema of classes) {
        if (schema.name.startsWith('__')) {
          continue;
        }
        actions.push({
          id: `class:${schema.name}`,
          category: 'Class',
          label: `Open Class: ${schema.name}`,
          run: () => this.onClassFocussed(schema.name)
        });
      }
      actions.push(
        {
          id: 'action:ask-ai',
          category: 'AI',
          label: 'Ask AI: Search IDs, Q&A & Realm Query (⌘⇧A)',
          run: () => this.setState({ isAiQueryOpen: true })
        },
        {
          id: 'action:ai-settings',
          category: 'AI',
          label: 'AI Assistant & MCP Server Settings (Copy MCP JSON)...',
          run: () => this.setState({ isAiSettingsOpen: true })
        },
        {
          id: 'action:split-right',
          category: 'View',
          label: 'Split Active Pane Right (Left / Right) (⌘\\)',
          run: () =>
            this.splitPane(this.getResolvedActivePaneId(), 'horizontal')
        },
        {
          id: 'action:split-down',
          category: 'View',
          label: 'Split Active Pane Down (Top / Bottom) (⌘⇧\\)',
          run: () => this.splitPane(this.getResolvedActivePaneId(), 'vertical')
        },
        ...(paneCount > 1
          ? [
              {
                id: 'action:close-active-pane',
                category: 'View',
                label: 'Close Active Split Pane',
                run: () => this.closePane(this.getResolvedActivePaneId())
              },
              {
                id: 'action:reset-single-pane',
                category: 'View',
                label: 'Close All Split Panes (Return to Single Pane)',
                run: () => this.resetSinglePane()
              }
            ]
          : []),
        {
          id: 'action:global-search',
          category: 'Action',
          label: 'Global Search Across All Classes (⌘⇧F)',
          run: () => this.setState({ isGlobalSearchOpen: true })
        },
        {
          id: 'action:overview',
          category: 'Action',
          label: 'Database Overview, Encryption & Schema Code Preview',
          run: () => this.setState({ isOverviewOpen: true })
        },
        {
          id: 'action:reload',
          category: 'Action',
          label: isAndroidTracked
            ? 'Pull Fresh from Android & Reload'
            : 'Reload Realm File from Disk',
          run: () => this.onManualReload()
        },
        ...(isAndroidTracked
          ? [
              {
                id: 'action:android-sync-5s',
                category: 'Android',
                label: 'Android Auto Sync: Every 5 Seconds',
                run: () => this.setAndroidAutoSync(5)
              },
              {
                id: 'action:android-sync-10s',
                category: 'Android',
                label: 'Android Auto Sync: Every 10 Seconds',
                run: () => this.setAndroidAutoSync(10)
              },
              {
                id: 'action:android-sync-off',
                category: 'Android',
                label: 'Android Auto Sync: Turn Off',
                run: () => this.setAndroidAutoSync(0)
              }
            ]
          : []),
        {
          id: 'action:reveal-finder',
          category: 'Action',
          label: 'Reveal Realm File in Finder',
          run: () => {
            if (this.realm) {
              shell.showItemInFolder(this.realm.path);
            }
          }
        },
        {
          id: 'action:copy-path',
          category: 'Action',
          label: 'Copy Local Realm Path to Clipboard',
          run: () => {
            void this.copyRealmPathToClipboard();
          }
        }
      );
      if (!readOnly) {
        actions.push(
          {
            id: 'action:add-class',
            category: 'Schema',
            label: 'Create New Class...',
            run: () => this.setState({ isAddClassOpen: true })
          },
          {
            id: 'action:add-property',
            category: 'Schema',
            label: 'Add Property / Column to Current Class...',
            run: () => this.setState({ isAddPropertyOpen: true })
          }
        );
      }
      return actions;
    }
  );

  private getCommandPaletteActions(): ICommandPaletteAction[] {
    return this.buildCommandPaletteActions(
      this.state.classes,
      countLeaves(this.state.layout),
      this.state.isAndroidTracked,
      Boolean(this.props.readOnly)
    );
  }

  private getResolvedActivePaneId(): string {
    if (containsPane(this.state.layout, this.state.activePaneId)) {
      return this.state.activePaneId;
    }
    return listLeafIds(this.state.layout)[0] ?? INITIAL_PANE_ID;
  }

  private getActivePaneFocus(): Focus | null {
    const activeId = this.getResolvedActivePaneId();
    return this.state.panes[activeId]?.focus ?? null;
  }

  private getPaneSnapshot(paneId: string) {
    const pane = this.state.panes[paneId];
    return {
      focus: pane?.focus ?? null,
      history: pane?.history ?? [],
      historyIndex: pane?.historyIndex ?? -1,
      activeObjectId: pane?.activeObjectId ?? null,
      contentInstance: this.paneContentInstances.get(paneId) ?? null
    };
  }

  private getPaneBreadcrumbs(paneId: string): IBreadcrumbItem[] {
    const snap = this.getPaneSnapshot(paneId);
    if (snap.historyIndex >= 0 && snap.historyIndex < snap.history.length) {
      return snap.history[snap.historyIndex].breadcrumbs;
    }
    if (snap.focus && snap.focus.kind === 'class') {
      return [{ label: snap.focus.className, focus: snap.focus }];
    }
    return [];
  }

  private cleanupPaneCaches(paneId: string) {
    this.paneContentInstances.delete(paneId);
    this.paneContentCallbackCache.delete(paneId);
    this.paneUiCallbackCache.delete(paneId);
    delete this.pendingPaneClassNames[paneId];
    Content.clearPaneCache(paneId);
  }

  private getPaneUiCallbacks = (paneId: string): ISplitPaneUiCallbacks => {
    const cached = this.paneUiCallbackCache.get(paneId);
    if (cached) {
      return cached;
    }
    const callbacks: ISplitPaneUiCallbacks = {
      onSelect: () => this.onSelectPane(paneId),
      onSelectClass: (className) => this.onPaneSelectClass(paneId, className),
      onSplitRight: () => this.splitPane(paneId, 'horizontal'),
      onSplitDown: () => this.splitPane(paneId, 'vertical'),
      onClose: () => this.closePane(paneId)
    };
    this.paneUiCallbackCache.set(paneId, callbacks);
    return callbacks;
  };

  private getPaneContentCallbacks = (paneId: string): IPaneContentCallbacks => {
    const cached = this.paneContentCallbackCache.get(paneId);
    if (cached) {
      return cached;
    }
    const callbacks: IPaneContentCallbacks = {
      contentRef: (instance) => {
        if (instance) {
          this.paneContentInstances.set(paneId, instance);
        } else {
          this.paneContentInstances.delete(paneId);
        }
      },
      onAddColumnClick: () => {
        if (this.state.activePaneId !== paneId) {
          this.setState({ activePaneId: paneId, isAddPropertyOpen: true });
        } else {
          this.toggleAddClassProperty();
        }
      },
      onAskAi: () => {
        if (this.state.activePaneId !== paneId) {
          this.setState({ activePaneId: paneId, isAiQueryOpen: true });
        } else {
          this.toggleAiQuery();
        }
      },
      onClassFocussed: (
        className,
        highlightedObject,
        parentObject,
        property
      ) =>
        this.handlePaneClassFocussed(
          paneId,
          className,
          highlightedObject,
          parentObject,
          property
        ),
      onHighlightChange: (highlight, collection) =>
        this.handlePaneHighlightChange(paneId, highlight, collection),
      onListFocussed: (object, property, highlightedObject) =>
        this.handlePaneListFocussed(
          paneId,
          object,
          property,
          highlightedObject
        ),
      onSingleListFocussed: (object, property) =>
        this.handlePaneSingleListFocussed(paneId, object, property)
    };
    this.paneContentCallbackCache.set(paneId, callbacks);
    return callbacks;
  };

  private pickDefaultSplitClassName(sourcePaneId: string): string | undefined {
    if (!this.realm) {
      return undefined;
    }
    const nonSystem = this.realm.schema.filter(
      (c) => !c.name.startsWith('__') && !c.embedded
    );
    if (nonSystem.length === 0) {
      return undefined;
    }
    const openClasses = new Set<string>();
    for (const id of listLeafIds(this.state.layout)) {
      const f = this.state.panes[id]?.focus;
      if (f) {
        openClasses.add(getClassName(f));
      }
    }
    const sourceFocus = this.state.panes[sourcePaneId]?.focus;
    const sourceClassName = sourceFocus ? getClassName(sourceFocus) : undefined;
    if (sourceClassName) {
      const sourceSchema = this.realm.schema.find(
        (s) => s.name === sourceClassName
      );
      if (sourceSchema) {
        for (const rawProp of Object.values(sourceSchema.properties)) {
          const objectType =
            typeof rawProp === 'object' ? rawProp.objectType : undefined;
          if (
            objectType &&
            objectType !== sourceClassName &&
            !openClasses.has(objectType) &&
            nonSystem.some((c) => c.name === objectType)
          ) {
            return objectType;
          }
        }
      }
      const unopened = nonSystem.find((c) => !openClasses.has(c.name));
      if (unopened) {
        return unopened.name;
      }
      const other = nonSystem.find((c) => c.name !== sourceClassName);
      if (other) {
        return other.name;
      }
    }
    return sourceClassName ?? nonSystem[0].name;
  }

  private splitPane = (
    targetPaneId: string,
    direction: SplitDirection = 'horizontal',
    explicitClassName?: string,
    highlightedObject?: Realm.Object
  ) => {
    if (!this.realm) {
      return;
    }
    const resolvedTarget = containsPane(this.state.layout, targetPaneId)
      ? targetPaneId
      : this.getResolvedActivePaneId();
    const targetClassName =
      explicitClassName || this.pickDefaultSplitClassName(resolvedTarget);
    if (!targetClassName) {
      return;
    }
    const focus = this.getClassFocus(targetClassName);
    const allowCreate = this.isCreateAllowed(focus);
    const newPaneId = allocateLayoutId('pane');
    const branchId = allocateLayoutId('branch');
    const validHighlight =
      highlightedObject && highlightedObject.isValid()
        ? highlightedObject
        : undefined;
    const activeObjectId = validHighlight
      ? extractObjectIdentifier(validHighlight)
      : null;
    const newPaneState: IPaneViewState = {
      id: newPaneId,
      activeObjectId,
      allowCreate,
      focus,
      history: [
        {
          focus,
          highlightedObject: validHighlight,
          breadcrumbs: [
            {
              label: targetClassName,
              objectId: activeObjectId,
              focus,
              highlightedObject: validHighlight
            }
          ]
        }
      ],
      historyIndex: 0
    };
    this.setState(
      (prev) => {
        const targetId = containsPane(prev.layout, targetPaneId)
          ? targetPaneId
          : listLeafIds(prev.layout)[0] ?? INITIAL_PANE_ID;
        return {
          activePaneId: newPaneId,
          layout: splitPaneInLayout(
            prev.layout,
            targetId,
            newPaneId,
            direction,
            'after',
            branchId
          ),
          panes: {
            ...prev.panes,
            [newPaneId]: newPaneState
          }
        };
      },
      () => {
        if (validHighlight && validHighlight.isValid()) {
          this.paneContentInstances
            .get(newPaneId)
            ?.highlightObject(validHighlight);
        }
      }
    );
  };

  private openClassInSplitView = (
    className: string,
    highlightedObject?: Realm.Object
  ) => {
    this.splitPane(
      this.getResolvedActivePaneId(),
      'horizontal',
      className,
      highlightedObject
    );
  };

  private closePane = (paneId: string) => {
    this.setState(
      (prev) => {
        if (countLeaves(prev.layout) <= 1) {
          return null;
        }
        const nextLayout = closePaneInLayout(prev.layout, paneId);
        if (nextLayout === prev.layout) {
          return null;
        }
        const nextPanes: Record<string, IPaneViewState | undefined> = {
          ...prev.panes
        };
        delete nextPanes[paneId];
        const nextActive =
          prev.activePaneId === paneId ||
          !containsPane(nextLayout, prev.activePaneId)
            ? findAdjacentPaneId(prev.layout, paneId) ??
              listLeafIds(nextLayout)[0] ??
              INITIAL_PANE_ID
            : prev.activePaneId;
        return {
          activePaneId: nextActive,
          layout: nextLayout,
          panes: nextPanes
        };
      },
      () => {
        this.cleanupPaneCaches(paneId);
      }
    );
  };

  private resetSinglePane = () => {
    let removedIds: string[] = [];
    this.setState(
      (prev) => {
        const leafIds = listLeafIds(prev.layout);
        if (leafIds.length <= 1) {
          return null;
        }
        const keepPaneId = containsPane(prev.layout, prev.activePaneId)
          ? prev.activePaneId
          : leafIds[0];
        removedIds = leafIds.filter((id) => id !== keepPaneId);
        return {
          activePaneId: keepPaneId,
          layout: createInitialLayout(keepPaneId),
          panes: {
            [keepPaneId]:
              prev.panes[keepPaneId] ?? createEmptyPaneState(keepPaneId)
          }
        };
      },
      () => {
        for (const id of removedIds) {
          this.cleanupPaneCaches(id);
        }
      }
    );
  };

  private onSelectPane = (paneId: string) => {
    if (
      this.state.activePaneId !== paneId &&
      containsPane(this.state.layout, paneId)
    ) {
      this.setState({ activePaneId: paneId });
    }
  };

  private onCommitBranchRatio = (branchId: string, ratio: number) => {
    this.setState((prev) => {
      const nextLayout = updateBranchRatioInLayout(
        prev.layout,
        branchId,
        ratio
      );
      return nextLayout === prev.layout ? null : { layout: nextLayout };
    });
  };

  private onDropPane = (
    sourcePaneId: string,
    targetPaneId: string,
    zone: SplitDropZone
  ) => {
    this.setState((prev) => {
      const nextLayout = moveOrSwapPaneInLayout(
        prev.layout,
        sourcePaneId,
        targetPaneId,
        zone
      );
      if (nextLayout === prev.layout) {
        return null;
      }
      return {
        activePaneId: sourcePaneId,
        layout: nextLayout
      };
    });
  };

  private onPaneSelectClass = (paneId: string, className: string) => {
    this.setState({ activePaneId: paneId }, () => {
      this.handlePaneClassFocussed(paneId, className);
    });
  };

  private onDeleteClass = (className: string) => {
    if (this.props.readOnly || !this.realm) {
      return;
    }
    const answer = remote.dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Cancel', `Delete "${className}"`],
      defaultId: 0,
      cancelId: 0,
      title: `Delete Class "${className}"`,
      message: `Are you sure you want to permanently delete the class "${className}" and all of its objects?`
    });
    if (answer !== 1) {
      return;
    }
    try {
      const realm = this.realm;
      const runDelete = () => {
        realm.deleteModel(className);
      };
      if (realm.isInTransaction) {
        runDelete();
      } else {
        realm.write(runDelete);
      }
      const nextClasses = realm.schema;
      const nextFocusClass = nextClasses.find(
        (c) => !c.name.startsWith('__') && !c.embedded && c.name !== className
      )?.name;
      this.setState((prev) => {
        const nextPanes: Record<string, IPaneViewState | undefined> = {};
        for (const paneId of listLeafIds(prev.layout)) {
          const pane = prev.panes[paneId];
          const wasDeletedClass =
            !pane?.focus ||
            getClassName(pane.focus) === className ||
            !this.isFocusValid(pane.focus);
          if (wasDeletedClass) {
            if (nextFocusClass) {
              const focus = this.getClassFocus(nextFocusClass);
              nextPanes[paneId] = {
                id: paneId,
                activeObjectId: null,
                allowCreate: this.isCreateAllowed(focus),
                focus,
                history: [
                  { focus, breadcrumbs: [{ label: nextFocusClass, focus }] }
                ],
                historyIndex: 0
              };
            } else {
              nextPanes[paneId] = createEmptyPaneState(paneId);
            }
          } else if (pane?.focus) {
            const refreshed = this.refreshFocus(pane.focus);
            nextPanes[paneId] = {
              ...pane,
              focus: refreshed,
              allowCreate: this.isCreateAllowed(refreshed)
            };
          }
        }
        return {
          classes: nextClasses,
          panes: nextPanes
        };
      });
    } catch (err) {
      showError(`Failed deleting class "${className}"`, err);
    }
  };

  private isPropertyNameAvailable = (name: string): boolean => {
    const targetFocus = this.getActivePaneFocus();
    return (
      targetFocus !== null &&
      !targetFocus.properties.find((property) => property.name === name)
    );
  };

  private toggleAddClassProperty = () => {
    this.setState({
      isAddPropertyOpen: !this.state.isAddPropertyOpen
    });
  };

  private onAddClass = async (schema: Realm.ObjectSchema) => {
    if (this.realm) {
      try {
        const leafIds = listLeafIds(this.state.layout);
        const targetPaneId = this.getResolvedActivePaneId();
        for (const paneId of leafIds) {
          const paneFocus = this.state.panes[paneId]?.focus;
          if (paneFocus) {
            this.pendingPaneClassNames[paneId] = getClassName(paneFocus);
          }
        }
        this.pendingPaneClassNames[targetPaneId] = schema.name;
        const nextSchemaVersion = this.realm.schemaVersion + 1;
        const modifiedSchema = [...this.state.classes, schema];
        const closingRealm = this.realm;
        delete this.realm;
        flushSync(() => {
          const clearedPanes: Record<string, IPaneViewState> = {};
          for (const paneId of leafIds) {
            clearedPanes[paneId] = createEmptyPaneState(paneId);
          }
          this.setState({ panes: clearedPanes });
        });
        closingRealm.close();
        await this.loadRealm(
          this.props.realm,
          modifiedSchema,
          nextSchemaVersion
        );
      } catch (err) {
        showError(`Failed creating the model "${schema.name}"`, err);
      }
    }
  };

  private onAddProperty = async (name: string, type: string) => {
    const activeFocus = this.getActivePaneFocus();
    if (this.realm && activeFocus && activeFocus.kind === 'class') {
      try {
        const focusedClassName = activeFocus.className;
        const leafIds = listLeafIds(this.state.layout);
        const activePaneId = this.getResolvedActivePaneId();
        for (const paneId of leafIds) {
          const paneFocus = this.state.panes[paneId]?.focus;
          if (paneFocus) {
            this.pendingPaneClassNames[paneId] = getClassName(paneFocus);
          }
        }
        if (!this.pendingPaneClassNames[activePaneId]) {
          this.pendingPaneClassNames[activePaneId] = focusedClassName;
        }
        const nextSchemaVersion = this.realm.schemaVersion + 1;
        const modifiedSchema = schemaUtils.addProperty(
          this.state.classes,
          focusedClassName,
          name,
          type
        );
        const closingRealm = this.realm;
        delete this.realm;
        flushSync(() => {
          const clearedPanes: Record<string, IPaneViewState> = {};
          for (const paneId of leafIds) {
            clearedPanes[paneId] = createEmptyPaneState(paneId);
          }
          this.setState({ panes: clearedPanes });
        });
        closingRealm.close();
        await this.loadRealm(
          this.props.realm,
          modifiedSchema,
          nextSchemaVersion
        );
      } catch (err) {
        showError(
          `Failed adding the property named "${name}" to the selected schema`,
          err
        );
      }
    }
  };

  private isFocusValid(focus: Focus): boolean {
    if (!this.realm) {
      return false;
    }
    if (focus.kind === 'class') {
      return this.realm.schema.some((s) => s.name === focus.className);
    }
    return focus.parent.isValid();
  }

  private refreshFocus(focus: Focus): Focus {
    if (focus.kind === 'class') {
      return this.getClassFocus(focus.className);
    } else if (focus.kind === 'list') {
      return this.getListFocus(focus.parent, focus.property);
    } else {
      return this.getSingleObjectFocus(focus.parent, focus.property);
    }
  }

  private changePaneFocusIfAllowed(
    paneId: string,
    focus: Focus,
    highlightedObject?: Realm.Object,
    breadcrumbs?: IBreadcrumbItem[],
    onCommitted?: () => void
  ) {
    if (!this.canChangeFocus(paneId)) {
      return;
    }
    const allowCreate = this.isCreateAllowed(focus);
    const snap = this.getPaneSnapshot(paneId);
    const nextBreadcrumbs =
      breadcrumbs ??
      (focus.kind === 'class' ? [{ label: focus.className, focus }] : []);
    const nextHistory = snap.history
      .slice(0, snap.historyIndex + 1)
      .concat([{ focus, highlightedObject, breadcrumbs: nextBreadcrumbs }])
      .slice(-MAX_HISTORY_ENTRIES);
    const nextIndex = nextHistory.length - 1;
    const activeObjectId = highlightedObject
      ? extractObjectIdentifier(highlightedObject)
      : null;

    this.setState(
      (prev) => {
        const existingPane = prev.panes[paneId] ?? createEmptyPaneState(paneId);
        return {
          panes: {
            ...prev.panes,
            [paneId]: {
              ...existingPane,
              id: paneId,
              activeObjectId,
              focus,
              allowCreate,
              history: nextHistory,
              historyIndex: nextIndex
            }
          }
        };
      },
      () => {
        if (paneId === this.getResolvedActivePaneId()) {
          updateOpenRealmSession(this.activeSessionId, {
            activeClassName: getClassName(focus),
            focusedAt: Date.now()
          });
        }
        const targetContent = this.paneContentInstances.get(paneId);
        if (
          highlightedObject &&
          highlightedObject.isValid() &&
          targetContent
        ) {
          targetContent.highlightObject(highlightedObject);
        }
        onCommitted?.();
      }
    );
  }

  private restorePaneHistoryEntry(paneId: string, targetIndex: number) {
    if (!this.canChangeFocus(paneId)) {
      return;
    }
    const snap = this.getPaneSnapshot(paneId);
    const entry = snap.history[targetIndex];
    if (!entry || !this.isFocusValid(entry.focus)) {
      return;
    }
    const focus = this.refreshFocus(entry.focus);
    const allowCreate = this.isCreateAllowed(focus);
    const validHighlight =
      entry.highlightedObject && entry.highlightedObject.isValid()
        ? entry.highlightedObject
        : undefined;
    const activeObjectId = validHighlight
      ? extractObjectIdentifier(validHighlight)
      : null;

    this.setState(
      (prev) => {
        const existingPane = prev.panes[paneId] ?? createEmptyPaneState(paneId);
        return {
          panes: {
            ...prev.panes,
            [paneId]: {
              ...existingPane,
              id: paneId,
              activeObjectId,
              focus,
              allowCreate,
              historyIndex: targetIndex
            }
          }
        };
      },
      () => {
        const targetContent = this.paneContentInstances.get(paneId);
        if (validHighlight && targetContent) {
          targetContent.highlightObject(validHighlight);
        }
      }
    );
  }

  private handlePaneHighlightChange(
    paneId: string,
    highlight: IHighlight | undefined,
    collection: Realm.OrderedCollection<any>
  ) {
    const currentId = this.getPaneSnapshot(paneId).activeObjectId;
    let nextId: IObjectIdentifier | null = currentId;
    if (highlight && highlight.rows.size === 1) {
      const rowIndex = highlight.rows.values().next().value;
      const rowObj =
        typeof rowIndex === 'number' ? collection[rowIndex] : undefined;
      const extracted =
        rowObj && typeof rowObj === 'object'
          ? extractObjectIdentifier(rowObj as Realm.Object)
          : null;
      nextId =
        extracted ??
        (typeof rowIndex === 'number'
          ? { key: 'row', value: `#${rowIndex}`, isPrimaryKey: false }
          : null);
    } else if (currentId !== null) {
      nextId = null;
    } else {
      return;
    }

    if (nextId === currentId) {
      return;
    }

    this.setState((prev) => {
      const existing = prev.panes[paneId];
      if (!existing) {
        return null;
      }
      return {
        panes: {
          ...prev.panes,
          [paneId]: {
            ...existing,
            activeObjectId: nextId
          }
        }
      };
    });
  }

  private onNavigateBack = () => {
    const paneId = this.getResolvedActivePaneId();
    const { history, historyIndex } = this.getPaneSnapshot(paneId);
    for (let i = historyIndex - 1; i >= 0; i--) {
      if (this.isFocusValid(history[i].focus)) {
        this.restorePaneHistoryEntry(paneId, i);
        return;
      }
    }
  };

  private onNavigateForward = () => {
    const paneId = this.getResolvedActivePaneId();
    const { history, historyIndex } = this.getPaneSnapshot(paneId);
    for (let i = historyIndex + 1; i < history.length; i++) {
      if (this.isFocusValid(history[i].focus)) {
        this.restorePaneHistoryEntry(paneId, i);
        return;
      }
    }
  };

  private onBreadcrumbClick = (index: number) => {
    const paneId = this.getResolvedActivePaneId();
    const currentBreadcrumbs = this.getPaneBreadcrumbs(paneId);
    const target = currentBreadcrumbs[index];
    if (!target || !this.isFocusValid(target.focus)) {
      return;
    }
    const focus = this.refreshFocus(target.focus);
    const nextBreadcrumbs = currentBreadcrumbs.slice(0, index + 1);
    const validHighlight =
      target.highlightedObject && target.highlightedObject.isValid()
        ? target.highlightedObject
        : undefined;
    this.changePaneFocusIfAllowed(
      paneId,
      focus,
      validHighlight,
      nextBreadcrumbs
    );
  };

  private handlePaneClassFocussed(
    paneId: string,
    className: string,
    highlightedObject?: Realm.Object,
    parentObject?: Realm.Object,
    property?: IPropertyWithName
  ) {
    const focus = this.getClassFocus(className);
    const snap = this.getPaneSnapshot(paneId);
    const currentBreadcrumbs = this.getPaneBreadcrumbs(paneId);

    if (!highlightedObject) {
      const current = snap.focus;
      if (
        current &&
        current.kind === 'class' &&
        current.className === className &&
        currentBreadcrumbs.length === 1
      ) {
        return;
      }
      this.changePaneFocusIfAllowed(paneId, focus, undefined, [
        { label: className, focus }
      ]);
      return;
    }

    const targetId = extractObjectIdentifier(highlightedObject);

    if (parentObject && property) {
      const parentId = extractObjectIdentifier(parentObject);
      const updatedBase = currentBreadcrumbs.map((crumb, idx) =>
        idx === currentBreadcrumbs.length - 1
          ? {
              ...crumb,
              objectId: parentId ?? crumb.objectId,
              highlightedObject: parentObject
            }
          : crumb
      );
      const nextCrumb: IBreadcrumbItem = {
        label: `.${property.name ?? className}`,
        typeLabel: className,
        objectId: targetId,
        focus,
        highlightedObject
      };
      this.changePaneFocusIfAllowed(paneId, focus, highlightedObject, [
        ...updatedBase,
        nextCrumb
      ]);
      return;
    }

    const ancestorIndex = currentBreadcrumbs.findIndex(
      (crumb) =>
        crumb.focus.kind === 'class' && crumb.focus.className === className
    );
    if (ancestorIndex >= 0 && ancestorIndex < currentBreadcrumbs.length - 1) {
      const truncated = currentBreadcrumbs
        .slice(0, ancestorIndex + 1)
        .map((c, idx) =>
          idx === ancestorIndex
            ? { ...c, objectId: targetId ?? c.objectId, highlightedObject }
            : c
        );
      this.changePaneFocusIfAllowed(paneId, focus, highlightedObject, truncated);
    } else {
      const nextCrumb: IBreadcrumbItem = {
        label: className,
        objectId: targetId,
        focus,
        highlightedObject
      };
      const base =
        currentBreadcrumbs.length > 0
          ? currentBreadcrumbs
          : [{ label: className, objectId: targetId, focus }];
      this.changePaneFocusIfAllowed(paneId, focus, highlightedObject, [
        ...base,
        nextCrumb
      ]);
    }
  }

  private handlePaneListFocussed(
    paneId: string,
    object: Realm.Object,
    property: IPropertyWithName,
    highlightedObject?: Realm.Object
  ) {
    const focus = this.getListFocus(object, property);
    const parentId = extractObjectIdentifier(object);
    const currentBreadcrumbs = this.getPaneBreadcrumbs(paneId);
    const updatedBase = currentBreadcrumbs.map((crumb, idx) =>
      idx === currentBreadcrumbs.length - 1
        ? {
            ...crumb,
            objectId: parentId ?? crumb.objectId,
            highlightedObject: object
          }
        : crumb
    );
    const nextCrumb: IBreadcrumbItem = {
      label: `.${property.name ?? 'list'}`,
      typeLabel: property.objectType ? `${property.objectType}[]` : 'List',
      objectId: highlightedObject
        ? extractObjectIdentifier(highlightedObject)
        : null,
      focus,
      highlightedObject
    };
    this.changePaneFocusIfAllowed(paneId, focus, highlightedObject, [
      ...updatedBase,
      nextCrumb
    ]);
  }

  private handlePaneSingleListFocussed(
    paneId: string,
    object: Realm.Object,
    property: IPropertyWithName
  ) {
    const focus = this.getSingleObjectFocus(object, property);
    const parentId = extractObjectIdentifier(object);
    const childObj =
      property.name && object.isValid()
        ? (object as unknown as Record<string, unknown>)[property.name]
        : undefined;
    const childId =
      childObj && typeof childObj === 'object'
        ? extractObjectIdentifier(childObj as Realm.Object)
        : null;
    const currentBreadcrumbs = this.getPaneBreadcrumbs(paneId);
    const updatedBase = currentBreadcrumbs.map((crumb, idx) =>
      idx === currentBreadcrumbs.length - 1
        ? {
            ...crumb,
            objectId: parentId ?? crumb.objectId,
            highlightedObject: object
          }
        : crumb
    );
    const nextCrumb: IBreadcrumbItem = {
      label: `.${property.name ?? 'object'}`,
      typeLabel: property.objectType || 'Embedded',
      objectId: childId,
      focus
    };
    this.changePaneFocusIfAllowed(paneId, focus, undefined, [
      ...updatedBase,
      nextCrumb
    ]);
  }

  private onClassFocussed: ClassFocussedHandler = (
    className,
    highlightedObject,
    parentObject,
    property
  ) =>
    this.handlePaneClassFocussed(
      this.getResolvedActivePaneId(),
      className,
      highlightedObject,
      parentObject,
      property
    );

  private getClassFocus = (className: string): IClassFocus | any => {
    if (this.realm) {
      const schema = this.realm.schema.find((s) => s.name === className);

      return {
        kind: 'class',
        className,
        results:
          schema?.asymmetric || schema?.embedded
            ? new MockedObjectCollection(schema)
            : this.realm.objects(className),
        properties: this.derivePropertiesFromClassName(className),
        isEmbedded: this.isEmbeddedType(className)
      };
    } else {
      throw new Error('getClassFocus called before realm was loaded');
    }
  };

  private getSingleObjectFocus = (
    object: Realm.Object & { [name: string]: any },
    property: IPropertyWithName
  ): ISingleObjectFocus => {
    if (property.name && property.objectType) {
      return {
        kind: 'single-object',
        parent: object,
        property,
        results: new SingleObjectCollection(object[property.name]),
        properties: this.derivePropertiesFromClassName(property.objectType),
        isEmbedded: property.isEmbedded ?? false
      };
    } else {
      throw new Error('Expected a property with a name & objectType property');
    }
  };

  private getListFocus = (
    // `{ [name: string]: any }` because of Realm JS types
    object: Realm.Object & { [name: string]: any },
    property: IPropertyWithName
  ): IListFocus => {
    if (property.name) {
      const common = {
        parent: object,
        property,
        properties: this.derivePropertiesFromProperty(property),
        results: object[property.name],
        isEmbedded: this.isEmbeddedType(property.objectType)
      };
      if (property.objectType && isPrimitive(property.objectType)) {
        return {
          ...common,
          kind: 'list',
          ofPrimitives: true
        };
      } else {
        return {
          ...common,
          kind: 'list',
          ofPrimitives: false
        };
      }
    } else {
      throw new Error('Expected a property with a name property');
    }
  };

  private getSchemaLength = (name: string, isAsymmetric?: boolean) => {
    if (this.realm) {
      const asymmetric =
        isAsymmetric ??
        this.realm.schema.find((s) => s.name === name)?.asymmetric;
      return asymmetric ? 0 : this.realm.objects(name).length;
    } else {
      return 0;
    }
  };

  private onEditModeChange: EditModeChangeHandler = (editMode) => {
    localStorage.setItem(EDIT_MODE_STORAGE_KEY, editMode);
    this.setState({ editMode });
  };

  private onHideEncryptionDialog = () => {
    this.setState({ isEncryptionDialogVisible: false });
  };

  private onHideImportDialog = () => {
    this.setState({ importDialog: null });
  };

  private onShowJsonViewerDialog: JsonViewerDialogExecutor = (
    value: unknown,
    onSave?: (updatedJson: string) => void
  ) => {
    this.setState({ jsonViewerDialog: { value, onSave } });
  };

  private onHideJsonViewerDialog = () => {
    this.setState({ jsonViewerDialog: null });
  };

  private onLeftSidebarToggle = () => {
    this.setState({ isLeftSidebarOpen: !this.state.isLeftSidebarOpen });
  };

  private onOpenWithEncryption = (
    key: string,
    remember = true,
    label?: string
  ) => {
    this.pendingEncryptionSave = { key, remember, label };
    this.props.realm.encryptionKey = Buffer.from(key, 'hex');
    this.loadRealm(this.props.realm).then(() => this.startWatchingRealmFile());
  };

  private onManualReload = () => {
    // A manual reload is also a vote of confidence that we should resume
    // watching: clear the attempt counter and re-enable the watcher in case
    // it was previously disabled by the rate limiter.
    this.reloadAttemptTimestamps = [];
    this.watcherDisabled = false;
    void this.reloadFromDisk({ rePullAndroid: true });
  };

  private stopAndroidAutoSync = () => {
    if (this.androidSyncTimer) {
      clearInterval(this.androidSyncTimer);
      this.androidSyncTimer = null;
    }
  };

  private setAndroidAutoSync = (seconds: 0 | 5 | 10 | 30) => {
    this.stopAndroidAutoSync();
    if (seconds <= 0) {
      this.setState({ androidAutoSyncSec: 0, androidSyncStatus: null });
      return;
    }
    this.setState({
      androidAutoSyncSec: seconds,
      androidSyncStatus: 'Active'
    });
    this.androidSyncTimer = setInterval(() => {
      void this.onAndroidAutoSyncTick();
    }, seconds * 1000);
    void this.onAndroidAutoSyncTick();
  };

  private onAndroidAutoSyncTick = async () => {
    if (
      this.isReloading ||
      this.isAndroidSyncTicking ||
      !this.props.realm?.path ||
      (this.realm && this.realm.isInTransaction)
    ) {
      return;
    }
    this.isAndroidSyncTicking = true;
    this.setState({ androidSyncStatus: 'Checking...' });
    try {
      const changed = await hasAndroidRemoteFileChanged(this.props.realm.path);
      if (!changed) {
        if (this.state.androidAutoSyncSec > 0) {
          this.setState({ androidSyncStatus: 'Up to date' });
        }
        return;
      }
      this.setState({ androidSyncStatus: 'Pulling update...' });
      await this.reloadFromDisk({ rePullAndroid: true, quietOnError: true });
      if (this.state.androidAutoSyncSec > 0) {
        const syncedAt = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        this.setState({ androidSyncStatus: `Synced ${syncedAt}` });
      }
    } catch {
      if (this.state.androidAutoSyncSec > 0) {
        this.setState({ androidSyncStatus: 'ADB offline' });
      }
    } finally {
      this.isAndroidSyncTicking = false;
    }
  };

  private onConfigureAndroidSync = () => {
    const { Menu, MenuItem } = remote;
    const menu = new Menu();
    const cur = this.state.androidAutoSyncSec;

    for (const sec of [5, 10, 30] as const) {
      menu.append(
        new MenuItem({
          label: `Auto Sync every ${sec} seconds`,
          type: 'checkbox',
          checked: cur === sec,
          click: () => this.setAndroidAutoSync(sec)
        })
      );
    }
    menu.append(
      new MenuItem({
        label: 'Turn Auto Sync Off',
        type: 'checkbox',
        checked: cur === 0,
        click: () => this.setAndroidAutoSync(0)
      })
    );
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(
      new MenuItem({
        label: 'Pull Fresh from Android Now',
        click: () => this.onManualReload()
      })
    );
    menu.popup();
  };

  private reloadFromDisk = async (options?: {
    rePullAndroid?: boolean;
    quietOnError?: boolean;
  }) => {
    if (this.isReloading) {
      return;
    }
    this.isReloading = true;
    this.stopWatchingRealmFile();

    // Preserve currently viewed class across reloads (handy during live debugging)
    this.pendingPaneClassNames = {};
    const leafIds = listLeafIds(this.state.layout);
    for (const paneId of leafIds) {
      const paneFocus = this.state.panes[paneId]?.focus;
      if (paneFocus) {
        this.pendingPaneClassNames[paneId] = getClassName(paneFocus);
      }
    }

    // Keep a reference to the realm we are about to discard. We must NOT call
    // realm.close() until React has fully committed a render in which no
    // Realm-bound objects remain in the tree. Otherwise React 19's passive
    // effects / devtools profiling pass walks the previous render's props
    // (e.g. focus.results, which is a Realm.Results) and trips the SDK's
    // "Accessing object which has been invalidated or deleted" assertion
    // mid-commit, which permanently wedges the reconciler.
    const closingRealm = this.realm;

    // Detach listeners first so a late change/schema notification fired during
    // the close handshake cannot land in React state that references the
    // closing realm.
    if (closingRealm) {
      try {
        closingRealm.removeListener('change', this.onRealmChanged);
        closingRealm.removeListener('schema', this.onRealmSchemaChanged);
      } catch {
        // ignore
      }
    }

    // Hide the realm from render() before flushing, so <Content> unmounts and
    // the sidebar drops its schema references.
    this.realm = undefined;

    flushSync(() => {
      const clearedPanes: Record<string, IPaneViewState> = {};
      for (const paneId of leafIds) {
        clearedPanes[paneId] = createEmptyPaneState(paneId);
      }
      this.setState({
        panes: clearedPanes,
        classes: [],
        progress: { status: 'in-progress' },
        dataVersion: 0,
        dataVersionAtBeginning: undefined
      });
    });

    // At this point Content (and any other consumer of Realm objects) has
    // unmounted and its passive effects have run with the realm still valid.
    // Releasing the native resources is now safe.
    if (closingRealm) {
      if (closingRealm.isInTransaction) {
        try {
          closingRealm.cancelTransaction();
        } catch {
          // ignore
        }
      }
      try {
        closingRealm.close();
      } catch {
        // ignore
      }
    }

    let syncError: unknown;
    try {
      if (options?.rePullAndroid && this.props.realm?.path) {
        try {
          await refreshLocalAndroidRealmIfTracked(this.props.realm.path);
        } catch (adbErr) {
          if (options.quietOnError) {
            syncError = adbErr;
          } else {
            showError('Failed pulling fresh Android Realm via ADB', adbErr);
          }
        }
      }
      await this.loadRealm(
        this.props.realm,
        this.props.import ? this.props.import.schema : undefined
      );
      if (syncError) {
        throw syncError;
      }
    } finally {
      this.startWatchingRealmFile();
      this.isReloading = false;
    }
  };

  // Watcher tuning constants. The debounce + stability window together let
  // the other process finish its write (and release its lock) before we try
  // to reopen, which is what prevents `new Realm()` from blocking the event
  // loop on lock contention.
  private static readonly WATCH_DEBOUNCE_MS = 750;
  private static readonly WATCH_STABILITY_POLL_MS = 500;
  private static readonly WATCH_MAX_STABILITY_POLLS = 20; // 10s ceiling
  private static readonly RELOAD_ATTEMPT_WINDOW_MS = 30000;
  private static readonly RELOAD_ATTEMPT_MAX = 5;

  private startWatchingRealmFile() {
    const realm = this.props.realm;
    if (!realm || this.watcherDisabled) {
      return;
    }
    const realmPath = realm.path;
    this.stopWatchingRealmFile();
    try {
      const stat = fs.statSync(realmPath);
      this.watchedInode = stat.ino;
      this.watchedMtimeMs = stat.mtimeMs;
      this.watchedSize = stat.size;
    } catch {
      this.watchedInode = null;
      this.watchedMtimeMs = null;
      this.watchedSize = null;
    }
    const dir = path.dirname(realmPath);
    this.watchedFileName = path.basename(realmPath);
    try {
      this.fileWatcher = fs.watch(dir, (_event, changed) => {
        if (!changed || changed !== this.watchedFileName) {
          return;
        }
        if (this.watchDebounceTimer) {
          clearTimeout(this.watchDebounceTimer);
        }
        this.watchDebounceTimer = setTimeout(() => {
          this.watchDebounceTimer = null;
          this.handleWatchedFileEvent();
        }, RealmBrowserContainer.WATCH_DEBOUNCE_MS);
      });
    } catch {
      // Watching is best-effort; the manual refresh button remains as a fallback.
      this.fileWatcher = null;
    }
  }

  private stopWatchingRealmFile() {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    if (this.watchStabilityTimer) {
      clearTimeout(this.watchStabilityTimer);
      this.watchStabilityTimer = null;
    }
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch {
        // ignore
      }
      this.fileWatcher = null;
    }
    this.watchedInode = null;
    this.watchedMtimeMs = null;
    this.watchedSize = null;
    this.watchedFileName = null;
    this.lastStableStat = null;
  }

  private handleWatchedFileEvent() {
    const realm = this.props.realm;
    if (!realm || this.isReloading) {
      return;
    }
    const realmPath = realm.path;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(realmPath);
    } catch {
      // File does not currently exist on disk — keep the current view
      // (matches existing behavior when a file is only deleted).
      return;
    }
    // Inode change = file was replaced (atomic rename / delete+recreate).
    // mtime or size change = another process wrote in-place to the same file.
    const inodeChanged =
      this.watchedInode !== null && stat.ino !== this.watchedInode;
    const mtimeChanged =
      this.watchedMtimeMs !== null && stat.mtimeMs !== this.watchedMtimeMs;
    const sizeChanged =
      this.watchedSize !== null && stat.size !== this.watchedSize;
    if (!(inodeChanged || mtimeChanged || sizeChanged)) {
      return;
    }
    // Wait for the file to stop changing before triggering reload. Reopening
    // mid-write is the case where Realm SDK's lock acquisition tends to
    // block the entire renderer event loop, so we pay the cost of a short
    // poll here to avoid that.
    this.lastStableStat = { size: stat.size, mtimeMs: stat.mtimeMs };
    this.waitForFileStability(0);
  }

  private waitForFileStability(pollsSoFar: number) {
    if (this.watchStabilityTimer) {
      clearTimeout(this.watchStabilityTimer);
      this.watchStabilityTimer = null;
    }
    this.watchStabilityTimer = setTimeout(() => {
      this.watchStabilityTimer = null;
      const realm = this.props.realm;
      if (!realm || this.isReloading || this.watcherDisabled) {
        return;
      }
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(realm.path);
      } catch {
        return;
      }
      const prev = this.lastStableStat;
      if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
        // File has been quiet for one full poll interval. Safe to reload.
        this.lastStableStat = null;
        if (this.recordAndCheckReloadAttempt()) {
          void this.reloadFromDisk();
        }
        return;
      }
      this.lastStableStat = { size: stat.size, mtimeMs: stat.mtimeMs };
      if (pollsSoFar + 1 >= RealmBrowserContainer.WATCH_MAX_STABILITY_POLLS) {
        // Other process is writing continuously — give up this round; the
        // next fs.watch event will restart the cycle.
        this.lastStableStat = null;
        return;
      }
      this.waitForFileStability(pollsSoFar + 1);
    }, RealmBrowserContainer.WATCH_STABILITY_POLL_MS);
  }

  private recordAndCheckReloadAttempt(): boolean {
    const now = Date.now();
    const cutoff = now - RealmBrowserContainer.RELOAD_ATTEMPT_WINDOW_MS;
    this.reloadAttemptTimestamps = this.reloadAttemptTimestamps.filter(
      (t) => t >= cutoff
    );
    if (
      this.reloadAttemptTimestamps.length >=
      RealmBrowserContainer.RELOAD_ATTEMPT_MAX
    ) {
      // Too many auto-reloads in a short window — back off completely. The
      // user can still trigger a manual reload via the sidebar button.
      this.watcherDisabled = true;
      this.stopWatchingRealmFile();
      console.warn(
        `Realm file changed >= ${RealmBrowserContainer.RELOAD_ATTEMPT_MAX} times ` +
          `in ${RealmBrowserContainer.RELOAD_ATTEMPT_WINDOW_MS / 1000}s; ` +
          `disabling auto-reload. Use the reload button to retry.`
      );
      return false;
    }
    this.reloadAttemptTimestamps.push(now);
    return true;
  }

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.realm && this.realm.isInTransaction) {
      e.returnValue = false;

      const { dataVersionAtBeginning, dataVersion } = this.state;
      const unsavedChanges =
        typeof dataVersionAtBeginning === 'number'
          ? dataVersion - dataVersionAtBeginning
          : 0;
      // Show a dialog
      const currentWindow = remote.getCurrentWindow();
      const plural = unsavedChanges > 1 ? 's' : '';
      remote.dialog
        .showMessageBox(currentWindow, {
          type: 'warning',
          message: `You have ${unsavedChanges} unsaved change${plural}`,
          buttons: ['Save and close', 'Discard and close', 'Cancel']
        })
        .then(({ response }) => {
          if (response === 0 || response === 1) {
            if (response === 0) {
              this.onCommitTransaction();
            } else if (response === 1) {
              this.onCancelTransaction();
            }
            // Allow the for the state to update
            process.nextTick(() => {
              window.close();
            });
          }
        });
    } else {
      unregisterOpenRealmSession(this.activeSessionId);
    }
  };

  private onExportSchemaIpc = (_event: unknown, language: Language) =>
    this.onExportSchema(language);

  private onKeyDown = (e: KeyboardEvent) => {
    const isCommandPaletteShortcut =
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'p';
    if (isCommandPaletteShortcut) {
      e.preventDefault();
      this.setState((prev) => ({
        isCommandPaletteOpen: !prev.isCommandPaletteOpen
      }));
      return;
    }

    const isGlobalSearchShortcut =
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'f';
    if (isGlobalSearchShortcut) {
      e.preventDefault();
      this.setState({ isGlobalSearchOpen: true });
      return;
    }

    const isAskAiShortcut =
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'a';
    if (isAskAiShortcut) {
      e.preventDefault();
      this.setState({ isAiQueryOpen: true });
      return;
    }

    const isSplitRightShortcut =
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key === '\\';
    if (isSplitRightShortcut) {
      e.preventDefault();
      this.splitPane(this.getResolvedActivePaneId(), 'horizontal');
      return;
    }

    const isSplitDownShortcut =
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      !e.altKey &&
      (e.key === '\\' || e.key === '|');
    if (isSplitDownShortcut) {
      e.preventDefault();
      this.splitPane(this.getResolvedActivePaneId(), 'vertical');
      return;
    }

    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    const isBack =
      (e.metaKey && !e.shiftKey && !e.altKey && e.key === '[') ||
      (e.altKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowLeft');
    const isForward =
      (e.metaKey && !e.shiftKey && !e.altKey && e.key === ']') ||
      (e.altKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowRight');

    if (isBack) {
      e.preventDefault();
      this.onNavigateBack();
    } else if (isForward) {
      e.preventDefault();
      this.onNavigateForward();
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 3) {
      e.preventDefault();
      this.onNavigateBack();
    } else if (e.button === 4) {
      e.preventDefault();
      this.onNavigateForward();
    }
  };

  private onWindowFocus = () => {
    updateOpenRealmSession(this.activeSessionId, { focusedAt: Date.now() });
  };

  private addListeners() {
    ipcRenderer.addListener('export-schema', this.onExportSchemaIpc);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('focus', this.onWindowFocus);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  private removeListeners() {
    ipcRenderer.removeListener('export-schema', this.onExportSchemaIpc);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('focus', this.onWindowFocus);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  private derivePropertiesFromProperty(
    property: IPropertyWithName
  ): IPropertyWithName[] {
    // Determine the properties
    if (property.objectType) {
      if (property.type === 'list') {
        const properties: IPropertyWithName[] = [
          { name: '#', type: 'int', readOnly: true, isPrimaryKey: false }
        ];
        if (isPrimitive(property.objectType)) {
          return properties.concat([
            {
              name: null,
              type: property.objectType,
              readOnly: false,
              isPrimaryKey: false
            }
          ]);
        } else {
          return properties.concat(
            this.derivePropertiesFromClassName(property.objectType)
          );
        }
      }

      if (property.type === 'object' && property.isEmbedded) {
        return this.derivePropertiesFromClassName(property.objectType);
      }

      throw new Error('Expected a list or embedded object');
    } else {
      throw new Error('Expected a list property with an objectType');
    }
  }

  private derivePropertiesFromClassName(
    className: string
  ): IPropertyWithName[] {
    if (!this.realm) {
      throw new Error(
        'derivePropertiesFromClassName called before realm was loaded'
      );
    }
    // Deriving the ObjectSchema from the className
    const objectSchema = this.realm.schema.find((schema) => {
      return schema.name === className;
    });
    if (!objectSchema) {
      throw new Error(`Found no object schema named '${className}'`);
    }
    // Derive the properties from the objectSchema
    return Object.keys(objectSchema.properties).map((propertyName) => {
      const property = objectSchema.properties[
        propertyName
      ] as Realm.ObjectSchemaProperty;
      if (typeof property === 'object') {
        const isEmbedded =
          !!property.objectType && this.isEmbeddedType(property.objectType);

        return {
          name: propertyName,
          readOnly: false,
          isEmbedded,
          isPrimaryKey: objectSchema.primaryKey === propertyName,
          ...property
        };
      } else {
        throw new Error(`Object schema had a string describing its property`);
      }
    });
  }

  private resetDataVersion() {
    if (typeof this.state.dataVersionAtBeginning === 'number') {
      this.setState({
        dataVersion: this.state.dataVersionAtBeginning,
        dataVersionAtBeginning: undefined
      });
    }
  }

  private canChangeFocus(paneId: string = this.getResolvedActivePaneId()) {
    const instance = this.paneContentInstances.get(paneId);
    if (instance) {
      const { latestCellValidation } = instance;
      return !latestCellValidation || latestCellValidation.valid;
    } else {
      return true;
    }
  }

  private onExportSchema = (language: Language): void => {
    if (!this.realm) {
      throw new Error('Expected a loaded Realm');
    }
    const basename = path.basename(this.realm.path, '.realm');
    const selectedPath = remote.dialog.showSaveDialogSync({
      defaultPath: `${basename}-classes`,
      message: `Select a directory to store the ${language} schema files`
    });
    if (selectedPath && this.realm) {
      const exporter = SchemaExporter(language);
      exporter.exportSchema(this.realm);
      exporter.writeFilesToDisk(selectedPath);
    }
  };

  private onExportData = (format: DataExportFormat) => {
    try {
      const exporter = new DataExporter(format);
      if (this.realm) {
        const destinationPath = remote.dialog.showSaveDialogSync({
          defaultPath: exporter.suggestFilename(this.realm),
          message: 'Select a destination for the data'
        });
        if (destinationPath) {
          exporter.export(this.realm, destinationPath);
        }
      } else {
        throw new Error('Realm is not open');
      }
    } catch (err) {
      showError('Failed to export data', err);
    }
  };

  private onImportIntoExistingRealm = (
    format: dataImporter.ImportFormat = dataImporter.ImportFormat.CSV
  ) => {
    const paths = dataImporter.showOpenDialog(format);
    if (this.realm && paths && paths.length > 0) {
      const classNames = this.realm.schema.map((s) => s.name);
      this.setState({ importDialog: { filePaths: paths, classNames } });
    }
  };

  private handleImport = (
    format: dataImporter.ImportFormat,
    files: dataImporter.ImportableFile[]
  ) => {
    if (this.realm) {
      this.setState({ progress: { status: 'in-progress' } });
      // Get the importer
      try {
        const importer = dataImporter.getDataImporter(format);
        importer.import(this.realm, files);
      } catch (err) {
        showError('Failed to import data', err);
      } finally {
        this.setState({ progress: { status: 'done' } });
      }
    }
  };

  private async copyRealmPathToClipboard(): Promise<void> {
    if (this.realm) {
      await navigator.clipboard.writeText(this.realm.path);
    } else {
      throw new Error('Realm was not loaded');
    }
  }
}

export { RealmBrowserContainer as RealmBrowser };
