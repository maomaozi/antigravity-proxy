const usageState = {
    records: [],
    total: 0,
    summary: {},
    limit: 100,
    offset: 0,
    sessionKey: new URLSearchParams(location.search).get('session_key') || '',
};
let usageSearchTimer = null;
const usageById = (id) => document.getElementById(id);
const tokenFormatter = new Intl.NumberFormat();

function usageEscape(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatTokens(value) {
    return tokenFormatter.format(Number(value) || 0);
}

function usageRelativeTime(timestamp) {
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 10_000) return 'just now';
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

function usageEndpoint(endpoint) {
    if (!endpoint) return '-';
    try { return new URL(endpoint).hostname; } catch { return endpoint; }
}

function renderUsageStats() {
    const summary = usageState.summary || {};
    const input = Number(summary.inputTokens) || 0;
    const cacheReported = summary.cachedInputTokens !== null && summary.cachedInputTokens !== undefined;
    const cached = cacheReported ? Number(summary.cachedInputTokens) || 0 : null;
    usageById('stat-requests').textContent = formatTokens(summary.requests);
    usageById('stat-sessions').textContent = `${formatTokens(summary.sessions)} sessions`;
    usageById('stat-input').textContent = formatTokens(input);
    usageById('stat-uncached').textContent = summary.uncachedInputTokens === null || summary.uncachedInputTokens === undefined
        ? 'Not reported'
        : `${formatTokens(summary.uncachedInputTokens)} uncached`;
    usageById('stat-cached').textContent = cacheReported ? formatTokens(cached) : '—';
    usageById('stat-cache-rate').textContent = cacheReported
        ? `${input ? (cached / input * 100).toFixed(1) : '0.0'}% cache rate`
        : 'Not reported';
    usageById('stat-output').textContent = formatTokens(summary.outputTokens);
    usageById('stat-reasoning').textContent = formatTokens(summary.reasoningTokens);
    usageById('stat-total').textContent = formatTokens(summary.totalTokens);
}

function renderUsageTable() {
    const table = usageById('usage-table');
    if (!usageState.records.length) {
        table.innerHTML = '<tr><td colspan="10" class="p-12 text-center text-zinc-400">// No token usage records found</td></tr>';
    } else {
        table.innerHTML = usageState.records.map(row => {
            const cacheReported = row.cachedInputTokens !== null && row.cachedInputTokens !== undefined;
            const cacheRate = cacheReported && row.inputTokens ? (row.cachedInputTokens / row.inputTokens * 100).toFixed(1) : '0.0';
            const cached = cacheReported
                ? `<div>${formatTokens(row.cachedInputTokens)}</div><div class="mt-1 text-[9px] opacity-70">${cacheRate}%</div>`
                : '<div title="Upstream did not report cached input tokens">—</div><div class="mt-1 text-[9px] opacity-70">Not reported</div>';
            const uncached = row.uncachedInputTokens === null || row.uncachedInputTokens === undefined
                ? '<span title="Cannot derive uncached input without cache metadata">—</span>'
                : formatTokens(row.uncachedInputTokens);
            const reasoning = row.reasoningTokensReported ? formatTokens(row.reasoningTokens) : '<span title="Upstream did not report reasoning separately">—</span>';
            return `<tr class="hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors">
                <td class="px-3 py-3 max-w-[220px]">
                    <div class="text-zinc-700 dark:text-zinc-300" title="${usageEscape(new Date(row.createdAt).toLocaleString())}">${usageRelativeTime(row.createdAt)}</div>
                    <div class="mt-1 truncate text-[9px] text-zinc-400" title="${usageEscape(row.requestId)}">${usageEscape(row.requestId)}</div>
                </td>
                <td class="px-3 py-3 max-w-[260px]">
                    <a class="block truncate text-zinc-700 dark:text-zinc-300 hover:text-emerald-500" href="?session_key=${encodeURIComponent(row.sessionKey)}" title="${usageEscape(row.sessionId)}">${usageEscape(row.sessionId)}</a>
                    <div class="mt-1 text-[9px] text-zinc-400 uppercase">${usageEscape(row.sessionSource)}${row.sessionInferred ? ' · inferred' : ''}</div>
                </td>
                <td class="px-3 py-3 max-w-[260px]">
                    <div class="truncate text-zinc-700 dark:text-zinc-300" title="${usageEscape(row.model)}">${usageEscape(row.model)}</div>
                    <div class="mt-1 truncate text-[9px] text-zinc-400" title="${usageEscape(row.upstreamModel || '')}">${usageEscape(row.upstreamModel || '-')}</div>
                </td>
                <td class="px-3 py-3 max-w-[240px]">
                    <div class="truncate text-zinc-700 dark:text-zinc-300" title="${usageEscape(row.accountEmail)}">${usageEscape(row.accountEmail)}</div>
                    <div class="mt-1 text-[9px] text-zinc-400"><span class="uppercase">${usageEscape(row.pool)}</span> · ${usageEscape(usageEndpoint(row.endpoint))} · ${row.streamed ? 'SSE' : 'JSON'}</div>
                </td>
                <td class="px-3 py-3 text-right tabular-nums">${formatTokens(row.inputTokens)}</td>
                <td class="px-3 py-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">${cached}</td>
                <td class="px-3 py-3 text-right tabular-nums">${uncached}</td>
                <td class="px-3 py-3 text-right tabular-nums">${formatTokens(row.outputTokens)}</td>
                <td class="px-3 py-3 text-right tabular-nums">${reasoning}</td>
                <td class="px-3 py-3 text-right tabular-nums font-bold">${formatTokens(row.totalTokens)}</td>
            </tr>`;
        }).join('');
    }

    const first = usageState.total ? usageState.offset + 1 : 0;
    const last = Math.min(usageState.offset + usageState.records.length, usageState.total);
    usageById('result-count').textContent = `${first}–${last} of ${formatTokens(usageState.total)} records`;
    usageById('page-label').textContent = `Page ${Math.floor(usageState.offset / usageState.limit) + 1}`;
    usageById('previous-page').disabled = usageState.offset === 0;
    usageById('next-page').disabled = usageState.offset + usageState.limit >= usageState.total;
    renderUsageStats();
}

function buildUsageQuery() {
    const query = new URLSearchParams({ limit: String(usageState.limit), offset: String(usageState.offset) });
    const search = usageById('search-input').value.trim();
    const model = usageById('model-filter').value;
    const range = Number(usageById('range-filter').value);
    if (search) query.set('search', search);
    if (model) query.set('model', model);
    if (range) query.set('from', String(Date.now() - range));
    if (usageState.sessionKey) query.set('session_key', usageState.sessionKey);
    return query;
}

async function loadUsage() {
    const status = usageById('refresh-status');
    status.textContent = 'Refreshing...';
    try {
        const response = await fetch(`/api/request-usage?${buildUsageQuery()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        usageState.records = result.records || [];
        usageState.total = result.total || 0;
        usageState.summary = result.summary || {};
        renderUsageTable();
        status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        status.textContent = `Refresh failed: ${error.message}`;
        usageById('usage-table').innerHTML = `<tr><td colspan="10" class="p-12 text-center text-rose-500">${usageEscape(error.message)}</td></tr>`;
    }
}

async function loadUsageModels() {
    try {
        const response = await fetch('/v1/models');
        const result = await response.json();
        const select = usageById('model-filter');
        for (const model of result.data || []) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name || model.id;
            select.append(option);
        }
    } catch {}
}

async function clearUsage() {
    if (!confirm('Clear all persisted request token usage? This cannot be recovered from the proxy.')) return;
    const response = await fetch('/api/request-usage', { method: 'DELETE' });
    if (!response.ok) { alert(`Failed to clear usage: HTTP ${response.status}`); return; }
    usageState.offset = 0;
    await loadUsage();
}

function applyUsageTheme() {
    const preference = localStorage.theme || 'system';
    const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
}

function cycleUsageTheme() {
    const current = localStorage.theme || 'system';
    const next = { system: 'light', light: 'dark', dark: 'system' }[current];
    if (next === 'system') localStorage.removeItem('theme'); else localStorage.theme = next;
    applyUsageTheme();
}

usageById('refresh-button').addEventListener('click', loadUsage);
usageById('clear-button').addEventListener('click', clearUsage);
usageById('theme-button').addEventListener('click', cycleUsageTheme);
usageById('search-input').addEventListener('input', () => {
    clearTimeout(usageSearchTimer);
    usageState.offset = 0;
    usageSearchTimer = setTimeout(loadUsage, 250);
});
usageById('model-filter').addEventListener('change', () => { usageState.offset = 0; loadUsage(); });
usageById('range-filter').addEventListener('change', () => { usageState.offset = 0; loadUsage(); });
usageById('previous-page').addEventListener('click', () => { usageState.offset = Math.max(0, usageState.offset - usageState.limit); loadUsage(); });
usageById('next-page').addEventListener('click', () => { usageState.offset += usageState.limit; loadUsage(); });
usageById('clear-session-filter').addEventListener('click', () => {
    usageState.sessionKey = '';
    history.replaceState(null, '', location.pathname);
    usageById('session-filter-banner').classList.add('hidden');
    usageById('session-filter-banner').classList.remove('flex');
    usageState.offset = 0;
    loadUsage();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyUsageTheme);
if (usageState.sessionKey) {
    usageById('session-filter-banner').classList.remove('hidden');
    usageById('session-filter-banner').classList.add('flex');
}
applyUsageTheme();
loadUsageModels();
loadUsage();
setInterval(() => { if (!document.hidden) loadUsage(); }, 10_000);
