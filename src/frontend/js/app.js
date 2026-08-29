let globalAccounts = [];
let globalCooldowns = {};
let globalSupportedModels = [];
let globalCodexModels = [];
let expandedAccounts = new Set();
let expandedFamilies = new Set();
let lastActivityMap = new Map();
let isLogsCollapsed = false;
let isResizing = false;
let userHasScrolledLogs = false;
let currentConfig = null;
let globalCodexAccounts = [];
let activeCodexLoginId = null;
let codexLoginPollTimer = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>\"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[ch]));
}

function getCategoryCooldown(email, category, quotas) {
     const now = Date.now();
     const cliExpiry = globalCooldowns[`${email}|cli`];
     const sandboxExpiry = globalCooldowns[`${email}|sandbox`];
     
     const isCliDown = cliExpiry && cliExpiry > now;
     const isSandboxDown = sandboxExpiry && sandboxExpiry > now;
     
     if (!isCliDown && !isSandboxDown) return null;

     if (Object.hasOwn(MODEL_FAMILIES, category)) {
         return isSandboxDown ? sandboxExpiry : null;
     }
     
     if (isCliDown) return cliExpiry;
     if (isSandboxDown) return sandboxExpiry;
     
     return null;
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return '-';
    const diff = Date.now() - timestamp;
    if (diff < 1000) return 'Just now';
    if (diff < 60000) return Math.floor(diff/1000) + 's ago';
    if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
    return Math.floor(diff/3600000) + 'h ago';
}

function formatReset(iso) {
    if (!iso) return '-';
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'Ready';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    let parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (parts.length < 2 && seconds > 0) parts.push(`${seconds}s`);

    return parts.join(' ');
}

function getFamilyQuotaData(accounts, familyName) {
    const familyAccounts = [];
    let earliestReset = null;

    accounts.forEach(acc => {
        if (acc.quota) {
            const familyQuotas = acc.quota.filter(q => getFamilyName(q.groupName) === familyName);
            if (familyQuotas.length > 0) {
                const avgQuota = Math.round(
                    familyQuotas.reduce((sum, q) => sum + (q.remainingFraction * 100), 0) / familyQuotas.length
                );

                let accountReset = null;
                familyQuotas.forEach(q => {
                    if (q.resetTime) {
                        const resetTime = new Date(q.resetTime).getTime();
                        if (resetTime > Date.now()) {
                            if (!accountReset || resetTime < accountReset) {
                                accountReset = resetTime;
                            }
                            if (!earliestReset || resetTime < earliestReset) {
                                earliestReset = resetTime;
                            }
                        }
                    }
                });

                familyAccounts.push({
                    email: acc.email,
                    avgQuota,
                    resetTime: accountReset
                });
            }
        }
    });

    return { accounts: familyAccounts, earliestReset };
}

function toggleFamily(idx) {
    const familyIdx = parseInt(idx, 10);
    if (expandedFamilies.has(familyIdx)) {
        expandedFamilies.delete(familyIdx);
    } else {
        expandedFamilies.add(familyIdx);
    }
    updateToggleAllButton();
    renderDashboardFamilies();
}

function toggleAllFamilies() {
    const total = buildDashboardFamilyStats().length;
    const allExpanded = total > 0 && expandedFamilies.size === total;

    if (allExpanded) {
        expandedFamilies.clear();
    } else {
        for (let index = 0; index < total; index++) expandedFamilies.add(index);
    }

    updateToggleAllButton();
    renderDashboardFamilies();
}

function updateToggleAllButton() {
    const btn = $('btn-toggle-all');
    if (!btn) return;
    const total = buildDashboardFamilyStats().length;
    const isAllExpanded = total > 0 && expandedFamilies.size === total;

    const span = btn.querySelector('span');
    const svg = btn.querySelector('svg');

    if (isAllExpanded) {
        span.textContent = 'Collapse Metrics';
        svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>';
    } else {
        span.textContent = 'Expand Metrics';
        svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16m-7 6h7"/>';
    }
}

function getThemePreference() {
    return localStorage.theme || 'system';
}

function setThemePreference(pref) {
    if (pref === 'system') localStorage.removeItem('theme');
    else localStorage.theme = pref;
    applyTheme();
}

function applyTheme() {
    const pref = getThemePreference();
    const isDark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    
    document.documentElement.classList.toggle('dark', isDark);
    
    const iconSun = $('icon-sun');
    const iconMoon = $('icon-moon');
    const iconSystem = $('icon-system');

    if (iconSun) iconSun.classList.toggle('hidden', pref !== 'light');
    if (iconMoon) iconMoon.classList.toggle('hidden', pref !== 'dark');
    if (iconSystem) iconSystem.classList.toggle('hidden', pref !== 'system');
}

function cycleTheme() {
    const next = { 'system': 'light', 'light': 'dark', 'dark': 'system' }[getThemePreference()];
    setThemePreference(next);
}

function initTheme() {
    applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

function addLog(msg) {
    const container = $('logs-content');
    if (!container) return;

    const div = document.createElement('div');
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
    
    let content = msg
        .replace(/\[(.*?)\]/g, '<span class="text-emerald-500">[$1]</span>')
        .replace(/(ERROR|CRITICAL)/g, '<span class="text-rose-500 font-bold">$1</span>')
        .replace(/(SUCCESS|OK)/g, '<span class="text-emerald-500">$1</span>')
        .replace(/(INFO)/g, '<span class="text-blue-500">$1</span>');

    div.innerHTML = `<span class="text-zinc-400 dark:text-zinc-600 mr-2 opacity-50 select-none">${time}</span>${content}`;
    div.className = "hover:bg-zinc-100/50 dark:hover:bg-zinc-800/50 -mx-4 px-4 py-0.5 transition-colors font-mono";
    
    container.appendChild(div);
    if (container.children.length > 200) container.removeChild(container.firstChild);
    
    if (!userHasScrolledLogs) {
        container.scrollTop = container.scrollHeight;
    }
}

function setupLogsInteraction() {
    const panel = $('logs-panel');
    const resizer = $('logs-resizer');
    const container = $('logs-content');
    if (!panel || !resizer || !container) return;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        panel.classList.remove('transition-[height]');
        document.body.style.cursor = 'ns-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newHeight = window.innerHeight - e.clientY;
        if (newHeight >= 40 && newHeight <= window.innerHeight * 0.8) {
            panel.style.height = `${newHeight}px`;
            if (newHeight > 50 && isLogsCollapsed) {
                isLogsCollapsed = false;
                $('logs-chevron').classList.remove('rotate-180');
            }
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            panel.classList.add('transition-[height]');
            document.body.style.cursor = 'default';
        }
    });

    container.addEventListener('scroll', () => {
        const threshold = 10;
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
        userHasScrolledLogs = !isAtBottom;
    });
}

