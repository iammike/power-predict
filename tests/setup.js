// jsdom 28 doesn't implement matchMedia, but uPlot calls it at module load
// (setPxRatio(), src/curve-chart.js's import chain). Any test that imports
// something pulling in uplot needs this stub or import fails outright.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

// jsdom 28 doesn't implement scrollIntoView. src/app.js's renderManualMode
// calls it unconditionally after every manual-mode render (#239).
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
