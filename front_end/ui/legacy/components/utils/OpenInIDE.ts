// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as i18n from '../../../../core/i18n/i18n.js';
import type * as Platform from '../../../../core/platform/platform.js';
import * as SDK from '../../../../core/sdk/sdk.js';

const UIStrings = {
  /**
   * @description Label for an action that opens a source location in the user's IDE.
   */
  openInIDE: 'Open in IDE',
  /**
   * @description Message shown when WebStorm could not locate the source of a CSS declaration.
   */
  cssSourceNotResolved: 'Could not resolve the CSS source location in this project.',
} as const;
const str_ = i18n.i18n.registerUIStrings('ui/legacy/components/utils/OpenInIDE.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

export interface OpenInIDERequest {
  url: string;
  lineNumber: number;
  columnNumber: number;
  sourceUrlIsAuthoritative?: boolean;
  inlineStyle?: InlineStyleTarget;
  componentSources?: ComponentSource[];
}

export interface ComponentSource {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface InlineStyleTarget {
  kind?: 'style-attribute'|'style-tag';
  propertyName?: string;
  propertyValue?: string;
  propertyPart: 'name'|'value'|'selector';
  selector?: string;
  tagName: string;
  attributes: Record<string, string>;
  sourceHint?: SourceHint;
}

interface SourceHint {
  url: string;
  line: number;
  column: number;
}

interface SourceLocationTarget {
  kind: 'source-location';
  url: string;
  line: number;
  column: number;
}

interface InlineStyleNavigationTarget {
  kind: 'inline-style';
  style: InlineStyleTarget;
}

type NavigationTarget = SourceLocationTarget|InlineStyleNavigationTarget;

interface BrowserNavigationPayload {
  version: 1;
  requestId: string;
  focusIde: boolean;
  targets: NavigationTarget[];
}

type NavigationResult =
    'opened'|'invalid-request'|'project-not-found'|'target-not-found'|'outside-project'|'connection-failure'|'timeout';

interface SnackbarConstructor extends CustomElementConstructor {
  show(properties: {
    message: string,
    closable?: boolean,
  }): HTMLElement;
}

let navigationFailureSnackbar: HTMLElement|null = null;

export interface LinkAction {
  section: string;
  title: string;
  jslogContext: string;
  handler: () => void;
}

export function createLinkAction(
    url: Platform.DevToolsPath.UrlString, lineNumber: number, columnNumber: number): LinkAction {
  return {
    section: 'reveal',
    title: i18nString(UIStrings.openInIDE),
    jslogContext: 'open-in-ide',
    handler: () => {
      openInIDE({url, lineNumber, columnNumber});
    },
  };
}

export function openInIDE(request: OpenInIDERequest): boolean {
  const sourceTarget: SourceLocationTarget|null = request.url.trim() ? {
    kind: 'source-location',
    url: request.url,
    line: Math.max(1, Math.trunc(request.lineNumber) + 1),
    column: Math.max(1, Math.trunc(request.columnNumber) + 1),
  } : null;
  const inlineStyleTarget: InlineStyleNavigationTarget|null = request.inlineStyle ? {
    kind: 'inline-style',
    style: request.inlineStyle,
  } : null;
  const componentSourceTargets: SourceLocationTarget[] = (request.componentSources ?? []).map(source => ({
    kind: 'source-location',
    url: source.url,
    line: Math.max(1, Math.trunc(source.lineNumber) + 1),
    column: Math.max(1, Math.trunc(source.columnNumber) + 1),
  }));
  const targetsWithNulls: Array<NavigationTarget|null> = request.sourceUrlIsAuthoritative ?
      [sourceTarget, inlineStyleTarget, ...componentSourceTargets] :
      [inlineStyleTarget, ...componentSourceTargets, sourceTarget];
  const targets = targetsWithNulls.filter((target): target is NavigationTarget => target !== null);
  if (targets.length === 0) {
    console.error('[WebStorm] Open in IDE request has no navigation targets:', request);
    return false;
  }

  const payload: BrowserNavigationPayload = {
    version: 1,
    requestId: crypto.randomUUID(),
    focusIde: true,
    targets,
  };
  void sendNavigationRequest(payload)
      .then(result => {
        if (result !== 'opened') {
          showNavigationFailure();
        }
      })
      .catch(error => {
        console.error('[WebStorm] Open in IDE request failed:', error);
        showNavigationFailure();
      });
  return true;
}

async function sendNavigationRequest(payload: BrowserNavigationPayload): Promise<NavigationResult> {
  const runtimeModels = SDK.TargetManager.TargetManager.instance().models(SDK.RuntimeModel.RuntimeModel);
  const executionContext = runtimeModels.flatMap(model => model.executionContexts())
                               .find(context => context.name === CDP_WORLD_NAME);
  if (!executionContext) {
    throw new Error('The inspected page is not connected to the IDE. Launch or reconnect it from WebStorm.');
  }

  const serializedPayload = JSON.stringify(payload);
  const expression = `(() => {
    const requestId = ${JSON.stringify(payload.requestId)};
    globalThis[${JSON.stringify(CDP_BINDING_NAME)}](${JSON.stringify(serializedPayload)});
    return new Promise(resolve => {
      const deadline = Date.now() + ${NAVIGATION_RESULT_TIMEOUT_MS};
      const poll = () => {
        const store = globalThis[${JSON.stringify(CDP_RESULT_STORE_NAME)}];
        const result = store?.[requestId];
        if (typeof result === 'string') {
          delete store[requestId];
          resolve(result);
          return;
        }
        if (Date.now() >= deadline) {
          resolve('timeout');
          return;
        }
        setTimeout(poll, ${NAVIGATION_RESULT_POLL_INTERVAL_MS});
      };
      poll();
    });
  })()`;
  const result = await executionContext.evaluate(
      {
        expression,
        objectGroup: 'webstorm-css-to-source',
        includeCommandLineAPI: false,
        silent: true,
        returnByValue: true,
        generatePreview: false,
        allowUnsafeEvalBlockedByCSP: true,
      },
      false,
      true);
  if ('error' in result) {
    throw new Error(result.error);
  }
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'The IDE navigation binding failed.');
  }
  const value = result.object?.value;
  if (typeof value !== 'string' || !NAVIGATION_RESULTS.has(value as NavigationResult)) {
    throw new Error('The IDE returned an invalid CSS navigation result.');
  }
  return value as NavigationResult;
}

function showNavigationFailure(): void {
  if (navigationFailureSnackbar?.isConnected) {
    return;
  }
  const snackbar = customElements.get('devtools-snackbar') as SnackbarConstructor|undefined;
  if (!snackbar) {
    console.error('[WebStorm] The DevTools snackbar component is not available.');
    return;
  }
  navigationFailureSnackbar = snackbar.show({
    message: i18nString(UIStrings.cssSourceNotResolved),
    closable: true,
  });
}

const CDP_BINDING_NAME = '__webstorm_css_to_source_open';
const CDP_WORLD_NAME = 'webstorm-css-to-source';
const CDP_RESULT_STORE_NAME = '__webstorm_css_to_source_results';
const NAVIGATION_RESULT_TIMEOUT_MS = 15_000;
const NAVIGATION_RESULT_POLL_INTERVAL_MS = 100;
const NAVIGATION_RESULTS = new Set<NavigationResult>([
  'opened',
  'invalid-request',
  'project-not-found',
  'target-not-found',
  'outside-project',
  'timeout',
]);
