// Generic transport surface. Implementations: ws (Node server / browser client),
// in-process (Worker postMessage), or any other duplex byte channel.

export interface ClientHandle {
  readonly id: string;
  send(frame: Uint8Array): void;
  onMessage(cb: (msg: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface Transport {
  /** Broadcast a frame to every connected client. */
  publish(frame: Uint8Array): void;
  /** Called when a new client connects. The handler typically sends a keyframe. */
  onClient(cb: (client: ClientHandle) => void): void;
}