function toggleLogs() {
    const panel = $('logs-panel');
    const chevron = $('logs-chevron');
    
    if (isLogsCollapsed) {
        panel.style.height = '';
        panel.classList.remove('h-8');
        panel.classList.add('h-48', 'sm:h-64');
        chevron.classList.remove('rotate-180');
    } else {
        panel.style.height = '32px';
        panel.classList.remove('h-48', 'sm:h-64');
        chevron.classList.add('rotate-180');
    }
    isLogsCollapsed = !isLogsCollapsed;
}

const MODEL_FAMILIES = {
    'Gemini Models': (n) => n.includes('gemini'),
    'Claude Sonnet 4.6': (n) => n.includes('claude') && n.includes('sonnet') && (n.includes('4-6') || n.includes('4.6')),
    'Claude Opus 4.6': (n) => n.includes('claude') && n.includes('opus') && (n.includes('4-6') || n.includes('4.6')),
    'GPT-OSS 120B': (n) => n.includes('gpt-oss') && n.includes('120b'),
};

function getFamilyName(modelName) {
    const n = modelName.toLowerCase();
    for (const [family, check] of Object.entries(MODEL_FAMILIES)) {
        if (check(n)) return family;
    }
    return 'Other';
}

function calculateFamilyStats(accounts) {
    const stats = {};
    const keys = Object.keys(MODEL_FAMILIES);
    keys.forEach(fam => {
        stats[fam] = { totalQuota: 0, healthyCount: 0, totalCount: 0 };
    });

    accounts.forEach(acc => {
        const isHealthy = acc.healthScore >= 50;
        const familyQuotas = {};
        
        if (acc.quota) {
            acc.quota.forEach(q => {
                const fam = getFamilyName(q.groupName);
                if (stats[fam]) {
                    if (!familyQuotas[fam]) familyQuotas[fam] = { sum: 0, count: 0 };
                    familyQuotas[fam].sum += q.remainingFraction;
                    familyQuotas[fam].count++;
                }
            });
        }

        for (const [fam, data] of Object.entries(familyQuotas)) {
            stats[fam].totalQuota += (data.sum / data.count);
            stats[fam].totalCount++;
            if (isHealthy) stats[fam].healthyCount++;
        }
    });

    return keys.map(name => {
        const data = stats[name];
        const avgAvailability = data.totalCount > 0 ? (data.totalQuota / data.totalCount) * 100 : 0;
        return {
            name,
            availability: Math.round(avgAvailability),
            healthy: data.healthyCount,
            total: data.totalCount
        };
    });
}

function calculateCodexFamilyStat() {
    if (!globalCodexModels.length) return null;

    const now = Date.now();
    const familyAccounts = [];
    let availabilitySum = 0;
    let measuredAccounts = 0;
    let healthyCount = 0;
    let earliestReset = null;

    globalCodexAccounts.forEach(account => {
        const windows = codexQuotaWindows(account.usage);
        const measured = windows.map(window => {
            const used = Number(window.usedPercent);
            if (!Number.isFinite(used)) return null;
            return {
                window,
                remaining: Math.max(0, Math.min(100, 100 - used)),
            };
        }).filter(Boolean);
        const quotaBlocked = account.usage?.limitReached === true || account.usage?.allowed === false || measured.some(item => item.remaining <= 0);
        const unavailable = account.available === false || Number(account.cooldownUntil || 0) > now || quotaBlocked;

        let availability = null;
        let resetTime = null;
        if (measured.length) {
            const minimum = Math.min(...measured.map(item => item.remaining));
            availability = unavailable ? 0 : minimum;
            const constraining = measured.filter(item => item.remaining === minimum);
            const resetCandidates = constraining
                .map(item => codexResetTarget(item.window, account.usageFetchedAt))
                .filter(value => Number.isFinite(value) && value > now);
            if (resetCandidates.length) resetTime = Math.min(...resetCandidates);
            availabilitySum += availability;
            measuredAccounts++;
        }
        if (!unavailable) healthyCount++;
        if (resetTime && (!earliestReset || resetTime < earliestReset)) earliestReset = resetTime;

        familyAccounts.push({
            email: account.email,
            avgQuota: availability === null ? 0 : Math.round(availability),
            resetTime,
            isUnavailable: unavailable,
            hasQuota: availability !== null,
        });
    });

    return {
        name: 'Codex Models',
        provider: 'codex',
        availability: measuredAccounts ? Math.round(availabilitySum / measuredAccounts) : 0,
        healthy: healthyCount,
        total: globalCodexAccounts.length,
        models: [...globalCodexModels].sort(),
        familyData: { accounts: familyAccounts, earliestReset },
    };
}

function buildDashboardFamilyStats() {
    const stats = calculateFamilyStats(globalAccounts);
    const codex = calculateCodexFamilyStat();
    if (codex) stats.push(codex);
    return stats;
}

function renderDashboardFamilies() {
    renderFamilyGrid(buildDashboardFamilyStats());
}

function organizeAccountDetails(account) {
    const groups = new Map();
    if (account.quota) {
        account.quota.forEach(q => {
            const fam = getFamilyName(q.groupName);
            if (!groups.has(fam)) groups.set(fam, []);
            groups.get(fam).push({ ...q, pct: Math.round(q.remainingFraction * 100) });
        });
    }
    return Array.from(groups.entries()).sort((a,b) => a[0].localeCompare(b[0]));
}

