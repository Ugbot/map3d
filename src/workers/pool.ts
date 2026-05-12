// Simple worker pool with promise-based RPC and backpressure.
// Composability: anything that consumes tiles only sees a `request<T>()` promise;
// swapping workers for a remote HTTP service is a one-file change.

export interface WorkerRequest<P = unknown> {
  id: number;
  type: string;
  payload: P;
}

export interface WorkerResponse<R = unknown> {
  id: number;
  ok: boolean;
  result?: R;
  error?: string;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  type: string;
};

export class WorkerPool {
  private workers: Worker[] = [];
  private nextWorker = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly factory: () => Worker,
    size = Math.max(2, Math.min(4, navigator.hardwareConcurrency - 1)),
  ) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      w.onerror = (e) => {
        // Reject all pending on this worker; we don't track ownership, so reject all.
        for (const [id, p] of this.pending) {
          p.reject(new Error(`worker error: ${e.message}`));
          this.pending.delete(id);
        }
      };
      this.workers.push(w);
    }
  }

  private onMessage(msg: WorkerResponse) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "worker error"));
  }

  request<R, P = unknown>(type: string, payload: P, transfer: Transferable[] = []): Promise<R> {
    const id = this.nextId++;
    const w = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    const msg: WorkerRequest<P> = { id, type, payload };
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        type,
      });
      w.postMessage(msg, transfer);
    });
  }

  get inflight() {
    return this.pending.size;
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.pending.clear();
  }
}
