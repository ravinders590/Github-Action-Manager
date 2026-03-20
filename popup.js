/* ========================================================
   GitHub Action Manager – Popup Logic
   ======================================================== */

document.addEventListener('DOMContentLoaded', init);

// ── DOM References ──────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── State ───────────────────────────────────────────────
let config = { token: '', owner: '', repo: '' };
let branchNames    = [];
let defaultBranch  = 'master';
let latestBranch   = '';
let perPageBranches = 0;    // 0 = fetch all pages; controlled by #branchPerPage select
let perPagePRs      = 50;   // controlled by #prPerPage select
let allPopupRepos   = [];
let popupReposFetched = false;

// ── Init ────────────────────────────────────────────────
async function init() {
  await loadConfig();
  wireUpTabs();
  wireUpSubTabs();
  wireUpSettingsButton();

  if (!config.token || !config.owner || !config.repo) {
    showConfigBar();
    return;
  }

  showRepoBar();
  initRepoPicker();
  await loadBranches();
  await Promise.all([loadOpenPRs(), loadWorkflows(), loadIssues()]);

  // Git Commands tab
  $('#btnGitCreateBranch').addEventListener('click', handleGitCreateBranch);
  $('#btnGitDeleteBranch').addEventListener('click', handleGitDeleteBranch);
  $('#btnGitRenameBranch').addEventListener('click', handleGitRenameBranch);

  // Issues tab
  $('#btnRefreshIssues').addEventListener('click', async () => {
    showLoader('Refreshing issues…');
    await loadIssues();
    hideLoader();
  });
  $('#btnCreateIssue').addEventListener('click', handleCreateIssue);

  // Branch per-page selector
  $('#branchPerPage').addEventListener('change', async () => {
    const val = $('#branchPerPage').value;
    perPageBranches = val === 'all' ? 0 : parseInt(val, 10);
    showLoader('Reloading branches…');
    await loadBranches();
    await loadWorkflows();
    hideLoader();
  });

  // PR per-page selector
  $('#prPerPage').addEventListener('change', async () => {
    const val = $('#prPerPage').value;
    perPagePRs = val === 'all' ? 0 : parseInt(val, 10);
    showLoader('Reloading PRs…');
    await loadOpenPRs();
    hideLoader();
  });

  // PR refresh button (toolbar)
  $('#btnRefreshPRs').addEventListener('click', async () => {
    showLoader('Refreshing PRs…');
    await loadOpenPRs();
    hideLoader();
  });

  $('#btnRefreshWorkflows').addEventListener('click', async () => {
    showLoader('Refreshing workflows…');
    await loadWorkflows();
    hideLoader();
  });
}

// ── Config persistence via chrome.storage ───────────────
function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['ghToken', 'ghOwner', 'ghRepo'],
      (items) => {
        config.token = items.ghToken || '';
        config.owner = items.ghOwner || '';
        config.repo = items.ghRepo || '';
        resolve();
      }
    );
  });
}

// ── UI: Config bar / Repo bar ───────────────────────────
function showConfigBar() {
  $('#configBar').classList.remove('hidden');
  $('#repoBar').classList.add('hidden');
  $('#openSettings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function showRepoBar() {
  $('#configBar').classList.add('hidden');
  $('#repoBar').classList.remove('hidden');
  $('#repoName').textContent = `${config.owner}/${config.repo}`;
}

// ── Repo Picker (inline popup switcher) ─────────────────
function initRepoPicker() {
  const panel = $('#repoPickerPanel');
  const btn   = $('#btnChangeRepo');
  const searchInput = $('#popupRepoSearch');

  btn.addEventListener('click', async () => {
    const isOpen = !panel.classList.contains('hidden');
    if (isOpen) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    searchInput.value = '';
    filterPopupDropdown('');
    searchInput.focus();
    if (!popupReposFetched) await fetchPopupRepos();
  });

  searchInput.addEventListener('input', () => {
    filterPopupDropdown(searchInput.value.trim());
  });

  searchInput.addEventListener('keydown', (e) => {
    const ul    = $('#popupRepoDropdown');
    const items = [...ul.querySelectorAll('.popup-repo-option:not(.popup-repo-no-results)')];
    const active = ul.querySelector('.popup-repo-option.active');
    let idx = items.indexOf(active);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = Math.min(idx + 1, items.length - 1);
      items.forEach((i) => i.classList.remove('active'));
      if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = Math.max(idx - 1, 0);
      items.forEach((i) => i.classList.remove('active'));
      if (items[idx]) { items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) applyPopupRepoSelection(active.dataset.fullName);
    } else if (e.key === 'Escape') {
      panel.classList.add('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#repoPickerPanel') && !e.target.closest('#btnChangeRepo')) {
      panel.classList.add('hidden');
    }
  });
}

