// Exercise the same setup, Send and teardown once without a rate or timing report.
export { default, setup, teardown } from '../../throughput.ts';
export const options = {scenarios: {step_1: {executor: 'shared-iterations', vus: 1, iterations: 1}}};
export const handleSummary = () => ({});
