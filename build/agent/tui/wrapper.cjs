#!/usr/bin/env node
// Tonoman web-TUI wrapper (baked into the sandbox image). Runs INSIDE the agent
// container and makes ttyd usable from a phone browser — two things ttyd 1.7.x can't
// do on mobile on its own:
//
//   1) Keyboard occlusion — ttyd fits the terminal to window.innerHeight, which mobile
//      browsers DON'T shrink when the soft keyboard opens, so the input row hides behind
//      it. We drive the terminal height from window.visualViewport (which DOES shrink).
//   2) No scroll wheel / PgUp on a phone. We reverse-proxy ttyd SAME-ORIGIN (ttyd runs
//      under base-path /term) so the page can drive the terminal, and add on-screen
//      scroll buttons (tap / double-tap = page / triple-tap = top-bottom / hold = fast).
//
// It binds 0.0.0.0:<TUI_PORT> in the container; the gateway publishes that port to host
// loopback (provision, tui-enabled) and `tonoman expose <TUI_PORT>` LAN-forwards it via
// the broker's tcpProxy — no admin, no netsh. Self-contained: Node built-ins only.
'use strict';
const http = require('http');
const net = require('net');

const TUI_PORT = Number(process.env.TUI_PORT || 7682);   // the wrapper (LAN-facing) port
const TTYD_PORT = Number(process.env.TTYD_PORT || 7681);  // ttyd, loopback in-container, base-path /term
const TTYD_HOST = '127.0.0.1';

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>tonoman tui</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#101010;overflow:hidden}
  #frame{border:0;width:100%;display:block;background:#101010}
  .sc{position:fixed;right:8px;width:44px;height:44px;border-radius:22px;
      background:rgba(80,80,90,.55);color:#fff;font:22px/44px system-ui,sans-serif;
      text-align:center;border:0;z-index:10;-webkit-tap-highlight-color:transparent;
      touch-action:manipulation;user-select:none}
  .sc:active{background:rgba(120,120,140,.8)}
  #up{bottom:120px} #dn{bottom:70px}
</style>
</head>
<body>
<iframe id="frame" src="/term/" allow="clipboard-read; clipboard-write"></iframe>
<button id="up" class="sc" aria-label="scroll up">&#9650;</button>
<button id="dn" class="sc" aria-label="scroll down">&#9660;</button>
<script>
  var f = document.getElementById('frame');
  function fit(){
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    f.style.height = h + 'px'; document.body.style.height = h + 'px';
    window.scrollTo(0, 0);
  }
  if (window.visualViewport){
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function(){ setTimeout(fit, 300); });
  fit();

  function termTarget(){
    try { var d = f.contentDocument;
      return d && (d.querySelector('.xterm-screen') || d.querySelector('.xterm-viewport') || d.querySelector('.xterm') || d.body);
    } catch(e){ return null; }
  }
  function wheel(dir, mag){
    var el = termTarget(); if (!el) return;
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * mag, deltaMode: 0, bubbles: true, cancelable: true }));
  }
  var TAP = 180, PAGE = 720, HOLD_MAG = 480, HOLD_MS = 320, TAP_GAP = 260;
  function jump(dir){ for (var i = 0; i < 60; i++) wheel(dir, PAGE); }
  function bind(btn, dir){
    var holdStart = null, repeat = null, didHold = false, taps = 0, tapTimer = null;
    function down(e){ if (e && e.cancelable) e.preventDefault(); didHold = false;
      holdStart = setTimeout(function(){ didHold = true; wheel(dir, HOLD_MAG);
        repeat = setInterval(function(){ wheel(dir, HOLD_MAG); }, 70); }, HOLD_MS); }
    function up(e){ if (e && e.cancelable) e.preventDefault();
      if (holdStart){ clearTimeout(holdStart); holdStart = null; }
      if (repeat){ clearInterval(repeat); repeat = null; }
      if (didHold){ didHold = false; return; }
      taps++; if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(function(){
        if (taps === 1) wheel(dir, TAP); else if (taps === 2) wheel(dir, PAGE); else jump(dir);
        taps = 0; }, TAP_GAP); }
    btn.addEventListener('touchstart', down, {passive:false});
    btn.addEventListener('touchend', up, {passive:false});
    btn.addEventListener('touchcancel', up);
    btn.addEventListener('mousedown', down); btn.addEventListener('mouseup', up);
  }
  bind(document.getElementById('up'), -1);
  bind(document.getElementById('dn'),  1);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(HTML);
    return;
  }
  const p = http.request(
    { host: TTYD_HOST, port: TTYD_PORT, method: req.method, path: req.url, headers: req.headers },
    (pr) => { res.writeHead(pr.statusCode || 502, pr.headers); pr.pipe(res); }
  );
  p.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
  req.pipe(p);
});
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(TTYD_PORT, TTYD_HOST, () => {
    up.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n');
    for (let i = 0; i < req.rawHeaders.length; i += 2) up.write(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n');
    up.write('\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
server.on('error', (e) => { console.error('tonoman-tui wrapper:', e.message); process.exit(1); });
server.listen(TUI_PORT, '0.0.0.0', () => console.log('tonoman-tui wrapper on :' + TUI_PORT + ' -> ttyd :' + TTYD_PORT + '/term'));
