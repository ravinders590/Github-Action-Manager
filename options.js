/* ========================================================
   GitHub Action Manager – Options Page Logic
   ======================================================== */

document.addEventListener('DOMContentLoaded', () => {
  loadSaved();
  wireUp();
});

const $ = (s) => document.querySelector(s);

// ── All fetched repos (cached) ───────────────────────────
let allRepos = [];

// ── Load saved settings ──────────────────────────────────
function loadSaved() {
  chrome.storage.sync.get(['ghToken', 'ghOwner', 'ghRepo'], (items) => {
    $('#ghToken').value = items.ghToken || '';
    $('#ghOwner').value = items.ghOwner || '';
    $('#ghRepo').value  = items.ghRepo  || '';

    // Show the selected repo chip if one is already saved
    if (items.ghOwner && items.ghRepo) {
      // Normalise in case a URL was stored previously
      const parsed = parseOwnerRepo(`${items.ghOwner}/${items.ghRepo}`);
      const owner = parsed ? parsed.owner : items.ghOwner;
      const repo  = parsed ? parsed.repo  : items.ghRepo;
      // Fix stored values if they contained a URL
      if (parsed && (owner !== items.ghOwner || repo !== items.ghRepo)) {
        chrome.storage.sync.set({ ghOwner: owner, ghRepo: repo });
      }
      selectRepo(owner, repo, false);
    }

    // Auto-fetch repos if a token is already stored
    if (items.ghToken) {
      fetchAndPopulateRepos(items.ghToken);
    }
  });
}

// ── Wire up all interactions ─────────────────────────────
function wireUp() {
  // Toggle token visibility
  $('#toggleToken').addEventListener('click', () => {
    const inp = $('#ghToken');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Auto-fetch repos when token field loses focus
  $('#ghToken').addEventListener('blur', () => {
    const token = $('#ghToken').value.trim();
    if (token) fetchAndPopulateRepos(token);
  });

  // Manual refresh button
  $('#btnFetchRepos').addEventListener('click', () => {
    const token = $('#ghToken').value.trim();
    if (!token) { showStatus('Enter a Personal Access Token first.', 'error'); return; }
    fetchAndPopulateRepos(token);
  });

  // Repo search input — parse GitHub URLs pasted by the user
  $('#repoSearch').addEventListener('input', () => {
    const raw = $('#repoSearch').value.trim();
    const parsed = parseOwnerRepo(raw);
    if (parsed && parsed.owner && parsed.repo) {
      // Immediately resolve URL/owner-repo paste to a selection
      selectRepo(parsed.owner, parsed.repo, false);
      filterDropdown(parsed.owner + '/' + parsed.repo);
    } else {
      filterDropdown(raw);
    }
    showDropdown();
  });
  $('#repoSearch').addEventListener('focus', () => {
    if (allRepos.length) showDropdown();
  });
  $('#repoSearch').addEventListener('keydown', handleSearchKeydown);

  // Clear selected repo
  $('#btnClearRepo').addEventListener('click', clearRepo);

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#repoPickerField')) hideDropdown();
  });

  // Save
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const token = $('#ghToken').value.trim();
    // Attempt to parse whatever is in the search box as a fallback
    const searchRaw = $('#repoSearch').value.trim();
    const fallback = parseOwnerRepo(searchRaw);
    const owner = $('#ghOwner').value.trim() || (fallback && fallback.owner) || '';
    const repo  = $('#ghRepo').value.trim()  || (fallback && fallback.repo)  || '';

    if (!token || !owner || !repo) {
      showStatus('Token and a selected repository are required.', 'error');
      return;
    }

    // Ensure hidden fields are up-to-date before saving
    $('#ghOwner').value = owner;
    $('#ghRepo').value  = repo;

    chrome.storage.sync.set(
      { ghToken: token, ghOwner: owner, ghRepo: repo },
      () => showStatus('Settings saved successfully!', 'success')
    );
  });

  // Test connection
  $('#btnTest').addEventListener('click', async () => {
    const token = $('#ghToken').value.trim();
    // Parse owner/repo defensively — covers stored URL edge-cases
    const searchRaw = $('#repoSearch').value.trim();
    const fallback = parseOwnerRepo(searchRaw);
    const owner = $('#ghOwner').value.trim() || (fallback && fallback.owner) || '';
    const repo  = $('#ghRepo').value.trim()  || (fallback && fallback.repo)  || '';

    if (!token || !owner || !repo) {
      showStatus('Select a repository first.', 'error');
      return;
    }

    showStatus('Testing connection…', 'info');
    try {
      const res = await ghRequest(`/repos/${owner}/${repo}`, token);
      if (!res.ok) throw new Error(apiErrorMessage(res.status, owner, repo));
      const data = await res.json();
      // Also auto-fix stored values if they were wrong
      chrome.storage.sync.set({ ghOwner: data.owner.login, ghRepo: data.name });
      selectRepo(data.owner.login, data.name, false);
      showStatus(`Connected to ${data.full_name} (${data.visibility})`, 'success');
    } catch (err) {
      showStatus(`Connection failed: ${err.message}`, 'error');
    }
  });
}

