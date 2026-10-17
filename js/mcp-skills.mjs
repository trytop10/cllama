/**
 * Automatic Skills derived from MCP servers ("auto Skill").
 *
 * A server configured with `autoSkill: true` gets a Skill without the user
 * creating one by hand. The Skill is **never stored** in DB_KEY.skillList: it is
 * rebuilt from the server list + the tools that `js/mcp.mjs` registered during
 * this page's lifetime (see chat/chat.js). That keeps everything in sync for
 * free — deleting/disabling/renaming a server (or the server adding tools)
 * needs no migration, and the Skill management page never shows an entry the
 * user did not create.
 *
 * Rules baked in here (deliberate, not accidental):
 * - `manualOnly: true`  — Auto mode never injects it; the user picks it in the
 *   "/" picker (or types "/<name>"), which is its only entry point.
 * - `hidden: true`      — a marker for "not a user-created Skill"; it must NOT
 *   be used to filter the "/" picker, otherwise the Skill becomes unusable.
 * - Destructive / write tools are NOT blocked: server annotations are hints and
 *   are frequently wrong (e.g. a clock tool marked destructive). Every MCP call
 *   already goes through the side-effect confirmation gate, which is the real
 *   safety boundary; the prompt marks such tools so the model warns the user.
 * - `tools` are read from the already-registered registry (passed in), never by
 *   probing the server again: deriving a Skill costs no network request.
 *
 * Pure functions, zero imports, so `tools/mcp-skills.test.mjs` can run them in
 * Node. Unknown fields are ignored rather than rejected.
 */

/** Skill ids of derived MCP Skills are `mcp:<serverId>`. */
export const MCP_SKILL_PREFIX = 'mcp:';

/** Upper bound for tool names listed in the generated description. */
export const MCP_SKILL_DESC_TOOLS_MAX = 6;

/** Upper bound for tools listed in the generated prompt (keeps it small). */
export const MCP_SKILL_PROMPT_TOOLS_MAX = 60;

/** Derived UI-group Skills are `mcp:<serverId>:ui:<slug>-<hash>`. */
export const MCP_SKILL_UI_SEPARATOR = ':ui:';

/** A UI group needs at least this many tools to be worth its own Skill. */
export const MCP_SKILL_UI_GROUP_MIN_TOOLS = 2;

/** Cap on UI-group Skills per server (the "/" picker must stay usable). */
export const MCP_SKILL_UI_GROUPS_MAX = 12;

/** Max characters of a server-supplied tool description kept in the prompt. */
export const MCP_SKILL_TOOL_DESC_MAX = 200;

/** Max characters of the description given to the model for one MCP tool. */
export const MCP_TOOL_DESCRIPTION_MAX = 600;

/**
 * Build the description the model sees for an MCP tool.
 *
 * Only server-provided facts are used — nothing is translated or invented:
 * `annotations.title`, the raw description, the parameter names (with `*` for
 * required) and the read-only / destructive hints. A model choosing between
 * many similar tools needs exactly this, and `list_tools` / the Skill editor
 * show the same text.
 *
 * @param {string} serverName - MCP server name
 * @param {Object} tool - Tool entry from `tools/list`
 * @returns {string} Description text
 */
export function mcpToolDescription(serverName, tool) {
  const name = String(serverName ?? '').trim();
  // Newer MCP servers put the human-readable title at the tool's top level
  // (`title`), older ones inside `annotations.title`; accept both.
  const title = String(tool?.title ?? tool?.annotations?.title ?? '').trim();
  const raw = String(tool?.description ?? '').trim();

  let text = `[MCP:${name}]`;
  if (title) {
    text += ` ${title}${raw && raw !== title ? `: ${raw}` : ''}`;
  } else {
    text += ` ${raw || String(tool?.name || '')}`;
  }

  const schema = tool?.inputSchema || tool?.parameters || {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props);
  if (keys.length) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const params = keys
      .map((key) => `${key}${required.has(key) ? '*' : ''} (${props[key]?.type || 'string'})`)
      .join(', ');
    text += ` Parameters: ${params}.`;
  }

  const flags = [];
  if (tool?.annotations?.readOnlyHint === true) flags.push('read-only');
  if (tool?.annotations?.destructiveHint === true) flags.push('destructive');
  if (flags.length) text += ` [${flags.join(', ')}]`;

  return text.length > MCP_TOOL_DESCRIPTION_MAX
    ? `${text.slice(0, MCP_TOOL_DESCRIPTION_MAX - 1)}…`
    : text;
}

