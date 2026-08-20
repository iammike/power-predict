// Fake Web Worker for handleArchive tests (#239, part 2). jsdom doesn't
// implement Worker at all, so src/app.js's `new Worker('dist/archive-worker.js')`
// needs a global stub. This one is driven directly by the test: grab the
// most recently constructed instance off `FakeWorker.instances` and call
// its onmessage/onerror handlers with the same message shapes the real
// archive-worker.js posts (see src/archive-worker.js's postMessage calls
// for the `progress`/`activity`/`done`/`error` message shapes).
export class FakeWorker {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage() {
    // handleArchive only ever posts the initial {type:'parse', file}
    // message and never reads a response to postMessage itself -- all
    // communication back is driven by the test calling onmessage/onerror
    // directly, so there's nothing for this to do.
  }

  terminate() {
    this.terminated = true;
  }
}
