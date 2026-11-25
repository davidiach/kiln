// Web Worker entry point: keeps running programs off the main thread, so an
// infinite loop can be killed instead of freezing the page.
import { createHost } from './host.js';

const host = createHost((msg, transfer) => self.postMessage(msg, transfer));
self.onmessage = (e) => host.handle(e.data);