// ── Fetch repos from GitHub ──────────────────────────────
async function fetchAndPopulateRepos(token) {
  setFetchStatus('Fetching repositories…', 'loading');
  allRepos = [];

  try {
    // Fetch user info and repos in parallel
    const [userRes, reposRes] = await Promise.all([
      ghRequest('/user', token),
      fetchAllRepos(token),
    ]);

    if (!userRes.ok) {
      if (userRes.status === 401) throw new Error('Invalid or expired token.');
      if (userRes.status === 403) throw new Error('Access denied — check token scopes.');
      throw new Error(`GitHub error ${userRes.status}`);
    }

    const user = await userRes.json();
    allRepos = reposRes;

    // Show authenticated user pill
    const pill = $('#repoUserPill');
    pill.textContent = `@${user.login} · ${allRepos.length} repo${allRepos.length !== 1 ? 's' : ''}`;
    pill.classList.remove('hidden');

    setFetchStatus('', '');
    filterDropdown($('#repoSearch').value.trim());

    // Always open the dropdown so user can see and pick from all repos
    showDropdown();

  } catch (err) {
    setFetchStatus(`Failed to fetch repos: ${err.message}`, 'error');
  }
}

async function fetchAllRepos(token) {
  const repos = [];
  let page = 1;
  while (true) {
    const res = await ghRequest(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, token);
    if (!res.ok) break;
    const data = await res.json();
    if (!data.length) break;
    repos.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

// ── Dropdown helpers ─────────────────────────────────────
function filterDropdown(query) {
  const ul = $('#repoDropdown');
  const lower = query.toLowerCase();
  const filtered = query
    ? allRepos.filter((r) => r.full_name.toLowerCase().includes(lower))
    : allRepos;

  ul.innerHTML = '';

  if (!filtered.length && allRepos.length) {
    const li = document.createElement('li');
    li.className = 'repo-option repo-no-results';
    li.textContent = query ? `No repos matching "${query}"` : 'No repos found.';
    ul.appendChild(li);
    return;
  }

  filtered.forEach((repo) => {
    const li = document.createElement('li');
    li.className = 'repo-option';
    li.setAttribute('role', 'option');
    li.dataset.fullName = repo.full_name;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'repo-option-name';

    // Bold the matching part
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
    metaSpan.className = 'repo-option-meta';
    metaSpan.textContent = [
      repo.private ? 'private' : 'public',
      repo.language,
    ].filter(Boolean).join(' · ');

    li.appendChild(nameSpan);
    li.appendChild(metaSpan);

    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur from firing before click
      const [owner, repoName] = repo.full_name.split('/');
      selectRepo(owner, repoName, true);
    });

    ul.appendChild(li);
  });
}

function showDropdown() {
  if (!allRepos.length) return;
  filterDropdown($('#repoSearch').value.trim());
  $('#repoDropdown').classList.remove('hidden');
}

function hideDropdown() {
  $('#repoDropdown').classList.add('hidden');
}

function handleSearchKeydown(e) {
  const ul = $('#repoDropdown');
  const items = [...ul.querySelectorAll('.repo-option:not(.repo-no-results)')];
  const active = ul.querySelector('.repo-option.active');
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
    if (active) {
      const [owner, repoName] = active.dataset.fullName.split('/');
      selectRepo(owner, repoName, true);
    }
  } else if (e.key === 'Escape') {
    hideDropdown();
  }
}

// ── Select / clear repo ──────────────────────────────────
function selectRepo(owner, repo, focusOut) {
  $('#ghOwner').value = owner;
  $('#ghRepo').value  = repo;

  const fullName = `${owner}/${repo}`;
  $('#repoSearch').value = fullName;
  $('#repoChipLabel').textContent = fullName;
  $('#repoSelectedChip').classList.remove('hidden');
  hideDropdown();
  if (focusOut) $('#repoSearch').blur();
}

function clearRepo() {
  $('#ghOwner').value = '';
  $('#ghRepo').value  = '';
  $('#repoSearch').value = '';
  $('#repoSelectedChip').classList.add('hidden');
  $('#repoSearch').focus();
  showDropdown();
}

// ── Fetch status strip ───────────────────────────────────
function setFetchStatus(msg, type) {
  const el = $('#repoFetchStatus');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.className = `repo-fetch-status repo-fetch-${type}`;
  el.classList.remove('hidden');
}

// ── GitHub API helper ────────────────────────────────────
function ghRequest(path, token) {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

function apiErrorMessage(status, owner, repo) {
  if (status === 401) return 'Invalid or expired token — generate a new one at github.com/settings/tokens.';
  if (status === 403) return 'Access denied. Ensure the token has "repo" and "workflow" scopes.';
  if (status === 404) return `Repository "${owner}/${repo}" not found. Check the Owner / Org and Repository name.`;
  return `GitHub returned HTTP ${status}`;
}

// ── Status message ───────────────────────────────────────
function showStatus(message, type) {
  const el = $('#status');
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 6000);
}

// ── Utility ──────────────────────────────────────────────
function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

/**
 * Accepts any of:
 *   https://github.com/owner/repo
 *   github.com/owner/repo
 *   owner/repo
 *   owner (with separate repo param)
 * Returns { owner, repo } or null if it cannot be parsed.
 */
function parseOwnerRepo(raw, knownRepo) {
  if (!raw) return null;
  const s = raw.trim().replace(/\.git$/, '').replace(/\/+$/, '');

  // Full or partial GitHub URL
  const urlMatch = s.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };

  // owner/repo  (no protocol)
  const slashMatch = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slashMatch) return { owner: slashMatch[1], repo: slashMatch[2] };

  // bare owner with a separate known repo
  if (knownRepo && !s.includes('/')) return { owner: s, repo: knownRepo };

  return null;
}
