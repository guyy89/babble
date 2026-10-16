const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
// Numbers are wrapped in a left-to-right isolate so signs and $ stay in place inside Hebrew (RTL) text.
const ltr = (s: string) => `\u2066${s}\u2069`;

export const money = (n: number | undefined) => (n === undefined ? '—' : ltr(usd.format(n)));
export const price = (n: number | undefined) => (n === undefined || n === 0 ? '—' : n.toFixed(n >= 1 ? 2 : 4));
export const signed = (n: number) => ltr(`${n > 0 ? '+' : ''}${usd.format(n)}`);
export const pnlClass = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
export const time = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });
