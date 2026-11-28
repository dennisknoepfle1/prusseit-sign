/* Konfetti zum Abschluss (Verkauf unterschrieben, Auto ausgeliefert). Ohne Bibliothek, ca. 3 Sekunden.
   window.prusseitConfetti("Herzlichen Glückwunsch …") */
(function () {
  const COLORS = ["#e30613", "#ff3b46", "#b0000c", "#ffffff", "#18151a", "#f4c542"];
  window.prusseitConfetti = function (msg) {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return banner(msg, true);
    const cv = document.createElement("canvas"), dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999";
    document.body.appendChild(cv);
    const W = innerWidth, H = innerHeight; cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext("2d"); c.scale(dpr, dpr);
    const N = Math.min(220, Math.round(W * H / 5000)), ps = [];
    for (let i = 0; i < N; i++) {
      const left = i % 2 === 0, a = (left ? -60 : -120) * Math.PI / 180 + (Math.random() - .5) * .9, v = 9 + Math.random() * 9;
      ps.push({ x: left ? -10 : W + 10, y: H * (.55 + Math.random() * .25), vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        w: 6 + Math.random() * 7, h: 9 + Math.random() * 9, r: Math.random() * 6, vr: (Math.random() - .5) * .35,
        col: COLORS[i % COLORS.length], round: Math.random() < .25, delay: Math.random() * 18 });
    }
    let t = 0;
    const tick = () => {
      t++; c.clearRect(0, 0, W, H); let alive = 0;
      for (const p of ps) {
        if (t < p.delay) { alive++; continue; }
        p.vx *= .985; p.vy = p.vy * .985 + .32; p.x += p.vx + Math.sin((t + p.delay) / 9) * .6; p.y += p.vy; p.r += p.vr;
        if (p.y < H + 30) alive++;
        c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.col;
        c.globalAlpha = Math.max(0, Math.min(1, (220 - t) / 40));
        if (p.round) { c.beginPath(); c.arc(0, 0, p.w / 2, 0, 7); c.fill(); }
        else c.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.r * 1.7)), p.w, p.h * Math.abs(Math.cos(p.r * 1.7)));
        if (p.col === "#ffffff") { c.strokeStyle = "rgba(0,0,0,.12)"; c.strokeRect(-p.w / 2, -2, p.w, 4); }
        c.restore();
      }
      if (alive && t < 230) requestAnimationFrame(tick); else cv.remove();
    };
    requestAnimationFrame(tick);
    banner(msg);
  };
  function banner(msg, still) {
    if (!msg) return;
    const b = document.createElement("div");
    b.textContent = msg;
    b.style.cssText = "position:fixed;left:50%;top:42%;transform:translate(-50%,-10px) scale(.92);opacity:0;z-index:10000;pointer-events:none;" +
      "background:#e30613;color:#fff;font:700 clamp(20px,3.2vw,30px)/1.25 system-ui,-apple-system,sans-serif;padding:18px 28px;border-radius:18px;" +
      "box-shadow:0 18px 50px rgba(227,6,19,.35);text-align:center;max-width:min(88vw,720px);transition:opacity .35s ease,transform .45s cubic-bezier(.2,1.4,.4,1)";
    document.body.appendChild(b);
    requestAnimationFrame(() => { b.style.opacity = "1"; b.style.transform = "translate(-50%,0) scale(1)"; });
    setTimeout(() => { b.style.opacity = "0"; b.style.transform = "translate(-50%,-10px) scale(.96)"; setTimeout(() => b.remove(), 450); }, still ? 2600 : 3200);
  }
})();
