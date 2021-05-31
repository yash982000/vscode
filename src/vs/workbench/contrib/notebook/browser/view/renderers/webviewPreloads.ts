/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from 'vs/base/common/event';
import type { IDisposable } from 'vs/base/common/lifecycle';
import { RenderOutputType } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import type { FromWebviewMessage, IBlurOutputMessage, ICellDropMessage, ICellDragMessage, ICellDragStartMessage, IClickedDataUrlMessage, IDimensionMessage, IClickMarkdownPreviewMessage, IMouseEnterMarkdownPreviewMessage, IMouseEnterMessage, IMouseLeaveMarkdownPreviewMessage, IMouseLeaveMessage, IToggleMarkdownPreviewMessage, IWheelMessage, ToWebviewMessage, ICellDragEndMessage, IOutputFocusMessage, IOutputBlurMessage, DimensionUpdate, IContextMenuMarkdownPreviewMessage, ITelemetryFoundRenderedMarkdownMath, ITelemetryFoundUnrenderedMarkdownMath, IMarkdownCellInitialization } from 'vs/workbench/contrib/notebook/browser/view/renderers/backLayerWebView';

// !! IMPORTANT !! everything must be in-line within the webviewPreloads
// function. Imports are not allowed. This is stringified and injected into
// the webview.

declare module globalThis {
	const acquireVsCodeApi: () => ({
		getState(): { [key: string]: unknown; };
		setState(data: { [key: string]: unknown; }): void;
		postMessage: (msg: unknown) => void;
	});
}

declare class ResizeObserver {
	constructor(onChange: (entries: { target: HTMLElement, contentRect?: ClientRect; }[]) => void);
	observe(element: Element): void;
	disconnect(): void;
}


type Listener<T> = { fn: (evt: T) => void; thisArg: unknown; };

interface EmitterLike<T> {
	fire(data: T): void;
	event: Event<T>;
}

interface PreloadStyles {
	readonly outputNodePadding: number;
	readonly outputNodeLeftPadding: number;
}

export interface PreloadOptions {
	dragAndDropEnabled: boolean;
}

declare function __import(path: string): Promise<any>;