function renderFamilyGrid(stats) {
    const grid = $('family-grid');
    if (!grid) return;

    const html = stats.map((stat, index) => {
        const isExpanded = expandedFamilies.has(index);
        const familyData = stat.familyData || getFamilyQuotaData(globalAccounts, stat.name);
        
        const accountsWithFamily = stat.provider === 'codex'
            ? globalCodexAccounts
            : globalAccounts.filter(acc => acc.quota && acc.quota.some(q => getFamilyName(q.groupName) === stat.name));
        
        const allAccountsDownForFamily = stat.provider === 'codex'
            ? stat.total > 0 && stat.healthy === 0
            : accountsWithFamily.length > 0 && accountsWithFamily.every(acc => {
                const sboxExp = globalCooldowns[`${acc.email}|sandbox|${stat.name}`];
                const cliExp = globalCooldowns[`${acc.email}|cli|${stat.name}`];
                return (sboxExp && sboxExp > Date.now()) && (cliExp && cliExp > Date.now());
            });

        let indicatorColor = allAccountsDownForFamily ? 'text-rose-500' : (stat.availability > 50 ? 'text-emerald-500' : (stat.availability < 20 ? 'text-rose-500' : 'text-zinc-400 dark:text-zinc-300'));
        let barIndicatorColor = allAccountsDownForFamily ? 'bg-rose-500' : (stat.availability > 50 ? 'bg-emerald-500' : (stat.availability < 20 ? 'bg-rose-500' : 'bg-zinc-300 dark:bg-zinc-600'));
        let borderColor = allAccountsDownForFamily ? 'border-rose-200 dark:border-rose-900/50' : 'border-zinc-200 dark:border-zinc-800';

        const modelsInFamily = (stat.models || globalSupportedModels
            .filter(m => getFamilyName(m) === stat.name))
            .map(m => m.replace('models/', '').replace('anthropic/', ''))
            .sort()
            .join(', ');

        return `
        <div class="bg-white dark:bg-[#0f0f0f] rounded border ${borderColor} overflow-hidden group hover:border-zinc-400 dark:hover:border-zinc-700 transition-colors flex flex-col self-start">
            <div class="p-3 sm:p-4 cursor-pointer flex flex-col" onclick="toggleFamily(${index})">
                <div class="flex items-start justify-between mb-4">
                    <div>
                        <div class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">${stat.name}</div>
                        <div class="flex items-baseline gap-2">
                            <span class="text-2xl font-bold ${indicatorColor} tracking-tighter">${stat.availability}%</span>
                            <span class="text-[9px] text-zinc-500 dark:text-zinc-600 font-medium">AVAILABILITY</span>
                        </div>
                    </div>
                </div>

                <div class="flex items-center justify-between gap-4 mt-auto">
                     <div class="min-w-0 flex-1 h-12 overflow-hidden text-[10px] text-zinc-500 dark:text-zinc-600 leading-tight" title="${modelsInFamily}">${modelsInFamily}</div>
                     <div class="flex flex-col items-end shrink-0" title="Time until next quota refill">
                        <span class="text-[8px] text-zinc-500 dark:text-zinc-700 uppercase tracking-tighter">Quota increase in</span>
                        <span class="text-[10px] text-zinc-600 dark:text-zinc-400 font-bold">${familyData.earliestReset ? formatReset(new Date(familyData.earliestReset).toISOString()) : '--'}</span>
                    </div>
                </div>
            </div>

            <div class="h-0.5 w-full bg-zinc-100 dark:bg-zinc-900">
                <div class="h-full ${barIndicatorColor} transition-all duration-1000" style="width: ${stat.availability}%"></div>
            </div>

            ${isExpanded ? `
            <div class="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-[#050505] px-4 py-3">
                ${familyData.accounts.length === 0 ? `
                    <div class="text-center text-[10px] text-zinc-500 dark:text-zinc-600 py-1">No data</div>
                ` : `
                    <div class="space-y-1">
                        ${familyData.accounts
                            .sort((a, b) => b.avgQuota - a.avgQuota)
                            .map(acc => {
                                 let quotaColor = acc.avgQuota >= 80 ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600';
                                 if (acc.avgQuota < 20) quotaColor = 'bg-rose-500';
                                 const fullAcc = stat.provider === 'codex'
                                     ? globalCodexAccounts.find(a => a.email === acc.email)
                                     : globalAccounts.find(a => a.email === acc.email);
                            let isCooldown = Boolean(stat.provider === 'codex' && acc.isUnavailable);
                            let remaining = 0;
                            
                            if (fullAcc && stat.provider !== 'codex') {
                                const expiry = getCategoryCooldown(acc.email, stat.name, fullAcc.quota || []);
                                if (expiry && expiry > Date.now()) {
                                    isCooldown = true;
                                    remaining = Math.ceil((expiry - Date.now()) / 1000);
                                }
                            }

                            let rowClass = "grid grid-cols-[minmax(0,72px)_minmax(36px,1fr)_max-content] sm:grid-cols-[minmax(0,88px)_minmax(48px,1fr)_max-content] items-center gap-2 py-1 px-2 -mx-2 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors";
                            let textClass = "text-zinc-600 dark:text-zinc-400";
                            
                            if (isCooldown) {
                                rowClass += " bg-rose-50 dark:bg-rose-950/10";
                                textClass = "text-rose-500 font-bold";
                            }

                            return `
                            <div class="${rowClass}">
                                <div class="text-[10px] ${textClass} truncate">
                                    ${acc.email.split('@')[0]}
                                </div>
                                <div class="h-0.5 bg-zinc-200 dark:bg-zinc-800 rounded-none overflow-hidden">
                                    <div class="h-full ${quotaColor} rounded-none" style="width: ${acc.avgQuota}%"></div>
                                </div>
                                <div class="text-[9px] ${isCooldown ? 'text-rose-500' : 'text-zinc-500'} font-bold tabular-nums whitespace-nowrap text-right">
                                    ${isCooldown ? 'WAIT' : (acc.resetTime ? formatReset(new Date(acc.resetTime).toISOString()) : 'Ready')}
                                </div>
                            </div>
                            `;
                        }).join('')}
                    </div>
                `}
            </div>
            ` : ''}
        </div>
        `;
    }).join('');

    grid.innerHTML = html;
}

