const updates = new Map<object, () => void>();
let scheduled = false;

function flush() {
  const first = updates.entries().next().value;
  try {
    if (first) {
      updates.delete(first[0]);
      first[1]();
    }
  } finally {
    if (updates.size) requestAnimationFrame(flush);
    else scheduled = false;
  }
}

export function schedulePlot(plot: object, update: () => void) {
  updates.set(plot, update);
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}

export function cancelPlot(plot: object) {
  updates.delete(plot);
}
