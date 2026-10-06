import { it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import process from 'node:process';

function listen(server, ...args) {
  return new Promise((resolve) => server.listen(...args, () => resolve(server.address())));
}

it('fetch and sockets to loopback are allowed', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const { port } = await listen(server, 0, '127.0.0.1');
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
    for (const host of ['127.0.0.1', 'localhost']) {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, host, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
      });
    }
  } finally {
    server.close();
  }
});

it('a Unix socket path is allowed, whatever host the request names', { skip: process.platform === 'win32' }, async () => {
  // Relative, from inside the temp dir: an absolute Unix socket path is
  // limited to about 104 bytes, which a nested TMPDIR can exceed.
  process.chdir(os.tmpdir());
  const socketPath = `s${process.pid}.sock`;
  const server = http.createServer((_req, res) => res.end('ok'));
  await listen(server, socketPath);
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });
    // As a Docker-style client does: the socket path decides where it goes.
    const body = await new Promise((resolve, reject) => {
      http
        .get({ socketPath, host: 'example.com', path: '/' }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    assert.equal(body, 'ok');
  } finally {
    server.close();
    rmSync(socketPath, { force: true });
  }
});