async function fetchPopupRepos() {
  setPopupRepoStatus('Fetching repositories\u2026', 'loading');
  try {
    const repos = [];
    let page = 1;
    while (true) {
      const res  = await ghFetch(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `GitHub error ${res.status}`);
      if (!data.length) break;
      repos.push(...data);
      if (data.length < 100) break;
      page++;
    }
    allPopupRepos   = repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
    popupReposFetched = true;
    setPopupRepoStatus('', '');
    filterPopupDropdown($('#popupRepoSearch').value.trim());
  } catch (err) {
    setPopupRepoStatus(`Failed: ${err.message}`, 'error');
  }
}

function setPopupRepoStatus(msg, type) {
  const el = $('#popupRepoStatus');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.className   = `popup-repo-status ${type}`;
  el.classList.remove('hidden');
}

function filterPopupDropdown(query) {
  const ul    = $('#popupRepoDropdown');
  const lower = query.toLowerCase();
  const filtered = query
    ? allPopupRepos.filter((r) => r.full_name.toLowerCase().includes(lower))
    : allPopupRepos;

  ul.innerHTML = '';

  if (!filtered.length) {
    const li = document.createElement('li');
    li.className   = 'popup-repo-option popup-repo-no-results';
    li.textContent = allPopupRepos.length ? `No repos matching \"${query}\"` : 'Loading\u2026';
    ul.appendChild(li);
    return;
  }

  filtered.slice(0, 60).forEach((repo) => {
    const li = document.createElement('li');
    li.className = 'popup-repo-option';
    li.setAttribute('role', 'option');
    li.dataset.fullName = repo.full_name;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'popup-repo-option-name';
    if (query) {
      const idx = repo.full_name.toLowerCase().indexOf(lower);
      nameSpan.innerHTML =
        escapeHtml(repo.full_name.slice(0, idx)) +
        `<mark>${escapeHtml(repo.full_name.slice(idx, idx + query.length))}</mark>` +
        escapeHtml(repo.full_name.slice(idx + query.length));
    } else {
      nameSpan.textContent = repo.full_name;
    }

    const metaSpan = document.createElement('span');
    metaSpan.className   = 'popup-repo-option-meta';
    metaSpan.textContent = [repo.private ? 'private' : 'public', repo.language].filter(Boolean).join(' \u00b7 ');

    li.appendChild(nameSpan);
    li.appendChild(metaSpan);

    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyPopupRepoSelection(repo.full_name);
    });

    ul.appendChild(li);
  });
}

async function applyPopupRepoSelection(fullName) {
  const [owner, repo] = fullName.split('/');
  config.owner = owner;
  config.repo  = repo;
  chrome.storage.sync.set({ ghOwner: owner, ghRepo: repo });
  $('#repoPickerPanel').classList.add('hidden');
  showRepoBar();
  showLoader(`Switching to ${fullName}\u2026`);
  branchNames   = [];
  defaultBranch = 'master';
  latestBranch  = '';
  await loadBranches();
  await Promise.all([loadOpenPRs(), loadWorkflows()]);
  hideLoader();
  toast(`Switched to ${fullName}`, 'success');
}

// ── Tabs navigation ─────────────────────────────────────
function wireUpTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      $$('.tab-content').forEach((tc) => tc.classList.remove('active'));
      $(`#tab${capitalize(tab.dataset.tab)}`).classList.add('active');
    });
  });
}

function wireUpSubTabs() {
  $$('.sub-tab').forEach((st) => {
    st.addEventListener('click', () => {
      const group = st.closest('.tab-content');
      group.querySelectorAll('.sub-tab').forEach((s) => s.classList.remove('active'));
      st.classList.add('active');
      group.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      $(`#panel${capitalize(st.dataset.subtab)}`).classList.add('active');
    });
  });
}

