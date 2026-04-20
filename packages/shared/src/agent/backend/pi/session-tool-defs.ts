/**
 * Pi Session Tool Proxy Definitions
 *
 * Thin wrapper around the canonical tool definitions in @craft-agent/session-tools-core.
 * Adds the `mcp__session__` prefix that the Pi SDK expects.
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';

export type SessionToolProxyDef = JsonSchemaToolDef;

export { SESSION_TOOL_NAMES };

function relaxPiMetadataSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = { ...inputSchema } as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  const properties = { ...(schema.properties ?? {}) };
  if ('_displayName' in properties && !('displayName' in properties)) {
    properties.displayName = properties._displayName;
  }
  if ('_intent' in properties) {
    if (!('intent' in properties)) properties.intent = properties._intent;
    if (!('intention' in properties)) properties.intention = properties._intent;
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter(key => key !== '_displayName' && key !== '_intent')
    : undefined;

  return {
    ...schema,
    properties,
    ...(required ? { required } : {}),
  };
}

export function getSessionToolProxyDefs(): SessionToolProxyDef[] {
  return getToolDefsAsJsonSchema({
    prefix: 'mcp__session__',
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
  }).map(def => ({
    ...def,
    inputSchema: relaxPiMetadataSchema(def.inputSchema),
  }));
}
