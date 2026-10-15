const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (n: number | undefined) => (n === undefined ? '—' : usd.format(n));
export const price = (n: number | undefined) => (n === undefined || n === 0 ? '—' : n.toFixed(n >= 1 ? 2 : 4));
export const signed = (n: number) => `${n > 0 ? '+' : ''}${usd.format(n)}`;
export const pnlClass = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
export const time = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });
