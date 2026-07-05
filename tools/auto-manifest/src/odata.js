'use strict';
/**
 * OData/CSDL connector — generates a Fiodos manifest DRAFT from a closed
 * third-party system's $metadata document (Dynamics 365 / Dataverse, SAP OData,
 * any OData v4 service) instead of source code.
 *
 * This is the "closed software" analysis mode: the system's own schema is the
 * source of truth (Microsoft documents $metadata as exactly that), so there is
 * nothing to hallucinate — every generated action maps 1:1 to an Action/
 * Function/EntitySet that exists in the document. NO source code and NO LLM
 * are involved; the output is a mechanical draft the integrator curates in the
 * dashboard (same "draft for human review" doctrine as the code analyzer).
 *
 * Execution model: each generated action carries a declarative `execution`
 * block (ApiExecutionSpec of @fiodos/core). At runtime the embedded orb turns
 * those into real calls via buildApiActionRegistries — the client writes no
 * handler code. Credentials NEVER appear here: execution.authRef names a
 * runtime-registered auth provider.
 *
 * Usage (wired from index.js):
 *   fiodos from-odata <metadata.xml | https://org/api/data/v9.2/$metadata>
 *     --app-id com.acme.dynamics --app-name "Acme Dynamics"
 *     [--entities accounts,contacts]   CRUD skeletons for these entity sets
 *     [--auth-ref dataverse]           auth provider name (default 'default')
 *     [--out <dir>] [--publish --api-key fyd_… [--api-url …]]
 *
 * Parsing note: CSDL is machine-generated, well-formed XML; this module uses a
 * small tag scanner (no XML dependency) that extracts only the subset needed
 * (EntityType/EntitySet/Action/Function). Anything it cannot understand is
 * SKIPPED and recorded in provenance — never guessed.
 */

const fs = require('fs');
const path = require('path');

// ── tiny CSDL tag scanner ─────────────────────────────────────────────────────

/** Attribute string → { name: value } (handles single/double quotes). */
function parseAttrs(tag) {
  const attrs = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  return attrs;
}

/**
 * Extract all elements named `tag` as { attrs, inner }. Handles both block
 * (`<Tag …>…</Tag>`) and self-closing (`<Tag …/>`) forms.
 */
function extractElements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    out.push({ attrs: parseAttrs(m[1] || ''), inner: m[3] || '' });
  }
  return out;
}

/** Parse the CSDL subset we need. Returns null when it doesn't look like CSDL. */
function parseCsdl(xml) {
  const schemas = extractElements(xml, 'Schema');
  if (!schemas.length) return null;
  // Dataverse uses one namespace (Microsoft.Dynamics.CRM); SAP splits schemas.
  // We take the first namespace that declares operations/types as primary.
  const namespace =
    (schemas.find((s) => /<(Action|Function|EntityType)\b/.test(s.inner)) || schemas[0])
      .attrs.Namespace || '';

  const entityTypes = {};
  for (const et of extractElements(xml, 'EntityType')) {
    const name = et.attrs.Name;
    if (!name) continue;
    const keyRefs = extractElements(et.inner, 'PropertyRef').map((k) => k.attrs.Name);
    const properties = extractElements(et.inner, 'Property').map((p) => ({
      name: p.attrs.Name,
      type: p.attrs.Type || 'Edm.String',
      nullable: p.attrs.Nullable !== 'false',
    }));
    entityTypes[name] = { name, keys: keyRefs.filter(Boolean), properties };
  }

  const entitySets = extractElements(xml, 'EntitySet')
    .map((es) => ({ name: es.attrs.Name, entityType: es.attrs.EntityType || '' }))
    .filter((es) => es.name);

  const readOps = (tag) =>
    extractElements(xml, tag).map((op) => ({
      name: op.attrs.Name,
      isBound: op.attrs.IsBound === 'true',
      parameters: extractElements(op.inner, 'Parameter').map((p) => ({
        name: p.attrs.Name,
        type: p.attrs.Type || 'Edm.String',
        nullable: p.attrs.Nullable !== 'false',
      })),
    }));

  return {
    namespace,
    entityTypes,
    entitySets,
    actions: readOps('Action').filter((a) => a.name),
    functions: readOps('Function').filter((f) => f.name),
  };
}

// ── Edm → manifest mapping helpers ───────────────────────────────────────────

const EDM_NUMBER = new Set([
  'Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Decimal', 'Edm.Double', 'Edm.Single', 'Edm.Byte',
]);

function edmToParamType(edm) {
  if (edm === 'Edm.Boolean') return 'boolean';
  if (EDM_NUMBER.has(edm)) return 'number';
  return 'string'; // String, Guid, DateTimeOffset, enums… all travel as strings
}

