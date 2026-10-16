// Hebrew labels for enum values shown on screen.
import type { Order } from './store';

export const SIDE: Record<Order['side'], string> = { buy: 'קנייה', sell: 'מכירה' };

export const ORDER_TYPE: Record<Order['type'], string> = {
  market: 'שוק', limit: 'לימיט', stop: 'סטופ', stop_limit: 'סטופ לימיט',
};

export const STATUS: Record<Order['status'], string> = {
  new: 'ממתינה',
  held: 'ממתינה לכניסה',
  partially_filled: 'בוצעה חלקית',
  filled: 'בוצעה',
  canceled: 'בוטלה',
  rejected: 'נדחתה',
  expired: 'פגה',
};

/** Label for an order row: bracket legs read as take-profit / stop-loss. */
export const orderKind = (o: Order) => (o.parentId ? (o.type === 'stop' ? 'סטופ' : 'יעד רווח') : ORDER_TYPE[o.type]);
