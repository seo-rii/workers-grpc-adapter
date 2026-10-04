// This module has no SDK/adapter imports. The host can measure bootstrap
// readiness separately from the deferred SDK graph's module evaluation.
export function benchmarkBootstrap(sdks, load) {
  let worker, imports = 0;
  return { async fetch(request) {
    const phase = new URL(request.url).pathname.slice(1);
    if (phase === 'ready') return Response.json({ status: 'passed', sdks, graphLoaded: !!worker, imports });
    if (phase === 'import') {
      if (worker || imports) return new Response('GRAPH_ALREADY_IMPORTED', { status: 409 });
      imports++;
      worker = await load();
      const response = await worker.fetch(new Request('https://entry.fixture.invalid/ready'));
      const result = await response.json();
      return Response.json({ ...result, graphLoaded: true, imports });
    }
    if (!worker) return new Response('GRAPH_NOT_IMPORTED', { status: 409 });
    return worker.fetch(request);
  } };
}
