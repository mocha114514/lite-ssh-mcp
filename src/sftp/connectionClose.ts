import type { Client } from 'ssh2';

interface CloseObservers {
  callbacks: Set<() => void>;
  notify(): void;
}

// One shared connection may own many admitted SFTP channels. Fan out one
// listener instead of adding one native listener per channel (or changing the
// client's listener limit). Observing closure never ends/destroys the client.
const observers = new WeakMap<Client, CloseObservers>();

export function observeConnectionClose(client: Client, callback: () => void): () => void {
  let group = observers.get(client);
  if (!group) {
    const callbacks = new Set<() => void>();
    group = {
      callbacks,
      notify() {
        observers.delete(client);
        const pending = [...callbacks];
        callbacks.clear();
        for (const notify of pending) notify();
      },
    };
    observers.set(client, group);
    client.once('close', group.notify);
  }
  group.callbacks.add(callback);
  const owned = group;
  return () => {
    owned.callbacks.delete(callback);
    if (owned.callbacks.size === 0 && observers.get(client) === owned) {
      client.removeListener('close', owned.notify);
      observers.delete(client);
    }
  };
}
