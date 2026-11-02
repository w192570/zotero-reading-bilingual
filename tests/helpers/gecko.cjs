const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { firefox } = require('playwright');

// Run plugin code with an actual system principal. Playwright page.evaluate
// alone cannot reproduce Gecko's privileged/content object security checks.
async function gecko(t) {
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zrb-gecko-'));
  fs.writeFileSync(path.join(profile, 'user.js'), `user_pref("marionette.port", ${port});\nuser_pref("browser.shell.checkDefaultBrowser", false);\n`);
  const child = spawn(process.env.ZRB_GECKO_BINARY || firefox.executablePath(),
    ['-headless', '-no-remote', '-profile', profile, '-marionette', '--remote-allow-system-access', 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
  let socket;
  t.after(async () => {
    if (socket && child.exitCode === null) {
      try { await call('Marionette:Quit', { flags: ['eForceQuit'] }); } catch (e) {}
    }
    socket?.destroy();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    // Keep the isolated profile for diagnosis; never touch a user's profile.
  });
  for (let i = 0; i < 150 && !socket; i++) {
    socket = await new Promise(resolve => {
      const candidate = net.createConnection({ host: '127.0.0.1', port });
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', () => { candidate.destroy(); resolve(null); });
    });
    if (!socket) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!socket) throw new Error('Firefox Marionette did not start');
  let buffer = Buffer.alloc(0), nextId = 0;
  const messages = [], waiters = [];
  const deliver = message => waiters.length ? waiters.shift().resolve(message) : messages.push(message);
  const fail = error => { while (waiters.length) waiters.shift().reject(error); };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Marionette connection closed')));
  socket.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    for (;;) {
      const colon = buffer.indexOf(58);
      if (colon < 0) break;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) break;
      const body = buffer.subarray(colon + 1, colon + 1 + length);
      buffer = buffer.subarray(colon + 1 + length);
      deliver(JSON.parse(body.toString()));
    }
  });
  const receive = () => messages.length ? Promise.resolve(messages.shift())
    : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  await receive();
  async function call(name, params) {
    const id = ++nextId;
    const message = Buffer.from(JSON.stringify([0, id, name, params]));
    socket.write(Buffer.concat([Buffer.from(message.length + ':'), message]));
    const [type, replyId, error, result] = await receive();
    if (type !== 1 || replyId !== id) throw new Error('Unexpected Marionette response');
    if (error) throw new Error(error.message + '\n' + error.stacktrace);
    return result;
  }
  const session = await call('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
  await call('WebDriver:SetTimeouts', { script: 120000 });
  await call('Marionette:SetContext', { value: 'chrome' });
  return {
    version: session.capabilities.browserVersion,
    async run(script, args = [], async = false) {
      const result = await call(async ? 'WebDriver:ExecuteAsyncScript' : 'WebDriver:ExecuteScript',
        { script, args, newSandbox: false, sandbox: 'system', filename: 'zrb-gecko-test.js', line: 0 });
      return result.value;
    },
  };
}

module.exports = { gecko };