async function webviewPreloads(style: PreloadStyles, options: PreloadOptions, rendererData: readonly RendererMetadata[]) {
	let currentOptions = options;

	const acquireVsCodeApi = globalThis.acquireVsCodeApi;
	const vscode = acquireVsCodeApi();
	delete (globalThis as any).acquireVsCodeApi;

	const handleInnerClick = (event: MouseEvent) => {
		if (!event || !event.view || !event.view.document) {
			return;
		}

		for (const node of event.composedPath()) {
			if (node instanceof HTMLAnchorElement && node.href) {
				if (node.href.startsWith('blob:')) {
					handleBlobUrlClick(node.href, node.download);
				} else if (node.href.startsWith('data:')) {
					handleDataUrl(node.href, node.download);
				}
				event.preventDefault();
				return;
			}
		}
	};

	const handleDataUrl = async (data: string | ArrayBuffer | null, downloadName: string) => {
		postNotebookMessage<IClickedDataUrlMessage>('clicked-data-url', {
			data,
			downloadName
		});
	};

	const handleBlobUrlClick = async (url: string, downloadName: string) => {
		try {
			const response = await fetch(url);
			const blob = await response.blob();
			const reader = new FileReader();
			reader.addEventListener('load', () => {
				handleDataUrl(reader.result, downloadName);
			});
			reader.readAsDataURL(blob);
		} catch (e) {
			console.error(e.message);
		}
	};

	document.body.addEventListener('click', handleInnerClick);

	const preservedScriptAttributes: (keyof HTMLScriptElement)[] = [
		'type', 'src', 'nonce', 'noModule', 'async',
	];

	// derived from https://github.com/jquery/jquery/blob/d0ce00cdfa680f1f0c38460bc51ea14079ae8b07/src/core/DOMEval.js
	const domEval = (container: Element) => {
		const arr = Array.from(container.getElementsByTagName('script'));
		for (let n = 0; n < arr.length; n++) {
			const node = arr[n];
			const scriptTag = document.createElement('script');
			const trustedScript = ttPolicy?.createScript(node.innerText) ?? node.innerText;
			scriptTag.text = trustedScript as string;
			for (const key of preservedScriptAttributes) {
				const val = node[key] || node.getAttribute && node.getAttribute(key);
				if (val) {
					scriptTag.setAttribute(key, val as any);
				}
			}

			// TODO@connor4312: should script with src not be removed?
			container.appendChild(scriptTag).parentNode!.removeChild(scriptTag);
		}
	};

	async function loadScriptSource(url: string, originalUri = url): Promise<string> {
		const res = await fetch(url);
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`Unexpected ${res.status} requesting ${originalUri}: ${text || res.statusText}`);
		}

		return text;
	}

	interface RendererContext {
		getState<T>(): T | undefined;
		setState<T>(newState: T): void;
		getRenderer(id: string): Promise<any | undefined>;
		postMessage?(message: unknown): void;
		onDidReceiveMessage?: Event<unknown>;
	}

	interface ScriptModule {
		activate(ctx?: RendererContext): Promise<RendererApi | undefined | any> | RendererApi | undefined | any;
	}

	const invokeSourceWithGlobals = (functionSrc: string, globals: { [name: string]: unknown }) => {
		const args = Object.entries(globals);
		return new Function(...args.map(([k]) => k), functionSrc)(...args.map(([, v]) => v));
	};

	const runPreload = async (url: string, originalUri: string): Promise<ScriptModule> => {
		const text = await loadScriptSource(url, originalUri);
		return {
			activate: () => {
				try {
					return invokeSourceWithGlobals(text, { ...kernelPreloadGlobals, scriptUrl: url });
				} catch (e) {
					console.error(e);
					throw e;
				}
			}
		};
	};

	const runRenderScript = async (url: string, rendererId: string): Promise<ScriptModule> => {
		const text = await loadScriptSource(url);
		// TODO: Support both the new module based renderers and the old style global renderers
		const isModule = /\bexport\b.*\bactivate\b/.test(text);
		if (isModule) {
			return __import(url);
		} else {
			return createBackCompatModule(rendererId, url, text);
		}
	};

	const createBackCompatModule = (rendererId: string, scriptUrl: string, scriptText: string): ScriptModule => ({
		activate: (): RendererApi => {
			const onDidCreateOutput = createEmitter<ICreateCellInfo>();
			const onWillDestroyOutput = createEmitter<undefined | IDestroyCellInfo>();

			const globals = {
				scriptUrl,
				acquireNotebookRendererApi: <T>(): GlobalNotebookRendererApi<T> => ({
					onDidCreateOutput: onDidCreateOutput.event,
					onWillDestroyOutput: onWillDestroyOutput.event,
					setState: newState => vscode.setState({ ...vscode.getState(), [rendererId]: newState }),
					getState: () => {
						const state = vscode.getState();
						return typeof state === 'object' && state ? state[rendererId] as T : undefined;
					},
				}),
			};

			invokeSourceWithGlobals(scriptText, globals);

			return {
				renderCell(id, context) {
					onDidCreateOutput.fire({ ...context, outputId: id });
				},
				destroyCell(id) {
					onWillDestroyOutput.fire(id ? { outputId: id } : undefined);
				}
			};
		}
	});

	const dimensionUpdater = new class {
		private readonly pending = new Map<string, DimensionUpdate>();

		update(id: string, height: number, options: { init?: boolean; isOutput?: boolean }) {
			if (!this.pending.size) {
				setTimeout(() => {
					this.updateImmediately();
				}, 0);
			}
			this.pending.set(id, {
				id,
				height,
				...options,
			});
		}

		updateImmediately() {
			if (!this.pending.size) {
				return;
			}

			postNotebookMessage<IDimensionMessage>('dimension', {
				updates: Array.from(this.pending.values())
			});
			this.pending.clear();
		}
	};

	const resizeObserver = new class {

		private readonly _observer: ResizeObserver;

		private readonly _observedElements = new WeakMap<Element, { id: string, output: boolean }>();

		constructor() {
			this._observer = new ResizeObserver(entries => {
				for (const entry of entries) {
					if (!document.body.contains(entry.target)) {
						continue;
					}

					const observedElementInfo = this._observedElements.get(entry.target);
					if (!observedElementInfo) {
						continue;
					}

					if (entry.target.id === observedElementInfo.id && entry.contentRect) {
						if (observedElementInfo.output) {
							let height = 0;
							if (entry.contentRect.height !== 0) {
								entry.target.style.padding = `${style.outputNodePadding}px ${style.outputNodePadding}px ${style.outputNodePadding}px ${style.outputNodeLeftPadding}px`;
								height = entry.contentRect.height + style.outputNodePadding * 2;
							} else {
								entry.target.style.padding = `0px`;
							}
							dimensionUpdater.update(observedElementInfo.id, height, {
								isOutput: true
							});
						} else {
							dimensionUpdater.update(observedElementInfo.id, entry.target.clientHeight, {
								isOutput: false
							});
						}
					}
				}
			});
		}

		public observe(container: Element, id: string, output: boolean) {
			if (this._observedElements.has(container)) {
				return;
			}

			this._observedElements.set(container, { id, output });
			this._observer.observe(container);
		}
	};

	function scrollWillGoToParent(event: WheelEvent) {
		for (let node = event.target as Node | null; node; node = node.parentNode) {
			if (!(node instanceof Element) || node.id === 'container' || node.classList.contains('cell_container') || node.classList.contains('output_container')) {
				return false;
			}

			if (event.deltaY < 0 && node.scrollTop > 0) {
				return true;
			}

			if (event.deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight) {
				return true;
			}
		}

		return false;
	}

	const handleWheel = (event: WheelEvent) => {
		if (event.defaultPrevented || scrollWillGoToParent(event)) {
			return;
		}
		postNotebookMessage<IWheelMessage>('did-scroll-wheel', {
			payload: {
				deltaMode: event.deltaMode,
				deltaX: event.deltaX,
				deltaY: event.deltaY,
				deltaZ: event.deltaZ,
				detail: event.detail,
				type: event.type
			}
		});
	};

	function focusFirstFocusableInCell(cellId: string) {
		const cellOutputContainer = document.getElementById(cellId);
		if (cellOutputContainer) {
			const focusableElement = cellOutputContainer.querySelector('[tabindex="0"], [href], button, input, option, select, textarea') as HTMLElement | null;
			focusableElement?.focus();
		}
	}

	function createFocusSink(cellId: string, outputId: string, focusNext?: boolean) {
		const element = document.createElement('div');
		element.tabIndex = 0;
		element.addEventListener('focus', () => {
			postNotebookMessage<IBlurOutputMessage>('focus-editor', {
				id: outputId,
				focusNext
			});
		});

		return element;
	}

	function addMouseoverListeners(element: HTMLElement, outputId: string): void {
		element.addEventListener('mouseenter', () => {
			postNotebookMessage<IMouseEnterMessage>('mouseenter', {
				id: outputId,
			});
		});
		element.addEventListener('mouseleave', () => {
			postNotebookMessage<IMouseLeaveMessage>('mouseleave', {
				id: outputId,
			});
		});
	}

	function isAncestor(testChild: Node | null, testAncestor: Node | null): boolean {
		while (testChild) {
			if (testChild === testAncestor) {
				return true;
			}
			testChild = testChild.parentNode;
		}

		return false;
	}

	class FocusTracker {
		private _outputId: string;
		private _hasFocus: boolean = false;
		private _loosingFocus: boolean = false;
		private _element: HTMLElement | Window;
		constructor(element: HTMLElement | Window, outputId: string) {
			this._element = element;
			this._outputId = outputId;
			this._hasFocus = isAncestor(document.activeElement, <HTMLElement>element);
			this._loosingFocus = false;

			element.addEventListener('focus', this._onFocus.bind(this), true);
			element.addEventListener('blur', this._onBlur.bind(this), true);
		}

		private _onFocus() {
			this._loosingFocus = false;
			if (!this._hasFocus) {
				this._hasFocus = true;
				postNotebookMessage<IOutputFocusMessage>('outputFocus', {
					id: this._outputId,
				});
			}
		}

		private _onBlur() {
			if (this._hasFocus) {
				this._loosingFocus = true;
				window.setTimeout(() => {
					if (this._loosingFocus) {
						this._loosingFocus = false;
						this._hasFocus = false;
						postNotebookMessage<IOutputBlurMessage>('outputBlur', {
							id: this._outputId,
						});
					}
				}, 0);
			}
		}

		dispose() {
			if (this._element) {
				this._element.removeEventListener('focus', this._onFocus, true);
				this._element.removeEventListener('blur', this._onBlur, true);
			}
		}
	}

	const focusTrackers = new Map<string, FocusTracker>();

	function addFocusTracker(element: HTMLElement, outputId: string): void {
		if (focusTrackers.has(outputId)) {
			focusTrackers.get(outputId)?.dispose();
		}

		focusTrackers.set(outputId, new FocusTracker(element, outputId));
	}

	function createEmitter<T>(listenerChange: (listeners: Set<Listener<T>>) => void = () => undefined): EmitterLike<T> {
		const listeners = new Set<Listener<T>>();
		return {
			fire(data) {
				for (const listener of [...listeners]) {
					listener.fn.call(listener.thisArg, data);
				}
			},
			event(fn, thisArg, disposables) {
				const listenerObj = { fn, thisArg };
				const disposable: IDisposable = {
					dispose: () => {
						listeners.delete(listenerObj);
						listenerChange(listeners);
					},
				};

				listeners.add(listenerObj);
				listenerChange(listeners);

				if (disposables instanceof Array) {
					disposables.push(disposable);
				} else if (disposables) {
					disposables.add(disposable);
				}

				return disposable;
			},
		};
	}

	function showPreloadErrors(outputNode: HTMLElement, ...errors: readonly Error[]) {
		outputNode.innerText = `Error loading preloads:`;
		const errList = document.createElement('ul');
		for (const result of errors) {
			console.error(result);
			const item = document.createElement('li');
			item.innerText = result.message;
			errList.appendChild(item);
		}
		outputNode.appendChild(errList);
	}

	interface ICreateCellInfo {
		element: HTMLElement;
		outputId?: string;

		mime: string;
		metadata: unknown;
		metadata2: unknown;

		text(): string;
		json(): any;
		data(): Uint8Array;
		blob(): Blob;
		/** @deprecated */
		bytes(): Uint8Array;
	}

	interface IDestroyCellInfo {
		outputId: string;
	}

	const onDidReceiveKernelMessage = createEmitter<unknown>();

	/** @deprecated */
	interface GlobalNotebookRendererApi<T> {
		setState: (newState: T) => void;
		getState(): T | undefined;
		readonly onWillDestroyOutput: Event<undefined | IDestroyCellInfo>;
		readonly onDidCreateOutput: Event<ICreateCellInfo>;
	}

	const kernelPreloadGlobals = {
		acquireVsCodeApi,
		onDidReceiveKernelMessage: onDidReceiveKernelMessage.event,
		postKernelMessage: (data: unknown) => postNotebookMessage('customKernelMessage', { message: data }),
	};

	const ttPolicy = window.trustedTypes?.createPolicy('notebookRenderer', {
		createHTML: value => value,
		createScript: value => value,
	});

	window.addEventListener('wheel', handleWheel);

	window.addEventListener('message', async rawEvent => {
		const event = rawEvent as ({ data: ToWebviewMessage; });

		switch (event.data.type) {
			case 'initializeMarkdownPreview':
				{
					await ensureMarkdownPreviewCells(event.data.cells);
					dimensionUpdater.updateImmediately();
					postNotebookMessage('initializedMarkdownPreview', {});
				}
				break;
			case 'createMarkdownPreview':
				ensureMarkdownPreviewCells([event.data.cell]);
				break;
			case 'showMarkdownPreview':
				{
					const data = event.data;

					const cellContainer = document.getElementById(data.id);
					if (cellContainer) {
						cellContainer.style.visibility = 'visible';
						cellContainer.style.top = `${data.top}px`;
						updateMarkdownPreview(cellContainer, data.id, data.content);
					}
				}
				break;
			case 'hideMarkdownPreviews':
				{
					for (const id of event.data.ids) {
						const cellContainer = document.getElementById(id);
						if (cellContainer) {
							cellContainer.style.visibility = 'hidden';
						}
					}
				}
				break;
			case 'unhideMarkdownPreviews':
				{
					for (const id of event.data.ids) {
						const cellContainer = document.getElementById(id);
						if (cellContainer) {
							cellContainer.style.visibility = 'visible';
							updateMarkdownPreview(cellContainer, id, undefined);
						}
					}
				}
				break;
			case 'deleteMarkdownPreview':
				{
					for (const id of event.data.ids) {
						const cellContainer = document.getElementById(id);
						cellContainer?.remove();
					}
				}
				break;
			case 'updateSelectedMarkdownPreviews':
				{
					const selectedCellIds = new Set<string>(event.data.selectedCellIds);

					for (const oldSelected of document.querySelectorAll('.preview.selected')) {
						const id = oldSelected.id;
						if (!selectedCellIds.has(id)) {
							oldSelected.classList.remove('selected');
						}
					}

					for (const newSelected of selectedCellIds) {
						const previewContainer = document.getElementById(newSelected);
						if (previewContainer) {
							previewContainer.classList.add('selected');
						}
					}
				}
				break;
			case 'html': {
				const data = event.data;
				outputs.enqueue(event.data.outputId, async (state) => {
					const preloadsAndErrors = await Promise.all<unknown>([
						data.rendererId ? renderers.load(data.rendererId) : undefined,
						...data.requiredPreloads.map(p => kernelPreloads.waitFor(p.uri)),
					].map(p => p?.catch(err => err)));

					if (state.cancelled) {
						return;
					}

					let cellOutputContainer = document.getElementById(data.cellId);
					const outputId = data.outputId;
					if (!cellOutputContainer) {
						const container = document.getElementById('container')!;

						const upperWrapperElement = createFocusSink(data.cellId, outputId);
						container.appendChild(upperWrapperElement);

						const newElement = document.createElement('div');

						newElement.id = data.cellId;
						newElement.classList.add('cell_container');

						container.appendChild(newElement);
						cellOutputContainer = newElement;

						const lowerWrapperElement = createFocusSink(data.cellId, outputId, true);
						container.appendChild(lowerWrapperElement);
					}

					cellOutputContainer.style.position = 'absolute';
					cellOutputContainer.style.top = data.cellTop + 'px';

					const outputContainer = document.createElement('div');
					outputContainer.classList.add('output_container');
					outputContainer.style.position = 'absolute';
					outputContainer.style.overflow = 'hidden';
					outputContainer.style.maxHeight = '0px';
					outputContainer.style.top = `${data.outputOffset}px`;

					const outputNode = document.createElement('div');
					outputNode.classList.add('output');
					outputNode.style.position = 'absolute';
					outputNode.style.top = `0px`;
					outputNode.style.left = data.left + 'px';
					// outputNode.style.width = 'calc(100% - ' + data.left + 'px)';
					// outputNode.style.minHeight = '32px';
					outputNode.style.padding = '0px';
					outputNode.id = outputId;

					addMouseoverListeners(outputNode, outputId);
					addFocusTracker(outputNode, outputId);
					const content = data.content;
					if (content.type === RenderOutputType.Html) {
						const trustedHtml = ttPolicy?.createHTML(content.htmlContent) ?? content.htmlContent;
						outputNode.innerHTML = trustedHtml as string;
						domEval(outputNode);
					} else if (preloadsAndErrors.some(e => e instanceof Error)) {
						const errors = preloadsAndErrors.filter((e): e is Error => e instanceof Error);
						showPreloadErrors(outputNode, ...errors);
					} else {
						const rendererApi = preloadsAndErrors[0] as RendererApi;
						try {
							rendererApi.renderCell(outputId, {
								element: outputNode,
								mime: content.mimeType,
								metadata: content.metadata,
								metadata2: content.metadata2,
								data() {
									return content.valueBytes;
								},
								bytes() { return this.data(); },
								text() {
									return new TextDecoder().decode(content.valueBytes);
								},
								json() {
									return JSON.parse(this.text());
								},
								blob() {
									return new Blob([content.valueBytes], { type: content.mimeType });
								}
							});
						} catch (e) {
							showPreloadErrors(outputNode, e);
						}
					}

					cellOutputContainer.appendChild(outputContainer);
					outputContainer.appendChild(outputNode);
					resizeObserver.observe(outputNode, outputId, true);

					if (content.type === RenderOutputType.Html) {
						domEval(outputNode);
					}

					const clientHeight = outputNode.clientHeight;
					const cps = document.defaultView!.getComputedStyle(outputNode);
					if (clientHeight !== 0 && cps.padding === '0px') {
						// we set padding to zero if the output height is zero (then we can have a zero-height output DOM node)
						// thus we need to ensure the padding is accounted when updating the init height of the output
						dimensionUpdater.update(outputId, clientHeight + style.outputNodePadding * 2, {
							isOutput: true,
							init: true,
						});

						outputNode.style.padding = `${style.outputNodePadding}px ${style.outputNodePadding}px ${style.outputNodePadding}px ${style.outputNodeLeftPadding}px`;
					} else {
						dimensionUpdater.update(outputId, outputNode.clientHeight, {
							isOutput: true,
							init: true,
						});
					}

					// don't hide until after this step so that the height is right
					cellOutputContainer.style.visibility = data.initiallyHidden ? 'hidden' : 'visible';
				});
				break;
			}
			case 'view-scroll':
				{
					// const date = new Date();
					// console.log('----- will scroll ----  ', date.getMinutes() + ':' + date.getSeconds() + ':' + date.getMilliseconds());

					for (const request of event.data.widgets) {
						const widget = document.getElementById(request.outputId);
						if (widget) {
							widget.parentElement!.parentElement!.style.top = `${request.cellTop}px`;
							widget.parentElement!.style.top = `${request.outputOffset}px`;
							if (request.forceDisplay) {
								widget.parentElement!.parentElement!.style.visibility = 'visible';
							}
						}
					}

					for (const cell of event.data.markdownPreviews) {
						const container = document.getElementById(cell.id);
						if (container) {
							container.style.top = `${cell.top}px`;
						}
					}

					break;
				}
			case 'clear':
				renderers.clearAll();
				document.getElementById('container')!.innerText = '';

				focusTrackers.forEach(ft => {
					ft.dispose();
				});
				focusTrackers.clear();
				break;
			case 'clearOutput': {
				const output = document.getElementById(event.data.outputId);
				const { rendererId, outputId } = event.data;

				outputs.cancelOutput(outputId);
				if (output && output.parentNode) {
					if (rendererId) {
						renderers.clearOutput(rendererId, outputId);
					}
					output.parentNode.removeChild(output);
				}

				break;
			}
			case 'hideOutput': {
				const { outputId } = event.data;
				outputs.enqueue(event.data.outputId, () => {
					const container = document.getElementById(outputId)?.parentElement?.parentElement;
					if (container) {
						container.style.visibility = 'hidden';
					}
				});
				break;
			}
			case 'showOutput': {
				const { outputId, cellTop: top } = event.data;
				outputs.enqueue(event.data.outputId, () => {
					const output = document.getElementById(outputId);
					if (output) {
						output.parentElement!.parentElement!.style.visibility = 'visible';
						output.parentElement!.parentElement!.style.top = top + 'px';

						dimensionUpdater.update(outputId, output.clientHeight, {
							isOutput: true,
						});
					}
				});
				break;
			}
			case 'ack-dimension':
				{
					const { outputId, height } = event.data;
					const output = document.getElementById(outputId);
					if (output) {
						output.parentElement!.style.maxHeight = `${height}px`;
						output.parentElement!.style.height = `${height}px`;
					}
					break;
				}
			case 'preload':
				const resources = event.data.resources;
				for (const { uri, originalUri } of resources) {
					kernelPreloads.load(uri, originalUri);
				}
				break;
			case 'focus-output':
				focusFirstFocusableInCell(event.data.cellId);
				break;
			case 'decorations':
				{
					const outputContainer = document.getElementById(event.data.cellId);
					outputContainer?.classList.add(...event.data.addedClassNames);
					outputContainer?.classList.remove(...event.data.removedClassNames);
				}

				break;
			case 'customKernelMessage':
				onDidReceiveKernelMessage.fire(event.data.message);
				break;
			case 'customRendererMessage':
				renderers.getRenderer(event.data.rendererId)?.receiveMessage(event.data.message);
				break;
			case 'notebookStyles':
				const documentStyle = document.documentElement.style;

				for (let i = documentStyle.length - 1; i >= 0; i--) {
					const property = documentStyle[i];

					// Don't remove properties that the webview might have added separately
					if (property && property.startsWith('--notebook-')) {
						documentStyle.removeProperty(property);
					}
				}

				// Re-add new properties
				for (const variable of Object.keys(event.data.styles)) {
					documentStyle.setProperty(`--${variable}`, event.data.styles[variable]);
				}
				break;
			case 'notebookOptions':
				currentOptions = event.data.options;

				// Update markdown previews
				for (const markdownContainer of document.querySelectorAll('.preview')) {
					setMarkdownContainerDraggable(markdownContainer, currentOptions.dragAndDropEnabled);
				}


				break;
		}
	});

	interface RendererApi {
		renderCell: (id: string, context: ICreateCellInfo) => void;
		destroyCell?: (id?: string) => void;
	}

	class Renderer {
		constructor(
			public readonly data: RendererMetadata,
			private readonly loadExtension: (id: string) => Promise<void>,
		) { }

		private _onMessageEvent = createEmitter();
		private _loadPromise?: Promise<RendererApi | undefined>;
		private _api: RendererApi | undefined;

		public get api() { return this._api; }

		public load(): Promise<RendererApi | undefined> {
			if (!this._loadPromise) {
				this._loadPromise = this._load();
			}

			return this._loadPromise;
		}

		public receiveMessage(message: unknown) {
			this._onMessageEvent.fire(message);
		}

		private createRendererContext(): RendererContext {
			const { id, messaging } = this.data;
			const context: RendererContext = {
				setState: newState => vscode.setState({ ...vscode.getState(), [id]: newState }),
				getState: <T>() => {
					const state = vscode.getState();
					return typeof state === 'object' && state ? state[id] as T : undefined;
				},
				// TODO: This is async so that we can return a promise to the API in the future.
				// Currently the API is always resolved before we call `createRendererContext`.
				getRenderer: async (id: string) => renderers.getRenderer(id)?.api,
			};

			if (messaging) {
				context.onDidReceiveMessage = this._onMessageEvent.event;
				context.postMessage = message => postNotebookMessage('customRendererMessage', { rendererId: id, message });
			}

			return context;
		}

		/** Inner function cached in the _loadPromise(). */
		private async _load(): Promise<RendererApi | undefined> {
			const module = await runRenderScript(this.data.entrypoint, this.data.id);
			if (!module) {
				return;
			}

			const api = await module.activate(this.createRendererContext());
			this._api = api;

			// Squash any errors extends errors. They won't prevent the renderer
			// itself from working, so just log them.
			await Promise.all(rendererData
				.filter(d => d.extends === this.data.id)
				.map(d => this.loadExtension(d.id).catch(console.error)),
			);

			return api;
		}
	}

	const kernelPreloads = new class {
		private readonly preloads = new Map<string /* uri */, Promise<unknown>>();

		/**
		 * Returns a promise that resolves when the given preload is activated.
		 */
		public waitFor(uri: string) {
			return this.preloads.get(uri) || Promise.resolve(new Error(`Preload not ready: ${uri}`));
		}

		/**
		 * Loads a preload.
		 * @param uri URI to load from
		 * @param originalUri URI to show in an error message if the preload is invalid.
		 */
		public load(uri: string, originalUri: string) {
			const promise = Promise.all([
				runPreload(uri, originalUri),
				this.waitForAllCurrent(),
			]).then(([module]) => module.activate());

			this.preloads.set(uri, promise);
			return promise;
		}

		/**
		 * Returns a promise that waits for all currently-registered preloads to
		 * activate before resolving.
		 */
		private waitForAllCurrent() {
			return Promise.all([...this.preloads.values()].map(p => p.catch(err => err)));
		}
	};

	const outputs = new class {
		private outputs = new Map<string, { cancelled: boolean; queue: Promise<unknown> }>();
		/**
		 * Pushes the action onto the list of actions for the given output ID,
		 * ensuring that it's run in-order.
		 */
		public enqueue(outputId: string, action: (record: { cancelled: boolean }) => unknown) {
			const record = this.outputs.get(outputId);
			if (!record) {
				this.outputs.set(outputId, { cancelled: false, queue: new Promise(r => r(action({ cancelled: false }))) });
			} else {
				record.queue = record.queue.then(r => !record.cancelled && action(record));
			}
		}

		/**
		 * Cancells the rendering of all outputs.
		 */
		public cancelAll() {
			for (const record of this.outputs.values()) {
				record.cancelled = true;
			}
			this.outputs.clear();
		}

		/**
		 * Cancels any ongoing rendering out an output.
		 */
		public cancelOutput(outputId: string) {
			const output = this.outputs.get(outputId);
			if (output) {
				output.cancelled = true;
				this.outputs.delete(outputId);
			}
		}
	};

	const renderers = new class {
		private readonly _renderers = new Map</* id */ string, Renderer>();

		constructor() {
			for (const renderer of rendererData) {
				this._renderers.set(renderer.id, new Renderer(renderer, async (extensionId) => {
					const ext = this._renderers.get(extensionId);
					if (!ext) {
						throw new Error(`Could not find extending renderer: ${extensionId}`);
					}

					await ext.load();
				}));
			}
		}

		public getRenderer(id: string) {
			return this._renderers.get(id);
		}

		public async load(id: string) {
			const renderer = this._renderers.get(id);
			if (!renderer) {
				throw new Error('Could not find renderer');
			}

			return renderer.load();
		}


		public clearAll() {
			outputs.cancelAll();
			for (const renderer of this._renderers.values()) {
				renderer.api?.destroyCell?.();
			}
		}

		public clearOutput(rendererId: string, outputId: string) {
			outputs.cancelOutput(outputId);
			this._renderers.get(rendererId)?.api?.destroyCell?.(outputId);
		}

		public async renderCustom(rendererId: string, outputId: string, info: ICreateCellInfo) {
			const api = await this.load(rendererId);
			if (!api) {
				throw new Error(`renderer ${rendererId} did not return an API`);
			}

			api.renderCell(outputId, info);
		}

		public async renderMarkdown(id: string, element: HTMLElement, content: string): Promise<void> {
			const markdownRenderers = Array.from(this._renderers.values())
				.filter(renderer => renderer.data.mimeTypes.includes('text/markdown') && !renderer.data.extends);

			if (!markdownRenderers.length) {
				throw new Error('Could not find renderer');
			}

			await Promise.all(markdownRenderers.map(x => x.load()));

			markdownRenderers[0].api?.renderCell(id, {
				element,
				mime: 'text/markdown',
				metadata: undefined,
				metadata2: undefined,
				outputId: undefined,
				text() { return content; },
				json() { return undefined; },
				bytes() { return this.data(); },
				data() { return new TextEncoder().encode(content); },
				blob() { return new Blob([this.data()], { type: this.mime }); },
			});
		}
	}();

	vscode.postMessage({
		__vscode_notebook_message: true,
		type: 'initialized'
	});

	function setMarkdownContainerDraggable(element: Element, isDraggable: boolean) {
		if (isDraggable) {
			element.classList.add('draggable');
			element.setAttribute('draggable', 'true');
		} else {
			element.classList.remove('draggable');
			element.removeAttribute('draggable');
		}
	}

	async function createMarkdownPreview(cellId: string, content: string, top: number): Promise<HTMLElement> {
		const container = document.getElementById('container')!;
		const cellContainer = document.createElement('div');

		const existing = document.getElementById(cellId);
		if (existing) {
			console.error(`Trying to create markdown preview that already exists: ${cellId}`);
			return existing;
		}

		cellContainer.id = cellId;
		cellContainer.classList.add('preview');

		cellContainer.style.position = 'absolute';
		cellContainer.style.top = top + 'px';
		container.appendChild(cellContainer);

		cellContainer.addEventListener('dblclick', () => {
			postNotebookMessage<IToggleMarkdownPreviewMessage>('toggleMarkdownPreview', { cellId });
		});

		cellContainer.addEventListener('click', e => {
			postNotebookMessage<IClickMarkdownPreviewMessage>('clickMarkdownPreview', {
				cellId,
				altKey: e.altKey,
				ctrlKey: e.ctrlKey,
				metaKey: e.metaKey,
				shiftKey: e.shiftKey,
			});
		});

		cellContainer.addEventListener('contextmenu', e => {
			postNotebookMessage<IContextMenuMarkdownPreviewMessage>('contextMenuMarkdownPreview', {
				cellId,
				clientX: e.clientX,
				clientY: e.clientY,
			});
		});

		cellContainer.addEventListener('mouseenter', () => {
			postNotebookMessage<IMouseEnterMarkdownPreviewMessage>('mouseEnterMarkdownPreview', { cellId });
		});

		cellContainer.addEventListener('mouseleave', () => {
			postNotebookMessage<IMouseLeaveMarkdownPreviewMessage>('mouseLeaveMarkdownPreview', { cellId });
		});

		setMarkdownContainerDraggable(cellContainer, currentOptions.dragAndDropEnabled);

		cellContainer.addEventListener('dragstart', e => {
			markdownPreviewDragManager.startDrag(e, cellId);
		});

		cellContainer.addEventListener('drag', e => {
			markdownPreviewDragManager.updateDrag(e, cellId);
		});

		cellContainer.addEventListener('dragend', e => {
			markdownPreviewDragManager.endDrag(e, cellId);
		});

		const previewRoot = cellContainer.attachShadow({ mode: 'open' });

		// Add default webview style
		const defaultStyles = document.getElementById('_defaultStyles') as HTMLStyleElement;
		previewRoot.appendChild(defaultStyles.cloneNode(true));

		// Add default preview style
		const previewStyles = document.getElementById('preview-styles') as HTMLTemplateElement;
		previewRoot.appendChild(previewStyles.content.cloneNode(true));

		const previewNode = document.createElement('div');
		previewNode.id = 'preview';
		previewRoot.appendChild(previewNode);

		await updateMarkdownPreview(cellContainer, cellId, content);

		resizeObserver.observe(cellContainer, cellId, false);

		return cellContainer;
	}

	async function ensureMarkdownPreviewCells(update: readonly IMarkdownCellInitialization[]): Promise<void> {
		await Promise.all(update.map(async cell => {
			let container = document.getElementById(cell.cellId);
			if (container) {
				await updateMarkdownPreview(container, cell.cellId, cell.content);
			} else {
				container = await createMarkdownPreview(cell.cellId, cell.content, cell.offset);
			}

			container.style.visibility = cell.visible ? 'visible' : 'hidden';
		}));
	}

	function postNotebookMessage<T extends FromWebviewMessage>(
		type: T['type'],
		properties: Omit<T, '__vscode_notebook_message' | 'type'>
	) {
		vscode.postMessage({
			__vscode_notebook_message: true,
			type,
			...properties
		});
	}

	let hasPostedRenderedMathTelemetry = false;
	const unsupportedKatexTermsRegex = /(\\(?:abovewithdelims|array|Arrowvert|arrowvert|atopwithdelims|bbox|bracevert|buildrel|cancelto|cases|class|cssId|ddddot|dddot|DeclareMathOperator|definecolor|displaylines|enclose|eqalign|eqalignno|eqref|hfil|hfill|idotsint|iiiint|label|leftarrowtail|leftroot|leqalignno|lower|mathtip|matrix|mbox|mit|mmlToken|moveleft|moveright|mspace|newenvironment|Newextarrow|notag|oldstyle|overparen|overwithdelims|pmatrix|raise|ref|renewenvironment|require|root|Rule|scr|shoveleft|shoveright|sideset|skew|Space|strut|style|texttip|Tiny|toggle|underparen|unicode|uproot)\b)/gi;

	async function updateMarkdownPreview(previewContainerNode: HTMLElement, cellId: string, content: string | undefined) {
		const previewRoot = previewContainerNode.shadowRoot;
		const previewNode = previewRoot?.getElementById('preview');
		if (!previewNode) {
			return;
		}

		if (typeof content === 'string') {
			if (content.trim().length === 0) {
				previewContainerNode.classList.add('emptyMarkdownCell');
				previewNode.innerText = '';
			} else {
				previewContainerNode.classList.remove('emptyMarkdownCell');
				await renderers.renderMarkdown(cellId, previewNode, content);

				if (!hasPostedRenderedMathTelemetry) {
					const hasRenderedMath = previewNode.querySelector('.katex');
					if (hasRenderedMath) {
						hasPostedRenderedMathTelemetry = true;
						postNotebookMessage<ITelemetryFoundRenderedMarkdownMath>('telemetryFoundRenderedMarkdownMath', {});
					}
				}

				const matches = previewNode.innerText.match(unsupportedKatexTermsRegex);
				if (matches) {
					postNotebookMessage<ITelemetryFoundUnrenderedMarkdownMath>('telemetryFoundUnrenderedMarkdownMath', {
						latexDirective: matches[0],
					});
				}
			}
		}

		dimensionUpdater.update(cellId, previewContainerNode.clientHeight, {
			isOutput: false
		});
	}

	const markdownPreviewDragManager = new class MarkdownPreviewDragManager {

		private currentDrag: { cellId: string, clientY: number } | undefined;

		constructor() {
			document.addEventListener('dragover', e => {
				// Allow dropping dragged markdown cells
				e.preventDefault();
			});

			document.addEventListener('drop', e => {
				e.preventDefault();

				const drag = this.currentDrag;
				if (!drag) {
					return;
				}

				this.currentDrag = undefined;
				postNotebookMessage<ICellDropMessage>('cell-drop', {
					cellId: drag.cellId,
					ctrlKey: e.ctrlKey,
					altKey: e.altKey,
					dragOffsetY: e.clientY,
				});
			});
		}

		startDrag(e: DragEvent, cellId: string) {
			if (!e.dataTransfer) {
				return;
			}

			if (!currentOptions.dragAndDropEnabled) {
				return;
			}

			this.currentDrag = { cellId, clientY: e.clientY };

			(e.target as HTMLElement).classList.add('dragging');

			postNotebookMessage<ICellDragStartMessage>('cell-drag-start', {
				cellId: cellId,
				dragOffsetY: e.clientY,
			});

			// Continuously send updates while dragging instead of relying on `updateDrag`.
			// This lets us scroll the list based on drag position.
			const trySendDragUpdate = () => {
				if (this.currentDrag?.cellId !== cellId) {
					return;
				}

				postNotebookMessage<ICellDragMessage>('cell-drag', {
					cellId: cellId,
					dragOffsetY: this.currentDrag.clientY,
				});
				requestAnimationFrame(trySendDragUpdate);
			};
			requestAnimationFrame(trySendDragUpdate);
		}

		updateDrag(e: DragEvent, cellId: string) {
			if (cellId !== this.currentDrag?.cellId) {
				this.currentDrag = undefined;
			}
			this.currentDrag = { cellId, clientY: e.clientY };
		}

		endDrag(e: DragEvent, cellId: string) {
			this.currentDrag = undefined;
			(e.target as HTMLElement).classList.remove('dragging');
			postNotebookMessage<ICellDragEndMessage>('cell-drag-end', {
				cellId: cellId
			});
		}
	}();
}

export interface RendererMetadata {
	readonly id: string;
	readonly entrypoint: string;
	readonly mimeTypes: readonly string[];
	readonly extends: string | undefined;
	readonly messaging: boolean;
}

export function preloadsScriptStr(styleValues: PreloadStyles, options: PreloadOptions, renderers: readonly RendererMetadata[]) {
	// TS will try compiling `import()` in webviePreloads, so use an helper function instead
	// of using `import(...)` directly
	return `
		const __import = (x) => import(x);
		(${webviewPreloads})(
				JSON.parse(decodeURIComponent("${encodeURIComponent(JSON.stringify(styleValues))}")),
				JSON.parse(decodeURIComponent("${encodeURIComponent(JSON.stringify(options))}")),
				JSON.parse(decodeURIComponent("${encodeURIComponent(JSON.stringify(renderers))}"))
			)\n//# sourceURL=notebookWebviewPreloads.js\n`;
}
