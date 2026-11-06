import {projectChart, type ChartProjectionMessage, type ChartProjectionRequest, type ChartProjectionResponse} from "./chart-projection";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ChartProjectionMessage>) => void) | null;
  postMessage: (message: ChartProjectionResponse) => void;
};
let pending: ChartProjectionRequest | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

scope.onmessage = event => {
  const message = event.data;
  if (message.type === "cancel") {
    if (pending?.generation === message.generation) pending = null;
    return;
  }
  pending = message;
  timer ??= setTimeout(() => {
    timer = null;
    const request = pending;
    pending = null;
    if (!request) return;
    try {
      scope.postMessage({type: "projected", generation: request.generation, projection: projectChart(request)});
    } catch (error) {
      scope.postMessage({type: "error", generation: request.generation,
        error: error instanceof Error ? error.message : "Chart projection failed."});
    }
  }, 0);
};