function wireUpSettingsButton() {
  $('#btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// ── Tab name helper ─────────────────────────────────────
function capitalize(str) {
  if (str === 'pr') return 'PR';
  if (str === 'build') return 'Build';
  if (str === 'git') return 'Git';
  if (str === 'issues') return 'Issues';
  if (str === 'createPR') return 'CreatePR';
  if (str === 'mergePR') return 'MergePR';
  if (str === 'gitCreateBranch') return 'GitCreateBranch';
  if (str === 'gitDeleteBranch') return 'GitDeleteBranch';
  if (str === 'gitRenameBranch') return 'GitRenameBranch';
  if (str === 'listIssues') return 'ListIssues';
  if (str === 'createIssue') return 'CreateIssue';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── GitHub API helpers ──────────────────────────────────
function ghFetch(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...options.headers,
  };
  return fetch(url, { ...options, headers });
}

async function ghJSON(path, options = {}) {
  const res = await ghFetch(path, options);
  const data = await res.json();
  if (!res.ok) {
    let msg;
    if (res.status === 401) msg = 'Invalid or expired token — update it in Settings.';
    else if (res.status === 403) msg = 'Access denied. Ensure the token has "repo" and "workflow" scopes.';
    else if (res.status === 404) msg = `Not found — check the Owner / Org and Repository name in Settings.`;
    else msg = data.message || `GitHub API error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Load branches into selects ──────────────────────────
async function loadBranches() {
  try {
    // Fetch branches with dynamic per_page; "all" paginates until exhausted
    let allBranchData = [];
    if (perPageBranches === 0) {
      // Fetch all pages
      let page = 1;
      while (true) {
        const batch = await ghJSON(`/repos/${config.owner}/${config.repo}/branches?per_page=100&page=${page}`);
        allBranchData.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
    } else {
      allBranchData = await ghJSON(`/repos/${config.owner}/${config.repo}/branches?per_page=${perPageBranches}`);
    }

    const [repoData, events] = await Promise.all([
      ghJSON(`/repos/${config.owner}/${config.repo}`),
      ghJSON(`/repos/${config.owner}/${config.repo}/events?per_page=100`).catch(() => []),
    ]);

    const allNames = allBranchData.map((b) => b.name);

    // Determine the repo default branch
    const repoDef = repoData.default_branch || '';
    if (repoDef && allNames.includes(repoDef)) {
      defaultBranch = repoDef;
    } else if (allNames.includes('master')) {
      defaultBranch = 'master';
    } else if (allNames.includes('main')) {
      defaultBranch = 'main';
    } else if (allNames.length) {
      defaultBranch = allNames[0];
    }

    // Extract recently pushed branches from events (most recent first, deduplicated)
    const recentBranches = [];
    for (const ev of events) {
      if (ev.type === 'PushEvent' && ev.payload && ev.payload.ref) {
        const name = ev.payload.ref.replace(/^refs\/heads\//, '');
        if (allNames.includes(name) && !recentBranches.includes(name)) {
          recentBranches.push(name);
        }
      }
    }

    // Latest branch = most recently pushed non-default branch, or default if nothing else
    latestBranch = recentBranches.find((b) => b !== defaultBranch) || recentBranches[0] || defaultBranch;

    // Sort: recently active branches first (in recency order), then the rest alphabetically
    const remainingAlpha = allNames
      .filter((b) => !recentBranches.includes(b))
      .sort((a, b) => a.localeCompare(b));
    branchNames = [...recentBranches, ...remainingAlpha];

    populateSelect('#prBase', branchNames, 'Select base branch', defaultBranch);
    populateSelect('#prHead', branchNames, 'Select compare branch', latestBranch);

    // Populate Git Commands tab branch selects
    populateSelect('#gitBranchBase', branchNames, 'Select source branch', defaultBranch);
    populateSelect('#gitDeleteBranch', branchNames, 'Select branch to delete', '');
    populateSelect('#gitRenameSource', branchNames, 'Select branch to rename', '');
  } catch (err) {
    toast(`Failed to load branches: ${err.message}`, 'error');
  }
}

function populateSelect(selector, items, placeholder, preselect) {
  const el = $(selector);
  el.innerHTML = `<option value="">${placeholder}</option>` +
    items.map((i) => `<option value="${escapeHtml(i)}"${i === preselect ? ' selected' : ''}>${escapeHtml(i)}</option>`).join('');
}

// ── Load open PRs ───────────────────────────────────────
async function loadOpenPRs() {
  try {
    const perPage = perPagePRs === 0 ? 100 : perPagePRs;
    let prs = [];
    if (perPagePRs === 0) {
      // Fetch all pages
      let page = 1;
      while (true) {
        const batch = await ghJSON(`/repos/${config.owner}/${config.repo}/pulls?state=open&per_page=100&page=${page}&sort=updated&direction=desc`);
        prs.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
    } else {
      prs = await ghJSON(`/repos/${config.owner}/${config.repo}/pulls?state=open&per_page=${perPage}&sort=updated&direction=desc`);
    }
    const sel = $('#prList');
    sel.innerHTML = `<option value="">Select a PR to merge (${prs.length} open)</option>` +
      prs.map((pr) => `<option value="${pr.number}">#${pr.number} – ${escapeHtml(pr.title)}</option>`).join('');

    // Store PR data for detail card
    sel._prData = prs;
    sel.addEventListener('change', () => showPRDetail(sel));

    // Update PR count in toolbar
    const countEl = $('#prCount');
    if (countEl) countEl.textContent = `${prs.length} open PR${prs.length !== 1 ? 's' : ''}`;

    // Wire merge button (guard against duplicate listeners)
    const mergeBtn = $('#btnMergePR');
    mergeBtn.replaceWith(mergeBtn.cloneNode(true));
    $('#btnMergePR').addEventListener('click', handleMergePR);

    // Wire close PR button (guard against duplicate listeners)
    const closeBtn = $('#btnClosePR');
    closeBtn.replaceWith(closeBtn.cloneNode(true));
    $('#btnClosePR').addEventListener('click', handleClosePR);
  } catch (err) {
    toast(`Failed to load PRs: ${err.message}`, 'error');
  }
}

function showPRDetail(sel) {
  const num = parseInt(sel.value, 10);
  const card = $('#prDetail');
  if (!num) {
    card.classList.add('hidden');
    $('#btnMergePR').disabled = true;
    $('#btnClosePR').disabled = true;
    return;
  }

  const pr = sel._prData.find((p) => p.number === num);
  if (!pr) return;

  card.querySelector('.pr-number').textContent = `#${pr.number}`;
  card.querySelector('.pr-detail-title').textContent = pr.title;
  card.querySelector('.pr-author').textContent = `by ${pr.user.login}`;
  card.querySelector('.pr-status').textContent = pr.draft ? 'Draft' : 'Open';
  card.querySelector('.pr-head-branch').textContent = pr.head.ref;
  card.querySelector('.pr-base-branch').textContent = pr.base.ref;
  card.classList.remove('hidden');
  $('#btnMergePR').disabled = false;
  $('#btnClosePR').disabled = false;
}

// ── Create PR ───────────────────────────────────────────
$('#btnCreatePR').addEventListener('click', handleCreatePR);

async function handleCreatePR() {
  const base = $('#prBase').value;
  const head = $('#prHead').value;
  const title = $('#prTitle').value.trim();
  const body = $('#prBody').value.trim();

  if (!base || !head) return toast('Please select both base and compare branches.', 'error');
  if (base === head) return toast('Base and compare branches must differ.', 'error');
  if (!title) return toast('PR title is required.', 'error');

  showLoader('Creating Pull Request…');
  try {
    const pr = await ghJSON(`/repos/${config.owner}/${config.repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: body || '', head, base }),
    });
    hideLoader();
    toast(`PR #${pr.number} created successfully!`, 'success');
    // Reset form
    $('#prTitle').value = '';
    $('#prBody').value = '';
  } catch (err) {
    hideLoader();
    toast(`Create PR failed: ${err.message}`, 'error');
  }
}

// ── Close PR ────────────────────────────────────────────
async function handleClosePR() {
  const prNumber = $('#prList').value;
  if (!prNumber) return toast('Select a PR to close.', 'error');

  if (!confirm(`Close PR #${prNumber}?\n\nThis will close the PR without merging.`)) return;

  showLoader(`Closing PR #${prNumber}…`);
  try {
    await ghJSON(`/repos/${config.owner}/${config.repo}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
    hideLoader();
    toast(`PR #${prNumber} closed.`, 'success');
    await loadOpenPRs();
  } catch (err) {
    hideLoader();
    toast(`Close PR failed: ${err.message}`, 'error');
  }
}

// ── Merge PR ────────────────────────────────────────────
async function handleMergePR() {
  const prNumber = $('#prList').value;
  const method = $('#mergeMethod').value;
  if (!prNumber) return toast('Select a PR to merge.', 'error');

  showLoader('Merging Pull Request…');
  try {
    await ghJSON(`/repos/${config.owner}/${config.repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: method }),
    });
    hideLoader();
    toast(`PR #${prNumber} merged successfully!`, 'success');
    // Refresh PRs list
    await loadOpenPRs();
  } catch (err) {
    hideLoader();
    toast(`Merge failed: ${err.message}`, 'error');
  }
}

// ── Git Commands ────────────────────────────────────────
async function handleGitCreateBranch() {
  const base = $('#gitBranchBase').value;
  const name = $('#gitNewBranchName').value.trim();

  if (!base) return toast('Select a source branch.', 'error');
  if (!name) return toast('Enter a name for the new branch.', 'error');
  if (!/^[\w.\-/]+$/.test(name)) return toast('Branch name contains invalid characters.', 'error');

  showLoader(`Creating branch "${name}"…`);
  try {
    // Resolve source branch SHA
    const refData = await ghJSON(`/repos/${config.owner}/${config.repo}/git/ref/heads/${encodeURIComponent(base)}`);
    const sha = refData.object.sha;

    await ghJSON(`/repos/${config.owner}/${config.repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
    });
    hideLoader();
    toast(`Branch "${name}" created from "${base}"!`, 'success');
    $('#gitNewBranchName').value = '';
    await loadBranches();
  } catch (err) {
    hideLoader();
    toast(`Create branch failed: ${err.message}`, 'error');
  }
}

async function handleGitDeleteBranch() {
  const branch = $('#gitDeleteBranch').value;
  if (!branch) return toast('Select a branch to delete.', 'error');

  if (!confirm(`Delete branch "${branch}" from ${config.owner}/${config.repo}?\n\nThis cannot be undone.`)) return;

  showLoader(`Deleting branch "${branch}"…`);
  try {
    const res = await ghFetch(
      `/repos/${config.owner}/${config.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: 'DELETE' }
    );
    if (res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub error ${res.status}`);
    }
    hideLoader();
    toast(`Branch "${branch}" deleted.`, 'success');
    await loadBranches();
  } catch (err) {
    hideLoader();
    toast(`Delete branch failed: ${err.message}`, 'error');
  }
}

async function handleGitRenameBranch() {
  const source = $('#gitRenameSource').value;
  const target = $('#gitRenameTarget').value.trim();

  if (!source) return toast('Select a branch to rename.', 'error');
  if (!target) return toast('Enter the new branch name.', 'error');
  if (!/^[\w.\-/]+$/.test(target)) return toast('Branch name contains invalid characters.', 'error');
  if (source === target) return toast('New name must differ from the current name.', 'error');

  showLoader(`Renaming "${source}" → "${target}"…`);
  try {
    await ghJSON(
      `/repos/${config.owner}/${config.repo}/branches/${encodeURIComponent(source)}/rename`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: target }),
      }
    );
    hideLoader();
    toast(`Branch renamed to "${target}"!`, 'success');
    $('#gitRenameTarget').value = '';
    await loadBranches();
  } catch (err) {
    hideLoader();
    toast(`Rename branch failed: ${err.message}`, 'error');
  }
}

// ── Dynamic Workflow Loader ──────────────────────────────
async function loadWorkflows() {
  const list = $('#workflowList');
  const countEl = $('#workflowCount');
  list.innerHTML = '<p class="workflow-empty">Loading workflows…</p>';

  try {
    const data = await ghJSON(`/repos/${config.owner}/${config.repo}/actions/workflows?per_page=100`);
    const workflows = data.workflows;

    if (!workflows.length) {
      list.innerHTML = '<p class="workflow-empty">No workflows found in this repository.</p>';
      countEl.textContent = '';
      return;
    }

    countEl.textContent = `${workflows.length} workflow${workflows.length !== 1 ? 's' : ''}`;
    list.innerHTML = '';
    workflows.forEach((wf) => list.appendChild(buildWorkflowCard(wf)));

    // Load last run for each workflow asynchronously
    workflows.forEach((wf) => loadWorkflowLastRun(wf.id));
  } catch (err) {
    list.innerHTML = `<p class="workflow-empty workflow-error">Failed to load: ${escapeHtml(err.message)}</p>`;
    toast(`Failed to load workflows: ${err.message}`, 'error');
  }
}

function buildWorkflowCard(wf) {
  const fileName = wf.path.split('/').pop();
  const isActive = wf.state === 'active';

  const card = document.createElement('div');
  card.className = 'wf-card';
  card.dataset.wfId = String(wf.id);

  const branchOptions = branchNames
    .map((b) => `<option value="${escapeHtml(b)}"${b === defaultBranch ? ' selected' : ''}>${escapeHtml(b)}</option>`)
    .join('');

  card.innerHTML = `
    <div class="wf-card-header">
      <div class="wf-info">
        <span class="wf-name">${escapeHtml(wf.name)}</span>
        <span class="wf-file">${escapeHtml(fileName)}</span>
      </div>
      <div class="wf-header-actions">
        <button class="wf-toggle-btn ${isActive ? 'wf-toggle-disable' : 'wf-toggle-enable'}" title="${isActive ? 'Disable workflow' : 'Enable workflow'}">
          ${isActive ? 'Disable' : 'Enable'}
        </button>
        <span class="wf-badge ${isActive ? 'wf-badge-active' : 'wf-badge-inactive'}">
          ${isActive ? 'active' : 'disabled'}
        </span>
      </div>
    </div>
    <div class="wf-last-run hidden">
      <span class="wf-run-label">Last run:</span>
      <span class="wf-run-status"></span>
      <span class="wf-run-time"></span>
      <button class="wf-runs-toggle icon-btn" title="View recent runs">
        <svg viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427z"/></svg>
      </button>
    </div>
    <div class="wf-runs-list hidden"></div>
    <div class="wf-footer">
      <select class="input wf-branch-sel">
        <option value="">Select branch…</option>
        ${branchOptions}
      </select>
      <button class="btn btn-run wf-trigger-btn" ${!isActive ? 'disabled' : ''}>
        <svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg>
        Run
      </button>
    </div>
  `;

  card.querySelector('.wf-trigger-btn').addEventListener('click', () => {
    const branch = card.querySelector('.wf-branch-sel').value;
    if (!branch) return toast('Please select a branch.', 'error');
    triggerWorkflowById(wf.id, wf.name, branch, card);
  });

  card.querySelector('.wf-toggle-btn').addEventListener('click', () => {
    toggleWorkflowState(wf.id, wf.state, card);
  });

  card.querySelector('.wf-runs-toggle').addEventListener('click', () => {
    const list = card.querySelector('.wf-runs-list');
    const isOpen = !list.classList.contains('hidden');
    if (isOpen) {
      list.classList.add('hidden');
    } else {
      list.classList.remove('hidden');
      if (!list.dataset.loaded) loadWorkflowRuns(wf.id, card);
    }
  });

  return card;
}

async function triggerWorkflowById(wfId, wfName, branch, card) {
  const btn = card.querySelector('.wf-trigger-btn');
  btn.disabled = true;
  showLoader(`Triggering "${wfName}"…`);
  try {
    const res = await ghFetch(`/repos/${config.owner}/${config.repo}/actions/workflows/${wfId}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: branch }),
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.message || `Dispatch failed (${res.status})`);
    }
    hideLoader();
    btn.disabled = false;
    toast(`"${wfName}" triggered on ${branch}!`, 'success');
    setTimeout(() => loadWorkflowLastRun(wfId, card), 4000);
  } catch (err) {
    hideLoader();
    btn.disabled = false;
    toast(`Trigger failed: ${err.message}`, 'error');
  }
}

async function loadWorkflowLastRun(wfId, card) {
  try {
    const cardEl = card || $(`[data-wf-id="${wfId}"]`);
    if (!cardEl) return;

    const runs = await ghJSON(
      `/repos/${config.owner}/${config.repo}/actions/workflows/${wfId}/runs?per_page=1`
    );
    if (!runs.workflow_runs.length) return;

    const run = runs.workflow_runs[0];
    const lastRunEl = cardEl.querySelector('.wf-last-run');
    lastRunEl.classList.remove('hidden');

    const conclusion = run.conclusion || run.status;
    let statusClass = 'pending';
    if (run.conclusion === 'success') statusClass = 'success';
    else if (run.conclusion === 'failure') statusClass = 'failure';
    const statusEl = lastRunEl.querySelector('.wf-run-status');
    statusEl.textContent = conclusion;
    statusEl.className = `wf-run-status ${statusClass}`;

    lastRunEl.querySelector('.wf-run-time').textContent = timeAgo(new Date(run.created_at));
  } catch {
    // silently ignore
  }
}

// ── Workflow Enable / Disable ────────────────────────────
async function toggleWorkflowState(wfId, currentState, card) {
  const isActive = currentState === 'active';
  const action = isActive ? 'disable' : 'enable';
  showLoader(`${isActive ? 'Disabling' : 'Enabling'} workflow…`);
  try {
    const res = await ghFetch(
      `/repos/${config.owner}/${config.repo}/actions/workflows/${wfId}/${action}`,
      { method: 'PUT' }
    );
    if (res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub error ${res.status}`);
    }
    hideLoader();
    // Refresh the whole workflow list to reflect updated state
    await loadWorkflows();
    toast(`Workflow ${action}d.`, 'success');
  } catch (err) {
    hideLoader();
    toast(`Failed to ${action} workflow: ${err.message}`, 'error');
  }
}

// ── Workflow Run History ─────────────────────────────────
async function loadWorkflowRuns(wfId, card) {
  const list = card.querySelector('.wf-runs-list');
  list.innerHTML = '<p class="wf-runs-loading">Loading runs…</p>';
  try {
    const data = await ghJSON(
      `/repos/${config.owner}/${config.repo}/actions/workflows/${wfId}/runs?per_page=5`
    );
    list.dataset.loaded = '1';
    if (!data.workflow_runs.length) {
      list.innerHTML = '<p class="wf-runs-loading">No runs found.</p>';
      return;
    }
    list.innerHTML = data.workflow_runs.map((run) => {
      const conclusion = run.conclusion || run.status;
      let statusClass = 'pending';
      if (run.conclusion === 'success') statusClass = 'success';
      else if (run.conclusion === 'failure') statusClass = 'failure';
      const canCancel = run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting';
      const canRerun = run.conclusion === 'failure' || run.conclusion === 'cancelled';
      return `
        <div class="wf-run-item" data-run-id="${run.id}">
          <span class="wf-run-item-branch chip">${escapeHtml(run.head_branch || '—')}</span>
          <span class="wf-run-item-status ${statusClass}">${escapeHtml(conclusion)}</span>
          <span class="wf-run-item-time">${timeAgo(new Date(run.created_at))}</span>
          <div class="wf-run-item-actions">
            ${canCancel ? `<button class="wf-run-action-btn wf-cancel-run" data-run-id="${run.id}" title="Cancel run">Cancel</button>` : ''}
            ${canRerun ? `<button class="wf-run-action-btn wf-rerun" data-run-id="${run.id}" title="Re-run">Re-run</button>` : ''}
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.wf-cancel-run').forEach((btn) => {
      btn.addEventListener('click', () => cancelWorkflowRun(btn.dataset.runId, card, wfId));
    });
    list.querySelectorAll('.wf-rerun').forEach((btn) => {
      btn.addEventListener('click', () => rerunWorkflow(btn.dataset.runId, card, wfId));
    });
  } catch (err) {
    list.innerHTML = `<p class="wf-runs-loading" style="color:var(--accent-red)">Failed: ${escapeHtml(err.message)}</p>`;
  }
}

async function cancelWorkflowRun(runId, card, wfId) {
  showLoader('Cancelling run…');
  try {
    const res = await ghFetch(
      `/repos/${config.owner}/${config.repo}/actions/runs/${runId}/cancel`,
      { method: 'POST' }
    );
    if (res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub error ${res.status}`);
    }
    hideLoader();
    toast('Run cancelled.', 'success');
    const list = card.querySelector('.wf-runs-list');
    delete list.dataset.loaded;
    loadWorkflowRuns(wfId, card);
  } catch (err) {
    hideLoader();
    toast(`Cancel failed: ${err.message}`, 'error');
  }
}

async function rerunWorkflow(runId, card, wfId) {
  showLoader('Re-running workflow…');
  try {
    const res = await ghFetch(
      `/repos/${config.owner}/${config.repo}/actions/runs/${runId}/rerun`,
      { method: 'POST' }
    );
    if (res.status !== 201) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub error ${res.status}`);
    }
    hideLoader();
    toast('Workflow re-run triggered.', 'success');
    setTimeout(() => {
      const list = card.querySelector('.wf-runs-list');
      delete list.dataset.loaded;
      loadWorkflowRuns(wfId, card);
    }, 3000);
  } catch (err) {
    hideLoader();
    toast(`Re-run failed: ${err.message}`, 'error');
  }
}

// ── Issues ──────────────────────────────────────────────
async function loadIssues() {
  const list = $('#issueList');
  const countEl = $('#issueCount');
  list.innerHTML = '<p class="workflow-empty">Loading issues…</p>';
  try {
    const issues = await ghJSON(
      `/repos/${config.owner}/${config.repo}/issues?state=open&per_page=50&sort=updated&direction=desc`
    );
    // Filter out pull requests (GitHub returns PRs as issues too)
    const realIssues = issues.filter((i) => !i.pull_request);
    countEl.textContent = `${realIssues.length} open issue${realIssues.length !== 1 ? 's' : ''}`;
    if (!realIssues.length) {
      list.innerHTML = '<p class="workflow-empty">No open issues.</p>';
      return;
    }
    list.innerHTML = '';
    realIssues.forEach((issue) => list.appendChild(buildIssueItem(issue)));
  } catch (err) {
    list.innerHTML = `<p class="workflow-empty workflow-error">Failed to load: ${escapeHtml(err.message)}</p>`;
    toast(`Failed to load issues: ${err.message}`, 'error');
  }
}

function buildIssueItem(issue) {
  const el = document.createElement('div');
  el.className = 'issue-item';
  el.dataset.issueNum = issue.number;

  const labels = issue.labels.slice(0, 3)
    .map((l) => `<span class="issue-label" style="background:rgba(${hexToRgb('#' + l.color)},0.15);color:#${l.color};border-color:rgba(${hexToRgb('#' + l.color)},0.4)">${escapeHtml(l.name)}</span>`)
    .join('');

  el.innerHTML = `
    <div class="issue-item-main">
      <div class="issue-item-top">
        <span class="issue-number">#${issue.number}</span>
        <span class="issue-title">${escapeHtml(issue.title)}</span>
      </div>
      <div class="issue-item-meta">
        <span class="issue-meta-author">by ${escapeHtml(issue.user.login)}</span>
        <span class="issue-meta-time">${timeAgo(new Date(issue.created_at))}</span>
        ${labels ? `<div class="issue-labels">${labels}</div>` : ''}
      </div>
    </div>
    <button class="btn-close-issue icon-btn" data-num="${issue.number}" title="Close issue #${issue.number}">
      <svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L9.06 8l3.22 3.22a.749.749 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.749.749 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06"/></svg>
    </button>
  `;

  el.querySelector('.btn-close-issue').addEventListener('click', () => handleCloseIssue(issue.number));
  return el;
}