function renderAccountsTable(accounts) {
    const tbody = $('accounts-table-body');
    if (!tbody) return;
    
    if (accounts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-zinc-500 font-mono text-xs italic">// Waiting for accounts...</td></tr>`;
        return;
    }

    tbody.innerHTML = accounts.map(acc => {
        const safeEmail = acc.email.replace(/[@.]/g, '-');
        const isExpanded = expandedAccounts.has(acc.email);
        const lastActive = lastActivityMap.get(acc.email);
        const initials = acc.email.substring(0, 2).toUpperCase();
        const now = Date.now();
        const emailCooldowns = Object.keys(globalCooldowns).filter(k => k.startsWith(acc.email + '|'));
        const isChallenge = acc.challenge && acc.challenge.url;
        const details = organizeAccountDetails(acc);

        const familyHealths = [];
        const familiesWithData = details.map(([cat, quotas]) => {
             let familyHealth = 100;
             if (acc.modelScores) {
                 let scoreSum = 0;
                 let scoreCount = 0;
                 Object.entries(acc.modelScores).forEach(([key, score]) => {
                     const [modelName] = key.split('|');
                     if (getFamilyName(modelName) === cat) {
                         scoreSum += score;
                         scoreCount++;
                     }
                 });
                 if (scoreCount > 0) familyHealth = Math.round(scoreSum / scoreCount);
                 else familyHealth = acc.healthScore;
             } else {
                 familyHealth = acc.healthScore;
             }
             familyHealths.push(familyHealth);
             return { cat, quotas, familyHealth };
        });

        const globalHealth = familyHealths.length > 0 
            ? Math.round(familyHealths.reduce((a, b) => a + b, 0) / familyHealths.length)
            : acc.healthScore;

        const historyHtml = (acc.history || []).map(h => 
            `<div class="w-1 h-1 rounded-full ${h.status === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}" title="${new Date(h.timestamp).toLocaleString()}"></div>`
        ).join('');

        let detailsHtml = '';
        if (details.length > 0) {
            detailsHtml = `
            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8 font-mono">
                <div class="lg:col-span-8">
                    <h4 class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                        Resource Allocations
                    </h4>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        ${familiesWithData.map(({cat, quotas, familyHealth}) => {
                            const best = Math.round(Math.max(...quotas.map(q => q.remainingFraction * 100)));
                            const isSandboxDown = (globalCooldowns[`${acc.email}|sandbox|${cat}`] || 0) > now;
                            const isCliDown = (globalCooldowns[`${acc.email}|cli|${cat}`] || 0) > now;
                            const isAllDown = isSandboxDown && isCliDown;
                            
                            let textColor = isAllDown ? 'text-rose-500' : (best > 50 ? 'text-emerald-500' : (best < 20 ? 'text-rose-500' : 'text-zinc-400 dark:text-zinc-300'));
                            let barColor = isAllDown ? 'bg-rose-500' : (best > 50 ? 'bg-emerald-500' : (best < 20 ? 'bg-rose-500' : 'bg-zinc-300 dark:bg-zinc-600'));
                            let familyBorderColor = isAllDown ? 'border-rose-200 dark:border-rose-900/50' : 'border-zinc-200 dark:border-zinc-800';

                            let earliestFamilyReset = null;
                            quotas.forEach(q => {
                                if (q.resetTime) {
                                    const r = new Date(q.resetTime).getTime();
                                    if (r > now && (!earliestFamilyReset || r < earliestFamilyReset)) earliestFamilyReset = r;
                                }
                            });

                            return `
                            <div class="bg-white dark:bg-[#0f0f0f] rounded border ${familyBorderColor} overflow-hidden group/family transition-colors p-4">
                                <div class="flex items-center justify-between mb-4">
                                    <div class="min-w-0 flex-grow">
                                        <div class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1 truncate">${cat}</div>
                                        <div class="flex items-baseline gap-2">
                                            <span class="text-xl font-bold ${textColor} tracking-tighter leading-none">${best}%</span>
                                            <span class="text-[8px] text-zinc-500 dark:text-zinc-600 font-medium whitespace-nowrap">AVAILABILITY</span>
                                        </div>
                                    </div>
                                    <div class="flex gap-1.5 shrink-0 ml-4">
                                        <div class="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900" title="Sandbox Pool Status">
                                            <span class="text-[8px] font-bold text-zinc-500">SBX</span>
                                            <span class="w-1.2 h-1.2 rounded-full ${isSandboxDown ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}"></span>
                                        </div>
                                        <div class="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900" title="CLI Pool Status">
                                            <span class="text-[8px] font-bold text-zinc-500">CLI</span>
                                            <span class="w-1.2 h-1.2 rounded-full ${isCliDown ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}"></span>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="h-0.5 w-full bg-zinc-100 dark:bg-zinc-900 mt-4 rounded-none overflow-hidden">
                                    <div class="h-full ${barColor} transition-all duration-500 rounded-none" style="width: ${best}%"></div>
                                </div>
                                
                                <div class="flex items-center justify-between mt-2.5">
                                    <div class="text-[8px] text-zinc-500 dark:text-zinc-600 uppercase tracking-wider font-medium shrink-0">Status: OK</div>
                                    <div class="flex items-baseline gap-1.5 shrink-0 min-w-0">
                                        <span class="text-[7px] text-zinc-600 dark:text-zinc-700 uppercase tracking-tighter whitespace-nowrap">Quota resets in</span>
                                        <span class="text-[9px] text-zinc-500 font-bold whitespace-nowrap">${earliestFamilyReset ? formatReset(new Date(earliestFamilyReset).toISOString()) : 'Ready'}</span>
                                    </div>
                                </div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
                <div class="lg:col-span-4 space-y-4">
                    <div>
                        <h4 class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                            Configuration
                        </h4>
                        <div class="space-y-2">
                            <div class="flex justify-between items-center text-[10px] p-2 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/30 group/pid transition-colors">
                                <span class="text-zinc-500">Project ID</span>
                                <div class="flex items-center gap-2">
                                    <span class="text-zinc-700 dark:text-zinc-300 truncate max-w-[120px] font-mono" title="${acc.projectId}">${acc.projectId || 'None'}</span>
                                    <div class="flex items-center gap-1 opacity-0 group-hover/pid:opacity-100 transition-all">
                                        <button onclick="event.stopPropagation(); redisoverProject('${acc.email}')" class="hover:text-emerald-500 p-0.5" title="Rediscover"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>
                                        <button onclick="event.stopPropagation(); editProjectId('${acc.email}', '${acc.projectId || ''}')" class="hover:text-indigo-500 p-0.5" title="Edit"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg></button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
        }

        const knownFamilies = acc.quota ? [...new Set(acc.quota.map(q => getFamilyName(q.groupName)))] : Object.keys(MODEL_FAMILIES);
        const totalPossibleBlocks = knownFamilies.length * 2;
        const activeCooldowns = emailCooldowns.filter(k => globalCooldowns[k] > now).length;
        const isAllDownFinal = activeCooldowns >= totalPossibleBlocks && totalPossibleBlocks > 0;

        return `
        <tr id="row-${safeEmail}" class="group hover:bg-zinc-100/50 dark:hover:bg-zinc-900/50 transition-colors border-b border-zinc-200/50 dark:border-zinc-800/50 last:border-0 cursor-pointer" onclick="toggleAccount('${acc.email}')">
            <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                    <div class="w-6 h-6 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-500 group-hover:text-emerald-500 group-hover:border-emerald-500/30 transition-colors">${initials}</div>
                    <div class="min-w-0">
                         <div class="font-medium text-zinc-700 dark:text-zinc-300 truncate text-xs flex items-center gap-2 group-hover:text-zinc-900 dark:group-hover:text-white transition-colors">
                             ${acc.email}
                             ${isChallenge ? `<a href="${acc.challenge.url || '#'}" target="_blank" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${acc.challenge.reason === 'subscription_required' ? 'bg-rose-50 text-rose-600 border border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800' : 'bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800'} transition-colors cursor-help" onclick="event.stopPropagation()" title="${acc.challenge.message || 'Validation required'}">${acc.challenge.reason === 'subscription_required' ? 'SUB' : 'VERIFY'}</a>` : ''}
                             ${isAllDownFinal ? `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-50 text-rose-600 border border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 animate-pulse dark:border-rose-800">COOLDOWN</span>` : ''}
                        </div>
                        <div class="flex gap-0.5 mt-1.5 opacity-40 group-hover:opacity-100 transition-opacity">${historyHtml}</div>
                    </div>
                </div>
            </td>
            <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold border ${globalHealth > 50 ? 'bg-zinc-50 text-emerald-600 border-emerald-200 dark:bg-zinc-900 dark:text-emerald-500 dark:border-emerald-500/30' : (globalHealth > 20 ? 'bg-zinc-50 text-zinc-600 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800' : 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-900/30 dark:text-rose-500 dark:border-rose-800')}">
                        ${globalHealth}%
                    </span>
                </div>
            </td>
            <td class="px-4 py-3">
                <span class="text-[10px] text-zinc-500 group-hover:text-zinc-600 dark:group-hover:text-zinc-400 transition-colors" id="time-${safeEmail}">${formatTimeAgo(lastActive)}</span>
            </td>
            <td class="px-4 py-3 text-right">
                 <div class="flex items-center justify-end gap-2" onclick="event.stopPropagation()">
                     <button onclick="resetAccountHealth('${acc.email}')" class="text-zinc-400 dark:text-zinc-600 hover:text-zinc-900 dark:hover:text-white transition-colors p-1" title="Reset Health"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>
                     <button onclick="deleteAccount('${acc.email}')" class="text-zinc-400 dark:text-zinc-600 hover:text-rose-500 transition-colors p-1" title="Remove"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
                     <svg class="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-600 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                 </div>
            </td>
        </tr>
        <tr id="detail-${safeEmail}" class="${isExpanded ? '' : 'hidden'} bg-zinc-50 dark:bg-[#050505] shadow-inner transition-colors">
            <td colspan="4" class="px-6 py-6 border-b border-zinc-200 dark:border-zinc-800">
                ${detailsHtml}
                <div class="mt-6 flex justify-end">
                    <button onclick="deleteAccount('${acc.email}')" class="text-[10px] text-rose-600 dark:text-rose-500 hover:text-rose-700 dark:hover:text-rose-400 font-bold uppercase tracking-wider border border-rose-200 dark:border-rose-900/30 hover:border-rose-300 dark:hover:border-rose-900/60 bg-rose-50 dark:bg-rose-950/10 hover:bg-rose-100 dark:hover:bg-rose-950/30 px-3 py-1.5 rounded transition-all">Remove Permanently</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function updateUI(data) {
    if (Array.isArray(data)) {
        globalAccounts = data;
    } else {
        if (data.accounts) globalAccounts = data.accounts;
        if (data.cooldowns) globalCooldowns = data.cooldowns;
        if (data.supportedModels) globalSupportedModels = data.supportedModels;
        if (data.codexModels) globalCodexModels = data.codexModels;
        if (data.version && $('app-version')) $('app-version').textContent = 'v' + data.version;
    }
    
    const accounts = globalAccounts || [];
    accounts.sort((a,b) => b.healthScore - a.healthScore);

    if ($('stat-total-accounts')) $('stat-total-accounts').textContent = accounts.length;
    if ($('last-updated')) $('last-updated').textContent = new Date().toLocaleTimeString();

    renderDashboardFamilies();
    renderAccountsTable(accounts);
}

function toggleAccount(email) {
    if (expandedAccounts.has(email)) expandedAccounts.delete(email);
    else expandedAccounts.add(email);
    renderAccountsTable(globalAccounts);
}

async function deleteAccount(email) {
    if (!confirm(`Delete ${email}?`)) return;
    await fetch(`/api/accounts/${email}`, { method: 'DELETE' });
    globalAccounts = globalAccounts.filter(a => a.email !== email);
    renderAccountsTable(globalAccounts);
}

async function resetAccountHealth(email) {
    if (!confirm(`Reset health for ${email}?`)) return;
    await fetch(`/api/accounts/${email}/reset`, { method: 'POST' });
    addLog(`[ACTION] Health reset for ${email}`);
}

async function resetAllAccounts() {
    if (!confirm('Are you sure you want to reset the state of ALL accounts? This will clear all cooldowns, validation flags, and health scores.')) return;
    try {
        const res = await fetch('/api/accounts/reset-all', { method: 'POST' });
        if (res.ok) {
            addLog('[ACTION] Reset all accounts state successfully');
        } else {
            addLog('[ERROR] Failed to reset all accounts');
        }
    } catch (e) {
        addLog(`[ERROR] Reset all failed: ${e.message}`);
    }
}

async function editProjectId(email, currentPid) {
    const newPid = prompt(`Enter new Project ID for ${email}:`, currentPid);
    if (newPid === null || newPid === currentPid) return;
    
    try {
        const res = await fetch(`/api/accounts/${email}/project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: newPid })
        });
        if (res.ok) {
            addLog(`[ACTION] Updated Project ID for ${email} to ${newPid}`);
        } else {
            addLog(`[ERROR] Failed to update Project ID for ${email}`);
        }
    } catch (e) {
        addLog(`[ERROR] Update Project ID failed: ${e.message}`);
    }
}

async function redisoverProject(email) {
    addLog(`[ACTION] Rediscovering project for ${email}...`);
    try {
        const res = await fetch(`/api/accounts/${email}/project/rediscover`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            addLog(`[SUCCESS] New project discovered for ${email}: ${data.projectId}`);
        } else {
            const err = await res.text();
            addLog(`[ERROR] Rediscovery failed: ${err}`);
        }
    } catch (e) {
        addLog(`[ERROR] Rediscovery failed: ${e.message}`);
    }
}

function codexWindowLabel(window, fallback) {
    const seconds = Number(window?.limitWindowSeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
        if (seconds >= 4 * 3600 && seconds <= 6 * 3600) return '5h';
        if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return '7d';
        if (seconds % 86400 === 0) return `${seconds / 86400}d`;
        if (seconds % 3600 === 0) return `${seconds / 3600}h`;
        return `${Math.round(seconds / 60)}m`;
    }
    return fallback;
}

function codexQuotaWindows(usage) {
    if (!usage) return [];
    const windows = [
        usage.primaryWindow ? { ...usage.primaryWindow, fallback: 'primary' } : null,
        usage.secondaryWindow ? { ...usage.secondaryWindow, fallback: 'secondary' } : null,
    ].filter(Boolean);
    return windows.sort((a, b) => {
        const aa = Number(a.limitWindowSeconds);
        const bb = Number(b.limitWindowSeconds);
        if (!Number.isFinite(aa)) return 1;
        if (!Number.isFinite(bb)) return -1;
        return aa - bb;
    });
}

function codexResetTarget(window, fetchedAt) {
    const direct = Number(window?.resetAt);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const remaining = Number(window?.resetAfterSeconds);
    if (Number.isFinite(remaining) && remaining >= 0 && Number.isFinite(fetchedAt)) {
        return fetchedAt + remaining * 1000;
    }
    return null;
}

function codexQuotaBarClass(remaining) {
    if (remaining >= 80) return 'bg-emerald-500';
    if (remaining < 20) return 'bg-rose-500';
    return 'bg-zinc-300 dark:bg-zinc-600';
}

function renderCodexAccounts() {
    const tbody = $('codex-accounts-table-body');
    if (!tbody) return;
    if (!globalCodexAccounts.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-xs text-zinc-400">// No Codex accounts. Add one with device-code login.</td></tr>';
        return;
    }
    const now = Date.now();
    tbody.innerHTML = globalCodexAccounts.map(account => {
        const cooling = Number(account.cooldownUntil || 0) > now;
        const expiresAt = Number(account.expiresAt || 0);
        const expiry = expiresAt > now ? `${Math.max(1, Math.ceil((expiresAt - now) / 60000))}m` : 'refresh on use';
        const usage = account.usage || null;
        const windows = codexQuotaWindows(usage);
        const usageHtml = account.usageError
            ? `<div class="text-[9px] text-rose-500" title="${escapeHtml(account.usageError.message || 'Quota unavailable')}">quota unavailable</div>`
            : windows.length
                ? windows.map(window => {
                    const usedRaw = Number(window.usedPercent);
                    const hasUsage = Number.isFinite(usedRaw);
                    const used = hasUsage ? Math.max(0, Math.min(100, usedRaw)) : 0;
                    const remaining = hasUsage ? Math.max(0, 100 - used) : 0;
                    const remainingText = hasUsage ? `${remaining.toFixed(remaining % 1 ? 1 : 0)}% left` : '—';
                    const usedText = hasUsage ? `${used.toFixed(used % 1 ? 1 : 0)}% used` : 'Usage unavailable';
                    return `<div class="grid grid-cols-[28px_1fr_58px] items-center gap-2 min-w-[190px]" title="${escapeHtml(usedText)}">
                        <span class="text-[9px] uppercase text-zinc-400">${escapeHtml(codexWindowLabel(window, window.fallback))}</span>
                        <div class="h-0.5 bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                            <div class="h-full ${codexQuotaBarClass(remaining)} transition-all duration-500" style="width: ${remaining}%"></div>
                        </div>
                        <span class="text-[9px] font-bold tabular-nums text-right text-zinc-600 dark:text-zinc-400">${escapeHtml(remainingText)}</span>
                    </div>`;
                }).join('')
                : '<span class="text-[9px] text-zinc-400">loading…</span>';
        const resetHtml = account.usageError
            ? '<span class="text-[9px] text-zinc-400">—</span>'
            : windows.length
                ? windows.map(window => {
                    const target = codexResetTarget(window, account.usageFetchedAt);
                    const relative = target ? formatReset(target) : '—';
                    const title = target ? new Date(target).toLocaleString() : 'Reset time unavailable';
                    return `<div class="flex items-center gap-2 whitespace-nowrap" title="${escapeHtml(title)}"><span class="text-[9px] uppercase text-zinc-400 w-7">${escapeHtml(codexWindowLabel(window, window.fallback))}</span><span class="text-[10px] font-mono text-zinc-700 dark:text-zinc-300">${escapeHtml(relative)}</span></div>`;
                }).join('')
                : '<span class="text-[9px] text-zinc-400">loading…</span>';
        const quotaBlocked = usage?.limitReached === true || usage?.allowed === false || windows.some(window => Number(window.usedPercent) >= 100);
        const statusClass = quotaBlocked
            ? 'border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400'
            : cooling
                ? 'border-amber-200 dark:border-amber-900 text-amber-600 dark:text-amber-400'
                : 'border-emerald-200 dark:border-emerald-900 text-emerald-600 dark:text-emerald-400';
        const statusText = quotaBlocked ? 'Limit' : cooling ? 'Cooldown' : 'Ready';
        return `<tr class="hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors">
            <td class="px-4 py-3">
                <div class="text-xs text-zinc-800 dark:text-zinc-200">${escapeHtml(account.email)}</div>
                <div class="mt-1 text-[9px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">${escapeHtml(usage?.planType || 'Codex OAuth')}</div>
            </td>
            <td class="px-4 py-3 text-[10px] text-zinc-500 font-mono">${escapeHtml(account.accountId || '-')}</td>
            <td class="px-4 py-3 text-[10px] text-zinc-500">${escapeHtml(expiry)}</td>
            <td class="px-4 py-3 space-y-1">${usageHtml}</td>
            <td class="px-4 py-3 space-y-1">${resetHtml}</td>
            <td class="px-4 py-3">
                <span class="inline-flex px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase ${statusClass}">${statusText}</span>
            </td>
            <td class="px-4 py-3 text-right">
                <button data-codex-delete="${encodeURIComponent(account.email)}" class="px-2 py-1 text-[9px] uppercase tracking-wider text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded transition-colors">Remove</button>
            </td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-codex-delete]').forEach(button => {
        button.addEventListener('click', () => deleteCodexAccount(decodeURIComponent(button.dataset.codexDelete)));
    });
}

async function loadCodexUsage() {
    if (!globalCodexAccounts.length) return;
    try {
        const response = await fetch('/api/codex/usage', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const byEmail = new Map((data.accounts || []).map(snapshot => [snapshot.email, snapshot]));
        const fetchedAt = Number(data.generatedAt) || Date.now();
        globalCodexAccounts = globalCodexAccounts.map(account => {
            const snapshot = byEmail.get(account.email);
            return {
                ...account,
                usage: snapshot?.usage || null,
                usageError: snapshot?.error || null,
                usageFetchedAt: fetchedAt,
            };
        });
        renderCodexAccounts();
        renderDashboardFamilies();
    } catch (error) {
        addLog(`[CODEX] Usage refresh failed: ${error.message}`);
    }
}

async function loadCodexAccounts() {
    try {
        const response = await fetch('/api/codex/accounts');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        globalCodexAccounts = data.accounts || [];
        renderCodexAccounts();
        renderDashboardFamilies();
        await loadCodexUsage();
    } catch (error) {
        const tbody = $('codex-accounts-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-xs text-rose-500">${escapeHtml(error.message)}</td></tr>`;
    }
}

async function deleteCodexAccount(email) {
    if (!confirm(`Delete Codex account ${email}?`)) return;
    const response = await fetch(`/api/codex/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (!response.ok) {
        addLog(`[CODEX] Failed to remove ${email}: HTTP ${response.status}`);
        return;
    }
    addLog(`[CODEX] Removed ${email}`);
    await loadCodexAccounts();
}

function setCodexDeviceStatus(message, isError = false) {
    const status = $('codex-device-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('text-rose-500', isError);
    status.classList.toggle('text-zinc-500', !isError);
}

async function startCodexDeviceLogin() {
    const modal = $('codex-device-modal');
    const content = $('codex-device-content');
    if (!modal || !content) return;
    if (codexLoginPollTimer) clearTimeout(codexLoginPollTimer);
    activeCodexLoginId = null;
    modal.classList.remove('hidden');
    content.classList.add('hidden');
    setCodexDeviceStatus('Requesting a one-time device code...');
    try {
        const response = await fetch('/api/codex/auth/device/start', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        activeCodexLoginId = data.loginId;
        $('codex-device-link').textContent = data.verificationUrl;
        $('codex-device-link').href = data.verificationUrl;
        $('codex-device-open').href = data.verificationUrl;
        $('codex-device-code').textContent = data.userCode;
        content.classList.remove('hidden');
        setCodexDeviceStatus('Waiting for authorization in your browser...');
        scheduleCodexLoginPoll();
    } catch (error) {
        setCodexDeviceStatus(error.message || String(error), true);
    }
}

function scheduleCodexLoginPoll() {
    if (!activeCodexLoginId) return;
    codexLoginPollTimer = setTimeout(pollCodexDeviceLogin, 1000);
}

async function pollCodexDeviceLogin() {
    const loginId = activeCodexLoginId;
    if (!loginId) return;
    try {
        const response = await fetch(`/api/codex/auth/device/${encodeURIComponent(loginId)}`);
        const state = await response.json();
        if (!response.ok) throw new Error(state.error || `HTTP ${response.status}`);
        if (state.status === 'waiting') {
            setCodexDeviceStatus('Waiting for authorization in your browser...');
            scheduleCodexLoginPoll();
            return;
        }
        if (state.status === 'completed') {
            setCodexDeviceStatus(`Signed in as ${state.email || 'Codex account'}.`);
            activeCodexLoginId = null;
            await loadCodexAccounts();
            addLog(`[CODEX] Added ${state.email || 'account'} via device code`);
            setTimeout(() => $('codex-device-modal')?.classList.add('hidden'), 900);
            return;
        }
        setCodexDeviceStatus(state.error || `Device login ${state.status}.`, state.status === 'failed');
        activeCodexLoginId = null;
    } catch (error) {
        setCodexDeviceStatus(error.message || String(error), true);
        activeCodexLoginId = null;
    }
}

async function cancelCodexDeviceLogin() {
    if (codexLoginPollTimer) clearTimeout(codexLoginPollTimer);
    codexLoginPollTimer = null;
    const loginId = activeCodexLoginId;
    activeCodexLoginId = null;
    if (loginId) {
        try { await fetch(`/api/codex/auth/device/${encodeURIComponent(loginId)}`, { method: 'DELETE' }); } catch {}
    }
    $('codex-device-modal')?.classList.add('hidden');
}

async function copyCodexDeviceCode() {
    const code = $('codex-device-code')?.textContent || '';
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        setCodexDeviceStatus('Code copied. Waiting for authorization...');
    } catch {
        setCodexDeviceStatus('Copy failed; select the code manually.', true);
    }
}

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        currentConfig = await res.json();
        globalCodexModels = currentConfig.codex?.models || globalCodexModels;
        renderDashboardFamilies();
    } catch (e) {
        console.error('[Config] Failed to load:', e);
    }
}

function openConfigModal() {
    if (!currentConfig) {
        addLog('[CONFIG] Configuration not loaded yet');
        return;
    }

    $('cfg-cooldown-default').value = currentConfig.rotation.cooldown.defaultDurationMs;
    $('cfg-cooldown-max').value = currentConfig.rotation.cooldown.maxDurationMs;
    $('cfg-health-min').value = currentConfig.scoring.healthRange.min;
    $('cfg-health-max').value = currentConfig.scoring.healthRange.max;
    $('cfg-health-initial').value = currentConfig.scoring.healthRange.initial;
    $('cfg-penalty-api').value = currentConfig.scoring.penalties.apiError;
    $('cfg-penalty-refresh').value = currentConfig.scoring.penalties.refreshError;
    $('cfg-reward-success').value = currentConfig.scoring.rewards.success;
    $('cfg-weight-health').value = currentConfig.scoring.weights.health;
    $('cfg-weight-lru').value = currentConfig.scoring.weights.lru;
    $('cfg-blacklist').value = currentConfig.models.blacklist.join('\n');
    $('cfg-retry-max').value = currentConfig.retry.maxAttempts;
    $('cfg-retry-threshold').value = currentConfig.retry.transientRetryThresholdSeconds;
    $('cfg-codex-enabled').checked = currentConfig.codex?.enabled !== false;
    $('cfg-codex-models').value = (currentConfig.codex?.models || []).join('\n');
    $('cfg-codex-responses-timeout').value = currentConfig.codex?.responsesTimeoutMs || 120000;
    $('cfg-codex-compact-timeout').value = currentConfig.codex?.compactTimeoutMs || 60000;
    $('config-modal').classList.remove('hidden');
}

function closeConfigModal() {
    $('config-modal').classList.add('hidden');
}

async function saveConfig() {
    const updates = {
        rotation: {
            cooldown: {
                defaultDurationMs: parseInt($('cfg-cooldown-default').value),
                maxDurationMs: parseInt($('cfg-cooldown-max').value)
            }
        },
        scoring: {
            healthRange: {
                min: parseInt($('cfg-health-min').value),
                max: parseInt($('cfg-health-max').value),
                initial: parseInt($('cfg-health-initial').value)
            },
            penalties: {
                apiError: parseInt($('cfg-penalty-api').value),
                refreshError: parseInt($('cfg-penalty-refresh').value)
            },
            rewards: {
                success: parseInt($('cfg-reward-success').value)
            },
            weights: {
                health: parseFloat($('cfg-weight-health').value),
                lru: parseFloat($('cfg-weight-lru').value)
            }
        },
        models: {
            blacklist: $('cfg-blacklist').value.split('\n').map(l => l.trim()).filter(Boolean)
        },
        retry: {
            maxAttempts: parseInt($('cfg-retry-max').value),
            transientRetryThresholdSeconds: parseInt($('cfg-retry-threshold').value)
        },
        codex: {
            enabled: $('cfg-codex-enabled').checked,
            models: $('cfg-codex-models').value.split('\n').map(line => line.trim()).filter(Boolean),
            responsesTimeoutMs: parseInt($('cfg-codex-responses-timeout').value),
            compactTimeoutMs: parseInt($('cfg-codex-compact-timeout').value)
        }
    };

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        
        if (res.ok) {
            currentConfig = await res.json();
            globalCodexModels = currentConfig.codex?.models || [];
            renderDashboardFamilies();
            addLog('[CONFIG] Configuration saved successfully');
            closeConfigModal();
        } else {
            const error = await res.json();
            addLog(`[CONFIG] Failed to save: ${error.error}`);
        }
    } catch (e) {
        addLog(`[CONFIG] Failed to save: ${e.message}`);
    }
}

function setupSSE() {
    const es = new EventSource('/api/sse');
    es.addEventListener('init', e => updateUI(JSON.parse(e.data)));
    es.addEventListener('update', e => updateUI(JSON.parse(e.data)));
    es.addEventListener('cooldown', e => updateUI(JSON.parse(e.data)));
    es.addEventListener('flash', e => {
        const { email, status } = JSON.parse(e.data);
        const safeEmail = email.replace(/[@.]/g, '-');
        lastActivityMap.set(email, Date.now());
        const timeEl = $(`time-${safeEmail}`);
        if (timeEl) timeEl.textContent = 'Just now';
        const row = $(`row-${safeEmail}`);
        if (row) {
            const isError = status === 'error';
            const activeClass = isError ? 'flash-error' : 'flash-active';
            row.classList.remove('flash-active', 'flash-error');
            void row.offsetWidth; 
            row.classList.add(activeClass);
            const circle = row.querySelector('.rounded-full');
            if (circle) {
                const ringClass = isError ? 'ring-rose-500/50' : 'ring-emerald-500/50';
                circle.classList.add('ring-4', ringClass, 'transition-all');
                setTimeout(() => circle.classList.remove('ring-4', ringClass), 2500);
            }
        }
    });
    es.addEventListener('log', e => {
        const data = JSON.parse(e.data);
        addLog(data.message);
    });
}

function initializeApp() {
    initTheme();
    loadConfig();
    loadCodexAccounts();
    setupSSE();
    setupLogsInteraction();
    setInterval(() => {
        const hasActiveCooldowns = Object.values(globalCooldowns).some(expiry => expiry > Date.now());
        if (hasActiveCooldowns) {
            renderAccountsTable(globalAccounts);
        } else {
            globalAccounts.forEach(acc => {
                const safe = acc.email.replace(/[@.]/g, '-');
                const el = $(`time-${safe}`);
                if (el) el.textContent = formatTimeAgo(lastActivityMap.get(acc.email));
            });
        }
    }, 1000);
    setInterval(loadCodexUsage, 60_000);
}

window.initializeApp = initializeApp;
