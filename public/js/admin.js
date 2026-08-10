// Admin panel client.  Polls /admin/api/state and renders it.
//
// Everything user-supplied (driver names, IPs, emoji) is inserted with
// textContent rather than innerHTML - driverName in particular is set by
// whoever is driving, so it must never be treated as markup.

(function () {
    'use strict';

    var POLL_MS = 3000;
    var timer = null;
    var busy = false;

    function $(id) { return document.getElementById(id); }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function fmtDuration(ms) {
        if (ms === null || ms === undefined || isNaN(ms)) return '?';
        var s = Math.floor(ms / 1000);
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = s % 60;
        if (h > 0) return h + 'h ' + m + 'm';
        if (m > 0) return m + 'm ' + sec + 's';
        return sec + 's';
    }

    function fmtBytes(b) {
        if (!b) return '?';
        return Math.round(b / 1048576) + ' MB';
    }

    function toast(msg, isError) {
        var t = $('admin-toast');
        t.textContent = msg;
        t.className = 'admin-toast ' + (isError ? 'admin-toast-error' : 'admin-toast-ok');
        setTimeout(function () {
            if (t.textContent === msg) { t.textContent = ''; t.className = 'admin-toast'; }
        }, 4000);
    }

    function post(url, okMsg) {
        if (busy) return;
        busy = true;
        fetch(url, {
            method: 'POST',
            headers: { 'X-Requested-With': 'electron-admin' },
            credentials: 'same-origin'
        }).then(function (r) {
            if (r.status === 401) { window.location = '/admin'; return null; }
            return r.json().catch(function () { return { ok: false, error: 'bad response' }; });
        }).then(function (data) {
            if (!data) return;
            if (data.ok) toast(okMsg || 'Done', false);
            else toast(data.error || 'Failed', true);
            refresh();
        }).catch(function (e) {
            toast('Request failed: ' + e.message, true);
        }).then(function () {
            busy = false;
        });
    }

    function riderRow(rider) {
        var tr = el('tr');
        tr.appendChild(el('td', 'admin-mono', rider.ip || 'unknown'));
        tr.appendChild(el('td', null, fmtDuration(rider.durationMs)));

        var light = el('td');
        if (rider.trafficLight) {
            var dot = el('span', 'admin-light admin-light-' + String(rider.trafficLight).toLowerCase());
            dot.title = String(rider.trafficLight);
            light.appendChild(dot);
        } else {
            light.textContent = '-';
        }
        tr.appendChild(light);

        tr.appendChild(el('td', null, rider.emoji || '-'));
        tr.appendChild(el('td', 'admin-mono admin-muted', String(rider.socketId).slice(0, 8)));

        var actions = el('td');
        var kick = el('button', 'roundy-btn admin-btn-tiny admin-btn-danger', 'Kick');
        kick.addEventListener('click', function () {
            if (!confirm('Disconnect rider at ' + rider.ip + '?')) return;
            post('/admin/api/rider/' + encodeURIComponent(rider.socketId) + '/kick', 'Rider kicked');
        });
        actions.appendChild(kick);
        tr.appendChild(actions);
        return tr;
    }

    function sessionCard(s) {
        var card = el('div', 'admin-card');

        var head = el('div', 'admin-card-head');
        var titleWrap = el('div', 'admin-card-title');

        var name = el('span', 'admin-sess-name', s.driverName || '(no name)');
        titleWrap.appendChild(name);

        var id = el('a', 'admin-mono admin-sess-id', s.sessId);
        id.href = '/player/play/' + encodeURIComponent(s.sessId);
        id.target = '_blank';
        id.rel = 'noopener';
        titleWrap.appendChild(id);

        var kindLabel = { human: 'driver', automated: 'auto', playlist: 'jukebox', none: 'no driver' }[s.driverKind] || s.driverKind;
        titleWrap.appendChild(el('span', 'admin-tag admin-tag-' + s.driverKind, kindLabel));
        if (s.publicSession) titleWrap.appendChild(el('span', 'admin-tag admin-tag-public', 'public'));
        if (s.blindfoldRiders) titleWrap.appendChild(el('span', 'admin-tag', 'blindfold'));

        head.appendChild(titleWrap);

        var controls = el('div', 'admin-card-controls');
        if (s.driverKind === 'automated' || s.driverKind === 'playlist') {
            var stopBtn = el('button', 'roundy-btn admin-btn-small', 'Stop driver');
            stopBtn.addEventListener('click', function () {
                if (!confirm('Stop the automated driver on ' + s.sessId + '?')) return;
                post('/admin/api/session/' + encodeURIComponent(s.sessId) + '/stop-driver', 'Driver stopped');
            });
            controls.appendChild(stopBtn);
        }
        var endBtn = el('button', 'roundy-btn admin-btn-small admin-btn-danger', 'End session');
        endBtn.addEventListener('click', function () {
            if (!confirm('End session ' + s.sessId + ' and disconnect ' + s.riderCount + ' rider(s)?')) return;
            post('/admin/api/session/' + encodeURIComponent(s.sessId) + '/end', 'Session ended');
        });
        controls.appendChild(endBtn);
        head.appendChild(controls);
        card.appendChild(head);

        var meta = el('div', 'admin-card-meta');
        meta.appendChild(el('span', null, 'age ' + fmtDuration(s.ageMs)));
        meta.appendChild(el('span', null, s.riderCount + ' rider' + (s.riderCount === 1 ? '' : 's')));
        if (s.driverConnected) meta.appendChild(el('span', 'admin-mono', 'driver ' + s.driverIp));
        if (s.minutesRemaining !== null && s.minutesRemaining !== undefined) {
            meta.appendChild(el('span', null, Math.max(0, Math.round(s.minutesRemaining)) + 'm left'));
        }
        if (s.camUrl) meta.appendChild(el('span', null, 'cam: ' + s.camUrl));
        card.appendChild(meta);

        if (s.driverComments) card.appendChild(el('div', 'admin-card-comments', s.driverComments));

        if (s.riders.length) {
            var table = el('table', 'admin-rider-table');
            var thead = el('thead');
            var hrow = el('tr');
            ['IP', 'Connected', 'Light', 'Emoji', 'Socket', ''].forEach(function (h) {
                hrow.appendChild(el('th', null, h));
            });
            thead.appendChild(hrow);
            table.appendChild(thead);
            var tbody = el('tbody');
            s.riders.forEach(function (r) { tbody.appendChild(riderRow(r)); });
            table.appendChild(tbody);
            card.appendChild(table);
        } else {
            card.appendChild(el('p', 'admin-muted admin-empty-riders', 'No riders connected.'));
        }

        return card;
    }

    function render(data) {
        $('stat-sessions').textContent = data.totals.sessions;
        $('stat-riders').textContent = data.totals.riders;
        $('stat-human').textContent = data.totals.humanDrivers;
        $('stat-auto').textContent = data.totals.automatedDrivers;
        $('stat-uptime').textContent = fmtDuration(data.uptimeSec * 1000);
        $('stat-mem').textContent = fmtBytes(data.memory);

        var playlistBtn = $('admin-start-playlist');
        playlistBtn.disabled = !data.playlistConfigured ||
            data.sessions.some(function (s) { return s.sessId === data.playlistSessId; });

        var wrap = $('admin-sessions');
        wrap.textContent = '';
        if (!data.sessions.length) {
            wrap.appendChild(el('p', 'admin-muted', 'No active sessions.'));
            return;
        }
        data.sessions.forEach(function (s) { wrap.appendChild(sessionCard(s)); });
    }

    function refresh() {
        return fetch('/admin/api/state', { credentials: 'same-origin' })
            .then(function (r) {
                if (r.status === 401) { window.location = '/admin'; return null; }
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                if (!data) return;
                render(data);
                $('admin-status').textContent = 'updated ' + new Date().toLocaleTimeString();
                $('admin-status').className = 'admin-muted';
            })
            .catch(function (e) {
                $('admin-status').textContent = 'error: ' + e.message;
                $('admin-status').className = 'admin-status-error';
            });
    }

    function startPolling() {
        stopPolling();
        if (!$('admin-autorefresh').checked) return;
        timer = setInterval(function () {
            if (document.hidden) return;   // don't poll a backgrounded tab
            refresh();
        }, POLL_MS);
    }

    function stopPolling() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    document.addEventListener('DOMContentLoaded', function () {
        $('admin-refresh').addEventListener('click', function () { refresh(); });
        $('admin-autorefresh').addEventListener('change', startPolling);
        $('admin-start-auto').addEventListener('click', function () {
            if (!confirm('Start a new automated session with default settings?')) return;
            post('/admin/api/automated/start', 'Automated session started');
        });
        $('admin-start-playlist').addEventListener('click', function () {
            post('/admin/api/playlist/start', 'Jukebox started');
        });
        // Coming back to a backgrounded tab should show current data at once
        // rather than whatever was on screen when polling paused.
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) refresh();
        });

        refresh();
        startPolling();
    });
})();