async function handleCloseIssue(num) {
  if (!confirm(`Close issue #${num}?`)) return;
  showLoader(`Closing issue #${num}…`);
  try {
    await ghJSON(`/repos/${config.owner}/${config.repo}/issues/${num}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
    hideLoader();
    toast(`Issue #${num} closed.`, 'success');
    await loadIssues();
  } catch (err) {
    hideLoader();
    toast(`Close issue failed: ${err.message}`, 'error');
  }
}

async function handleCreateIssue() {
  const title = $('#issueTitle').value.trim();
  const body = $('#issueBody').value.trim();
  const labelsRaw = $('#issueLabels').value.trim();

  if (!title) return toast('Issue title is required.', 'error');

  const labels = labelsRaw ? labelsRaw.split(',').map((l) => l.trim()).filter(Boolean) : [];

  showLoader('Creating issue…');
  try {
    const issue = await ghJSON(`/repos/${config.owner}/${config.repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: body || '', labels }),
    });
    hideLoader();
    toast(`Issue #${issue.number} created!`, 'success');
    $('#issueTitle').value = '';
    $('#issueBody').value = '';
    $('#issueLabels').value = '';
    await loadIssues();
  } catch (err) {
    hideLoader();
    toast(`Create issue failed: ${err.message}`, 'error');
  }
}

// ── Helpers ─────────────────────────────────────────────
function hexToRgb(hex) {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

// ── Toast ───────────────────────────────────────────────
function toast(message, type = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Loader ──────────────────────────────────────────────
function showLoader(text = 'Processing…') {
  $('#loader').classList.remove('hidden');
  $('.loader-text').textContent = text;
}
function hideLoader() {
  $('#loader').classList.add('hidden');
}

// ── Utilities ───────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
