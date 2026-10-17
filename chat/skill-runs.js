import { i18n, DB_KEY, loadSkillRuns, clearSkillRuns, filterSkillRuns } from "../js/cllama.js";
import { browser } from '../js/browser.mjs';
import { getQueryParam } from "../js/util.js";

let skillRunCache = []; // All audit records; the toolbar filters this list

document.addEventListener('DOMContentLoaded', async () => {
  // Breadcrumb link back to the chat page (keeps the chat scenario id).
  const ccId = getQueryParam("id");
  const crumbChat = document.getElementById('crumbChat');
  if (crumbChat) {
    crumbChat.textContent = browser.i18n.getMessage("chat") || 'Chat';
    crumbChat.href = ccId ? `./chat.html?id=${ccId}` : './chat.html';
  }

  document.getElementById('b_clear_runs').addEventListener('click', async () => {
    await clearSkillRuns();
    renderSkillRuns();
  });
  // Filters apply live (no "apply" button): source, status, Skill and free text.
  ['runFilterOrigin', 'runFilterStatus', 'runFilterSkill'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', renderRunList);
  });
  document.getElementById('runFilterSearch')?.addEventListener('input', renderRunList);
  document.getElementById('b_reset_run_filters')?.addEventListener('click', resetRunFilters);

  await renderSkillRuns();
  document.title = browser.i18n.getMessage('skillRuns') || 'Skill run history';
  i18n();

  // Keep the audit trail live: a chat page in another window may record a run
  // while this page is open.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[DB_KEY.skillRuns]) renderSkillRuns();
  });
});

/**
 * Localized label for an audit action code (used by user/page records and by
 * steps that are UI actions rather than tool names).
 * @param {Object} entry - { action, count }
 * @returns {string} Human-readable label
 */
function runActionLabel(entry = {}) {
  const action = String(entry.action || '');
  if (action === 'parse_drafts') {
    const tpl = browser.i18n.getMessage('skillRunParsedDrafts') || 'Parsed {count} draft(s) from the answer';
    return tpl.replace('{count}', String(entry.count ?? ''));
  }
  const key = {
    import: 'artifactImport',
    import_overwrite: 'artifactImportOverwrite',
    cancel: 'artifactCancel',
    card_stale: 'skillRunCardStale',
    view_failed: 'skillRunViewFailed'
  }[action];
  return (key && browser.i18n.getMessage(key)) || action || 'unknown';
}

/**
 * Localized label for the origin of an audit record. 'model' is intentionally
 * absent: those records are labelled with the Skill name instead.
 */
const ORIGIN_LABELS = {
  user: 'skillRunManual',
  page: 'skillRunPage',
  app: 'skillRunApp'
};

/**
 * Read the audit trail, refresh the filter dropdowns and render the list.
 */
async function renderSkillRuns() {
  skillRunCache = await loadSkillRuns();
  renderRunSkillOptions();
  renderRunList();
}

/**
 * Fill the "Skill" filter with the Skills that actually appear in the trail,
 * keeping the current selection when it is still available.
 */
function renderRunSkillOptions() {
  const select = document.getElementById('runFilterSkill');
  if (!select) return;
  const previous = select.value || 'all';
  select.innerHTML = '';

  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = browser.i18n.getMessage('skillRunFilterAllSkills') || 'All Skills';
  select.appendChild(all);

  const names = [...new Set(skillRunCache.map((r) => r.skillName).filter(Boolean))].sort();
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = names.includes(previous) ? previous : 'all';
}

/**
 * Current filter values from the toolbar.
 * @returns {Object} { origin, status, skill, query }
 */
function readRunFilters() {
  return {
    origin: document.getElementById('runFilterOrigin')?.value || 'all',
    status: document.getElementById('runFilterStatus')?.value || 'all',
    skill: document.getElementById('runFilterSkill')?.value || 'all',
    query: document.getElementById('runFilterSearch')?.value || ''
  };
}

/**
 * Reset the toolbar to "show everything".
 */
