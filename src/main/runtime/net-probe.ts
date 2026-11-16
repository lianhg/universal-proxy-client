import net from 'node:net';

/**
 * 探测某端口是否已被监听（连接成功 = 有人占着）。
 *
 * 原先 manager.ts / speedtester.ts / telemetry.ts 各自内联了一份完全相同的实现，
 * 只有默认超时不同；这里统一成一处，避免三份拷贝日后行为漂移。
 */
export function tcpProbe(port: number, host = '127.0.0.1', timeout = 400): Promise<boolean> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}
