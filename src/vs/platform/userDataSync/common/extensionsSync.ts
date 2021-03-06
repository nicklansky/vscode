/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUserData, UserDataSyncError, UserDataSyncErrorCode, SyncStatus, IUserDataSyncStoreService, ISyncExtension, IUserDataSyncLogService, IUserDataSynchroniser, SyncSource } from 'vs/platform/userDataSync/common/userDataSync';
import { VSBuffer } from 'vs/base/common/buffer';
import { Emitter, Event } from 'vs/base/common/event';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { URI } from 'vs/base/common/uri';
import { joinPath } from 'vs/base/common/resources';
import { IExtensionManagementService, IExtensionGalleryService, IGlobalExtensionEnablementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionType, IExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IFileService } from 'vs/platform/files/common/files';
import { Queue } from 'vs/base/common/async';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { localize } from 'vs/nls';
import { merge } from 'vs/platform/userDataSync/common/extensionsMerge';
import { isNonEmptyArray } from 'vs/base/common/arrays';
import { AbstractSynchroniser } from 'vs/platform/userDataSync/common/abstractSynchronizer';

interface ISyncPreviewResult {
	readonly added: ISyncExtension[];
	readonly removed: IExtensionIdentifier[];
	readonly updated: ISyncExtension[];
	readonly remote: ISyncExtension[] | null;
	readonly remoteUserData: IUserData;
	readonly skippedExtensions: ISyncExtension[];
}

interface ILastSyncUserData extends IUserData {
	skippedExtensions: ISyncExtension[] | undefined;
}

export class ExtensionsSynchroniser extends AbstractSynchroniser implements IUserDataSynchroniser {

	private static EXTERNAL_USER_DATA_EXTENSIONS_KEY: string = 'extensions';

	private _status: SyncStatus = SyncStatus.Idle;
	get status(): SyncStatus { return this._status; }
	private _onDidChangStatus: Emitter<SyncStatus> = this._register(new Emitter<SyncStatus>());
	readonly onDidChangeStatus: Event<SyncStatus> = this._onDidChangStatus.event;

	private _onDidChangeLocal: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChangeLocal: Event<void> = this._onDidChangeLocal.event;