function resetRunFilters() {
  const origin = document.getElementById('runFilterOrigin');
  const status = document.getElementById('runFilterStatus');
  const skill = document.getElementById('runFilterSkill');
  const search = document.getElementById('runFilterSearch');
  if (origin) origin.value = 'all';
  if (status) status.value = 'all';
  if (skill) skill.value = 'all';
  if (search) search.value = '';
  renderRunList();
}

/**
 * Apply the filters and render the matching records (newest first).
 */
function renderRunList() {
  const container = document.getElementById('skillRunsContainer');
  if (!container) return;
  const count = document.getElementById('runFilterCount');

  if (!skillRunCache.length) {
    // Resolve the text directly (not through the `.i18n` class): this element is
    // created after the one-time i18n() pass, so a raw key would leak through.
    container.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'text-muted small';
    empty.textContent = browser.i18n.getMessage('skillRunsEmpty') || 'No runs recorded yet.';
    container.appendChild(empty);
    if (count) count.textContent = '';
    return;
  }

  const runs = filterSkillRuns(skillRunCache, readRunFilters());
  if (count) {
    const tpl = browser.i18n.getMessage('skillRunFilterCount') || '{shown} / {total}';
    count.textContent = tpl.replace('{shown}', String(runs.length)).replace('{total}', String(skillRunCache.length));
  }

  container.innerHTML = '';
  if (!runs.length) {
    const none = document.createElement('div');
    none.className = 'text-muted small';
    none.textContent = browser.i18n.getMessage('skillRunsNoMatch') || 'No record matches the filter.';
    container.appendChild(none);
    return;
  }

  // Newest first.
  runs.slice().reverse().forEach((run) => {
    const origin = run.origin || 'model';
    const item = document.createElement('div');
    item.className = 'skill-run'
      + (run.status === 'failed' ? ' skill-run-failed' : '')
      + (origin === 'model' ? '' : ` skill-run-${origin}`);

    const head = document.createElement('div');
    head.className = 'skill-run-head';
    const badge = run.status === 'failed' ? '⚠️' : run.status === 'aborted' ? '⏹️'
      : origin === 'model' ? '✅' : origin === 'app' ? '🧩' : '🖐️';
    const when = new Date(run.time).toLocaleString();
    // Runs started by the model show which Skill ran; user/page/app records show
    // the action instead, so the timeline reads "who did what".
    const label = origin === 'model'
      ? (run.skillName || browser.i18n.getMessage('skillRunNoSkill') || 'No Skill')
      : `${browser.i18n.getMessage(ORIGIN_LABELS[origin] || 'skillRunPage') || origin} · ${runActionLabel(run)}`;
    head.textContent = `${badge} ${label} · ${when}`;
    if (origin === 'model' || origin === 'app') head.textContent += ` · ${(run.duration / 1000).toFixed(1)}s`;
    if (run.model) head.textContent += ` · ${run.model}`;
    item.appendChild(head);

    const steps = document.createElement('ul');
    steps.className = 'skill-run-steps';
    (Array.isArray(run.steps) ? run.steps : []).forEach((s) => {
      const li = document.createElement('li');
      li.className = s.ok ? '' : 'skill-run-step-failed';
      const ms = typeof s.ms === 'number' ? ` (${(s.ms / 1000).toFixed(1)}s)` : '';
      li.textContent = `${s.ok ? '✓' : (s.denied ? '🚫' : '✗')} ${runActionLabel({ action: s.tool, count: run.count })}${ms}${s.argsPreview ? ` ${s.argsPreview}` : ''}`;
      if (!s.ok && s.error) {
        const err = document.createElement('div');
        err.className = 'skill-run-error';
        err.textContent = s.error;
        li.appendChild(err);
      }
      steps.appendChild(li);
    });
    if (!steps.children.length) {
      const li = document.createElement('li');
      li.className = 'text-muted';
      li.textContent = browser.i18n.getMessage('skillRunNoSteps') || 'No tool was called.';
      steps.appendChild(li);
    }
    item.appendChild(steps);
    container.appendChild(item);
  });
}