/**
 * Build the Skill id for an MCP server.
 * @param {string|number} serverId - Server id from DB_KEY.mcpServers
 * @returns {string} e.g. "mcp:mcp_1700000000000"
 */
export function mcpSkillId(serverId) {
  return `${MCP_SKILL_PREFIX}${String(serverId ?? '')}`;
}

/**
 * Whether an id belongs to a derived MCP Skill.
 * @param {string|number} id - Skill id
 * @returns {boolean}
 */
export function isMcpSkillId(id) {
  return typeof id === 'string' && id.startsWith(MCP_SKILL_PREFIX);
}

/**
 * Extract the server id from a derived Skill id.
 * @param {string} id - Skill id ("mcp:<serverId>")
 * @returns {string|null} The server id, or null when the id is not an MCP one
 */
export function serverIdFromSkillId(id) {
  if (!isMcpSkillId(id)) return null;
  const rest = id.slice(MCP_SKILL_PREFIX.length);
  const cut = rest.indexOf(MCP_SKILL_UI_SEPARATOR);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

/**
 * Flatten a server-supplied description to one bounded line: prompts are plain
 * text, and a multi-line description would break the bullet list.
 * @param {string} text - Raw description
 * @returns {string} Single-line, trimmed, length-capped text
 */
export function oneLine(text) {
  const flat = String(text ?? '')
    // A server description must never be rewritten by applySkillArguments(),
    // which substitutes `$ARGUMENTS` / `$1` in a Skill prompt. Dropping the
    // dollar keeps the meaning and is invisible to the model otherwise.
    .replace(/\$(ARGUMENTS|\d+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MCP_SKILL_TOOL_DESC_MAX
    ? `${flat.slice(0, MCP_SKILL_TOOL_DESC_MAX - 1)}…`
    : flat;
}

/**
 * Whether a tool may change data destructively, according to the registry /
 * the server's annotations. This is a WARNING marker, not a block: annotations
 * are hints (and often wrong), and every MCP call is confirmed by the user.
 * @param {Object} tool - Registered tool object
 * @returns {boolean}
 */
export function isDestructiveTool(tool) {
  if (!tool) return false;
  if (tool.sideEffect === 'write') return true;
  return tool.annotations?.destructiveHint === true;
}

/**
 * Tools registered for one server (matched by the `serverName` field mcp.mjs
 * stamps on every tool).
 * @param {string} serverName - Server name
 * @param {Array<Object>} tools - All registered tools
 * @returns {Array<Object>} This server's tools
 */
function ownToolsFor(serverName, tools) {
  const wanted = String(serverName ?? '').trim().toLowerCase();
  if (!wanted) return [];
  return (Array.isArray(tools) ? tools : []).filter((t) =>
    t && t.name && t.serverName && String(t.serverName).trim().toLowerCase() === wanted
  );
}

/**
 * The `ui://` resource a registry tool declares, if any.
 * @param {Object} tool - Registered tool
 * @returns {string} Resource URI or ''
 */
export function uiResourceOfTool(tool) {
  return String(tool?.ui?.resourceUri || '').trim();
}

/**
 * Human-readable label for a UI resource.
 *
 * The last path segment is used, but a file name is never a label: most MCP
 * Apps ship `ui://<app>/index.html`, so taking the raw last segment would give
 * every app the same name ("index.html"). `index.*` falls back to the parent
 * directory, other file names lose their extension.
 * (`ui://todo/index.html` → `todo`, `ui://aaa/dashboard` → `dashboard`)
 * @param {string} uri - Resource URI
 * @returns {string} Label
 */
export function uiGroupLabel(uri) {
  const raw = String(uri || '').trim();
  const parts = raw.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  let last = parts.pop() || '';
  if (/^index\.[A-Za-z0-9]+$/i.test(last)) {
    last = parts.pop() || last;
  } else {
    last = last.replace(/\.[A-Za-z0-9]+$/, '');
  }
  try {
    return decodeURIComponent(last) || raw;
  } catch (e) {
    return last || raw;
  }
}

/**
 * Short stable hash (base36), used to keep ids and labels unique.
 * @param {string} text - Input
 * @returns {string} 6 characters
 */
function shortHash(text) {
  let hash = 5381;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(-6);
}

/**
 * Stable id of a UI-group Skill. Derived from the URI (not from an index), so
 * adding or removing tools never re-points a conversation's remembered choice.
 * @param {string} serverId - Server id
 * @param {string} uri - `ui://` resource
 * @returns {string} Skill id
 */
export function mcpUiGroupSkillId(serverId, uri) {
  const slug = String(uiGroupLabel(uri))
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'app';
  return `${mcpSkillId(serverId)}${MCP_SKILL_UI_SEPARATOR}${slug}-${shortHash(uri)}`;
}

/**
 * Build the English prompt of a derived Skill: the tool list IS the content, so
 * the model sees exactly which names it may call and what they do.
 * @param {string} serverName - MCP server name
 * @param {Array<{name:string,description:string}>} allowed - Callable tools
 * @param {Array<{name:string,description:string}>} sensitive - Tools that may change data
 * @param {Object} [options] - { appLabel } when this Skill covers one UI group
 * @returns {string} Prompt text
 */
export function buildMcpSkillPrompt(serverName, allowed, sensitive, options = {}) {
  const lines = [];
  lines.push(`You are connected to the MCP server "${serverName}". Its tools are listed below.`);
  if (options.appLabel) {
    lines.push(`This Skill covers only the "${options.appLabel}" app of that server. Other apps have their own Skills.`);
  }
  lines.push('');
  lines.push('When the request needs data or an action that one of these tools can provide, call the tool instead of guessing. Pick the most specific tool, pass only the arguments it declares, and base your answer on what the tool actually returned.');
  lines.push('');
  lines.push('Available tools:');
  for (const tool of allowed) {
    lines.push(`- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`);
  }

  if (sensitive.length) {
    lines.push('');
    lines.push('These tools may change or delete data. Every call needs the user\'s explicit confirmation, and you must report exactly what the tool result says:');
    for (const tool of sensitive) {
      lines.push(`- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`);
    }
    lines.push('Never claim a change happened unless the result confirms it, and ask before choosing one of these tools when the request is ambiguous.');
  }

  lines.push('');
  lines.push('Never claim a tool succeeded unless its result says so, and quote concrete values (numbers, ids, dates) from the result.');
  return lines.join('\n');
}

/**
 * Build one derived Skill from a set of tools.
 * @param {Object} options - { serverId, serverName, own, id, name, appLabel }
 * @returns {Object} Skill
 */
function buildSkillVariant({ serverId, serverName, own, id, name, appLabel }) {
  const allowed = [];
  const sensitive = [];
  const serialized = [];
  for (const tool of own) {
    const item = { name: tool.name, description: oneLine(tool.description) };
    // Everything stays callable: the confirmation gate is the safety boundary.
    // Destructive-looking tools are only flagged so the model warns the user.
    if (isDestructiveTool(tool)) sensitive.push(item);
    allowed.push(item);
    serialized.push({ name: tool.name });
  }

  const promptAllowed = allowed.slice(0, MCP_SKILL_PROMPT_TOOLS_MAX);
  const omitted = allowed.length - promptAllowed.length;
  let prompt = buildMcpSkillPrompt(serverName, promptAllowed, sensitive, { appLabel });
  if (omitted > 0) {
    prompt += `\n\n(${omitted} more tool${omitted === 1 ? '' : 's'} of this server are available but not listed; call list_tools if you need their exact names.)`;
  }

  const names = allowed.slice(0, MCP_SKILL_DESC_TOOLS_MAX).map((t) => t.name);
  const more = allowed.length > names.length ? ', …' : '';
  const scope = appLabel ? ` (app "${appLabel}")` : '';
  const description = names.length
    ? `Tools of the MCP server "${serverName}"${scope}: ${names.join(', ')}${more}.`
    : `Tools of the MCP server "${serverName}"${scope}.`;

  return {
    id,
    name,
    description,
    prompt,
    // Tools of this variant; destructive/write ones are blocked by default.
    tools: serialized,
    // User-only invocation (Auto mode never injects it) — see the module doc.
    manualOnly: true,
    // Marker: not a user-created Skill. Never filter the "/" picker with it.
    hidden: true,
    source: 'mcp',
    serverId,
    serverName,
    ...(appLabel ? { appLabel } : {})
  };
}

/**
 * Build the Skill for one MCP server.
 * @param {Object} server - Server entry from DB_KEY.mcpServers
 * @param {Array<Object>} tools - All registered tools (from listTools())
 * @returns {Object|null} The Skill, or null when this server must not expose one
 */
export function buildMcpSkill(server, tools) {
  if (!server || server.autoSkill !== true || server.enabled === false) return null;
  const serverId = server.id === undefined || server.id === null ? '' : String(server.id).trim();
  const serverName = String(server.name ?? '').trim();
  if (!serverId || !serverName) return null;

  const own = ownToolsFor(serverName, tools);
  if (!own.length) return null;

  return buildSkillVariant({
    serverId,
    serverName,
    own,
    id: mcpSkillId(serverId),
    name: serverName
  });
}

/**
 * Build one Skill per `ui://` app of a server ("dashboard", "editor", …).
 *
 * This is the deterministic way to shrink the model's choice from "all 20
 * tools" to "the 3 tools of the app the user picked". Rules:
 * - only tools that declare a `ui://` resource are grouped;
 * - a group needs at least MCP_SKILL_UI_GROUP_MIN_TOOLS tools (a one-tool app
 *   gains nothing over the full set);
 * - with a single group the split changes nothing, so no group Skills at all;
 * - at most MCP_SKILL_UI_GROUPS_MAX groups, so the "/" picker stays usable.
 *
 * @param {Object} server - Server entry from DB_KEY.mcpServers
 * @param {Array<Object>} tools - All registered tools (from listTools())
 * @returns {Array<Object>} Group Skills (empty when splitting adds no value)
 */
export function buildMcpUiGroupSkills(server, tools) {
  if (!server || server.autoSkill !== true || server.enabled === false) return [];
  const serverId = server.id === undefined || server.id === null ? '' : String(server.id).trim();
  const serverName = String(server.name ?? '').trim();
  if (!serverId || !serverName) return [];

  const groups = new Map();
  for (const tool of ownToolsFor(serverName, tools)) {
    const uri = uiResourceOfTool(tool);
    if (!uri) continue;
    if (!groups.has(uri)) groups.set(uri, []);
    groups.get(uri).push(tool);
  }

  const entries = [...groups.entries()]
    .filter(([, list]) => list.length >= MCP_SKILL_UI_GROUP_MIN_TOOLS)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, MCP_SKILL_UI_GROUPS_MAX);

  // A single app is the whole server: splitting it would only add a row.
  if (entries.length < 2) return [];

  const labelCounts = new Map();
  for (const [uri] of entries) {
    const label = uiGroupLabel(uri);
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  return entries.map(([uri, list]) => {
    const base = uiGroupLabel(uri);
    const label = (labelCounts.get(base) || 0) > 1 ? `${base} (${shortHash(uri)})` : base;
    return buildSkillVariant({
      serverId,
      serverName,
      own: list,
      id: mcpUiGroupSkillId(serverId, uri),
      name: `${serverName} · ${label}`,
      appLabel: label
    });
  });
}

/**
 * Build every derived Skill for the current configuration.
 *
 * Servers whose names collide are skipped: tool names are prefixed with the
 * server *name* (`mcp_<server>_<tool>`), so two servers sharing a name would
 * produce a Skill pointing at the wrong tools.
 *
 * @param {Array<Object>} servers - Server entries from DB_KEY.mcpServers
 * @param {Array<Object>} tools - All registered tools (from listTools())
 * @returns {{skills: Array<Object>, skipped: Array<{server: Object, reason: string}>}}
 */
export function buildMcpSkills(servers, tools) {
  const list = Array.isArray(servers) ? servers : [];
  const nameCounts = new Map();
  for (const server of list) {
    if (!server || server.autoSkill !== true || server.enabled === false) continue;
    const key = String(server.name ?? '').trim().toLowerCase();
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  const skills = [];
  const skipped = [];
  for (const server of list) {
    if (!server || server.autoSkill !== true) continue;
    if (server.enabled === false) {
      skipped.push({ server, reason: 'disabled' });
      continue;
    }
    const key = String(server.name ?? '').trim().toLowerCase();
    if (key && nameCounts.get(key) > 1) {
      skipped.push({ server, reason: 'duplicate-name' });
      continue;
    }
    const skill = buildMcpSkill(server, tools);
    if (skill) {
      // The full set comes first (the "not sure which app" fallback), followed
      // by one Skill per ui:// app so the model only chooses between a few.
      skills.push(skill);
      skills.push(...buildMcpUiGroupSkills(server, tools));
    } else {
      skipped.push({ server, reason: 'no-tools' });
    }
  }
  return { skills, skipped };
}