	private readonly lastSyncExtensionsResource: URI;
	private readonly replaceQueue: Queue<void>;

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@IUserDataSyncStoreService private readonly userDataSyncStoreService: IUserDataSyncStoreService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IGlobalExtensionEnablementService private readonly extensionEnablementService: IGlobalExtensionEnablementService,
		@IUserDataSyncLogService private readonly logService: IUserDataSyncLogService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(SyncSource.Extensions, fileService, environmentService);
		this.replaceQueue = this._register(new Queue());
		this.lastSyncExtensionsResource = joinPath(this.syncFolder, '.lastSyncExtensions');
		this._register(
			Event.debounce(
				Event.any(
					Event.filter(this.extensionManagementService.onDidInstallExtension, (e => !!e.gallery)),
					Event.filter(this.extensionManagementService.onDidUninstallExtension, (e => !e.error))),
				() => undefined, 500)(() => this._onDidChangeLocal.fire()));
	}

	private setStatus(status: SyncStatus): void {
		if (this._status !== status) {
			this._status = status;
			this._onDidChangStatus.fire(status);
		}
	}

	async pull(): Promise<void> {
		if (!this.configurationService.getValue<boolean>('sync.enableExtensions')) {
			this.logService.info('Extensions: Skipped pulling extensions as it is disabled.');
			return;
		}

		this.stop();

		try {
			this.logService.info('Extensions: Started pulling extensions...');
			this.setStatus(SyncStatus.Syncing);

			const remoteUserData = await this.getRemoteUserData();

			if (remoteUserData.content !== null) {
				const localExtensions = await this.getLocalExtensions();
				const remoteExtensions: ISyncExtension[] = JSON.parse(remoteUserData.content);
				const { added, updated, remote } = merge(localExtensions, remoteExtensions, [], [], this.getIgnoredExtensions());
				await this.apply({ added, removed: [], updated, remote, remoteUserData, skippedExtensions: [] });
			}

			// No remote exists to pull
			else {
				this.logService.info('Extensions: Remote extensions does not exist.');
			}

			this.logService.info('Extensions: Finished pulling extensions.');
		} finally {
			this.setStatus(SyncStatus.Idle);
		}
	}

	async push(): Promise<void> {
		if (!this.configurationService.getValue<boolean>('sync.enableExtensions')) {
			this.logService.info('Extensions: Skipped pushing extensions as it is disabled.');
			return;
		}

		this.stop();

		try {
			this.logService.info('Extensions: Started pushing extensions...');
			this.setStatus(SyncStatus.Syncing);

			const localExtensions = await this.getLocalExtensions();
			const { added, removed, updated, remote } = merge(localExtensions, null, null, [], this.getIgnoredExtensions());
			const remoteUserData = await this.getRemoteUserData();
			await this.apply({ added, removed, updated, remote, remoteUserData, skippedExtensions: [] }, true);

			this.logService.info('Extensions: Finished pushing extensions.');
		} finally {
			this.setStatus(SyncStatus.Idle);
		}

	}

	async sync(): Promise<void> {
		if (!this.configurationService.getValue<boolean>('sync.enableExtensions')) {
			this.logService.trace('Extensions: Skipping synchronizing extensions as it is disabled.');
			return;
		}
		if (!this.extensionGalleryService.isEnabled()) {
			this.logService.trace('Extensions: Skipping synchronizing extensions as gallery is disabled.');
			return;
		}
		if (this.status !== SyncStatus.Idle) {
			this.logService.trace('Extensions: Skipping synchronizing extensions as it is running already.');
			return;
		}

		this.logService.trace('Extensions: Started synchronizing extensions...');
		this.setStatus(SyncStatus.Syncing);

		try {
			const previewResult = await this.getPreview();
			await this.apply(previewResult);
		} catch (e) {
			this.setStatus(SyncStatus.Idle);
			if (e instanceof UserDataSyncError && e.code === UserDataSyncErrorCode.Rejected) {
				// Rejected as there is a new remote version. Syncing again,
				this.logService.info('Extensions: Failed to synchronise extensions as there is a new remote version available. Synchronizing again...');
				return this.sync();
			}
			throw e;
		}

		this.logService.trace('Extensions: Finished synchronizing extensions.');
		this.setStatus(SyncStatus.Idle);
	}

	async stop(): Promise<void> { }

	async restart(): Promise<void> {
		throw new Error('Extensions: Conflicts should not occur');
	}

	resolveConflicts(content: string): Promise<void> {
		throw new Error('Extensions: Conflicts should not occur');
	}

	async hasPreviouslySynced(): Promise<boolean> {
		const lastSyncData = await this.getLastSyncUserData();
		return !!lastSyncData;
	}

	async hasRemoteData(): Promise<boolean> {
		const remoteUserData = await this.getRemoteUserData();
		return remoteUserData.content !== null;
	}

	async hasLocalData(): Promise<boolean> {
		try {
			const localExtensions = await this.getLocalExtensions();
			if (isNonEmptyArray(localExtensions)) {
				return true;
			}
		} catch (error) {
			/* ignore error */
		}
		return false;
	}

	async getRemoteContent(): Promise<string | null> {
		return null;
	}

	removeExtension(identifier: IExtensionIdentifier): Promise<void> {
		return this.replaceQueue.queue(async () => {
			const remoteData = await this.userDataSyncStoreService.read(ExtensionsSynchroniser.EXTERNAL_USER_DATA_EXTENSIONS_KEY, null);
			const remoteExtensions: ISyncExtension[] = remoteData.content ? JSON.parse(remoteData.content) : [];
			const ignoredExtensions = this.configurationService.getValue<string[]>('sync.ignoredExtensions') || [];
			const removedExtensions = remoteExtensions.filter(e => !ignoredExtensions.some(id => areSameExtensions({ id }, e.identifier)) && areSameExtensions(e.identifier, identifier));
			if (removedExtensions.length) {
				for (const removedExtension of removedExtensions) {
					remoteExtensions.splice(remoteExtensions.indexOf(removedExtension), 1);
				}
				this.logService.info(`Extensions: Removing extension '${identifier.id}' from remote.`);
				await this.writeToRemote(remoteExtensions, remoteData.ref);
			}
		});
	}

	async resetLocal(): Promise<void> {
		try {
			await this.fileService.del(this.lastSyncExtensionsResource);
		} catch (e) { /* ignore */ }
	}

	private async getPreview(): Promise<ISyncPreviewResult> {
		const lastSyncData = await this.getLastSyncUserData();
		const lastSyncExtensions: ISyncExtension[] | null = lastSyncData ? JSON.parse(lastSyncData.content!) : null;
		const skippedExtensions: ISyncExtension[] = lastSyncData ? lastSyncData.skippedExtensions || [] : [];

		const remoteUserData = await this.getRemoteUserData(lastSyncData);
		const remoteExtensions: ISyncExtension[] = remoteUserData.content ? JSON.parse(remoteUserData.content) : null;

		const localExtensions = await this.getLocalExtensions();

		if (remoteExtensions) {
			this.logService.trace('Extensions: Merging remote extensions with local extensions...');
		} else {
			this.logService.info('Extensions: Remote extensions does not exist. Synchronizing extensions for the first time.');
		}

		const { added, removed, updated, remote } = merge(localExtensions, remoteExtensions, lastSyncExtensions, skippedExtensions, this.getIgnoredExtensions());

		return { added, removed, updated, remote, skippedExtensions, remoteUserData };
	}

	private getIgnoredExtensions() {
		return this.configurationService.getValue<string[]>('sync.ignoredExtensions') || [];
	}

	private async apply({ added, removed, updated, remote, remoteUserData, skippedExtensions }: ISyncPreviewResult, forcePush?: boolean): Promise<void> {
		if (!added.length && !removed.length && !updated.length && !remote) {
			this.logService.trace('Extensions: No changes found during synchronizing extensions.');
		}

		if (added.length || removed.length || updated.length) {
			this.logService.info('Extensions: Updating local extensions...');
			skippedExtensions = await this.updateLocalExtensions(added, removed, updated, skippedExtensions);
		}

		if (remote) {
			// update remote
			this.logService.info('Extensions: Updating remote extensions...');
			remoteUserData = await this.writeToRemote(remote, forcePush ? null : remoteUserData.ref);
		}

		if (remoteUserData.content) {
			// update last sync
			this.logService.info('Extensions: Updating last synchronised extensions...');
			await this.updateLastSyncValue({ ...remoteUserData, skippedExtensions });
		}
	}

	private async updateLocalExtensions(added: ISyncExtension[], removed: IExtensionIdentifier[], updated: ISyncExtension[], skippedExtensions: ISyncExtension[]): Promise<ISyncExtension[]> {
		const removeFromSkipped: IExtensionIdentifier[] = [];
		const addToSkipped: ISyncExtension[] = [];

		if (removed.length) {
			const installedExtensions = await this.extensionManagementService.getInstalled(ExtensionType.User);
			const extensionsToRemove = installedExtensions.filter(({ identifier }) => removed.some(r => areSameExtensions(identifier, r)));
			await Promise.all(extensionsToRemove.map(async extensionToRemove => {
				this.logService.info('Extensions: Removing local extension.', extensionToRemove.identifier.id);
				await this.extensionManagementService.uninstall(extensionToRemove);
				removeFromSkipped.push(extensionToRemove.identifier);
			}));
		}

		if (added.length || updated.length) {
			await Promise.all([...added, ...updated].map(async e => {
				const extension = await this.extensionGalleryService.getCompatibleExtension(e.identifier, e.version);
				if (extension) {
					this.logService.info('Extensions: Installing local extension.', e.identifier.id, extension.version);
					try {
						await this.extensionManagementService.installFromGallery(extension);
						removeFromSkipped.push(extension.identifier);
						if (e.enabled) {
							await this.extensionEnablementService.enableExtension(extension.identifier);
						} else {
							await this.extensionEnablementService.disableExtension(extension.identifier);
						}
					} catch (error) {
						addToSkipped.push(e);
						this.logService.error(error);
						this.logService.info(localize('skip extension', "Skipping synchronising extension {0}", extension.displayName || extension.identifier.id));
					}
				} else {
					addToSkipped.push(e);
				}
			}));
		}

		const newSkippedExtensions: ISyncExtension[] = [];
		for (const skippedExtension of skippedExtensions) {
			if (!removeFromSkipped.some(e => areSameExtensions(e, skippedExtension.identifier))) {
				newSkippedExtensions.push(skippedExtension);
			}
		}
		for (const skippedExtension of addToSkipped) {
			if (!newSkippedExtensions.some(e => areSameExtensions(e.identifier, skippedExtension.identifier))) {
				newSkippedExtensions.push(skippedExtension);
			}
		}
		return newSkippedExtensions;
	}

	private async getLocalExtensions(): Promise<ISyncExtension[]> {
		const installedExtensions = await this.extensionManagementService.getInstalled(ExtensionType.User);
		const disabledExtensions = await this.extensionEnablementService.getDisabledExtensionsAsync();
		return installedExtensions
			.map(({ identifier }) => ({ identifier, enabled: !disabledExtensions.some(disabledExtension => areSameExtensions(disabledExtension, identifier)) }));
	}

	private async getLastSyncUserData(): Promise<ILastSyncUserData | null> {
		try {
			const content = await this.fileService.readFile(this.lastSyncExtensionsResource);
			return JSON.parse(content.value.toString());
		} catch (error) {
			return null;
		}
	}

	private async updateLastSyncValue(lastSyncUserData: ILastSyncUserData): Promise<void> {
		await this.fileService.writeFile(this.lastSyncExtensionsResource, VSBuffer.fromString(JSON.stringify(lastSyncUserData)));
	}

	private getRemoteUserData(lastSyncData?: IUserData | null): Promise<IUserData> {
		return this.userDataSyncStoreService.read(ExtensionsSynchroniser.EXTERNAL_USER_DATA_EXTENSIONS_KEY, lastSyncData || null, this.source);
	}

	private async writeToRemote(extensions: ISyncExtension[], ref: string | null): Promise<IUserData> {
		const content = JSON.stringify(extensions);
		ref = await this.userDataSyncStoreService.write(ExtensionsSynchroniser.EXTERNAL_USER_DATA_EXTENSIONS_KEY, content, ref, this.source);
		return { content, ref };
	}

}
