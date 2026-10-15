import { BridgeError } from './errors.mjs';
const failure = (code, active = false) => new BridgeError({
  queue_full: 'Browser queue is full. No generation submitted.',
  queue_timeout: 'Queue deadline expired. No generation submitted.',
  request_timeout: 'Request deadline expired; completion was not confirmed.',
  request_cancelled: 'Client cancelled the request.',
  adapter_quarantined: 'Adapter did not acknowledge cancellation. Restart required.',
  service_stopping: 'Service is stopping.',
}[code], code === 'queue_full' ? 429 : code === 'request_timeout' ? 504 : code === 'request_cancelled' ? 499 : 503,
code, { phase: active ? 'generation' : 'queue', generation_submitted: active ? 'unknown' : false });

// Aborting a promise does not prove the browser operation stopped. Keep ownership
// until it settles; quarantine adapters that ignore abort instead of overlapping.
export class SerialLane {
  constructor({ maxQueue = 4, queueTimeoutMs = 60000, requestTimeoutMs = 150000, cancelGraceMs = 3000 } = {}) {
    this.options = { maxQueue, queueTimeoutMs, requestTimeoutMs, cancelGraceMs };
    this.pending = []; this.active = null; this.quarantined = false; this.closed = false;
  }
  snapshot() { return { active: !!this.active, queued: this.pending.length, quarantined: this.quarantined, closed: this.closed }; }
  submit(operation, { signal } = {}) {
    if (this.closed) throw failure('service_stopping');
    if (this.quarantined) throw failure('adapter_quarantined');
    if (signal?.aborted) throw failure('request_cancelled');
    if (this.active && this.pending.length >= this.options.maxQueue) throw failure('queue_full');
    const controller = new AbortController();
    const job = { operation, controller, signal, deadlineMs: Date.now() + this.options.requestTimeoutMs, queueUntil: Date.now() + this.options.queueTimeoutMs, started: false, settled: false };
    const result = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.cancel = reason => {
      if (job.settled) return;
      job.settled = true;
      clearTimeout(job.timer); signal?.removeEventListener('abort', job.onAbort);
      this.pending = this.pending.filter(p => p !== job);
      controller.abort(reason); job.reject(reason);
      if (job.started) {
        job.grace = setTimeout(() => {
          if (this.active !== job) return;
          this.quarantined = true;
          for (const pending of [...this.pending]) pending.cancel(failure('adapter_quarantined'));
        }, this.options.cancelGraceMs);
        job.grace.unref?.();
      }
    };
    job.onAbort = () => job.cancel(failure('request_cancelled', job.started));
    signal?.addEventListener('abort', job.onAbort, { once: true });
    this.pending.push(job);
    job.timer = setTimeout(() => job.cancel(failure('queue_timeout')), Math.min(this.options.queueTimeoutMs, this.options.requestTimeoutMs));
    this.pump();
    return result;
  }
  pump() {
    if (this.active || this.closed || this.quarantined) return;
    const job = this.pending.shift();
    if (!job) return;
    if (Date.now() >= Math.min(job.queueUntil, job.deadlineMs)) { job.cancel(failure('queue_timeout')); this.pump(); return; }
    this.active = job; clearTimeout(job.timer);
    job.timer = setTimeout(() => job.cancel(failure('request_timeout', job.started)), Math.max(1, job.deadlineMs - Date.now()));
    job.task = Promise.resolve().then(() => {
      if (Date.now() >= job.deadlineMs) job.cancel(failure('request_timeout'));
      job.controller.signal.throwIfAborted();
      job.started = true;
      return job.operation({ signal: job.controller.signal, deadlineMs: job.deadlineMs });
    }).then(value => this.finish(job, null, value), error => this.finish(job, error));
  }
  finish(job, error, value) {
    // Timer callbacks may be delayed behind the operation's promise microtasks.
    if (!error && !job.settled && Date.now() >= job.deadlineMs) job.cancel(failure('request_timeout', job.started));
    clearTimeout(job.timer); clearTimeout(job.grace);
    job.signal?.removeEventListener('abort', job.onAbort);
    this.active = null;
    if (!job.settled) {
      job.settled = true;
      if (error) job.reject(error); else job.resolve(value);
    }
    this.pump();
  }
  async close() {
    this.closed = true;
    for (const job of [...this.pending]) job.cancel(failure('service_stopping'));
    const active = this.active;
    if (!active) return;
    active.cancel(failure('service_stopping', true));
    let timer;
    await Promise.race([active.task, new Promise(resolve => { timer = setTimeout(resolve, this.options.cancelGraceMs); })]);
    clearTimeout(timer);
  }
}
