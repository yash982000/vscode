/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/releasenoteseditor';
import { CancellationToken } from 'vs/base/common/cancellation';
import { onUnexpectedError } from 'vs/base/common/errors';
import { escapeMarkdownSyntaxTokens } from 'vs/base/common/htmlContent';
import { KeybindingParser } from 'vs/base/common/keybindingParser';
import { OS } from 'vs/base/common/platform';
import { escape } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import { TokenizationRegistry } from 'vs/editor/common/modes';
import { generateTokensCSSForColorMap } from 'vs/editor/common/modes/supports/tokenization';
import { IModeService } from 'vs/editor/common/services/modeService';
import * as nls from 'vs/nls';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IProductService } from 'vs/platform/product/common/productService';
import { asText, IRequestService } from 'vs/platform/request/common/request';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { renderMarkdownDocument } from 'vs/workbench/contrib/markdown/common/markdownDocumentRenderer';
import { WebviewInput } from 'vs/workbench/contrib/webviewPanel/browser/webviewEditorInput';
import { IWebviewWorkbenchService } from 'vs/workbench/contrib/webviewPanel/browser/webviewWorkbenchService';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { ACTIVE_GROUP, IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';

export class ReleaseNotesManager {

	private readonly _releaseNotesCache = new Map<string, Promise<string>>();

	private _currentReleaseNotes: WebviewInput | undefined = undefined;
	private _lastText: string | undefined;

	public constructor(
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IModeService private readonly _modeService: IModeService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IRequestService private readonly _requestService: IRequestService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IProductService private readonly _productService: IProductService
	) {
		TokenizationRegistry.onDidChange(async () => {
			if (!this._currentReleaseNotes || !this._lastText) {
				return;
			}
			const html = await this.renderBody(this._lastText);
			if (this._currentReleaseNotes) {
				this._currentReleaseNotes.webview.html = html;
			}
		});
	}

	public async show(
		accessor: ServicesAccessor,
		version: string
	): Promise<boolean> {
		const releaseNoteText = false ? await this.loadReleaseNotes(version) : `

		# January 2021 (version 1.53)

**Update 1.53.1**: The update addresses these security [issues](https://github.com/microsoft/vscode/milestone/143).

<!-- DOWNLOAD_LINKS_PLACEHOLDER -->

---

Welcome to the January 2021 release of Visual Studio Code. There are a number of updates in this version that we hope you will like, some of the key highlights include:

* **[Wrap tabs](#wrap-tabs)** - Wrap editor tabs in the workbench instead of having a scrollbar.
* **[Configure tab decorations](#tab-decorations)** - Add editor tab status decorations.
* **[Customize search mode](#default-search-mode)** - Use the Search view or open a new Search editor.
* **[JavaScript debugging](#javascript-debugger)** - Support for conditional exception breakpoints and Node.js worker_threads.
* **[Notebook UX updates](#notebooks)** - Outline view for Notebook cells, and breadcrumbs for improved navigation.
* **[Markdown preview image auto update](#markdown-preview-auto-updates-when-images-are-changed-on-disk)** - Preview automatically updates when images change.
* **[Emmet improvements](#emmet-performance-and-feature-improvements)** - Faster performance and supporting the latest features.
* **[Extension guidelines](#extension-guidelines)** - Documented best practices for extension authors.
* **[Remote Development video series](#documentation)** - Learn to create and configure container-based environments.

>If you'd like to read these release notes online, go to [Updates](https://code.visualstudio.com/updates) on [code.visualstudio.com](https://code.visualstudio.com).

**Join us live** at the [VS Code team's livestream](https://code.visualstudio.com/livestream) on Tuesday, February 9 at 8am Pacific (4pm London) to see a demo of what's new in this release, and ask us questions live.

**Insiders:** Want to try new features as soon as possible? You can download the nightly [Insiders](https://code.visualstudio.com/insiders) build and try the latest updates as soon as they are available.

## Workbench

### Wrap tabs

A new setting 'workbench.editor.wrapTabs' lets editor tabs wrap instead of showing a scrollbar.

![Wrapping tabs in editor](images/1_53/tabs-wrap.gif)
*Theme: [GitHub Dark Theme](https://marketplace.visualstudio.com/items?itemName=GitHub.github-vscode-theme)*

If the available space for the tabs is too small, wrapping will temporarily turn off, and you will see the old experience with a scrollbar.
		`;

		this._lastText = releaseNoteText;
		const html = await this.renderBody(releaseNoteText);
		const title = nls.localize('releaseNotesInputName', "Release Notes: {0}", version);

		const activeEditorPane = this._editorService.activeEditorPane;
		if (this._currentReleaseNotes) {
			this._currentReleaseNotes.setName(title);
			this._currentReleaseNotes.webview.html = html;
			this._webviewWorkbenchService.revealWebview(this._currentReleaseNotes, activeEditorPane ? activeEditorPane.group : this._editorGroupService.activeGroup, false);
		} else {
			this._currentReleaseNotes = this._webviewWorkbenchService.createWebview(
				'vs_code_release_notes',
				'releaseNotes',
				title,
				{ group: ACTIVE_GROUP, preserveFocus: false },
				{
					tryRestoreScrollPosition: true,
					enableFindWidget: true,
					localResourceRoots: []
				},
				undefined);

			this._currentReleaseNotes.webview.onDidClickLink(uri => this.onDidClickLink(URI.parse(uri)));
			this._currentReleaseNotes.onDispose(() => { this._currentReleaseNotes = undefined; });

			this._currentReleaseNotes.webview.html = html;
		}

		return true;
	}

	private async loadReleaseNotes(version: string): Promise<string> {
		const match = /^(\d+\.\d+)\./.exec(version);
		if (!match) {
			throw new Error('not found');
		}

		const versionLabel = match[1].replace(/\./g, '_');
		const baseUrl = 'https://code.visualstudio.com/raw';
		const url = `${baseUrl}/v${versionLabel}.md`;
		const unassigned = nls.localize('unassigned', "unassigned");

		const escapeMdHtml = (text: string): string => {
			return escape(text).replace(/\\/g, '\\\\');
		};

		const patchKeybindings = (text: string): string => {
			const kb = (match: string, kb: string) => {
				const keybinding = this._keybindingService.lookupKeybinding(kb);

				if (!keybinding) {
					return unassigned;
				}

				return keybinding.getLabel() || unassigned;
			};

			const kbstyle = (match: string, kb: string) => {
				const keybinding = KeybindingParser.parseKeybinding(kb, OS);

				if (!keybinding) {
					return unassigned;
				}

				const resolvedKeybindings = this._keybindingService.resolveKeybinding(keybinding);

				if (resolvedKeybindings.length === 0) {
					return unassigned;
				}

				return resolvedKeybindings[0].getLabel() || unassigned;
			};

			const kbCode = (match: string, binding: string) => {
				const resolved = kb(match, binding);
				return resolved ? `<code title="${binding}">${escapeMdHtml(resolved)}</code>` : resolved;
			};

			const kbstyleCode = (match: string, binding: string) => {
				const resolved = kbstyle(match, binding);
				return resolved ? `<code title="${binding}">${escapeMdHtml(resolved)}</code>` : resolved;
			};

			return text
				.replace(/`kb\(([a-z.\d\-]+)\)`/gi, kbCode)
				.replace(/`kbstyle\(([^\)]+)\)`/gi, kbstyleCode)
				.replace(/kb\(([a-z.\d\-]+)\)/gi, (match, binding) => escapeMarkdownSyntaxTokens(kb(match, binding)))
				.replace(/kbstyle\(([^\)]+)\)/gi, (match, binding) => escapeMarkdownSyntaxTokens(kbstyle(match, binding)));
		};

		const fetchReleaseNotes = async () => {
			let text;
			try {
				text = await asText(await this._requestService.request({ url }, CancellationToken.None));
			} catch {
				throw new Error('Failed to fetch release notes');
			}

			if (!text || !/^#\s/.test(text)) { // release notes always starts with `#` followed by whitespace
				throw new Error('Invalid release notes');
			}

			return patchKeybindings(text);
		};

		if (!this._releaseNotesCache.has(version)) {
			this._releaseNotesCache.set(version, (async () => {
				try {
					return await fetchReleaseNotes();
				} catch (err) {
					this._releaseNotesCache.delete(version);
					throw err;
				}
			})());
		}

		return this._releaseNotesCache.get(version)!;
	}

	private onDidClickLink(uri: URI) {
		this.addGAParameters(uri, 'ReleaseNotes')
			.then(updated => this._openerService.open(updated))
			.then(undefined, onUnexpectedError);
	}

	private async addGAParameters(uri: URI, origin: string, experiment = '1'): Promise<URI> {
		if (this._environmentService.isBuilt && !this._environmentService.isExtensionDevelopment && !this._environmentService.disableTelemetry && !!this._productService.enableTelemetry) {
			if (uri.scheme === 'https' && uri.authority === 'code.visualstudio.com') {
				const info = await this._telemetryService.getTelemetryInfo();

				return uri.with({ query: `${uri.query ? uri.query + '&' : ''}utm_source=VsCode&utm_medium=${encodeURIComponent(origin)}&utm_campaign=${encodeURIComponent(info.instanceId)}&utm_content=${encodeURIComponent(experiment)}` });
			}
		}
		return uri;
	}

	private async renderBody(text: string) {
		const nonce = generateUuid();
		const content = await renderMarkdownDocument(text, this._extensionService, this._modeService);
		const colorMap = TokenizationRegistry.getColorMap();
		const css = colorMap ? generateTokensCSSForColorMap(colorMap) : '';
		return `<!DOCTYPE html>
		<html>
			<head>
				<base href="https://code.visualstudio.com/raw/">
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; style-src 'nonce-${nonce}' https://code.visualstudio.com;">
				<style nonce="${nonce}">
					body {
						padding: 10px 20px;
						line-height: 22px;
						max-width: 882px;
						margin: 0 auto;
					}

					img {
						max-width: 100%;
						max-height: 100%;
					}

					a {
						text-decoration: none;
					}

					a:hover {
						text-decoration: underline;
					}

					a:focus,
					input:focus,
					select:focus,
					textarea:focus {
						outline: 1px solid -webkit-focus-ring-color;
						outline-offset: -1px;
					}

					hr {
						border: 0;
						height: 2px;
						border-bottom: 2px solid;
					}

					h1 {
						padding-bottom: 0.3em;
						line-height: 1.2;
						border-bottom-width: 1px;
						border-bottom-style: solid;
					}

					h1, h2, h3 {
						font-weight: normal;
					}

					table {
						border-collapse: collapse;
					}

					table > thead > tr > th {
						text-align: left;
						border-bottom: 1px solid;
					}

					table > thead > tr > th,
					table > thead > tr > td,
					table > tbody > tr > th,
					table > tbody > tr > td {
						padding: 5px 10px;
					}

					table > tbody > tr + tr > td {
						border-top-width: 1px;
						border-top-style: solid;
					}

					blockquote {
						margin: 0 7px 0 5px;
						padding: 0 16px 0 10px;
						border-left-width: 5px;
						border-left-style: solid;
					}

					code {
						font-family: "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace;
						font-size: 14px;
						line-height: 19px;
					}

					pre code {
						font-family: var(--vscode-editor-font-family);
						font-weight: var(--vscode-editor-font-weight);
						font-size: var(--vscode-editor-font-size);
						line-height: 1.5;
					}

					code > div {
						padding: 16px;
						border-radius: 3px;
						overflow: auto;
					}

					.monaco-tokenized-source {
						white-space: pre;
					}

					/** Theming */

					.vscode-light code > div {
						background-color: rgba(220, 220, 220, 0.4);
					}

					.vscode-dark code > div {
						background-color: rgba(10, 10, 10, 0.4);
					}

					.vscode-high-contrast code > div {
						background-color: rgb(0, 0, 0);
					}

					.vscode-high-contrast h1 {
						border-color: rgb(0, 0, 0);
					}

					.vscode-light table > thead > tr > th {
						border-color: rgba(0, 0, 0, 0.69);
					}

					.vscode-dark table > thead > tr > th {
						border-color: rgba(255, 255, 255, 0.69);
					}

					.vscode-light h1,
					.vscode-light hr,
					.vscode-light table > tbody > tr + tr > td {
						border-color: rgba(0, 0, 0, 0.18);
					}

					.vscode-dark h1,
					.vscode-dark hr,
					.vscode-dark table > tbody > tr + tr > td {
						border-color: rgba(255, 255, 255, 0.18);
					}

					${css}
				</style>
			</head>
			<body>${content}</body>
		</html>`;
	}
}
