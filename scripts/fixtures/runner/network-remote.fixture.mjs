import { it } from 'node:test';
import net from 'node:net';

// Each call must be refused by the guard before anything leaves the machine.
// The timeouts only bound the run if the guard is ever broken.
it('fetch to a remote host', async () => {
  await fetch('https://example.com', { signal: AbortSignal.timeout(3_000) });
});

it('socket to a remote host', () => {
  const socket = net.connect(80, 'example.com');
  socket.on('error', () => {});
  socket.destroy();
});

it('socket with an empty path to a remote host', () => {
  // `path: ''` is falsy, so Node connects over TCP to `host`.
  const socket = net.connect({ path: '', host: 'example.com', port: 80 });
  socket.on('error', () => {});
  socket.destroy();
});

// The global WebSocket arrived in Node 22.4.
it('WebSocket to a remote host', { skip: typeof WebSocket !== 'function' }, () => {
  const socket = new WebSocket('wss://example.com/socket');
  socket.addEventListener('error', () => {});
  socket.close();
});
