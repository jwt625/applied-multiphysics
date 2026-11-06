// SPDX-License-Identifier: GPL-3.0-or-later
// L3 spike: open spike/browser-check.html in an already started headless Chrome (--remote-debugging-port) and print
// the page console (the Worker reports through postMessage -> console.log). Usage: node browser-cdp.mjs <port> <url>
const [port, url] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
const done = new Promise((res) => {
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description).join(' ');
      console.log(text);
      if (text.startsWith('RESULT') || text.startsWith('WORKERERROR')) res();
    }
    if (m.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(m.params.exceptionDetails).slice(0, 800));
  };
});
await new Promise((r) => (ws.onopen = r));
send('Runtime.enable');
send('Page.navigate', { url });
await Promise.race([done, new Promise((r) => setTimeout(r, 45000))]);
ws.close();
