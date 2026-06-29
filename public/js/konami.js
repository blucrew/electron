/* ═══════════════════════════════════════════════════════
   E L E C T R O N  —  KONAMI CODE EASTER EGG
   ↑ ↑ ↓ ↓ ← → ← → B A
   ═══════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const KONAMI_SEQ = [
        'ArrowUp','ArrowUp','ArrowDown','ArrowDown',
        'ArrowLeft','ArrowRight','ArrowLeft','ArrowRight',
        'b','a'
    ];

    const ALL_PORTRAITS = [
        'Sir_Thorn_portrait.png',
        'Sir_Thorn_portrait_DARK_BIRTHDAY.png',
        'Sir_Thorn_portrait_DARK_EASTER.png',
        'Sir_Thorn_portrait_DARK_Halloween.png',
        'Sir_Thorn_portrait_DARK_JULY4.png',
        'Sir_Thorn_portrait_DARK_NYE.png',
        'Sir_Thorn_portrait_DARK_STPADDYS.png',
        'Sir_Thorn_portrait_DARK_VALENTINE.png',
        'Sir_Thorn_portrait_DARK_XMAS.png',
        'Sir_Thorn_portrait_LIGHT.png',
        'Sir_Thorn_portrait_LIGHT_BIRTHDAY.png',
        'Sir_Thorn_portrait_LIGHT_EASTER.png',
        'Sir_Thorn_portrait_LIGHT_HALLOWEEN.png',
        'Sir_Thorn_portrait_LIGHT_JULY4.png',
        'Sir_Thorn_portrait_LIGHT_NYE.png',
        'Sir_Thorn_portrait_LIGHT_STPADDYS.png',
        'Sir_Thorn_portrait_LIGHT_VALENTINE.png',
        'Sir_Thorn_portrait_LIGHT_XMAS.png'
    ];

    let konamiIdx       = 0;
    let vaporwaveActive = false;
    let prevTheme       = null;
    let animId          = null;
    let counterTimeout  = null;
    let counterValue    = 880;
    let clickSpawnOn    = false;
    let origThemeClick  = null;

    const KEY_SYMBOLS = {
        'ArrowUp':'↑','ArrowDown':'↓','ArrowLeft':'←',
        'ArrowRight':'→','b':'B','a':'A'
    };

    /* ── Konami listener ───────────────────────────────── */
    document.addEventListener('keydown', function (e) {
        if (e.key === KONAMI_SEQ[konamiIdx]) {
            if (konamiIdx === 0) loadFonts(); // preload font as soon as sequence starts
            konamiIdx++;
            showKonamiKey(konamiIdx - 1);
            if (konamiIdx === KONAMI_SEQ.length) {
                konamiIdx = 0;
                hideKonamiBar(true);
                if (!vaporwaveActive) activate();
            }
        } else {
            if (konamiIdx > 0) hideKonamiBar(false);
            konamiIdx = (e.key === KONAMI_SEQ[0]) ? 1 : 0;
            if (konamiIdx === 1) { loadFonts(); showKonamiKey(0); }
        }
    });

    /* ── Konami key display ────────────────────────────── */
    function showKonamiKey(idx) {
        let bar = document.getElementById('konami-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'konami-bar';
            bar.innerHTML = KONAMI_SEQ.map((k, i) =>
                `<span class="kb-key" id="kb-${i}">${KEY_SYMBOLS[k]}</span>`
            ).join('');
            document.body.appendChild(bar);
        }
        const slot = document.getElementById('kb-' + idx);
        if (slot) {
            slot.classList.add('kb-lit');
            // brief flash then settle
            setTimeout(() => slot.classList.add('kb-settled'), 350);
        }
    }

    function hideKonamiBar(success) {
        const bar = document.getElementById('konami-bar');
        if (!bar) return;
        if (!success) bar.classList.add('kb-fail');
        setTimeout(() => bar.remove(), success ? 300 : 500);
    }

    /* ── Activation ────────────────────────────────────── */
    function activate() {
        vaporwaveActive = true;
        prevTheme = (typeof lightTheme !== 'undefined' && lightTheme) ? 'light' : 'dark';
        showFlash();
        setupCanvas();
        document.body.classList.add('vaporwave');
        replaceText();
        setTimeout(startRain, 3500);
        insertCounter();
        createSticker();
        hookThemeButton();
    }

    function deactivateVisuals() {
        vaporwaveActive = false;
        if (animId) { cancelAnimationFrame(animId); animId = null; }
        if (counterTimeout) { clearTimeout(counterTimeout); counterTimeout = null; }
        const c = document.getElementById('vaporwave-bg-canvas');
        if (c) c.remove();
        const counter = document.getElementById('vaporwave-counter');
        if (counter) counter.remove();
        const sticker = document.getElementById('radical-sticker');
        if (sticker) sticker.remove();
        document.body.classList.remove('vaporwave');
        restoreThemeButton();
        // Restore previous theme without extra toggle if already correct
        if (typeof lightTheme !== 'undefined' && typeof toggleTheme === 'function') {
            const current = lightTheme ? 'light' : 'dark';
            if (current !== prevTheme) toggleTheme();
        }
    }

    /* ── Font loader ───────────────────────────────────── */
    function loadFonts() {
        if (document.getElementById('vaporwave-fonts')) return;
        const link = document.createElement('link');
        link.id   = 'vaporwave-fonts';
        link.rel  = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Bungee+Outline&family=Bungee&display=swap';
        document.head.appendChild(link);
    }

    /* ── Flash overlay ─────────────────────────────────── */
    function showFlash() {
        const el = document.createElement('div');
        el.id = 'konami-flash';
        el.innerHTML =
            '<div class="kf-title">E L E C T R O N</div>' +
            '<div class="kf-sub">CHEAT CODE ACCEPTED</div>' +
            '<div class="kf-counter">LIVE LOAD COUNTER: <span>' +
                pad(counterValue) + '</span></div>';
        document.body.appendChild(el);
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('kf-visible')));
        setTimeout(() => el.classList.remove('kf-visible'), 2800);
        setTimeout(() => el.remove(), 4200);
    }

    /* ── Canvas background ─────────────────────────────── */
    function setupCanvas() {
        const canvas = document.createElement('canvas');
        canvas.id = 'vaporwave-bg-canvas';
        document.body.prepend(canvas);

        function resize() {
            canvas.width  = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        resize();
        window.addEventListener('resize', resize);

        const ctx = canvas.getContext('2d');
        let t = 0, lastTs = null;

        (function loop(ts) {
            if (!vaporwaveActive) return;
            const dt = lastTs ? (ts - lastTs) / 1000 : 0;
            lastTs = ts;
            t += dt;
            drawBg(ctx, canvas.width, canvas.height, t);
            animId = requestAnimationFrame(loop);
        })(performance.now());
    }

    function drawBg(ctx, W, H, t) {
        const hy = H * 0.52;
        ctx.clearRect(0, 0, W, H);
        drawSky(ctx, W, hy);
        drawSun(ctx, W, hy, H);
        drawMountains(ctx, W, hy, H);
        drawGround(ctx, W, H, hy);
        drawGrid(ctx, W, H, hy, t);
    }

    function drawSky(ctx, W, hy) {
        const g = ctx.createLinearGradient(0, 0, 0, hy);
        g.addColorStop(0,    '#0d0020');
        g.addColorStop(0.42, '#1e0050');
        g.addColorStop(0.76, '#6b008a');
        g.addColorStop(1,    '#ff1493');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, hy);
    }

    function drawSun(ctx, W, hy, H) {
        const cx = W / 2, r = H * 0.21;
        const g = ctx.createRadialGradient(cx, hy, 0, cx, hy, r);
        g.addColorStop(0,    '#fff0a0');
        g.addColorStop(0.28, '#ffb040');
        g.addColorStop(0.62, '#ff2080');
        g.addColorStop(1,    'rgba(160,0,160,0)');

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, hy, r, Math.PI, 0);
        ctx.closePath();
        ctx.clip();

        ctx.fillStyle = g;
        ctx.fillRect(cx - r, hy - r, r * 2, r);

        // Horizontal scanlines
        ctx.globalCompositeOperation = 'destination-out';
        const lines = 14;
        for (let i = 1; i < lines; i++) {
            const frac = i / lines;
            const y  = hy - r * (1 - frac * frac);
            const lh = (r / lines) * 0.42 * (1 - frac * 0.45);
            ctx.fillStyle = 'rgba(0,0,0,1)';
            ctx.fillRect(cx - r, y, r * 2, lh);
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
    }

    function drawMountains(ctx, W, hy, H) {
        const backPts = [
            [0,0],[0.04,0.10],[0.07,0.06],[0.11,0.16],[0.16,0.08],
            [0.20,0.19],[0.25,0.11],[0.30,0.23],[0.35,0.12],[0.39,0.27],
            [0.44,0.15],[0.48,0.21],[0.52,0.11],[0.56,0.25],[0.61,0.14],
            [0.65,0.20],[0.70,0.09],[0.74,0.18],[0.79,0.11],[0.84,0.23],
            [0.88,0.13],[0.93,0.19],[0.97,0.08],[1,0.14],[1,0]
        ];
        const frontPts = [
            [0,0],[0.06,0.07],[0.11,0.04],[0.17,0.13],[0.22,0.05],
            [0.28,0.12],[0.33,0.04],[0.38,0.11],[0.43,0.05],[0.48,0.14],
            [0.53,0.06],[0.58,0.12],[0.63,0.05],[0.68,0.10],[0.73,0.04],
            [0.78,0.12],[0.84,0.05],[0.89,0.11],[0.94,0.04],[1,0.09],[1,0]
        ];

        // Back range — fill + neon ridge glow
        ctx.save();
        ctx.shadowColor = '#9900cc';
        ctx.shadowBlur = 20;
        ctx.fillStyle = '#2a0045';
        ctx.strokeStyle = '#7700bb';
        ctx.lineWidth = 1.5;
        mtnRange(ctx, W, hy, H, backPts);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Front range — darker fill + brighter neon ridge
        ctx.save();
        ctx.shadowColor = '#cc00ff';
        ctx.shadowBlur = 14;
        ctx.fillStyle = '#150022';
        ctx.strokeStyle = '#aa00ee';
        ctx.lineWidth = 1.2;
        mtnRange(ctx, W, hy, H, frontPts);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    function mtnRange(ctx, W, hy, H, pts) {
        ctx.beginPath();
        ctx.moveTo(0, hy);
        pts.forEach(([xf, yf]) => ctx.lineTo(W * xf, hy - H * yf));
        ctx.closePath();
    }

    function drawGround(ctx, W, H, hy) {
        const g = ctx.createLinearGradient(0, hy, 0, H);
        g.addColorStop(0, '#0a0020');
        g.addColorStop(1, '#040010');
        ctx.fillStyle = g;
        ctx.fillRect(0, hy, W, H - hy);
    }

    function drawGrid(ctx, W, H, hy, t) {
        const groundH = H - hy;
        const numV = 22, numHLines = 16;
        const vpX = W / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, hy, W, groundH);
        ctx.clip();

        // Vertical perspective fan — purple at horizon fading to teal at bottom
        const vGrad = ctx.createLinearGradient(0, hy, 0, H);
        vGrad.addColorStop(0,    'rgba(130, 0, 255, 0.0)');
        vGrad.addColorStop(0.18, 'rgba(150, 0, 255, 0.30)');
        vGrad.addColorStop(0.6,  'rgba(100, 40, 255, 0.58)');
        vGrad.addColorStop(1,    'rgba(0, 229, 255, 0.82)');
        ctx.strokeStyle = vGrad;
        for (let i = 0; i <= numV; i++) {
            const bx = (i / numV) * W;
            const hx = vpX + (bx - vpX) * 0.015;
            const distFromCenter = Math.abs(i - numV / 2) / (numV / 2);
            ctx.lineWidth = 0.25 + distFromCenter * 1.3;
            ctx.beginPath();
            ctx.moveTo(hx, hy);
            ctx.lineTo(bx, H + 4);
            ctx.stroke();
        }

        // Horizontal scrolling lines — slowed to chill VHS pace
        const speed = 0.15;
        const offset = (t * speed) % (1 / numHLines);
        for (let i = 0; i <= numHLines + 1; i++) {
            const frac = ((i / numHLines) + offset) % 1.0;
            if (frac <= 0) continue;
            const y = hy + groundH * Math.pow(frac, 2.0);
            if (y > H + 2) continue;
            ctx.globalAlpha = Math.min(frac * 0.9 + 0.06, 0.88);
            ctx.strokeStyle = '#00e5ff';
            ctx.lineWidth = frac * 1.4 + 0.2;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
        }

        ctx.globalAlpha = 1;
        ctx.restore();
    }

    /* ── Text replacement ──────────────────────────────── */
    function replaceText() {
        const walker = document.createTreeWalker(
            document.body, NodeFilter.SHOW_TEXT, null, false
        );
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        nodes.forEach(n => {
            n.textContent = n.textContent.replace(/e l e c t r o n/g, 'E L E C T R O N');
        });
        document.title = document.title.replace(/e l e c t r o n/gi, 'E L E C T R O N');
    }

    /* ── Portrait rain (Phase 1) ───────────────────────── */
    function startRain() {
        const portraits = shuffle([...ALL_PORTRAITS]);
        const total = portraits.length;
        const size  = 106;
        let done    = 0;

        portraits.forEach((src, i) => {
            const delay   = i * 130;
            const rotStart = (Math.random() - 0.5) * 14;
            const rotEnd   = rotStart + (Math.random() - 0.5) * 50;
            const dur      = 1.5 + Math.random() * 0.7;
            const xPos     = Math.max(0, Math.min(
                (i / total) * (window.innerWidth - size) + (Math.random() - 0.5) * 55,
                window.innerWidth - size
            ));

            setTimeout(() => {
                const img = document.createElement('img');
                img.src = '/' + src;
                img.style.cssText = [
                    'position:fixed',
                    `top:${-(size + 12)}px`,
                    `left:${xPos}px`,
                    `width:${size}px`,
                    `height:${size}px`,
                    'border-radius:50%',
                    'object-fit:cover',
                    'z-index:8000',
                    'pointer-events:none',
                    'filter:drop-shadow(0 0 10px #ff6ec7) drop-shadow(0 0 22px #b14aed)',
                    `transform:rotate(${rotStart}deg)`,
                    `transition:top ${dur}s cubic-bezier(0.28,0,0.75,1.25), transform ${dur}s ease-in`
                ].join(';');
                document.body.appendChild(img);

                requestAnimationFrame(() => requestAnimationFrame(() => {
                    img.style.top       = (window.innerHeight + size + 12) + 'px';
                    img.style.transform = `rotate(${rotEnd}deg)`;
                }));

                setTimeout(() => {
                    img.remove();
                    if (++done === total) clickSpawnOn = true;
                }, dur * 1000 + 700);

            }, delay);
        });
    }

    /* ── Walking portraits (Phase 2) ───────────────────── */
    document.addEventListener('click', function (e) {
        if (!clickSpawnOn) return;
        if (e.target.closest('a, button, input, select, textarea, label')) return;
        spawnWalker();
    });

    function spawnWalker() {
        const src = ALL_PORTRAITS[Math.floor(Math.random() * ALL_PORTRAITS.length)];
        const img = document.createElement('img');
        img.src = '/' + src;
        const h = Math.round(window.innerHeight * 0.5);

        img.style.cssText = [
            'position:fixed',
            'bottom:0',
            `left:${window.innerWidth + 20}px`,
            `height:${h}px`,
            'width:auto',
            'border-radius:50%',
            'object-fit:contain',
            'z-index:7500',
            'pointer-events:none',
            'filter:drop-shadow(0 0 22px #ff6ec7) drop-shadow(0 0 44px #b14aed)'
        ].join(';');
        document.body.appendChild(img);

        let started = false;
        function startWalk() {
            if (started) return;
            started = true;
            const imgW  = (img.naturalWidth && img.naturalHeight)
                ? Math.round(img.naturalWidth * h / img.naturalHeight)
                : h;
            const walkDur = 4 + Math.random() * 2.5;
            const midX    = Math.round(window.innerWidth * 0.22);

            img.style.transition = `left ${walkDur}s linear`;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                img.style.left = midX + 'px';
                img.addEventListener('transitionend', function onMid() {
                    img.removeEventListener('transitionend', onMid);
                    img.style.transition = 'left 0.28s ease-in';
                    img.style.left = (-imgW - 60) + 'px';
                    img.addEventListener('transitionend', () => img.remove(), { once: true });
                });
            }));
        }

        img.addEventListener('load', startWalk, { once: true });
        if (img.complete && img.naturalHeight > 0) startWalk();
    }

    /* ── Counter ───────────────────────────────────────── */
    function insertCounter() {
        if (document.getElementById('vaporwave-counter')) return;
        const el = document.createElement('div');
        el.id = 'vaporwave-counter';
        el.innerHTML = 'LIVE LOAD COUNTER: <span id="counter-value">' + pad(counterValue) + '</span>';
        const faq = document.getElementById('faq');
        faq ? faq.parentNode.insertBefore(el, faq) : document.body.appendChild(el);
        tickCounter();
    }

    function tickCounter() {
        const processing = Math.random() < 0.12;
        const delay = processing
            ? 4200 + Math.random() * 3200
            : 2000 + Math.random() * 1000;

        counterTimeout = setTimeout(() => {
            const el = document.getElementById('counter-value');
            if (!el) return;
            if (processing) {
                const saved = el.textContent;
                let dots = 0;
                const blink = setInterval(() => {
                    el.textContent = '▓'.repeat(Math.min(++dots, 4));
                    if (dots >= 4) {
                        clearInterval(blink);
                        setTimeout(() => {
                            el.textContent = saved;
                            incrementCounter();
                            tickCounter();
                        }, 480);
                    }
                }, 190);
            } else {
                incrementCounter();
                tickCounter();
            }
        }, delay);
    }

    function incrementCounter() {
        counterValue = (counterValue + 1) % 10000;
        const el = document.getElementById('counter-value');
        if (el) el.textContent = pad(counterValue);
    }

    function pad(n) {
        return String(n).padStart(4, '0');
    }

    /* ── Sticker ───────────────────────────────────────── */
    function createSticker() {
        if (document.getElementById('radical-sticker')) return;
        const el = document.createElement('div');
        el.id = 'radical-sticker';
        el.innerHTML = `
        <svg class="sticker-burst" width="140" height="140" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M70 10 L82 48 L122 48 L90 72 L102 110 L70 88 L38 110 L50 72 L18 48 L58 48 Z"
                  fill="#ff00aa" stroke="#ffff00" stroke-width="12" stroke-linejoin="round"/>
            <path d="M70 20 L80 50 L115 50 L88 72 L100 102 L70 82 L40 102 L52 72 L25 50 L60 50 Z"
                  fill="#ff44cc"/>
        </svg>
        <div class="sticker-label">RADICAL<br>DUDES<br>TIP ↓</div>`;
        document.body.appendChild(el);
    }

    /* ── Theme button hook ─────────────────────────────── */
    function hookThemeButton() {
        const btn = document.getElementById('theme-toggler');
        if (!btn) return;
        origThemeClick = btn.onclick;
        btn.onclick = function (e) {
            e.preventDefault();
            deactivateVisuals();
        };
    }

    function restoreThemeButton() {
        const btn = document.getElementById('theme-toggler');
        if (btn) btn.onclick = origThemeClick;
    }

    /* ── Utilities ─────────────────────────────────────── */
    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

})();
