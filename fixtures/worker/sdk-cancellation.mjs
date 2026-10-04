import { runSdkCancellation } from './sdk-cancellation-shared.mjs';

const unhandled = [];
addEventListener('unhandledrejection', event => { unhandled.push(event.reason?.name ?? 'unknown'); });
export default {
  async fetch(request) {
    const input = await request.json(), before = unhandled.length;
    try {
      const result = await runSdkCancellation({ ...input, send: fetch, control: async operation => {
        const response = await fetch(`https://sdk-cancellation-control.invalid/${input.namespace}/${operation}`, { method: 'POST' });
        if (!response.ok) throw new Error('SDK_CANCEL_CONTROL_FAILED');
        return response.json();
      } });
      await new Promise(resolve => setTimeout(resolve, 0));
      return Response.json({ status: 'passed', result, unhandledRejections: unhandled.slice(before) });
    } catch (error) {
      return Response.json({ status: 'failed', error: error.message, stack: error.stack }, { status: 500 });
    }
  },
};
