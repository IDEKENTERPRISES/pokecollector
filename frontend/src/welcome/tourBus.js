// Shared by the tour (P15) and What's new (P16): What's new waits while a tour is showing.
import { useSyncExternalStore } from 'react';

let active = false;
const listeners = new Set();

export function setTourActive(value) {
  if (active === !!value) return;
  active = !!value;
  listeners.forEach((fn) => fn());
}

export function isTourActive() {
  return active;
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTourActive() {
  return useSyncExternalStore(subscribe, isTourActive, isTourActive);
}
