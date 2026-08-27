let bindings = [];
let totalBindings = 0;
let searchTimer = null;

const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function relativeTime(timestamp) {
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 10_000) return 'just now';
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortEndpoint(endpoint) {
    if (!endpoint) return '-';
    try {
        return new URL(endpoint).hostname;
    } catch {
        return endpoint;
    }
}

function renderStats() {
    byId('stat-sessions').textContent = new Set(bindings.map(row => row.sessionKey)).size;
    byId('stat-bindings').textContent = totalBindings;
    byId('stat-accounts').textContent = new Set(bindings.map(row => row.accountEmail)).size;
    byId('stat-active').textContent = bindings.filter(row => Date.now() - row.lastUsedAt < 3_600_000).length;
    byId('result-count').textContent = `${totalBindings} result${totalBindings === 1 ? '' : 's'}`;
}

function renderTable() {
    const table = byId('bindings-table');
    if (bindings.length === 0) {
        table.innerHTML = '<tr><td colspan="7" class="p-12 text-center text-zinc-400">// No session bindings found</td></tr>';
        renderStats();
        return;
    }

    table.innerHTML = bindings.map(row => {
        const session = escapeHtml(row.sessionId);
        const account = escapeHtml(row.accountEmail);
        const model = escapeHtml(row.model);
        const family = escapeHtml(row.modelFamily);
        const source = escapeHtml(row.source);
        const endpoint = escapeHtml(shortEndpoint(row.endpoint));
        const project = escapeHtml(row.projectId || '-');
        return `
            <tr class="hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors">
                <td class="px-4 py-3 max-w-[320px]">
                    <div class="truncate text-zinc-800 dark:text-zinc-200" title="${session}">${session}</div>
                    <div class="mt-1 flex items-center gap-2 text-[9px] text-zinc-400">
                        <span class="uppercase tracking-wider">${source}</span>
                        ${row.inferred ? '<span class="px-1 py-0.5 rounded bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400">INFERRED</span>' : ''}
                    </div>
                </td>
                <td class="px-4 py-3">
                    <div class="text-zinc-700 dark:text-zinc-300">${account}</div>
                    <div class="mt-1 text-[9px] text-zinc-400 truncate max-w-[220px]" title="${project}">${project}</div>
                </td>
                <td class="px-4 py-3">
                    <div class="text-zinc-700 dark:text-zinc-300">${model}</div>
                    <div class="mt-1 text-[9px] text-zinc-400">${family}</div>
                </td>
                <td class="px-4 py-3">
                    <span class="inline-flex px-1.5 py-0.5 rounded border ${row.pool === 'cli' ? 'border-blue-200 dark:border-blue-900 text-blue-600 dark:text-blue-400' : 'border-violet-200 dark:border-violet-900 text-violet-600 dark:text-violet-400'} text-[9px] font-bold uppercase">${escapeHtml(row.pool)}</span>
                    <div class="mt-1 text-[9px] text-zinc-400" title="${escapeHtml(row.endpoint || '')}">${endpoint}</div>
                </td>
                <td class="px-4 py-3 tabular-nums text-zinc-600 dark:text-zinc-400">${row.requestCount}</td>
                <td class="px-4 py-3 text-zinc-500" title="${new Date(row.lastUsedAt).toLocaleString()}">${relativeTime(row.lastUsedAt)}</td>
                <td class="px-4 py-3 text-right">
                    <button data-delete-binding="${row.id}" class="px-2 py-1 text-[9px] uppercase tracking-wider text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded transition-colors">Remove</button>
                </td>
            </tr>`;
    }).join('');

    table.querySelectorAll('[data-delete-binding]').forEach(button => {
        button.addEventListener('click', () => removeBinding(Number(button.dataset.deleteBinding)));
    });
    renderStats();
}

async function loadBindings() {
    const status = byId('refresh-status');
    status.textContent = 'Refreshing...';
    const search = byId('search-input').value.trim();
    const query = new URLSearchParams({ limit: '1000' });
    if (search) query.set('search', search);

    try {
        const response = await fetch(`/api/session-bindings?${query}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        bindings = result.bindings || [];
        totalBindings = result.total || 0;
        renderTable();
        status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        status.textContent = `Refresh failed: ${error.message}`;
        byId('bindings-table').innerHTML = `<tr><td colspan="7" class="p-12 text-center text-rose-500">${escapeHtml(error.message)}</td></tr>`;
    }
}

async function removeBinding(id) {
    const response = await fetch(`/api/session-bindings/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
        alert(`Failed to remove binding: HTTP ${response.status}`);
        return;
    }
    await loadBindings();
}

async function clearBindings() {
    if (!confirm('Clear all persisted session bindings? New requests will create fresh affinity records.')) return;
    const response = await fetch('/api/session-bindings', { method: 'DELETE' });
    if (!response.ok) {
        alert(`Failed to clear bindings: HTTP ${response.status}`);
        return;
    }
    await loadBindings();
}

function applyTheme() {
    const preference = localStorage.theme || 'system';
    const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
}

function cycleTheme() {
    const current = localStorage.theme || 'system';
    const next = { system: 'light', light: 'dark', dark: 'system' }[current];
    if (next === 'system') localStorage.removeItem('theme');
    else localStorage.theme = next;
    applyTheme();
}

byId('refresh-button').addEventListener('click', loadBindings);
byId('clear-button').addEventListener('click', clearBindings);
byId('theme-button').addEventListener('click', cycleTheme);
byId('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadBindings, 250);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
loadBindings();
setInterval(() => {
    if (!document.hidden) loadBindings();
}, 10_000);