/** True for Edm primitives we can ask the LLM to fill; entity refs are not. */
function isPrimitiveEdm(edm) {
  return typeof edm === 'string' && edm.startsWith('Edm.');
}

function snake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

function humanize(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/** Heuristic: operations whose name suggests destruction get double confirmation. */
function isDestructiveName(name) {
  return /delete|remove|cancel|close|deactivate|terminate|revoke/i.test(name);
}

/** EntitySet whose EntityType matches `ns.TypeName` (bound-operation targets). */
function entitySetForType(model, qualifiedType) {
  const bare = qualifiedType.replace(/^Collection\(|\)$/g, '');
  return model.entitySets.find(
    (es) => es.entityType === bare || es.entityType.endsWith(`.${bare.split('.').pop()}`),
  );
}

// ── manifest generation ──────────────────────────────────────────────────────

function baseAction({ intent, label, handler, confirm, destructive, description }) {
  const action = {
    intent,
    label,
    category: 'api',
    handler,
    requireConfirmation: confirm,
    parameters: {},
    examples: [label.toLowerCase(), `please ${label.toLowerCase()}`],
    ...(description ? { description } : {}),
  };
  if (confirm) {
    action.confirmationMessageTemplate = `Do you want to ${label.toLowerCase()}?`;
    if (destructive) {
      action.doubleConfirmation = true;
      action.voiceConfirmation = 'strict';
    }
  }
  return action;
}

/** OData Action (write) → manifest action with execution template. */
function actionFromODataAction(op, model, authRef, skipped) {
  const ns = model.namespace;
  let url;
  const parameters = {};
  const body = {};
  let opParams = op.parameters;

  if (op.isBound) {
    const binding = op.parameters[0];
    if (!binding) {
      skipped.push({ kind: 'Action', name: op.name, reason: 'bound action without binding parameter' });
      return null;
    }
    opParams = op.parameters.slice(1);
    const set = entitySetForType(model, binding.type);
    if (!set) {
      skipped.push({ kind: 'Action', name: op.name, reason: `no EntitySet found for binding type ${binding.type}` });
      return null;
    }
    if (binding.type.startsWith('Collection(')) {
      url = `{baseUrl}/${set.name}/${ns}.${op.name}`;
    } else {
      parameters.targetId = {
        type: 'string',
        required: true,
        description: `ID (GUID) of the target record in ${set.name}`,
      };
      url = `{baseUrl}/${set.name}({targetId})/${ns}.${op.name}`;
    }
  } else {
    url = `{baseUrl}/${op.name}`;
  }

  for (const p of opParams) {
    if (!p.name) continue;
    if (!isPrimitiveEdm(p.type)) {
      // Entity-typed parameters need integrator curation (JSON with @odata.type);
      // a mechanical draft must not invent that shape.
      skipped.push({ kind: 'ActionParameter', name: `${op.name}.${p.name}`, reason: `non-primitive type ${p.type} — curate manually` });
      continue;
    }
    parameters[p.name] = {
      type: edmToParamType(p.type),
      required: !p.nullable,
      description: `${humanize(p.name)} (${p.type})`,
    };
    body[p.name] = `{${p.name}}`;
  }

  const label = humanize(op.name);
  const action = baseAction({
    intent: snake(op.name),
    label,
    handler: `api:${op.name}`,
    confirm: true, // OData Actions change data by definition — always confirm
    destructive: isDestructiveName(op.name),
    description: `OData action ${model.namespace}.${op.name}`,
  });
  action.parameters = parameters;
  action.execution = {
    kind: 'http',
    method: 'POST',
    url,
    ...(Object.keys(body).length ? { body } : {}),
    ...(authRef ? { authRef } : {}),
  };
  return action;
}

/** OData Function (read) → manifest action (GET, no confirmation). */
function actionFromODataFunction(op, model, authRef, skipped) {
  if (op.isBound) {
    skipped.push({ kind: 'Function', name: op.name, reason: 'bound functions not auto-generated — curate manually' });
    return null;
  }
  const parameters = {};
  const segments = [];
  for (const p of op.parameters) {
    if (!p.name) continue;
    if (!isPrimitiveEdm(p.type)) {
      skipped.push({ kind: 'Function', name: op.name, reason: `non-primitive parameter ${p.name} (${p.type})` });
      return null;
    }
    parameters[p.name] = {
      type: edmToParamType(p.type),
      required: !p.nullable,
      description: `${humanize(p.name)} (${p.type})`,
    };
    // OData literal syntax: strings quoted, other primitives bare.
    segments.push(p.type === 'Edm.String' ? `${p.name}='{${p.name}}'` : `${p.name}={${p.name}}`);
  }
  const label = humanize(op.name);
  const action = baseAction({
    intent: snake(op.name),
    label,
    handler: `api:${op.name}`,
    confirm: false,
    destructive: false,
    description: `OData function ${model.namespace}.${op.name} (read-only)`,
  });
  action.parameters = parameters;
  action.execution = {
    kind: 'http',
    method: 'GET',
    url: `{baseUrl}/${op.name}(${segments.join(',')})`,
    ...(authRef ? { authRef } : {}),
  };
  return action;
}

const MAX_CRUD_PROPS = 8;

/** CRUD skeletons for one requested entity set (create/update/delete/get). */
function crudActionsForSet(set, model, authRef, skipped) {
  const typeName = set.entityType.split('.').pop();
  const type = model.entityTypes[typeName];
  if (!type) {
    skipped.push({ kind: 'EntitySet', name: set.name, reason: `EntityType ${set.entityType} not found in metadata` });
    return [];
  }
  const keySet = new Set(type.keys);
  const writable = type.properties
    .filter((p) => p.name && isPrimitiveEdm(p.type) && !keySet.has(p.name) && !p.name.startsWith('_'))
    .slice(0, MAX_CRUD_PROPS);
  const propParams = (required) =>
    Object.fromEntries(
      writable.map((p) => [
        p.name,
        {
          type: edmToParamType(p.type),
          required: required && !p.nullable,
          description: `${humanize(p.name)} (${p.type})`,
        },
      ]),
    );
  const propBody = Object.fromEntries(writable.map((p) => [p.name, `{${p.name}}`]));
  const idParam = {
    id: { type: 'string', required: true, description: `ID (GUID) of the ${typeName} record` },
  };
  const label = humanize(set.name);

  const create = baseAction({
    intent: `create_${snake(typeName)}`,
    label: `Create a ${humanize(typeName).toLowerCase()}`,
    handler: `api:create_${set.name}`,
    confirm: true,
    destructive: false,
    description: `Create a record in ${label}`,
  });
  create.parameters = propParams(true);
  create.execution = {
    kind: 'http', method: 'POST', url: `{baseUrl}/${set.name}`,
    body: propBody, ...(authRef ? { authRef } : {}),
  };

  const update = baseAction({
    intent: `update_${snake(typeName)}`,
    label: `Update a ${humanize(typeName).toLowerCase()}`,
    handler: `api:update_${set.name}`,
    confirm: true,
    destructive: false,
    description: `Update a record in ${label}`,
  });
  update.parameters = { ...idParam, ...propParams(false) };
  update.execution = {
    kind: 'http', method: 'PATCH', url: `{baseUrl}/${set.name}({id})`,
    body: propBody, ...(authRef ? { authRef } : {}),
  };

  const del = baseAction({
    intent: `delete_${snake(typeName)}`,
    label: `Delete a ${humanize(typeName).toLowerCase()}`,
    handler: `api:delete_${set.name}`,
    confirm: true,
    destructive: true,
    description: `Delete a record from ${label} (irreversible)`,
  });
  del.parameters = idParam;
  del.execution = {
    kind: 'http', method: 'DELETE', url: `{baseUrl}/${set.name}({id})`,
    ...(authRef ? { authRef } : {}),
  };

  const get = baseAction({
    intent: `get_${snake(typeName)}`,
    label: `Look up a ${humanize(typeName).toLowerCase()}`,
    handler: `api:get_${set.name}`,
    confirm: false,
    destructive: false,
    description: `Read one record from ${label}`,
  });
  get.parameters = idParam;
  get.execution = {
    kind: 'http', method: 'GET', url: `{baseUrl}/${set.name}({id})`,
    ...(authRef ? { authRef } : {}),
  };

  // Update body params that stay optional must not break on missing values, so
  // the update template only ships properties the integrator confirms. The
  // mechanical draft keeps them but flags it for curation.
  skipped.push({
    kind: 'Curation',
    name: set.name,
    reason: `update_${snake(typeName)} sends all ${writable.length} template properties — trim unused ones in the dashboard before publishing`,
  });

  return [create, update, del, get];
}

/**
 * Build the AppManifest draft from a CSDL document.
 * Returns { manifest, provenance }.
 */
function buildManifestFromCsdl(xml, opts) {
  const model = parseCsdl(xml);
  if (!model) {
    throw new Error('The document does not look like an OData CSDL $metadata (no <Schema> found)');
  }
  const skipped = [];
  const authRef = opts.authRef || 'default';
  const actions = [];

  for (const op of model.actions) {
    const a = actionFromODataAction(op, model, authRef, skipped);
    if (a) actions.push(a);
  }
  for (const op of model.functions) {
    const a = actionFromODataFunction(op, model, authRef, skipped);
    if (a) actions.push(a);
  }
  const requestedSets = (opts.entities || [])
    .map((name) => model.entitySets.find((es) => es.name.toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
  for (const set of requestedSets) {
    actions.push(...crudActionsForSet(set, model, authRef, skipped));
  }
  for (const name of opts.entities || []) {
    if (!model.entitySets.some((es) => es.name.toLowerCase() === name.toLowerCase())) {
      skipped.push({ kind: 'EntitySet', name, reason: 'requested with --entities but not present in metadata' });
    }
  }

  // De-duplicate intents (overloaded bound actions produce name collisions).
  const seen = new Set();
  const unique = [];
  for (const a of actions) {
    if (seen.has(a.intent)) {
      skipped.push({ kind: 'Duplicate', name: a.intent, reason: 'duplicate intent (overloaded operation) — kept first definition' });
      continue;
    }
    seen.add(a.intent);
    unique.push(a);
  }

  const manifest = {
    appId: opts.appId,
    appName: opts.appName,
    appDescription:
      opts.appDescription ||
      `${opts.appName} — actions generated from the system's OData schema (${model.namespace}).`,
    appType: 'third-party system (OData)',
    appFlow:
      'The agent operates over a closed third-party system through its OData API: ' +
      'read operations answer questions; write operations always ask for confirmation first.',
    version: '1.0.0-odata-draft',
    routes: [],
    actions: unique,
    policies: {
      requireConfirmationForDestructive: true,
      allowedWithoutAuth: [],
      contextRetentionTurns: 3,
    },
  };

  const provenance = {
    source: 'odata-metadata',
    namespace: model.namespace,
    counts: {
      csdlActions: model.actions.length,
      csdlFunctions: model.functions.length,
      csdlEntitySets: model.entitySets.length,
      generatedActions: unique.length,
    },
    authRef,
    skipped,
    note:
      'Mechanical draft generated from the OData $metadata — no source code, no LLM. ' +
      'Curate in the dashboard: disable what the orb should not expose, refine labels/examples, ' +
      'and review every confirmation level before publishing.',
  };
  return { manifest, provenance };
}

/** Load the metadata document from a local path or an http(s) URL. */
async function loadMetadata(target, extraHeaders) {
  if (/^https?:\/\//i.test(target)) {
    const res = await fetch(target, { headers: { Accept: 'application/xml', ...extraHeaders } });
    if (!res.ok) throw new Error(`GET ${target} failed: HTTP ${res.status}`);
    return await res.text();
  }
  return fs.readFileSync(path.resolve(target), 'utf8');
}

/**
 * CLI entrypoint for `fiodos from-odata …` (wired from index.js).
 * `io` injects the CLI's own logging + publish so this module stays testable.
 */
async function runFromOData({ target, outDir, opts, io }) {
  const { logUser, logDev, publish } = io;
  logUser('Reading OData $metadata (schema only — no source code involved)…');
  const xml = await loadMetadata(target, opts.headers || {});
  const { manifest, provenance } = buildManifestFromCsdl(xml, opts);

  // Same final gate as the code analyzer: the real @fiodos/core validator.
  let validation = { valid: true, errors: [] };
  try {
    const { validateManifest } = require('@fiodos/core');
    validation = validateManifest(manifest);
  } catch (e) {
    logDev(`[from-odata] core validator unavailable: ${e.message}`);
  }
  provenance.coreValidation = validation;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2));

  logUser(`Draft ready: ${manifest.actions.length} action(s) from ${provenance.namespace}`);
  if (provenance.skipped.length) {
    logUser(`${provenance.skipped.length} item(s) need manual curation — see provenance.json`);
  }
  logDev(`[from-odata] output → ${outDir}`);

  if (!validation.valid) {
    logUser('Draft has validation errors — fix before publishing:');
    for (const err of validation.errors) logUser(`  · ${err}`);
  }

  if (opts.publish) {
    if (!validation.valid) {
      throw new Error('Refusing to publish an invalid manifest (see errors above)');
    }
    await publish(manifest, {
      source: 'odata-metadata',
      generatedAt: new Date().toISOString(),
      routesIncluded: 0,
      actionsIncluded: manifest.actions.length,
    });
  }
  return { manifest, provenance };
}

module.exports = { parseCsdl, buildManifestFromCsdl, runFromOData };
