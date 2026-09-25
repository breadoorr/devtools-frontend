// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as i18n from '../../core/i18n/i18n.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Bindings from '../../models/bindings/bindings.js';
import * as Buttons from '../../ui/components/buttons/buttons.js';
import * as Components from '../../ui/legacy/components/utils/utils.js';
import * as UI from '../../ui/legacy/legacy.js';

import type {StylePropertiesSection} from './StylePropertiesSection.js';

type ComponentSource = Components.OpenInIDE.ComponentSource;
type InlineStyleTarget = Components.OpenInIDE.InlineStyleTarget;

const UIStrings = {
  /**
   * @description Label for an action that opens a CSS source location in the user's IDE.
   */
  openInIDE: 'Open in IDE',
} as const;
const str_ = i18n.i18n.registerUIStrings('panels/elements/OpenInIDE.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

interface OpenInIDETarget {
  property?: SDK.CSSProperty.CSSProperty;
  propertyPart?: 'name'|'value';
  selectorIndex?: number;
  linkElement?: Element;
}

interface OpenInIDELocation {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface StyleSheetOwnerTarget {
  location: OpenInIDELocation|null;
  inlineStyle?: InlineStyleTarget;
}

interface ComponentSourceCandidate {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

type ComponentFramework = 'react'|'vue'|'svelte'|'angular';

interface ComponentSourceResolution {
  framework: ComponentFramework;
  locations: ComponentSource[];
}

interface MappedComponentSource {
  location: ComponentSource;
  mapped: boolean;
}

const nodeStackTraceObserver: SDK.TargetManager.SDKModelObserver<SDK.DOMModel.DOMModel> = {
  modelAdded(domModel): void {
    void domModel.getAgent().invoke_setNodeStackTracesEnabled({enable: true});
  },
  modelRemoved(_domModel): void {
  },
};
SDK.TargetManager.TargetManager.instance().observeModels(SDK.DOMModel.DOMModel, nodeStackTraceObserver);

export function appendOpenInIDEContextMenuItem(
    contextMenu: UI.ContextMenu.ContextMenu, section: StylePropertiesSection, target: OpenInIDETarget = {}): void {
  const action = createOpenInIDEAction(section, target);
  if (!action) {
    return;
  }
  contextMenu.defaultSection().appendItem(i18nString(UIStrings.openInIDE), action, {jslogContext: 'open-in-ide'});
}

export function createOpenInIDEButton(
    section: StylePropertiesSection, target: OpenInIDETarget = {}): HTMLElement|null {
  const action = createOpenInIDEAction(section, target);
  if (!action) {
    return null;
  }
  const label = i18nString(UIStrings.openInIDE);
  // eslint-disable-next-line @devtools/no-imperative-dom-api -- The legacy styles tree expects a detached HTMLElement.
  const button = UI.UIUtils.createTextButton('', event => {
    event.consume(true);
    action();
  }, {
    className: 'open-in-ide-button',
    icon: 'webstorm-go-to-ide',
    jslogContext: 'open-in-ide',
    title: label,
    variant: Buttons.Button.Variant.ICON,
  });
  button.size = Buttons.Button.Size.MICRO;
  button.addEventListener('mousedown', event => event.consume(true));
  button.addEventListener('mouseup', event => event.consume(true));
  button.accessibleLabel = label;
  return button;
}

function createOpenInIDEAction(section: StylePropertiesSection, target: OpenInIDETarget): (() => void)|null {
  const {
    property: targetProperty,
    propertyPart: targetPropertyPart = 'value',
    selectorIndex: targetSelectorIndex,
    linkElement: targetLinkElement,
  } = target;
  const style = targetProperty?.ownerStyle ?? section.style();
  const rule = style.parentRule;
  const targetRule = rule instanceof SDK.CSSRule.CSSStyleRule ? rule : undefined;
  const targetSelector = targetSelectorIndex !== undefined ? targetRule?.selectors[targetSelectorIndex] : undefined;
  const header = rule?.header ?? (style.styleSheetId ? style.cssModel().styleSheetHeaderForId(style.styleSheetId) : null);
  const propertyRange = targetProperty ?
      (targetPropertyPart === 'name' ? targetProperty.nameRange() : targetProperty.valueRange()) :
      null;
  const range = propertyRange ?? targetProperty?.range ?? style.range;
  const cssWorkspaceBinding = Bindings.CSSWorkspaceBinding.CSSWorkspaceBinding.instance();
  let uiLocation = targetProperty ?
      cssWorkspaceBinding.propertyUILocation(targetProperty, targetPropertyPart === 'name') :
      (targetLinkElement ? Components.Linkifier.Linkifier.uiLocation(targetLinkElement) : null);
  let rawLocation: SDK.CSSModel.CSSLocation|null = null;
  if (!uiLocation && header && targetRule && targetSelectorIndex !== undefined && targetSelector) {
    rawLocation = new SDK.CSSModel.CSSLocation(
        header, targetRule.lineNumberInSource(targetSelectorIndex), targetRule.columnNumberInSource(targetSelectorIndex));
    uiLocation = cssWorkspaceBinding.rawLocationToUILocation(rawLocation);
  } else if (!uiLocation && header && range) {
    rawLocation = new SDK.CSSModel.CSSLocation(
        header, header.lineNumberInSource(range.startLine),
        header.columnNumberInSource(range.startLine, range.startColumn));
    uiLocation = cssWorkspaceBinding.rawLocationToUILocation(rawLocation);
  }

  let location: OpenInIDELocation|null = null;
  if (uiLocation) {
    location = {
      url: uiLocation.uiSourceCode.contentURL(),
      lineNumber: uiLocation.lineNumber,
      columnNumber: uiLocation.columnNumber ?? 0,
    };
  } else if (rawLocation && header) {
    location = {
      url: header.sourceURL || header.resourceURL(),
      lineNumber: rawLocation.lineNumber,
      columnNumber: rawLocation.columnNumber ?? 0,
    };
  }

  const isInlineStyle =
      style.type === SDK.CSSStyleDeclaration.Type.Inline || style.type === SDK.CSSStyleDeclaration.Type.Attributes;
  const sourceUrlIsAuthoritative = Boolean(uiLocation?.uiSourceCode.contentURL());
  const matchedNode = section.matchedStyles.nodeForStyle(style);
  const node = isInlineStyle ? matchedNode : null;
  if ((!location || !location.url) && !matchedNode && !header?.ownerNode) {
    return null;
  }

  return () => {
    void (async(): Promise<void> => {
      const ownerTarget = !isInlineStyle && !sourceUrlIsAuthoritative && header?.ownerNode ?
          await styleSheetOwnerTarget(
              header, location, targetRule, targetSelector?.text, targetProperty, targetPropertyPart, matchedNode) :
          null;
      const ownerLocation = ownerTarget?.location ?? null;
      const creationLocation = isInlineStyle ? await nodeCreationLocation(node) : null;
      const resolvedLocation = location?.url ? location : ownerLocation ?? creationLocation;
      const componentSourceResolution = matchedNode ? await frameworkComponentSourceLocations(matchedNode) : null;
      const componentSources = componentSourceResolution?.locations ?? [];
      let inlineStyle = (isInlineStyle && node ?
          createInlineStyleTarget(node, targetProperty, targetPropertyPart, creationLocation) :
          ownerTarget?.inlineStyle) ?? undefined;
      const componentSourceHint = inlineStyle ? preferredInlineStyleSourceHint(inlineStyle.kind, componentSources) : null;
      if (inlineStyle && componentSourceHint) {
        inlineStyle = {...inlineStyle, sourceHint: toSourceHint(componentSourceHint)};
      }
      if (resolvedLocation || inlineStyle || componentSources.length > 0) {
        Components.Linkifier.Linkifier.openInIDE({
          url: resolvedLocation?.url ?? '',
          lineNumber: resolvedLocation?.lineNumber ?? 0,
          columnNumber: resolvedLocation?.columnNumber ?? 0,
          sourceUrlIsAuthoritative,
          inlineStyle,
          componentSources,
        });
      } else {
        console.warn('[WebStorm] CDP did not provide a source location for this CSS declaration.');
      }
    })();
  };
}

async function frameworkComponentSourceLocations(node: SDK.DOMModel.DOMNode): Promise<ComponentSourceResolution|null> {
  const reactLocations = await reactFiberSourceLocations(node);
  if (reactLocations.length > 0) {
    return {framework: 'react', locations: reactLocations};
  }

  const vueLocations = await vueComponentSourceLocations(node);
  if (vueLocations.length > 0) {
    return {framework: 'vue', locations: vueLocations};
  }

  const svelteLocations = await svelteComponentSourceLocations(node);
  if (svelteLocations.length > 0) {
    return {framework: 'svelte', locations: svelteLocations};
  }

  const angularLocations = await angularComponentSourceLocations(node);
  if (angularLocations.length > 0) {
    return {framework: 'angular', locations: angularLocations};
  }

  return null;
}

async function reactFiberSourceLocations(node: SDK.DOMModel.DOMNode): Promise<ComponentSource[]> {
  const object = await node.resolveToObject('webstorm-css-to-source-react-fiber');
  if (!object) {
    return [];
  }
  let result: unknown;
  try {
    result = await object.callFunctionJSON<unknown, Element>(function(this: Element): unknown {
      const fiberKey = Object.getOwnPropertyNames(this).find(
          key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      if (!fiberKey) {
        return [];
      }
      interface Fiber {
        return?: Fiber|null;
        type?: unknown;
        elementType?: unknown;
        _debugSource?: {fileName?: unknown, lineNumber?: unknown, columnNumber?: unknown}|null;
        _debugStack?: {stack?: unknown}|string|null;
      }
      const fiber = (this as unknown as Record<string, unknown>)[fiberKey] as Fiber|undefined;
      const candidates: Array<{url: string, lineNumber: number, columnNumber: number}> = [];
      const seen = new Set<string>();
      const addCandidate = (url: unknown, line: unknown, column: unknown, oneBased: boolean): void => {
        if (typeof url !== 'string' || !url || typeof line !== 'number' || !Number.isFinite(line) ||
            typeof column !== 'number' || !Number.isFinite(column)) {
          return;
        }
        const lineNumber = Math.max(0, Math.trunc(line) - (oneBased ? 1 : 0));
        const columnNumber = Math.max(0, Math.trunc(column) - (oneBased ? 1 : 0));
        const key = `${url}:${lineNumber}:${columnNumber}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({url, lineNumber, columnNumber});
        }
      };
      const addStackLocation = (stack: unknown): void => {
        if (typeof stack !== 'string') {
          return;
        }
        let frameCount = 0;
        for (const line of stack.split('\n')) {
          const frame = line.trim().replace(/^at\s+/, '');
          const location = frame.endsWith(')') && frame.includes('(') ?
              frame.slice(frame.lastIndexOf('(') + 1, -1) :
              frame;
          const match = location.match(/^(.+):(\d+):(\d+)$/);
          if (match) {
            addCandidate(match[1], Number(match[2]), Number(match[3]), true);
            if (++frameCount === 4) {
              return;
            }
          }
        }
      };

      for (let current: Fiber|null|undefined = fiber;
           current && candidates.length < 24;
           current = current.return) {
        const componentType = current.elementType ?? current.type;
        if (typeof componentType !== 'function' &&
            (typeof componentType !== 'object' || componentType === null)) {
          continue;
        }
        const source = current._debugSource;
        if (source) {
          addCandidate(source.fileName, source.lineNumber, source.columnNumber, true);
        } else {
          const debugStack = typeof current._debugStack === 'string' ? current._debugStack : current._debugStack?.stack;
          addStackLocation(debugStack);
        }
      }
      return candidates;
    }, []);
  } finally {
    object.release();
  }
  if (!Array.isArray(result)) {
    return [];
  }
  return await componentSourceLocations(node, result);
}

async function vueComponentSourceLocations(node: SDK.DOMModel.DOMNode): Promise<ComponentSource[]> {
  const object = await node.resolveToObject('webstorm-css-to-source-vue-component');
  if (!object) {
    return [];
  }
  let result: unknown;
  try {
    result = await object.callFunctionJSON<unknown, Element>(function(this: Element): unknown {
      type VueComponentType = Record<string, unknown>;
      interface VueComponentInstance {
        parent?: VueComponentInstance|null;
        type?: unknown;
        vnode?: {type?: unknown}|null;
      }
      const candidates: Array<{url: string, lineNumber: number, columnNumber: number}> = [];
      const seen = new Set<string>();
      const addComponentType = (componentType: unknown): void => {
        if ((typeof componentType !== 'object' || componentType === null) && typeof componentType !== 'function') {
          return;
        }
        const type = componentType as VueComponentType;
        const options = type['__vccOpts'];
        const optionsFile = options && typeof options === 'object' ?
            (options as Record<string, unknown>)['__file'] :
            undefined;
        const file = typeof type['__file'] === 'string' ? type['__file'] : optionsFile;
        if (typeof file === 'string' && file && !seen.has(file)) {
          seen.add(file);
          candidates.push({url: file, lineNumber: 0, columnNumber: 0});
        }
      };

      let component =
          (this as unknown as Record<string, unknown>)['__vueParentComponent'] as VueComponentInstance|null|undefined;
      while (component && candidates.length < 24) {
        addComponentType(component.type);
        addComponentType(component.vnode?.type);
        component = component.parent;
      }
      return candidates;
    }, []);
  } finally {
    object.release();
  }
  if (!Array.isArray(result)) {
    return [];
  }
  return await componentSourceLocations(node, result);
}

async function svelteComponentSourceLocations(node: SDK.DOMModel.DOMNode): Promise<ComponentSource[]> {
  const object = await node.resolveToObject('webstorm-css-to-source-svelte-component');
  if (!object) {
    return [];
  }
  let result: unknown;
  try {
    result = await object.callFunctionJSON<unknown, Element>(function(this: Element): unknown {
      interface SvelteDevStackEntry {
        file?: unknown;
        line?: unknown;
        column?: unknown;
        parent?: SvelteDevStackEntry|null;
      }
      interface SvelteElementMetadata {
        loc?: {file?: unknown, line?: unknown, column?: unknown}|null;
        parent?: SvelteDevStackEntry|null;
      }
      const candidates: Array<{url: string, lineNumber: number, columnNumber: number}> = [];
      const seenLocations = new Set<string>();
      const seenMetadata = new Set<object>();
      const addCandidate = (url: unknown, line: unknown, column: unknown): void => {
        if (typeof url !== 'string' || !url || typeof line !== 'number' || !Number.isFinite(line) || line < 1 ||
            typeof column !== 'number' || !Number.isFinite(column) || column < 0) {
          return;
        }
        const lineNumber = Math.max(0, Math.trunc(line) - 1);
        const columnNumber = Math.max(0, Math.trunc(column));
        const key = `${url}:${lineNumber}:${columnNumber}`;
        if (!seenLocations.has(key)) {
          seenLocations.add(key);
          candidates.push({url, lineNumber, columnNumber});
        }
      };

      for (let element: Element|null = this;
           element && candidates.length < 24;
           element = element.parentElement) {
        const metadata =
            (element as unknown as Record<string, unknown>)['__svelte_meta'] as SvelteElementMetadata|null|undefined;
        if (!metadata || seenMetadata.has(metadata)) {
          continue;
        }
        seenMetadata.add(metadata);
        addCandidate(metadata.loc?.file, metadata.loc?.line, metadata.loc?.column);

        for (let entry = metadata.parent;
             entry && candidates.length < 24 && !seenMetadata.has(entry);
             entry = entry.parent) {
          seenMetadata.add(entry);
          addCandidate(entry.file, entry.line, entry.column);
        }
        if (candidates.length > 0) {
          break;
        }
      }
      return candidates;
    }, []);
  } finally {
    object.release();
  }
  if (!Array.isArray(result)) {
    return [];
  }
  return await componentSourceLocations(node, result);
}

async function angularComponentSourceLocations(node: SDK.DOMModel.DOMNode): Promise<ComponentSource[]> {
  const object = await node.resolveToObject('webstorm-css-to-source-angular-component');
  if (!object) {
    return [];
  }
  try {
    const attachedLocations = await object.callFunctionJSON<unknown, Element>(function(this: Element): unknown {
      const candidates: Array<{url: string, lineNumber: number, columnNumber: number}> = [];
      const seen = new Set<string>();
      for (let element: Element|null = this, depth = 0; element && depth < 32;
           element = element.parentElement, ++depth) {
        const value = element.getAttribute('data-ng-source-location');
        const match = value ? /^(.*)@o:\d+,l:(\d+),c:(\d+)$/.exec(value) : null;
        if (!match || !match[1]) {
          continue;
        }
        const location = {
          url: match[1],
          lineNumber: Number(match[2]),
          columnNumber: Number(match[3]),
        };
        const key = `${location.url}:${location.lineNumber}:${location.columnNumber}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(location);
        }
      }
      return candidates;
    }, []);
    const metadataLocations = await object.callFunctionJSON<unknown, Element>(function(this: Element): unknown {
      interface AngularDebugApi {
        getComponent?: (element: Element) => unknown;
        getOwningComponent?: (elementOrComponent: unknown) => unknown;
      }
      interface AngularDebugInfo {
        filePath?: unknown;
        lineNumber?: unknown;
      }
      interface AngularDecorator {
        args?: unknown[];
      }
      interface AngularComponentType {
        ɵcmp?: {debugInfo?: AngularDebugInfo|null}|null;
        decorators?: AngularDecorator[]|null;
      }
      const ng = (globalThis as typeof globalThis&{ng?: AngularDebugApi}).ng;
      if (!ng?.getOwningComponent) {
        return [];
      }
      const candidates: Array<{url: string, lineNumber: number, columnNumber: number}> = [];
      const seen = new Set<string>();
      const addCandidate = (url: unknown, lineNumber = 0, columnNumber = 0): void => {
        if (typeof url !== 'string' || !url) {
          return;
        }
        const key = `${url}:${lineNumber}:${columnNumber}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({url, lineNumber, columnNumber});
        }
      };
      const resolveResource = (componentFile: string, resource: string): string => {
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(resource) || resource.startsWith('/')) {
          return resource;
        }
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(componentFile)) {
          try {
            return new URL(resource, componentFile).toString();
          } catch {
          }
        }
        const normalizedFile = componentFile.replace(/\\/g, '/');
        const separator = normalizedFile.lastIndexOf('/');
        const directory = separator >= 0 ? normalizedFile.substring(0, separator) : '';
        const segments = directory ? directory.split('/') : [];
        for (const segment of resource.replace(/\\/g, '/').split('/')) {
          if (!segment || segment === '.') {
            continue;
          }
          if (segment === '..') {
            if (segments.length > 1) {
              segments.pop();
            }
          } else {
            segments.push(segment);
          }
        }
        return segments.join('/');
      };
      const components: unknown[] = [];
      const seenComponents = new Set<unknown>();
      const addComponent = (component: unknown): void => {
        if (component && !seenComponents.has(component)) {
          seenComponents.add(component);
          components.push(component);
        }
      };
      for (let element: Element|null = this, depth = 0; element && depth < 32 && components.length < 12;
           element = element.parentElement, ++depth) {
        addComponent(ng.getComponent?.(element));
        addComponent(ng.getOwningComponent(element));
      }

      for (const component of components) {
        if (candidates.length >= 24) {
          break;
        }
        const componentType = (component as {constructor?: AngularComponentType}).constructor;
        const debugInfo = componentType?.ɵcmp?.debugInfo;
        const componentFile = typeof debugInfo?.filePath === 'string' ? debugInfo.filePath : '';
        if (componentFile) {
          const decorators = Array.isArray(componentType?.decorators) ? componentType.decorators : [];
          for (const decorator of decorators) {
            const decoratorArguments = Array.isArray(decorator.args) ? decorator.args : [];
            for (const argument of decoratorArguments) {
              if (!argument || typeof argument !== 'object') {
                continue;
              }
              const metadata = argument as {
                templateUrl?: unknown,
                styleUrl?: unknown,
                styleUrls?: unknown,
              };
              if (typeof metadata.templateUrl === 'string') {
                addCandidate(resolveResource(componentFile, metadata.templateUrl));
              }
              if (typeof metadata.styleUrl === 'string') {
                addCandidate(resolveResource(componentFile, metadata.styleUrl));
              }
              if (Array.isArray(metadata.styleUrls)) {
                for (const styleUrl of metadata.styleUrls) {
                  if (typeof styleUrl === 'string') {
                    addCandidate(resolveResource(componentFile, styleUrl));
                  }
                }
              }
            }
          }
          const lineNumber = typeof debugInfo?.lineNumber === 'number' && Number.isFinite(debugInfo.lineNumber) ?
              Math.max(0, Math.trunc(debugInfo.lineNumber) - 1) :
              0;
          addCandidate(componentFile, lineNumber);
        }
      }
      return candidates;
    }, []);
    const directCandidates = prioritizeAngularComponentSources([
      ...(Array.isArray(attachedLocations) ? attachedLocations : []),
      ...(Array.isArray(metadataLocations) ? metadataLocations : []),
    ].filter(isComponentSourceCandidate));
    if (directCandidates.length > 0) {
      const locations = await componentSourceLocations(node, directCandidates);
      if (locations.length > 0) {
        return locations;
      }
    }

    const mappedSources: ComponentSource[] = [];
    const fallbacks: ComponentSource[] = [];
    for (let depth = 0; depth < MAX_ANGULAR_COMPONENT_DEPTH; ++depth) {
      let componentFound = false;
      for (const kind of ['template', 'constructor'] as const) {
        const source = await angularComponentFunctionSource(object, kind, depth);
        if (!source) {
          continue;
        }
        componentFound = true;
        if (source.mapped) {
          mappedSources.push(source.location);
        } else {
          fallbacks.push(source.location);
        }
      }
      if (!componentFound) {
        break;
      }
    }
    return deduplicateComponentSources(prioritizeAngularComponentSources([...mappedSources, ...fallbacks]));
  } finally {
    object.release();
  }
}

async function angularComponentFunctionSource(
    object: SDK.RemoteObject.RemoteObject, kind: 'template'|'constructor', depth: number):
    Promise<MappedComponentSource|null> {
  let functionObject: SDK.RemoteObject.RemoteObject|null = null;
  try {
    const result = await object.callFunction<unknown, Element>(function(
        this: Element, requestedKind: 'template'|'constructor', requestedDepth: number): unknown {
      interface AngularDebugApi {
        getComponent?: (element: Element) => unknown;
        getOwningComponent?: (elementOrComponent: unknown) => unknown;
      }
      interface AngularComponentType {
        ɵcmp?: {template?: unknown}|null;
      }
      const ng = (globalThis as typeof globalThis&{ng?: AngularDebugApi}).ng;
      if (!ng?.getOwningComponent) {
        return null;
      }
      const components: unknown[] = [];
      const seen = new Set<unknown>();
      const addComponent = (component: unknown): void => {
        if (component && !seen.has(component)) {
          seen.add(component);
          components.push(component);
        }
      };
      for (let element: Element|null = this, depth = 0; element && depth < 32 && components.length <= requestedDepth;
           element = element.parentElement, ++depth) {
        addComponent(ng.getComponent?.(element));
        addComponent(ng.getOwningComponent(element));
      }
      const component = components[requestedDepth];
      if (!component) {
        return null;
      }
      const componentType = (component as {constructor?: AngularComponentType}).constructor;
      return requestedKind === 'template' ? componentType?.ɵcmp?.template ?? null : componentType ?? null;
    }, [{value: kind}, {value: depth}]);
    functionObject = result.object;
    if (result.wasThrown || functionObject?.type !== 'function') {
      return null;
    }
    const details = await SDK.RemoteObject.RemoteFunction.objectAsFunction(functionObject).targetFunctionDetails();
    if (!details?.location) {
      return null;
    }
    const uiLocation =
        await Bindings.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance().rawLocationToUILocation(
            details.location);
    if (uiLocation?.isIgnoreListed()) {
      return null;
    }
    const scriptURL = details.location.script()?.sourceURL;
    if (uiLocation) {
      const url = uiLocation.uiSourceCode.contentURL();
      if (url) {
        return {
          location: {
            url,
            lineNumber: uiLocation.lineNumber,
            columnNumber: uiLocation.columnNumber ?? 0,
          },
          mapped: (!scriptURL || url !== scriptURL) && isAuthoredComponentSourceUrl(url),
        };
      }
    }
    return scriptURL ? {
      location: {
        url: scriptURL,
        lineNumber: details.location.lineNumber,
        columnNumber: details.location.columnNumber,
      },
      mapped: false,
    } : null;
  } finally {
    functionObject?.release();
  }
}

function deduplicateComponentSources(locations: ComponentSource[]): ComponentSource[] {
  const seen = new Set<string>();
  return locations.filter(location => {
    const key = `${location.url}:${location.lineNumber}:${location.columnNumber}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, MAX_COMPONENT_SOURCE_TARGETS);
}

function prioritizeAngularComponentSources<T extends ComponentSourceCandidate>(locations: T[]): T[] {
  return locations.map((location, index) => ({location, index}))
      .sort((left, right) => {
        const dependencyDifference = Number(isLikelyDependencySource(left.location.url)) -
            Number(isLikelyDependencySource(right.location.url));
        return dependencyDifference || left.index - right.index;
      })
      .map(({location}) => location);
}

function isLikelyDependencySource(url: string): boolean {
  const path = sourcePath(url).replace(/\\/g, '/');
  return /(?:^|\/)(?:node_modules|bazel-out)(?:\/|$)/.test(path) ||
      /(?:^|\/)[^/]*-fastbuild[^/]*(?:\/|$)/.test(path);
}

function preferredInlineStyleSourceHint(
    kind: InlineStyleTarget['kind'], componentSources: ComponentSource[]): ComponentSource|null {
  const preferredExtensions = kind === 'style-tag' ? STYLE_SOURCE_EXTENSIONS : TEMPLATE_SOURCE_EXTENSIONS;
  return componentSources.find(source => preferredExtensions.some(extension => sourcePath(source.url).endsWith(extension))) ??
      componentSources.find(source => COMPONENT_SOURCE_EXTENSIONS.some(extension => sourcePath(source.url).endsWith(extension))) ??
      componentSources.find(source => isAuthoredComponentSourceUrl(source.url)) ??
      null;
}

function toSourceHint(location: ComponentSource): NonNullable<InlineStyleTarget['sourceHint']> {
  return {
    url: location.url,
    line: Math.max(1, Math.trunc(location.lineNumber) + 1),
    column: Math.max(1, Math.trunc(location.columnNumber) + 1),
  };
}

function isAuthoredComponentSourceUrl(url: string): boolean {
  const path = sourcePath(url);
  return [...TEMPLATE_SOURCE_EXTENSIONS, ...COMPONENT_SOURCE_EXTENSIONS, ...STYLE_SOURCE_EXTENSIONS]
      .some(extension => path.endsWith(extension));
}

function sourcePath(url: string): string {
  return url.replace(/[?#].*$/, '').toLowerCase();
}

async function componentSourceLocations(node: SDK.DOMModel.DOMNode, result: unknown[]): Promise<ComponentSource[]> {

  const debuggerModel = node.domModel().target().model(SDK.DebuggerModel.DebuggerModel);
  const debuggerWorkspaceBinding = Bindings.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance();
  const locations: ComponentSource[] = [];
  const seen = new Set<string>();
  for (const candidate of result.slice(0, MAX_COMPONENT_SOURCE_CANDIDATES)) {
    if (!isComponentSourceCandidate(candidate)) {
      continue;
    }
    const rawLocation = debuggerModel?.createRawLocationByURL(
        candidate.url, candidate.lineNumber, candidate.columnNumber);
    const uiLocation = rawLocation ? await debuggerWorkspaceBinding.rawLocationToUILocation(rawLocation) : null;
    if (uiLocation?.isIgnoreListed()) {
      continue;
    }
    const location = uiLocation ? {
      url: uiLocation.uiSourceCode.contentURL(),
      lineNumber: uiLocation.lineNumber,
      columnNumber: uiLocation.columnNumber ?? 0,
    } : candidate;
    const key = `${location.url}:${location.lineNumber}:${location.columnNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      locations.push(location);
      if (locations.length === MAX_COMPONENT_SOURCE_TARGETS) {
        break;
      }
    }
  }
  return locations;
}

function isComponentSourceCandidate(candidate: unknown): candidate is ComponentSourceCandidate {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const {url, lineNumber, columnNumber} = candidate as Record<string, unknown>;
  return typeof url === 'string' && url.length > 0 && url.length <= MAX_SOURCE_URL_LENGTH &&
      typeof lineNumber === 'number' && Number.isInteger(lineNumber) && lineNumber >= 0 &&
      typeof columnNumber === 'number' && Number.isInteger(columnNumber) && columnNumber >= 0;
}

async function styleSheetOwnerTarget(
    header: SDK.CSSStyleSheetHeader.CSSStyleSheetHeader,
    location: OpenInIDELocation|null, rule: SDK.CSSRule.CSSStyleRule|undefined,
    selectedSelector: string|undefined, property: SDK.CSSProperty.CSSProperty|undefined,
    propertyPart: 'name'|'value', matchedNode: SDK.DOMModel.DOMNode|null): Promise<StyleSheetOwnerTarget|null> {
  const resourceURL = header.resourceURL();
  if (location?.url && location.url !== header.sourceURL && location.url !== resourceURL) {
    return null;
  }
  const node = await header.ownerNode?.resolvePromise();
  if (!node || node.nodeName().toLowerCase() !== 'style') {
    return null;
  }
  const ownerLocation = await nodeCreationLocation(node);
  const selectorText = selectedSelector ?? rule?.selectorText();
  const sourceElement = matchedNode ?? node;
  const inlineStyle = selectorText || property ? {
    kind: 'style-tag' as const,
    propertyName: property?.name,
    propertyValue: property?.value,
    propertyPart: property ? propertyPart : 'selector' as const,
    selector: selectorText,
    tagName: sourceElement.localName() || sourceElement.nodeName().toLowerCase(),
    attributes: Object.fromEntries(sourceElement.attributes().map(attribute => [attribute.name, attribute.value])),
  } : undefined;
  return {location: ownerLocation, inlineStyle};
}

function createInlineStyleTarget(
    node: SDK.DOMModel.DOMNode, property: SDK.CSSProperty.CSSProperty|undefined,
    propertyPart: 'name'|'value', sourceHint: OpenInIDELocation|null): InlineStyleTarget|null {
  const attributes = Object.fromEntries(node.attributes().map(attribute => [attribute.name, attribute.value]));
  if (!property) {
    return null;
  }
  return {
    kind: 'style-attribute',
    propertyName: property?.name,
    propertyValue: property?.value,
    propertyPart,
    tagName: node.localName() || node.nodeName().toLowerCase(),
    attributes,
    sourceHint: sourceHint ? {
      url: sourceHint.url,
      line: Math.max(1, Math.trunc(sourceHint.lineNumber) + 1),
      column: Math.max(1, Math.trunc(sourceHint.columnNumber) + 1),
    } : undefined,
  };
}

async function nodeCreationLocation(node: SDK.DOMModel.DOMNode|null): Promise<OpenInIDELocation|null> {
  const stackTrace = await node?.creationStackTrace();
  const debuggerModel = node?.domModel().target().model(SDK.DebuggerModel.DebuggerModel);
  if (!stackTrace || !debuggerModel) {
    return null;
  }

  const debuggerWorkspaceBinding = Bindings.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance();
  let firstLocation: OpenInIDELocation|null = null;
  for (let stack: typeof stackTrace|undefined = stackTrace; stack; stack = stack.parent) {
    for (const frame of stack.callFrames) {
      const rawLocation = debuggerModel.createRawLocationByScriptId(
          frame.scriptId, frame.lineNumber, frame.columnNumber);
      const uiLocation = await debuggerWorkspaceBinding.rawLocationToUILocation(rawLocation);
      if (uiLocation) {
        const mappedLocation = {
          url: uiLocation.uiSourceCode.contentURL(),
          lineNumber: uiLocation.lineNumber,
          columnNumber: uiLocation.columnNumber ?? 0,
        };
        firstLocation ??= mappedLocation;
        if (!uiLocation.isIgnoreListed()) {
          return mappedLocation;
        }
      } else if (!firstLocation && frame.url) {
        firstLocation = {
          url: frame.url,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
        };
      }
    }
  }
  return firstLocation;
}

const MAX_COMPONENT_SOURCE_TARGETS = 6;
const MAX_COMPONENT_SOURCE_CANDIDATES = 24;
const MAX_ANGULAR_COMPONENT_DEPTH = 12;
const MAX_SOURCE_URL_LENGTH = 8_192;
const TEMPLATE_SOURCE_EXTENSIONS = ['.html', '.htm', '.vue', '.svelte'];
const COMPONENT_SOURCE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte'];
const STYLE_SOURCE_EXTENSIONS = ['.css', '.scss', '.sass', '.less', '.styl', '.stylus'];
